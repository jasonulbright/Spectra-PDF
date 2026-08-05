//! Windows printer enumeration + capabilities (winspool via the `windows`
//! crate).
//!
//! One implementation shared by the GUI (`list_printers` /
//! `printer_capabilities` commands feeding the Print dialog) and the CLI
//! (`printers` subcommand and its `--capabilities` arm) — GUI/CLI parity by
//! construction, not by keeping two lists in step.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{DEVMODEW, DM_PAPERSIZE};
use windows::Win32::Graphics::Printing::{
    ClosePrinter, DocumentPropertiesW, EnumPrintersW, GetDefaultPrinterW, OpenPrinterW,
    PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W,
};
use windows::Win32::Storage::Xps::{
    DeviceCapabilitiesW, DC_COLLATE, DC_COLORDEVICE, DC_COPIES, DC_DUPLEX, DC_PAPERNAMES,
    DC_PAPERS, DC_PAPERSIZE,
};

#[derive(serde::Serialize)]
pub struct PrinterList {
    /// Installed printer names (local + network connections), sorted.
    pub printers: Vec<String>,
    /// The user's default printer, if one is set. Always one of `printers`
    /// when present.
    pub default: Option<String>,
}

pub fn enumerate() -> Result<PrinterList, String> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed = 0u32;
    let mut returned = 0u32;

    // Sizing call: fails with ERROR_INSUFFICIENT_BUFFER and reports `needed`.
    unsafe {
        let _ = EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut returned);
    }
    let mut printers = Vec::new();
    if needed > 0 {
        // u64-backed so the buffer start is 8-byte aligned: it is read back
        // as PRINTER_INFO_4W (two pointers on x64), and a Vec<u8> only
        // guarantees 1-byte alignment — a cast from that is UB per the Rust
        // abstract machine even where the Windows heap happens to over-align;
        // clippy::cast_ptr_alignment confirms the requirement.
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let byte_view = unsafe {
            std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, needed as usize)
        };
        unsafe {
            EnumPrintersW(
                flags,
                PCWSTR::null(),
                4,
                Some(byte_view),
                &mut needed,
                &mut returned,
            )
        }
        .map_err(|e| format!("EnumPrinters failed: {e}"))?;
        // Level 4 (PRINTER_INFO_4W) is the documented "fast, names-only"
        // level: the names sit in `buf` after the struct array, so the
        // buffer must outlive the reads (it does — `buf` spans this block).
        let infos = unsafe {
            std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, returned as usize)
        };
        for info in infos {
            if !info.pPrinterName.is_null() {
                if let Ok(name) = unsafe { info.pPrinterName.to_string() } {
                    printers.push(name);
                }
            }
        }
    }
    printers.sort_by_key(|n| n.to_lowercase());

    // A default that isn't in the enumerated set (stale registry entry for a
    // removed printer) would preselect a phantom in the dialog — drop it.
    let default = default_printer().filter(|d| printers.iter().any(|p| p == d));

    Ok(PrinterList { printers, default })
}

