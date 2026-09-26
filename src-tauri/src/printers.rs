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

/// Driver and spooler sizes are external input. These ceilings keep a broken
/// local queue from making the dialog reserve gigabytes before any printer
/// metadata is shown.
const MAX_ENUM_BUFFER_BYTES: usize = 64 * 1024 * 1024;
const MAX_PAPER_OPTIONS: usize = u16::MAX as usize + 1;
const MAX_DEVMODE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PRINTER_NAME_UNITS: usize = 32_767;

fn zeroed<T: Default + Clone>(count: usize, what: &str) -> Result<Vec<T>, String> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|e| format!("Could not allocate {what}: {e}"))?;
    values.resize(count, T::default());
    Ok(values)
}

fn checked_paper_count(count: i32) -> Result<usize, String> {
    let count = usize::try_from(count)
        .map_err(|_| "The printer returned an invalid paper count".to_string())?;
    if count > MAX_PAPER_OPTIONS {
        return Err(format!(
            "The printer reports {count} paper options, above the {}-option limit.",
            MAX_PAPER_OPTIONS
        ));
    }
    Ok(count)
}

fn checked_paper_counts(ids: i32, names: i32, sizes: i32) -> Result<usize, String> {
    let counts = [
        checked_paper_count(ids)?,
        checked_paper_count(names)?,
        checked_paper_count(sizes)?,
    ];
    if counts[1] != counts[0] || counts[2] != counts[0] {
        return Err("The printer returned inconsistent paper capability counts".to_string());
    }
    Ok(counts[0])
}

struct PaperOutputBuffers {
    ids: Vec<u16>,
    names: Vec<u16>,
    sizes: Vec<POINT>,
}

fn paper_output_buffers() -> Result<PaperOutputBuffers, String> {
    let name_units = MAX_PAPER_OPTIONS
        .checked_mul(64)
        .ok_or_else(|| "The printer paper-name list is too large".to_string())?;
    Ok(PaperOutputBuffers {
        // DeviceCapabilitiesW does not accept an output-buffer length. Keep
        // each buffer at the validated hard limit so a driver whose count
        // changes between the sizing and output calls cannot write past the
        // allocation. These three output buffers total under 9 MiB.
        ids: zeroed::<u16>(MAX_PAPER_OPTIONS, "printer paper ids")?,
        names: zeroed::<u16>(name_units, "printer paper names")?,
        sizes: zeroed::<POINT>(MAX_PAPER_OPTIONS, "printer paper sizes")?,
    })
}

fn checked_buffer_size(size: usize, limit: usize, what: &str) -> Result<usize, String> {
    if size > limit {
        return Err(format!(
            "The printer {what} requires {size} bytes, above the {} MiB limit.",
            limit / (1024 * 1024)
        ));
    }
    Ok(size)
}

fn checked_devmode_size(size: i32) -> Result<usize, String> {
    let size = usize::try_from(size)
        .map_err(|_| "The printer returned an invalid settings size".to_string())?;
    if size < std::mem::size_of::<DEVMODEW>() {
        return Err("The printer returned a truncated settings block".to_string());
    }
    checked_buffer_size(size, MAX_DEVMODE_BYTES, "default settings block")
}

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
        let needed_bytes = checked_buffer_size(
            needed as usize,
            MAX_ENUM_BUFFER_BYTES,
            "enumeration buffer",
        )?;
        // u64-backed so the buffer start is 8-byte aligned: it is read back
        // as PRINTER_INFO_4W (two pointers on x64), and a Vec<u8> only
        // guarantees 1-byte alignment — a cast from that is UB per the Rust
        // abstract machine even where the Windows heap happens to over-align;
        // clippy::cast_ptr_alignment confirms the requirement.
        let mut buf = zeroed::<u64>(needed_bytes.div_ceil(8), "printer enumeration buffer")?;
        let byte_view = unsafe {
            std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, needed_bytes)
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
        if needed as usize > needed_bytes
            || returned as usize > needed_bytes / std::mem::size_of::<PRINTER_INFO_4W>()
        {
            return Err("EnumPrinters returned data larger than its buffer".to_string());
        }
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

fn wide(s: &str) -> Result<Vec<u16>, String> {
    let units = s.encode_utf16().count();
    let capacity = units
        .checked_add(1)
        .filter(|&count| count <= MAX_PRINTER_NAME_UNITS)
        .ok_or_else(|| "The printer name is too long".to_string())?;
    let mut encoded = Vec::new();
    encoded
        .try_reserve_exact(capacity)
        .map_err(|e| format!("Could not allocate the printer name: {e}"))?;
    encoded.extend(s.encode_utf16());
    encoded.push(0);
    Ok(encoded)
}

const TENTHS_MM_TO_PT: f64 = 72.0 / 254.0;

