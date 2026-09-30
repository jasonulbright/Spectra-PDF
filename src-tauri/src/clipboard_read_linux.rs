//! The clipboard READ side on Linux, through the toolkit's own clipboard so
//! one code path serves both a Wayland and an X11 session.
//!
//! Wayland sends selection offers only to the client that holds keyboard
//! focus: an unfocused window reads an empty clipboard, which is a different
//! answer from "the clipboard holds nothing usable". The read therefore
//! refuses by name when the window is not focused on Wayland.
//!
//! Priority: `image/png` (or any image the toolkit can decode, re-encoded to
//! PNG), `text/uri-list` (copied files), `text/html`, plain text. Image
//! before HTML for the reason the Windows reader gives: a copied picture also
//! offers an `<img src="https://…">` flavour, which the hardened converter
//! refuses.

use std::path::Path;
use std::sync::mpsc;

use gtk::gdk;
use gtk::glib;
use tauri::{Manager, WebviewWindow};

use crate::clipboard_scratch::{
    checked_clipboard_size, discard_scratch_at, html_document, scratch_dir, write_scratch,
    ClipboardSource, MAX_CLIPBOARD_IMAGE_BYTES, MAX_CLIPBOARD_TEXT_BYTES,
};

/// The refusal an unfocused Wayland read returns. The renderer shows it as
/// is; the button that starts a read is inside the focused window, so this
/// fires only when focus moved away during the request.
pub const UNFOCUSED_WAYLAND: &str =
    "The clipboard can be read only while the Spectra PDF window has focus";

enum Payload {
    Png(Vec<u8>, i32, i32),
    Files(Vec<String>),
    Html(Vec<u8>),
    Text(String),
}

fn is_wayland() -> bool {
    gdk::Display::default()
        .map(|display| glib::prelude::ObjectExt::type_(&display).name() == "GdkWaylandDisplay")
        .unwrap_or(false)
}

/// Runs `f` on the GTK main thread and waits for its result. A synchronous
/// command already runs there; calling `run_on_main_thread` from the main
/// thread and then blocking on the channel would deadlock.
fn on_main_thread<T: Send + 'static>(
    window: &WebviewWindow,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    if glib::MainContext::default().is_owner() {
        return Ok(f());
    }
    let (tx, rx) = mpsc::channel();
    window
        .app_handle()
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("Could not reach the clipboard: {e}"))?;
    rx.recv()
        .map_err(|_| "The clipboard read did not complete".to_string())
}

fn atom(name: &str) -> gdk::Atom {
    gdk::Atom::intern(name)
}

/// The local paths named by a `text/uri-list` payload (RFC 2483): one URI per
/// line, `#` lines are comments. Only `file:` URIs naming an existing regular
/// file that Create PDF accepts are kept, the same filter the source picker
/// applies; a remote URI is never fetched.
pub fn local_files_from_uri_list(payload: &str) -> Vec<String> {
    payload
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| url::Url::parse(line).ok())
        .filter(|uri| uri.scheme() == "file")
        .filter(|uri| uri.host_str().is_none_or(|h| h.is_empty() || h == "localhost"))
        .filter_map(|uri| uri.to_file_path().ok())
        .filter(|path| path.is_file() && crate::create_pdf_sources::accepts(path))
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// A `text/html` payload as text. Browsers write UTF-8; some toolkits write
/// UTF-16 with a byte-order mark.
pub fn html_payload(bytes: &[u8]) -> String {
    let utf16 = |bytes: &[u8], le: bool| {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .take_while(|&u| u != 0)
            .collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xFF, 0xFE, rest @ ..] => utf16(rest, true),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, false),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => String::from_utf8_lossy(bytes).trim_end_matches('\0').to_string(),
    }
}

fn read_payload() -> Result<Option<Payload>, String> {
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    let targets = clipboard.wait_for_targets().unwrap_or_default();
    let offers = |name: &str| targets.iter().any(|t| t.name() == name);

    if offers("image/png") {
        if let Some(data) = clipboard.wait_for_contents(&atom("image/png")) {
            let bytes = data.data();
            checked_clipboard_size(bytes.len(), MAX_CLIPBOARD_IMAGE_BYTES, "image")?;
            if !bytes.is_empty() {
                let (width, height) = png_dimensions(&bytes).unwrap_or((0, 0));
                return Ok(Some(Payload::Png(bytes, width, height)));
            }
        }
    }
    if clipboard.wait_is_image_available() {
        if let Some(pixbuf) = clipboard.wait_for_image() {
            let bytes = pixbuf
                .save_to_bufferv("png", &[])
                .map_err(|e| format!("Could not encode the clipboard image: {e}"))?;
            checked_clipboard_size(bytes.len(), MAX_CLIPBOARD_IMAGE_BYTES, "image")?;
            return Ok(Some(Payload::Png(bytes, pixbuf.width(), pixbuf.height())));
        }
    }
    if offers("text/uri-list") {
        if let Some(data) = clipboard.wait_for_contents(&atom("text/uri-list")) {
            let bytes = data.data();
            checked_clipboard_size(bytes.len(), MAX_CLIPBOARD_TEXT_BYTES, "file list")?;
            let files = local_files_from_uri_list(&String::from_utf8_lossy(&bytes));
            if !files.is_empty() {
                return Ok(Some(Payload::Files(files)));
            }
        }
    }
    if offers("text/html") {
        if let Some(data) = clipboard.wait_for_contents(&atom("text/html")) {
            let bytes = data.data();
            checked_clipboard_size(bytes.len(), MAX_CLIPBOARD_TEXT_BYTES, "HTML")?;
            if !bytes.is_empty() {
                return Ok(Some(Payload::Html(bytes)));
            }
        }
    }
    if let Some(text) = clipboard.wait_for_text() {
        checked_clipboard_size(text.len(), MAX_CLIPBOARD_TEXT_BYTES, "text")?;
        return Ok(Some(Payload::Text(text.to_string())));
    }
    Ok(None)
}

