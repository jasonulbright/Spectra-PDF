//! The snapshot tool's OS side: the image clipboard, and the PNG file save.
//!
//! Two formats are published in ONE clipboard session: `CF_DIB`, which is
//! what a Windows consumer pastes, and the registered `PNG` format for
//! consumers that prefer it. Windows synthesizes `CF_BITMAP` from `CF_DIB`,
//! so that one is not written.
//!
//! Nothing here decodes an image. The renderer holds the pixels already and
//! builds both blobs; they arrive as one raw IPC body (`png || dib`) split by
//! a byte count in the request headers, so this module is the OS calls and
//! nothing else.
//!
//! The result is READ BACK from the clipboard after the write session closes:
//! a caller learns that the clipboard holds a W x H image, not that a call
//! returned success.

use std::thread::sleep;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

use crate::snapshot_save::header_number;
use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole::CF_DIB;

/// A `BITMAPINFOHEADER` is 40 bytes and carries the dimensions the read-back
/// reports; a body shorter than this is not a DIB.
const DIB_HEADER_BYTES: usize = 40;
/// Attempts to take the clipboard. Another application can hold it for a few
/// milliseconds at a time; failing the user's copy over that would be a
/// coin-flip feature.
const OPEN_ATTEMPTS: u32 = 12;
const OPEN_RETRY: Duration = Duration::from_millis(25);

#[derive(Serialize)]
pub struct ClipboardImage {
    /// Width read back OUT of the clipboard's own DIB header.
    pub width: i32,
    /// Height read back out of the clipboard's own DIB header. Positive means
    /// bottom-up rows, which is what is written.
    pub height: i32,
    /// The formats found on the clipboard afterwards.
    pub formats: Vec<String>,
}

/// A `HGLOBAL` that frees itself unless ownership passed to the clipboard.
/// `SetClipboardData` takes ownership on success and the handle must NOT be
/// freed then; on every failure path it must be, or the copy leaks the whole
/// raster.
struct MovableBlock {
    handle: HGLOBAL,
    owned: bool,
}

impl MovableBlock {
    fn new(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() {
            return Err("clipboard payload is empty".to_string());
        }
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len())
                .map_err(|e| format!("Could not allocate clipboard memory: {e}"))?;
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                let _ = GlobalFree(Some(handle));
                return Err("Could not lock clipboard memory".to_string());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            // GlobalUnlock reports failure when the lock count reaches zero,
            // which is the expected outcome here.
            let _ = GlobalUnlock(handle);
            Ok(Self { handle, owned: true })
        }
    }

    /// Hand the block to the clipboard. On success the clipboard owns it.
    fn publish(&mut self, format: u32) -> Result<(), String> {
        unsafe {
            SetClipboardData(format, Some(HANDLE(self.handle.0)))
                .map_err(|e| format!("Could not write clipboard format {format}: {e}"))?;
        }
        self.owned = false;
        Ok(())
    }
}

impl Drop for MovableBlock {
    fn drop(&mut self) {
        if self.owned {
            unsafe {
                let _ = GlobalFree(Some(self.handle));
            }
        }
    }
}

/// Open the clipboard, retrying while another application holds it.
fn open_clipboard_with(
    owner: Option<isize>,
    mut open: impl FnMut(Option<isize>) -> Result<(), String>,
) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..OPEN_ATTEMPTS {
        match open(owner) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = error;
                if attempt + 1 < OPEN_ATTEMPTS {
                    sleep(OPEN_RETRY);
                }
            }
        }
    }
    Err(format!("Another application is holding the clipboard: {last}"))
}

fn open_clipboard(owner: Option<isize>) -> Result<(), String> {
    open_clipboard_with(owner, |owner| {
        unsafe { OpenClipboard(owner.map(|handle| HWND(handle as *mut _))) }
            .map_err(|e| e.to_string())
    })
}

/// Read just the DIB dimensions while the clipboard is held open. The
/// clipboard may have changed between publishing and read-back, so its
/// current global block must be checked before the fixed-size header copy.
fn dib_dimensions(
    size: usize,
    read_header: impl FnOnce(&mut [u8; DIB_HEADER_BYTES]) -> Result<(), String>,
) -> Result<(i32, i32), String> {
    if size < DIB_HEADER_BYTES {
        return Err("The clipboard image header is incomplete".to_string());
    }
    let mut header = [0u8; DIB_HEADER_BYTES];
    read_header(&mut header)?;
    let width = i32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let height = i32::from_le_bytes([header[8], header[9], header[10], header[11]]);
    Ok((width, height))
}

