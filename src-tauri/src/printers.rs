//! Windows printer enumeration (winspool via the `windows` crate).
//!
//! One implementation shared by the GUI (`list_printers` command feeding the
//! Print dialog's picker) and the CLI (`printers` subcommand) — GUI/CLI
//! parity by construction, not by keeping two lists in step.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Graphics::Printing::{
    EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_INFO_4W,
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
        // abstract machine even where the Windows heap happens to over-align
        // (review-caught, confirmed by clippy::cast_ptr_alignment).
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