/// Width and height from a PNG's `IHDR`, which the format fixes as the first
/// chunk.
pub fn png_dimensions(bytes: &[u8]) -> Option<(i32, i32)> {
    if bytes.len() < 24 || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = i32::try_from(u32::from_be_bytes(bytes[16..20].try_into().ok()?)).ok()?;
    let height = i32::try_from(u32::from_be_bytes(bytes[20..24].try_into().ok()?)).ok()?;
    Some((width, height))
}

/// Remove a clipboard copy after its Create PDF dialog no longer needs it.
#[tauri::command]
pub fn discard_clipboard_source(path: String) -> Result<(), String> {
    let dir = scratch_dir()?;
    discard_scratch_at(&dir, Path::new(&path))
}

/// What the clipboard holds, as a file Create PDF accepts, or the copied
/// files themselves.
#[tauri::command]
pub fn read_clipboard_source(window: WebviewWindow) -> Result<ClipboardSource, String> {
    let focused = window.is_focused().unwrap_or(false);
    let payload = on_main_thread(&window, move || {
        if is_wayland() && !focused {
            return Err(UNFOCUSED_WAYLAND.to_string());
        }
        read_payload()
    })??;

    let Some(payload) = payload else {
        return Err(
            "The clipboard holds nothing Create PDF can use — copy an image, \
             formatted text or plain text first"
                .to_string(),
        );
    };

    match payload {
        Payload::Png(raw, width, height) => {
            let path = write_scratch("png", &raw)?;
            let known = width > 0 && height > 0;
            Ok(ClipboardSource {
                path,
                kind: "image".to_string(),
                format: "image/png".to_string(),
                bytes: raw.len(),
                width: known.then_some(width),
                height: known.then_some(height),
                chars: None,
                source_url: None,
                files: None,
            })
        }
        Payload::Files(files) => Ok(ClipboardSource {
            path: files[0].clone(),
            kind: "files".to_string(),
            format: "text/uri-list".to_string(),
            bytes: 0,
            width: None,
            height: None,
            chars: None,
            source_url: None,
            files: Some(files),
        }),
        Payload::Html(raw) => {
            let fragment = html_payload(&raw);
            if fragment.trim().is_empty() {
                return Err("The clipboard holds an empty HTML fragment".to_string());
            }
            let document = html_document(&fragment);
            let path = write_scratch("html", document.as_bytes())?;
            Ok(ClipboardSource {
                path,
                kind: "html".to_string(),
                format: "text/html".to_string(),
                bytes: document.len(),
                width: None,
                height: None,
                chars: Some(fragment.chars().count()),
                source_url: None,
                files: None,
            })
        }
        Payload::Text(text) => {
            if text.trim().is_empty() {
                return Err("The clipboard holds no text".to_string());
            }
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(text.as_bytes());
            let path = write_scratch("txt", &bytes)?;
            Ok(ClipboardSource {
                path,
                kind: "text".to_string(),
                format: "text/plain".to_string(),
                bytes: bytes.len(),
                width: None,
                height: None,
                chars: Some(text.chars().count()),
                source_url: None,
                files: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{html_payload, local_files_from_uri_list, png_dimensions};

    #[test]
    fn a_uri_list_keeps_only_existing_local_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a b.pdf");
        std::fs::write(&file, b"%PDF").unwrap();
        let archive = dir.path().join("kept-out.zip");
        std::fs::write(&archive, b"PK").unwrap();
        let uri = url::Url::from_file_path(&file).unwrap();
        let unaccepted = url::Url::from_file_path(&archive).unwrap();
        let list = format!(
            "# comment\r\n{uri}\r\n{unaccepted}\r\nhttps://example.invalid/x.pdf\r\nfile:///no/such/file\r\nfile://otherhost/x\r\n"
        );
        assert_eq!(
            local_files_from_uri_list(&list),
            vec![file.to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn html_payloads_decode_by_their_byte_order_mark() {
        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "<b>é</b>".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(html_payload(&utf16), "<b>é</b>");
        assert_eq!(html_payload("<i>x</i>\0".as_bytes()), "<i>x</i>");
    }

    #[test]
    fn png_dimensions_come_from_the_header_chunk() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((640, 480)));
        assert_eq!(png_dimensions(b"not a png"), None);
    }
}