/// Read the width/height back out of whatever DIB the clipboard now holds.
fn read_back(png_format: u32) -> Result<ClipboardImage, String> {
    open_clipboard(None)?;
    let result = (|| -> Result<ClipboardImage, String> {
        let mut formats = Vec::new();
        if unsafe { IsClipboardFormatAvailable(CF_DIB.0 as u32) }.is_ok() {
            formats.push("CF_DIB".to_string());
        }
        if png_format != 0 && unsafe { IsClipboardFormatAvailable(png_format) }.is_ok() {
            formats.push("PNG".to_string());
        }
        let handle = unsafe { GetClipboardData(CF_DIB.0 as u32) }
            .map_err(|e| format!("The clipboard did not accept the image: {e}"))?;
        let block = HGLOBAL(handle.0);
        let size = unsafe { GlobalSize(block) };
        let (width, height) = dib_dimensions(size, |header| {
            let ptr = unsafe { GlobalLock(block) };
            if ptr.is_null() {
                return Err("The clipboard image could not be read back".to_string());
            }
            unsafe {
                std::ptr::copy_nonoverlapping(
                    ptr as *const u8,
                    header.as_mut_ptr(),
                    DIB_HEADER_BYTES,
                );
                let _ = GlobalUnlock(block);
            }
            Ok(())
        })?;
        Ok(ClipboardImage { width, height, formats })
    })();
    unsafe {
        let _ = CloseClipboard();
    }
    result
}


/// Put a captured page region on the clipboard as an image.
///
/// Body: the PNG bytes followed by the DIB bytes; `snapshot-png-length` says
/// where the split is. Synchronous deliberately — Tauri runs a non-async
/// command on the main thread, and the clipboard is owned per task.
#[tauri::command]
pub fn copy_image_to_clipboard(
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<ClipboardImage, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err("snapshot image must be sent as a raw body".to_string())
        }
    };
    let png_length = header_number(&request, "snapshot-png-length")?;
    if png_length > body.len() {
        return Err("snapshot body is shorter than its declared PNG length".to_string());
    }
    let (png, dib) = body.split_at(png_length);
    if dib.len() < DIB_HEADER_BYTES {
        return Err("snapshot body carries no device-independent bitmap".to_string());
    }

    let mut dib_block = MovableBlock::new(dib)?;
    let mut png_block = if png.is_empty() { None } else { Some(MovableBlock::new(png)?) };
    let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    let owner = window
        .hwnd()
        .map(|handle| handle.0 as isize)
        .map_err(|e| format!("Could not access the clipboard owner window: {e}"))?;

    // EmptyClipboard clears ownership. Windows requires a real owner window
    // before SetClipboardData can publish the formats; a null owner makes the
    // next call fail even though OpenClipboard and EmptyClipboard succeeded.
    open_clipboard(Some(owner))?;
    let wrote = (|| -> Result<(), String> {
        unsafe { EmptyClipboard() }.map_err(|e| format!("Could not clear the clipboard: {e}"))?;
        dib_block.publish(CF_DIB.0 as u32)?;
        if let (Some(block), true) = (png_block.as_mut(), png_format != 0) {
            block.publish(png_format)?;
        }
        Ok(())
    })();
    unsafe {
        let _ = CloseClipboard();
    }
    wrote?;

    read_back(png_format)
}

/// Write the captured PNG to a path the user chose in the save dialog.
#[tauri::command]
pub fn save_snapshot_png(request: Request<'_>) -> Result<String, String> {
    crate::snapshot_save::save(&request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_the_clipboard_for_a_write_keeps_the_owner_window() {
        let owner = 123isize;
        let mut seen = Vec::new();
        open_clipboard_with(Some(owner), |passed| {
            seen.push(passed);
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, vec![Some(owner)]);
    }

    #[test]
    fn a_replaced_short_dib_is_refused_before_reading_its_header() {
        let mut read = false;
        let error = dib_dimensions(DIB_HEADER_BYTES - 1, |_| {
            read = true;
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("header is incomplete"));
        assert!(!read, "the undersized clipboard block was read");
    }

    #[test]
    fn dib_dimensions_are_read_from_the_checked_header() {
        let mut header = [0u8; DIB_HEADER_BYTES];
        header[4..8].copy_from_slice(&640i32.to_le_bytes());
        header[8..12].copy_from_slice(&(-480i32).to_le_bytes());
        let dims = dib_dimensions(DIB_HEADER_BYTES, |out| {
            *out = header;
            Ok(())
        })
        .unwrap();
        assert_eq!(dims, (640, -480));
    }
}
