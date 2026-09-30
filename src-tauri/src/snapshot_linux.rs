//! The snapshot tool's clipboard write on Linux, through the toolkit's own
//! clipboard so one code path serves both a Wayland and an X11 session.
//!
//! The PNG half of the request body is decoded into a pixbuf and published
//! with `set_image`, which offers every image type the toolkit can encode;
//! the DIB half is a Windows format and is ignored. `store` hands the image
//! to a running clipboard manager so the copy outlives this process.
//!
//! The result is READ BACK from the clipboard, as on Windows: a caller learns
//! that the clipboard holds a W x H image, not that a call returned success.

use std::sync::mpsc;

use gtk::gdk_pixbuf::PixbufLoader;
use gtk::glib;
use gtk::prelude::*;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::Manager;

use crate::snapshot_save::{header_number, PNG_SIGNATURE};

#[derive(Serialize)]
pub struct ClipboardImage {
    pub width: i32,
    pub height: i32,
    pub formats: Vec<String>,
}

fn publish(png: Vec<u8>) -> Result<ClipboardImage, String> {
    let loader = PixbufLoader::with_type("png")
        .map_err(|e| format!("Could not decode the snapshot image: {e}"))?;
    loader
        .write(&png)
        .and_then(|()| loader.close())
        .map_err(|e| format!("Could not decode the snapshot image: {e}"))?;
    let pixbuf = loader
        .pixbuf()
        .ok_or_else(|| "Could not decode the snapshot image".to_string())?;

    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard.set_image(&pixbuf);
    clipboard.store();

    let held = clipboard
        .wait_for_image()
        .ok_or_else(|| "The clipboard did not keep the snapshot image".to_string())?;
    let formats = clipboard
        .wait_for_targets()
        .unwrap_or_default()
        .iter()
        .map(|target| target.name().to_string())
        .collect();
    Ok(ClipboardImage { width: held.width(), height: held.height(), formats })
}

/// Put a captured page region on the clipboard as an image.
///
/// Body: the PNG bytes followed by the DIB bytes; `snapshot-png-length` says
/// where the split is.
#[tauri::command]
pub fn copy_image_to_clipboard(
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<ClipboardImage, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("snapshot image must be sent as a raw body".to_string()),
    };
    let png_length = header_number(&request, "snapshot-png-length")?;
    if png_length > body.len() {
        return Err("snapshot body is shorter than its declared PNG length".to_string());
    }
    let png = body[..png_length].to_vec();
    if png.len() < PNG_SIGNATURE.len() || png[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err("snapshot body carries no PNG image".to_string());
    }

    if glib::MainContext::default().is_owner() {
        return publish(png);
    }
    let (tx, rx) = mpsc::channel();
    window
        .app_handle()
        .run_on_main_thread(move || {
            let _ = tx.send(publish(png));
        })
        .map_err(|e| format!("Could not reach the clipboard: {e}"))?;
    rx.recv()
        .map_err(|_| "The clipboard write did not complete".to_string())?
}

/// Write the captured PNG to a path the user chose in the save dialog.
#[tauri::command]
pub fn save_snapshot_png(request: Request<'_>) -> Result<String, String> {
    crate::snapshot_save::save(&request)
}
