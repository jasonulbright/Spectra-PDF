//! Reading the clipboard as a document source off Windows. No backend yet:
//! both commands refuse by name, and `platform_capabilities` reports
//! `clipboardRead` false so the renderer offers no entry.

use crate::platform::{feature, Unsupported};

/// Uninhabited: no clipboard source exists to return.
#[derive(serde::Serialize)]
pub enum ClipboardSource {}

#[tauri::command]
pub fn discard_clipboard_source(path: String) -> Result<(), String> {
    let _ = path;
    Err(Unsupported::new(feature::CLIPBOARD_READ).into())
}

#[tauri::command]
pub fn read_clipboard_source() -> Result<ClipboardSource, String> {
    Err(Unsupported::new(feature::CLIPBOARD_READ).into())
}
