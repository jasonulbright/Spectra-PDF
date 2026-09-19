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
use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
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
fn open_clipboard() -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..OPEN_ATTEMPTS {
        // A null window handle associates the clipboard with the current
        // task, which is what a transient write wants: no window is claiming
        // to render formats on demand.
        match unsafe { OpenClipboard(None) } {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                if attempt + 1 < OPEN_ATTEMPTS {
                    sleep(OPEN_RETRY);
                }
            }
        }
    }
    Err(format!("Another application is holding the clipboard: {last}"))
}

/// Read the width/height back out of whatever DIB the clipboard now holds.
fn read_back(png_format: u32) -> Result<ClipboardImage, String> {
    open_clipboard()?;
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
        let ptr = unsafe { GlobalLock(block) };
        if ptr.is_null() {
            return Err("The clipboard image could not be read back".to_string());
        }
        let mut header = [0u8; DIB_HEADER_BYTES];
        unsafe {
            std::ptr::copy_nonoverlapping(ptr as *const u8, header.as_mut_ptr(), DIB_HEADER_BYTES);
            let _ = GlobalUnlock(block);
        }
        let width = i32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let height = i32::from_le_bytes([header[8], header[9], header[10], header[11]]);
        Ok(ClipboardImage { width, height, formats })
    })();
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

fn header_number(request: &Request<'_>, name: &str) -> Result<usize, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .ok_or_else(|| format!("snapshot request is missing its {name} header"))
}

/// Put a captured page region on the clipboard as an image.
///
/// Body: the PNG bytes followed by the DIB bytes; `snapshot-png-length` says
/// where the split is. Synchronous deliberately — Tauri runs a non-async
/// command on the main thread, and the clipboard is owned per task.
#[tauri::command]
pub fn copy_image_to_clipboard(request: Request<'_>) -> Result<ClipboardImage, String> {
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

    open_clipboard()?;
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

/// The eight-byte PNG signature. The write below refuses anything else.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Write the captured PNG to a path the user chose in the save dialog.
///
/// A raw body again (the same raster, megabytes of it), with the destination
/// percent-encoded in a header. Deliberately NOT a general "write these bytes
/// anywhere" door: the path must name a `.png` and the body must carry the
/// PNG signature, so the command can only ever do the one thing it exists for.
/// It overwrites, because the save dialog already asked.
#[tauri::command]
pub fn save_snapshot_png(request: Request<'_>) -> Result<String, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("snapshot image must be sent as a raw body".to_string()),
    };
    write_png(body, || {
        let encoded = request
            .headers()
            .get("snapshot-path")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "snapshot request is missing its snapshot-path header".to_string())?;
        percent_decode(encoded)
    })
}

/// The body must carry the PNG signature and the path must name a `.png`.
/// The file is published through a checked sibling stage, so an existing file
/// the save dialog offered to overwrite stays whole until the new one lands.
fn write_png(body: &[u8], path: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    if body.len() < PNG_SIGNATURE.len() || body[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err("snapshot body is not a PNG".to_string());
    }
    let path = path()?;
    if !std::path::Path::new(&path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("png"))
    {
        return Err(format!("a snapshot is saved as a .png file, not {path}"));
    }
    crate::file_publication::replace_bytes(body, std::path::Path::new(&path))
        .map_err(|e| format!("Could not write {path}: {e}"))?;
    Ok(path)
}

/// Percent-decoding for the path header. Headers are ASCII, and a Windows
/// path can hold anything; `encodeURIComponent` on the way in and this on the
/// way out is the same convention the filesystem plugin uses.
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("snapshot-path header is not valid percent-encoding".to_string());
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| "snapshot-path header is not valid percent-encoding".to_string())?;
            out.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "snapshot-path header is not valid percent-encoding".to_string())?,
            );
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "snapshot-path header is not valid UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(tail: &[u8]) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(tail);
        bytes
    }

    #[test]
    fn a_snapshot_replaces_the_chosen_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("shot.png");
        std::fs::write(&target, png(b"the previous shot")).unwrap();
        let path = target.to_string_lossy().to_string();

        assert_eq!(write_png(&png(b"a new shot"), || Ok(path.clone())).unwrap(), path);

        assert_eq!(std::fs::read(&target).unwrap(), png(b"a new shot"));
        let beside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(beside, vec![std::ffi::OsString::from("shot.png")]);
    }

    /// The refusals come before the path is even read, in the order the
    /// request is checked, and none of them touches an existing file.
    #[test]
    fn a_refused_snapshot_leaves_the_chosen_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("shot.png");
        std::fs::write(&target, png(b"the previous shot")).unwrap();
        let path = target.to_string_lossy().to_string();

        let not_png = write_png(b"GIF89a", || panic!("the path is read after the body"));
        assert_eq!(not_png.unwrap_err(), "snapshot body is not a PNG");
        let jpg = dir.path().join("shot.jpg").to_string_lossy().to_string();
        assert!(write_png(&png(b"x"), || Ok(jpg)).unwrap_err().contains(".png file"));
        assert!(write_png(&png(b"x"), || Err("no header".to_string())).is_err());

        assert_eq!(std::fs::read(&target).unwrap(), png(b"the previous shot"));
        assert!(write_png(&png(b"x"), || Ok(path)).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_snapshot_lands_through_the_checked_stage() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        writer.wait().unwrap();
        let orphan = dir
            .path()
            .join(format!("document-stage-{}-abc123.pdf", writer.id()));
        std::fs::write(&orphan, b"a killed save's stage").unwrap();
        let path = dir.path().join("shot.png").to_string_lossy().to_string();

        write_png(&png(b"a shot"), || Ok(path)).unwrap();

        assert!(!orphan.exists());
    }
}
