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

use std::path::PathBuf;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use windows::core::w;
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};

/// Attempts to take the clipboard, matching the write side: another
/// application can hold it for a few milliseconds at a time.
const OPEN_ATTEMPTS: u32 = 12;
const OPEN_RETRY: Duration = Duration::from_millis(25);

/// A `BITMAPINFOHEADER` is 40 bytes; a shorter body is not a DIB.
const DIB_HEADER_BYTES: usize = 40;

/// Scratch files older than this are removed when a new one is written. A
/// clipboard source is consumed within one dialog session, so anything from a
/// previous run is abandoned by construction.
const SCRATCH_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Serialize)]
pub struct ClipboardSource {
    /// The scratch file written. Its extension is one Create PDF accepts.
    pub path: String,
    /// `image` | `html` | `text` — what the caller shows, not what converts
    /// it (the engine decides that from the extension, as it does for a
    /// picked file).
    pub kind: String,
    /// The clipboard format the payload came from, for the report line.
    pub format: String,
    pub bytes: usize,
    /// Present for `CF_DIB` only: read out of the DIB's own header, so the
    /// caller reports the size the clipboard actually holds.
    pub width: Option<i32>,
    pub height: Option<i32>,
    /// Present for text and HTML: the character count of the payload.
    pub chars: Option<usize>,
    /// `CF_HTML`'s `SourceURL`, recorded for the report. NEVER fetched and
    /// never used as a base href — a relative reference in a fragment
    /// resolves to nothing, which is the offline posture being correct
    /// rather than convenient.
    pub source_url: Option<String>,
}

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
    Err(format!("Another application is holding the clipboard: {last}"))
}

/// Copy one format's payload out of the open clipboard.
///
/// The handle belongs to the clipboard and is never freed here. `GlobalSize`
/// bounds the copy: a clipboard block carries no length of its own.
fn read_format(format: u32) -> Option<Vec<u8>> {
    if format == 0 || unsafe { IsClipboardFormatAvailable(format) }.is_err() {
        return None;
    }
    let handle = unsafe { GetClipboardData(format) }.ok()?;
    let block = HGLOBAL(handle.0);
    let size = unsafe { GlobalSize(block) };
    if size == 0 {
        return None;
    }
    let ptr = unsafe { GlobalLock(block) };
    if ptr.is_null() {
        return None;
    }
    let mut out = vec![0u8; size];
    unsafe {
        std::ptr::copy_nonoverlapping(ptr as *const u8, out.as_mut_ptr(), size);
        // GlobalUnlock reports failure when the lock count reaches zero,
        // which is the expected outcome here.
        let _ = GlobalUnlock(block);
    }
    Some(out)
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

/// `StartFragment`/`EndFragment` are byte offsets into the WHOLE `CF_HTML`
/// payload. Returns the fragment, plus `SourceURL` when the header names one.
///
/// A header that does not carry usable offsets falls back to everything after
/// the header block (the first blank-line-free run of `Key:Value` lines),
/// because a fragment we cannot locate is still a fragment we can convert.
pub fn parse_cf_html(payload: &str) -> (String, Option<String>) {
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
    for line in payload.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
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

    let bytes = payload.as_bytes();
    if let (Some(s), Some(e)) = (start, end) {
        if s < e && e <= bytes.len() {
            // Offsets are byte offsets and may land mid-character on a
            // malformed writer; lossy rather than refusing the paste.
            return (
                String::from_utf8_lossy(&bytes[s..e]).into_owned(),
                source_url,
            );
        }
    }
    let tail = payload.get(header_end..).unwrap_or("").trim();
    (tail.to_string(), source_url)
}

/// Wrap a fragment as a standalone document. No base href, deliberately (see
/// `source_url`), and an explicit charset so the converter never guesses.
fn html_document(fragment: &str) -> String {
    if fragment.to_ascii_lowercase().contains("<html") {
        return fragment.to_string();
    }
    format!(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"></head>\n\
         <body>\n{fragment}\n</body></html>\n"
    )
}

fn scratch_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("spectrapdf").join("clipboard");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create the clipboard scratch folder: {e}"))?;
    Ok(dir)
}