#[derive(serde::Serialize)]
pub struct PaperOption {
    /// DMPAPER id (driver-specific ids above 255 included) — what the
    /// engine forwards to mswinpr2's /UserSettings /Paper.
    pub id: u16,
    pub name: String,
    /// Size in PDF points, exactly as the driver reports it (usually
    /// portrait; envelope media can be natively landscape) — from the
    /// tenths-of-millimetre DC_PAPERSIZE report.
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(serde::Serialize)]
pub struct PrinterCapabilities {
    /// The driver's real paper list (names + sizes), in driver order.
    pub papers: Vec<PaperOption>,
    /// dmPaperSize of the printer's default DEVMODE, when reported.
    pub default_paper: Option<u16>,
    /// Hardware duplexer present (DC_DUPLEX).
    pub duplex: bool,
    /// Color-capable device (DC_COLORDEVICE; unknown reads as color so a
    /// real control is never hidden by a query failure).
    pub color: bool,
    /// Driver-side collation support — informational; our collation is
    /// job-sequencing, never dmCollate.
    pub collate: bool,
    /// Driver-reported dmCopies maximum — informational for the same reason.
    pub max_copies: u32,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

const TENTHS_MM_TO_PT: f64 = 72.0 / 254.0;

/// Query one printer's paper list and feature flags (DeviceCapabilities +
/// its default DEVMODE). Read-only: nothing here opens a job or touches the
/// printer's stored defaults.
pub fn capabilities(name: &str) -> Result<PrinterCapabilities, String> {
    let wname = wide(name);
    let device = PCWSTR(wname.as_ptr());

    // Paper ids / names / sizes are three parallel queries; drivers report
    // the same count for each, but a mismatched (buggy) driver only narrows
    // the zip — never an out-of-bounds read.
    let n_papers = unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_PAPERS, None, None) };
    if n_papers < 0 {
        return Err(format!("The printer '{name}' did not report its capabilities"));
    }
    let n = n_papers as usize;

    let mut ids = vec![0u16; n];
    let mut names_buf = vec![0u16; n * 64];
    let mut sizes = vec![POINT { x: 0, y: 0 }; n];
    if n > 0 {
        unsafe {
            DeviceCapabilitiesW(
                device,
                PCWSTR::null(),
                DC_PAPERS,
                Some(PWSTR(ids.as_mut_ptr())),
                None,
            );
            DeviceCapabilitiesW(
                device,
                PCWSTR::null(),
                DC_PAPERNAMES,
                Some(PWSTR(names_buf.as_mut_ptr())),
                None,
            );
            DeviceCapabilitiesW(
                device,
                PCWSTR::null(),
                DC_PAPERSIZE,
                Some(PWSTR(sizes.as_mut_ptr() as *mut u16)),
                None,
            );
        }
    }

    let mut papers = Vec::with_capacity(n);
    for i in 0..n {
        let raw = &names_buf[i * 64..(i + 1) * 64];
        let len = raw.iter().position(|&c| c == 0).unwrap_or(64);
        let paper_name = String::from_utf16_lossy(&raw[..len]);
        let w = sizes[i].x as f64 * TENTHS_MM_TO_PT;
        let h = sizes[i].y as f64 * TENTHS_MM_TO_PT;
        // A zero-sized or nameless row is driver noise, not a paper.
        if paper_name.is_empty() || w <= 0.0 || h <= 0.0 {
            continue;
        }
        papers.push(PaperOption {
            id: ids[i],
            name: paper_name,
            width_pt: w,
            height_pt: h,
        });
    }

    let duplex = unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_DUPLEX, None, None) } == 1;
    let color_q =
        unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_COLORDEVICE, None, None) };
    let color = color_q != 0; // 1 = color, 0 = mono, -1 (unknown) = assume color
    let collate =
        unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_COLLATE, None, None) } == 1;
    let copies_q = unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_COPIES, None, None) };
    let max_copies = if copies_q > 0 { copies_q as u32 } else { 1 };

    Ok(PrinterCapabilities {
        papers,
        default_paper: default_paper_id(&wname),
        duplex,
        color,
        collate,
        max_copies,
    })
}

/// dmPaperSize from the printer's default DEVMODE (DocumentProperties with
/// DM_OUT_BUFFER — a read, never the settings dialog).
fn default_paper_id(wname: &[u16]) -> Option<u16> {
    const DM_OUT_BUFFER: u32 = 2;
    let mut handle = PRINTER_HANDLE::default();
    unsafe { OpenPrinterW(PCWSTR(wname.as_ptr()), &mut handle, None) }.ok()?;
    let result = (|| {
        let size = unsafe {
            DocumentPropertiesW(None, handle, PCWSTR(wname.as_ptr()), None, None, 0)
        };
        if size <= 0 {
            return None;
        }
        // The driver's DEVMODE carries a private tail beyond DEVMODEW —
        // allocate the reported size, aligned for the struct read.
        let words = (size as usize).div_ceil(std::mem::size_of::<u64>());
        let mut buf = vec![0u64; words];
        let devmode = buf.as_mut_ptr() as *mut DEVMODEW;
        let rc = unsafe {
            DocumentPropertiesW(
                None,
                handle,
                PCWSTR(wname.as_ptr()),
                Some(devmode),
                None,
                DM_OUT_BUFFER,
            )
        };
        if rc < 0 {
            return None;
        }
        let dm = unsafe { &*devmode };
        if dm.dmFields.contains(DM_PAPERSIZE) {
            let id = unsafe { dm.Anonymous1.Anonymous1.dmPaperSize };
            u16::try_from(id).ok()
        } else {
            None
        }
    })();
    let _ = unsafe { ClosePrinter(handle) };
    result
}

fn default_printer() -> Option<String> {
    let mut len = 0u32;
    unsafe {
        let _ = GetDefaultPrinterW(Some(PWSTR::null()), &mut len);
    }
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    if unsafe { GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut len) }.ok().is_err() {
        return None;
    }
    // `len` counts the terminating NUL on success.
    Some(String::from_utf16_lossy(&buf[..len.saturating_sub(1) as usize]))
}
