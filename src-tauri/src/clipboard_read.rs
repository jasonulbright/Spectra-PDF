//! The clipboard READ side: whatever is on the clipboard, as a file Create
//! PDF already accepts.
//!
//! `snapshot.rs` is the write half and this is its inverse, under the same
//! session discipline: the retrying `open_clipboard`, `CloseClipboard` on
//! every path including the error paths, and a `GlobalLock`/`GlobalUnlock`
//! pair around every read. Ownership differs in one way that matters —
//! `GetClipboardData` hands back a handle the CLIPBOARD still owns, so
//! nothing here is ever freed.
//!
//! Nothing converts. Four formats are copied out verbatim into a scratch file
//! whose extension the engine's own accepted set already covers:
//! the registered `PNG` -> `.png`, `CF_DIB` -> `.dib` (a packed DIB is
//! exactly a headerless `.dib`, and its `biXPelsPerMeter` reaches the page
//! size), `HTML Format` -> `.html` (the same hardened LibreOffice arm, so a
//! remote reference is blocked), `CF_UNICODETEXT` -> `.txt`.
//!
//! The bytes never cross the IPC boundary: a pasted screenshot is megabytes,
//! the engine needs a file anyway, and the caller needs only the path.

use std::thread::sleep;
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};

use crate::clipboard_scratch::{
    checked_clipboard_size, discard_scratch_at, html_document, scratch_dir, write_scratch,
    ClipboardSource, MAX_CLIPBOARD_IMAGE_BYTES, MAX_CLIPBOARD_TEXT_BYTES,
};

/// Attempts to take the clipboard, matching the write side: another
/// application can hold it for a few milliseconds at a time.
const OPEN_ATTEMPTS: u32 = 12;
const OPEN_RETRY: Duration = Duration::from_millis(25);

/// A `BITMAPINFOHEADER` is 40 bytes; a shorter body is not a DIB.
const DIB_HEADER_BYTES: usize = 40;

fn open_clipboard() -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..OPEN_ATTEMPTS {
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
    Err(format!(
        "Another application is holding the clipboard: {last}"
    ))
}

/// Copy one format's payload out of the open clipboard.
///
/// The handle belongs to the clipboard and is never freed here. `GlobalSize`
/// bounds the copy: a clipboard block carries no length of its own.
fn read_format(format: u32, limit: usize, kind: &str) -> Result<Option<Vec<u8>>, String> {
    if format == 0 || unsafe { IsClipboardFormatAvailable(format) }.is_err() {
        return Ok(None);
    }
    let Ok(handle) = (unsafe { GetClipboardData(format) }) else {
        return Ok(None);
    };
    let block = HGLOBAL(handle.0);
    let size = checked_clipboard_size(unsafe { GlobalSize(block) }, limit, kind)?;
    if size == 0 {
        return Ok(None);
    }
    let mut out = Vec::new();
    out.try_reserve_exact(size)
        .map_err(|error| format!("Not enough memory to read clipboard {kind}: {error}"))?;
    out.resize(size, 0);
    let ptr = unsafe { GlobalLock(block) };
    if ptr.is_null() {
        return Ok(None);
    }
    unsafe {
        std::ptr::copy_nonoverlapping(ptr as *const u8, out.as_mut_ptr(), size);
        // GlobalUnlock reports failure when the lock count reaches zero,
        // which is the expected outcome here.
        let _ = GlobalUnlock(block);
    }
    Ok(Some(out))
}