fn prune(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|age| age > SCRATCH_MAX_AGE).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn write_scratch(extension: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = scratch_dir()?;
    prune(&dir);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for n in 0..1_000u32 {
        let candidate = dir.join(format!("clipboard-{stamp}-{n}.{extension}"));
        if !candidate.exists() {
            std::fs::write(&candidate, bytes)
                .map_err(|e| format!("Could not write the clipboard file: {e}"))?;
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err("could not allocate a clipboard scratch file".to_string())
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
    let picked = (|| {
        if let Some(bytes) = read_format(png_format) {
            return Some(("png", "PNG", bytes));
        }
        if let Some(bytes) = read_format(CF_DIB.0 as u32) {
            return Some(("dib", "CF_DIB", bytes));
        }
        if let Some(bytes) = read_format(html_format) {
            return Some(("html", "CF_HTML", bytes));
        }
        if let Some(bytes) = read_format(CF_UNICODETEXT.0 as u32) {
            return Some(("txt", "CF_UNICODETEXT", bytes));
        }
        None
    })();
    unsafe {
        let _ = CloseClipboard();
    }

    let Some((extension, format, raw)) = picked else {
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
            })
        }
        "dib" => {
            if raw.len() < DIB_HEADER_BYTES {
                return Err("The clipboard image is not a device-independent bitmap".to_string());
            }
            let width = i32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]);
            let height = i32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]);
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
            })
        }
        "html" => {
            // CF_HTML is defined as UTF-8 and its offsets are byte offsets
            // into that encoding.
            let payload = String::from_utf8_lossy(&raw);
            let (fragment, source_url) = parse_cf_html(&payload);
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
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{html_document, parse_cf_html, utf16_payload};

    fn cf_html(fragment: &str, source: Option<&str>) -> String {
        // Build the payload the way a browser does: fixed-width offsets
        // computed over the finished bytes.
        let mut header = String::from("Version:0.9\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n");
        if let Some(url) = source {
            header.push_str(&format!("SourceURL:{url}\r\n"));
        }
        let body = format!("<html><body><!--StartFragment-->{fragment}<!--EndFragment--></body></html>");
        let start = header.len() + body.find(fragment).unwrap();
        let end = start + fragment.len();
        let header = header
            .replace("StartFragment:0000000000", &format!("StartFragment:{start:010}"))
            .replace("EndFragment:0000000000", &format!("EndFragment:{end:010}"));
        format!("{header}{body}")
    }

    #[test]
    fn fragment_comes_from_the_declared_offsets() {
        let payload = cf_html("<p>hello</p>", None);
        let (fragment, url) = parse_cf_html(&payload);
        assert_eq!(fragment, "<p>hello</p>");
        assert!(url.is_none());
    }

    #[test]
    fn source_url_survives_its_own_colons() {
        let payload = cf_html("<b>x</b>", Some("https://example.test:8443/a/b?q=1"));
        let (_, url) = parse_cf_html(&payload);
        assert_eq!(url.as_deref(), Some("https://example.test:8443/a/b?q=1"));
    }

    #[test]
    fn about_blank_is_not_a_source_url() {
        let payload = cf_html("<b>x</b>", Some("about:blank"));
        let (_, url) = parse_cf_html(&payload);
        assert!(url.is_none());
    }

    #[test]
    fn unusable_offsets_fall_back_to_the_body() {
        // Offsets past the end of the payload: the fragment is still there.
        let payload = "Version:0.9\r\nStartFragment:9999999\r\nEndFragment:9999999\r\n\
                       <p>fallback</p>";
        let (fragment, _) = parse_cf_html(payload);
        assert_eq!(fragment, "<p>fallback</p>");
    }

    #[test]
    fn a_bare_fragment_is_wrapped_but_a_document_is_not() {
        assert!(html_document("<p>x</p>").contains("<meta charset=\"utf-8\">"));
        let whole = "<html><body>x</body></html>";
        assert_eq!(html_document(whole), whole);
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