/// Query one printer's paper list and feature flags (DeviceCapabilities +
/// its default DEVMODE). Read-only: nothing here opens a job or touches the
/// printer's stored defaults.
pub fn capabilities(name: &str) -> Result<PrinterCapabilities, String> {
    let wname = wide(name)?;
    let device = PCWSTR(wname.as_ptr());

    // Each capability has its own sizing query. Never size all three output
    // buffers from only the DC_PAPERS result.
    let n_ids = unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_PAPERS, None, None) };
    let n_names = unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_PAPERNAMES, None, None) };
    let n_sizes = unsafe { DeviceCapabilitiesW(device, PCWSTR::null(), DC_PAPERSIZE, None, None) };
    let n = checked_paper_counts(n_ids, n_names, n_sizes)
        .map_err(|e| format!("The printer '{name}' {e}"))?;

    let mut output = if n > 0 {
        Some(paper_output_buffers()?)
    } else {
        None
    };
    if let Some(buffers) = output.as_mut() {
        let ids_written = unsafe {
            DeviceCapabilitiesW(
                device,
                PCWSTR::null(),
                DC_PAPERS,
                Some(PWSTR(buffers.ids.as_mut_ptr())),
                None,
            )
        };
        let names_written = unsafe {
            DeviceCapabilitiesW(
                device,
                PCWSTR::null(),
                DC_PAPERNAMES,
                Some(PWSTR(buffers.names.as_mut_ptr())),
                None,
            )
        };
        let sizes_written = unsafe {
            DeviceCapabilitiesW(
                device,
                PCWSTR::null(),
                DC_PAPERSIZE,
                Some(PWSTR(buffers.sizes.as_mut_ptr() as *mut u16)),
                None,
            )
        };
        if checked_paper_counts(ids_written, names_written, sizes_written)
            .map_err(|e| format!("The printer '{name}' {e}"))?
            != n
        {
            return Err(format!(
                "The printer '{name}' changed its paper capabilities while they were being read"
            ));
        }
    }

    let mut papers = Vec::new();
    papers
        .try_reserve_exact(n)
        .map_err(|e| format!("Could not allocate printer paper options: {e}"))?;
    for i in 0..n {
        let buffers = output
            .as_ref()
            .ok_or_else(|| "The printer returned paper data without output buffers".to_string())?;
        let raw = &buffers.names[i * 64..(i + 1) * 64];
        let len = raw.iter().position(|&c| c == 0).unwrap_or(64);
        let paper_name = String::from_utf16_lossy(&raw[..len]);
        let w = buffers.sizes[i].x as f64 * TENTHS_MM_TO_PT;
        let h = buffers.sizes[i].y as f64 * TENTHS_MM_TO_PT;
        // A zero-sized or nameless row is driver noise, not a paper.
        if paper_name.is_empty() || w <= 0.0 || h <= 0.0 {
            continue;
        }
        papers.push(PaperOption {
            id: buffers.ids[i],
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
        let size = checked_devmode_size(size).ok()?;
        // The driver's DEVMODE carries a private tail beyond DEVMODEW —
        // allocate the reported size, aligned for the struct read.
        let words = size.div_ceil(std::mem::size_of::<u64>());
        let mut buf = zeroed::<u64>(words, "printer default settings").ok()?;
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
    let capacity = usize::try_from(len).ok()?;
    if capacity > MAX_PRINTER_NAME_UNITS {
        return None;
    }
    let mut buf = zeroed::<u16>(capacity, "default printer name").ok()?;
    if unsafe { GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut len) }.ok().is_err() {
        return None;
    }
    // `len` counts the terminating NUL on success.
    let written = usize::try_from(len).ok()?;
    if written == 0 || written > buf.len() {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..written - 1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printer_driver_counts_and_buffers_are_bounded() {
        assert_eq!(checked_paper_count(0).unwrap(), 0);
        assert_eq!(checked_paper_count(u16::MAX as i32 + 1).unwrap(), MAX_PAPER_OPTIONS);
        assert!(checked_paper_count(-1).is_err());
        assert!(checked_paper_count(MAX_PAPER_OPTIONS as i32 + 1).is_err());
        assert_eq!(
            checked_buffer_size(MAX_ENUM_BUFFER_BYTES, MAX_ENUM_BUFFER_BYTES, "test").unwrap(),
            MAX_ENUM_BUFFER_BYTES
        );
        assert!(
            checked_buffer_size(MAX_ENUM_BUFFER_BYTES + 1, MAX_ENUM_BUFFER_BYTES, "test").is_err()
        );
        assert!(checked_devmode_size(-1).is_err());
        assert!(checked_devmode_size((std::mem::size_of::<DEVMODEW>() - 1) as i32).is_err());
        assert_eq!(
            checked_devmode_size(std::mem::size_of::<DEVMODEW>() as i32).unwrap(),
            std::mem::size_of::<DEVMODEW>()
        );
        assert!(checked_devmode_size(MAX_DEVMODE_BYTES as i32 + 1).is_err());
        assert_eq!(wide("Printer").unwrap().last(), Some(&0));
        assert!(wide(&"x".repeat(MAX_PRINTER_NAME_UNITS)).is_err());
    }

    #[test]
    fn paper_capability_counts_must_match_before_the_rows_are_zipped() {
        assert_eq!(checked_paper_counts(3, 3, 3).unwrap(), 3);
        assert!(checked_paper_counts(3, 4, 3).is_err());
        assert!(checked_paper_counts(3, 3, -1).is_err());
    }

    #[test]
    fn paper_output_buffers_cover_the_full_bounded_driver_count() {
        let buffers = paper_output_buffers().unwrap();
        assert_eq!(buffers.ids.len(), MAX_PAPER_OPTIONS);
        assert_eq!(buffers.names.len(), MAX_PAPER_OPTIONS * 64);
        assert_eq!(buffers.sizes.len(), MAX_PAPER_OPTIONS);
    }

    #[test]
    fn allocation_failure_is_reported_instead_of_panicking() {
        assert!(zeroed::<u64>(usize::MAX, "test allocation").is_err());
    }
}