/// A UTF-16 clipboard payload as a Rust string, stopping at the terminator.
fn utf16_payload(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

fn dib_dimensions(bytes: &[u8]) -> Result<(i32, i32), String> {
    if bytes.len() < DIB_HEADER_BYTES {
        return Err("The clipboard image is not a device-independent bitmap".to_string());
    }
    let width = i32::from_le_bytes(bytes[4..8].try_into().expect("four-byte width"));
    let signed_height = i32::from_le_bytes(bytes[8..12].try_into().expect("four-byte height"));
    let height = signed_height
        .checked_abs()
        .ok_or_else(|| "The clipboard image has an invalid height".to_string())?;
    Ok((width, height))
}

/// `StartFragment`/`EndFragment` are byte offsets into the WHOLE `CF_HTML`
/// payload. Returns the fragment, plus `SourceURL` when the header names one.
///
/// A header that does not carry usable offsets falls back to everything after
/// the header block (the first blank-line-free run of `Key:Value` lines),
/// because a fragment we cannot locate is still a fragment we can convert.
pub fn parse_cf_html(payload: &[u8]) -> (String, Option<String>) {
    let mut start: Option<usize> = None;
    let mut end: Option<usize> = None;
    let mut source_url: Option<String> = None;
    let mut header_end = 0usize;

    // The header is a fixed vocabulary, and matching on it rather than on
    // "looks like Key:Value" is what stops the FIRST BODY LINE being eaten:
    // `<a href="https://…">` splits at a colon perfectly well.
    const HEADER_KEYS: [&str; 8] = [
        "Version",
        "StartHTML",
        "EndHTML",
        "StartFragment",
        "EndFragment",
        "StartSelection",
        "EndSelection",
        "SourceURL",
    ];
    for line in payload.split_inclusive(|byte| *byte == b'\n') {
        let mut trimmed = line;
        while matches!(trimmed.last(), Some(b'\r' | b'\n')) {
            trimmed = &trimmed[..trimmed.len() - 1];
        }
        // The header vocabulary and its numeric offsets are ASCII. A malformed
        // body must not be decoded before offsets are applied to the raw bytes.
        let Ok(trimmed) = std::str::from_utf8(trimmed) else {
            break;
        };
        let Some((key, value)) = trimmed.split_once(':') else {
            break;
        };
        let key = key.trim();
        if !HEADER_KEYS.contains(&key) {
            break;
        }
        let value = value.trim();
        match key {
            "StartFragment" => start = value.parse::<usize>().ok(),
            "EndFragment" => end = value.parse::<usize>().ok(),
            // A SourceURL carries its own colons — `split_once` already kept
            // everything after the FIRST one, which is the whole URL.
            "SourceURL" => {
                if !value.is_empty() && value != "about:blank" {
                    source_url = Some(value.to_string());
                }
            }
            _ => {}
        }
        header_end += line.len();
    }

    if let (Some(s), Some(e)) = (start, end) {
        if s < e && e <= payload.len() {
            // Offsets are byte offsets and may land mid-character on a
            // malformed writer; lossy rather than refusing the paste.
            return (
                String::from_utf8_lossy(&payload[s..e]).into_owned(),
                source_url,
            );
        }
    }
    let tail = String::from_utf8_lossy(payload.get(header_end..).unwrap_or_default());
    (tail.trim().to_string(), source_url)
}

/// Remove a clipboard copy after its Create PDF dialog no longer needs it.
/// The renderer supplies the path it received, but deletion is confined to
/// this command's dedicated scratch directory and filename set.
#[tauri::command]
pub fn discard_clipboard_source(path: String) -> Result<(), String> {
    let dir = scratch_dir()?;
    discard_scratch_at(&dir, std::path::Path::new(&path))
}

/// What the clipboard holds, as a file Create PDF accepts.
///
/// Priority: `PNG`, `CF_DIB`, `HTML Format`, `CF_UNICODETEXT`. Image before
/// HTML is load-bearing — copying a picture in a browser puts a bitmap AND an
/// `<img src="https://…">` flavour on the clipboard, and the hardened
/// converter would (correctly) refuse the remote reference, so an HTML-first
/// order would turn a copied picture into a blank page.
///
/// Synchronous deliberately, like the write side: Tauri runs a non-async
/// command on the main thread and the clipboard is owned per task.
#[tauri::command]
pub fn read_clipboard_source() -> Result<ClipboardSource, String> {
    let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    let html_format = unsafe { RegisterClipboardFormatW(w!("HTML Format")) };

    open_clipboard()?;
    let picked = (|| -> Result<Option<(&str, &str, Vec<u8>)>, String> {
        if let Some(bytes) = read_format(png_format, MAX_CLIPBOARD_IMAGE_BYTES, "image")? {
            return Ok(Some(("png", "PNG", bytes)));
        }
        if let Some(bytes) = read_format(CF_DIB.0 as u32, MAX_CLIPBOARD_IMAGE_BYTES, "image")? {
            return Ok(Some(("dib", "CF_DIB", bytes)));
        }
        if let Some(bytes) = read_format(html_format, MAX_CLIPBOARD_TEXT_BYTES, "HTML")? {
            return Ok(Some(("html", "CF_HTML", bytes)));
        }
        if let Some(bytes) = read_format(
            CF_UNICODETEXT.0 as u32,
            MAX_CLIPBOARD_TEXT_BYTES,
            "text",
        )? {
            return Ok(Some(("txt", "CF_UNICODETEXT", bytes)));
        }
        Ok(None)
    })();
    unsafe {
        let _ = CloseClipboard();
    }

    let Some((extension, format, raw)) = picked? else {
        return Err(
            "The clipboard holds nothing Create PDF can use — copy an image, \
             formatted text or plain text first"
                .to_string(),
        );
    };

    match extension {
        "png" => {
            let path = write_scratch("png", &raw)?;
            Ok(ClipboardSource {
                path,
                kind: "image".to_string(),
                format: format.to_string(),
                bytes: raw.len(),
                width: None,
                height: None,
                chars: None,
                source_url: None,
                files: None,
            })
        }
        "dib" => {
            let (width, height) = dib_dimensions(&raw)?;
            let path = write_scratch("dib", &raw)?;
            Ok(ClipboardSource {
                path,
                kind: "image".to_string(),
                format: format.to_string(),
                bytes: raw.len(),
                width: Some(width),
                height: Some(height.abs()),
                chars: None,
                source_url: None,
                files: None,
            })
        }
        "html" => {
            // CF_HTML is defined as UTF-8 and its offsets are byte offsets
            // into that encoding.
            let (fragment, source_url) = parse_cf_html(&raw);
            if fragment.trim().is_empty() {
                return Err("The clipboard holds an empty HTML fragment".to_string());
            }
            let document = html_document(&fragment);
            let path = write_scratch("html", document.as_bytes())?;
            Ok(ClipboardSource {
                path,
                kind: "html".to_string(),
                format: format.to_string(),
                bytes: document.len(),
                width: None,
                height: None,
                chars: Some(fragment.chars().count()),
                source_url,
                files: None,
            })
        }
        _ => {
            let text = utf16_payload(&raw);
            if text.trim().is_empty() {
                return Err("The clipboard holds no text".to_string());
            }
            // UTF-8 with a BOM: measured to make no difference to the
            // converter for a multi-script payload, and it removes a codepage
            // guess for a Latin-1-only one.
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(text.as_bytes());
            let chars = text.chars().count();
            let path = write_scratch("txt", &bytes)?;
            Ok(ClipboardSource {
                path,
                kind: "text".to_string(),
                format: format.to_string(),
                bytes: bytes.len(),
                width: None,
                height: None,
                chars: Some(chars),
                source_url: None,
                files: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{dib_dimensions, parse_cf_html, utf16_payload};

    #[test]
    fn a_dib_height_that_cannot_be_made_positive_is_refused() {
        let mut header = [0u8; 40];
        header[4..8].copy_from_slice(&1i32.to_le_bytes());
        header[8..12].copy_from_slice(&i32::MIN.to_le_bytes());
        assert!(dib_dimensions(&header).is_err());

        header[8..12].copy_from_slice(&(-12i32).to_le_bytes());
        assert_eq!(dib_dimensions(&header).unwrap(), (1, 12));
    }

    fn cf_html(fragment: &str, source: Option<&str>) -> String {
        // Build the payload the way a browser does: fixed-width offsets
        // computed over the finished bytes.
        let mut header =
            String::from("Version:0.9\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n");
        if let Some(url) = source {
            header.push_str(&format!("SourceURL:{url}\r\n"));
        }
        let body =
            format!("<html><body><!--StartFragment-->{fragment}<!--EndFragment--></body></html>");
        let start = header.len() + body.find(fragment).unwrap();
        let end = start + fragment.len();
        let header = header
            .replace(
                "StartFragment:0000000000",
                &format!("StartFragment:{start:010}"),
            )
            .replace("EndFragment:0000000000", &format!("EndFragment:{end:010}"));
        format!("{header}{body}")
    }

    #[test]
    fn fragment_comes_from_the_declared_offsets() {
        let payload = cf_html("<p>hello</p>", None);
        let (fragment, url) = parse_cf_html(payload.as_bytes());
        assert_eq!(fragment, "<p>hello</p>");
        assert!(url.is_none());
    }

    #[test]
    fn invalid_utf8_before_a_fragment_does_not_shift_cf_html_offsets() {
        let mut body = b"<html><body>prefix".to_vec();
        body.push(0xFF);
        body.extend_from_slice(
            b"<!--StartFragment--><p>captured</p><!--EndFragment--></body></html>",
        );
        let start_marker = b"<!--StartFragment-->";
        let start = "Version:0.9\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n".len()
            + body
                .windows(start_marker.len())
                .position(|window| window == start_marker)
                .unwrap()
            + start_marker.len();
        let end = start + b"<p>captured</p>".len();
        let header = "Version:0.9\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n"
            .replace(
                "StartFragment:0000000000",
                &format!("StartFragment:{start:010}"),
            )
            .replace("EndFragment:0000000000", &format!("EndFragment:{end:010}"));
        let mut raw = header.into_bytes();
        raw.extend_from_slice(&body);

        let (fragment, _) = parse_cf_html(&raw);
        assert_eq!(fragment, "<p>captured</p>");
    }

    #[test]
    fn source_url_survives_its_own_colons() {
        let payload = cf_html("<b>x</b>", Some("https://example.test:8443/a/b?q=1"));
        let (_, url) = parse_cf_html(payload.as_bytes());
        assert_eq!(url.as_deref(), Some("https://example.test:8443/a/b?q=1"));
    }

    #[test]
    fn about_blank_is_not_a_source_url() {
        let payload = cf_html("<b>x</b>", Some("about:blank"));
        let (_, url) = parse_cf_html(payload.as_bytes());
        assert!(url.is_none());
    }

    #[test]
    fn unusable_offsets_fall_back_to_the_body() {
        // Offsets past the end of the payload: the fragment is still there.
        let payload = "Version:0.9\r\nStartFragment:9999999\r\nEndFragment:9999999\r\n\
                       <p>fallback</p>";
        let (fragment, _) = parse_cf_html(payload.as_bytes());
        assert_eq!(fragment, "<p>fallback</p>");
    }

    #[test]
    fn utf16_stops_at_the_terminator() {
        let mut bytes = Vec::new();
        for unit in "héllo".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0x41u16.to_le_bytes());
        assert_eq!(utf16_payload(&bytes), "héllo");
    }
}
