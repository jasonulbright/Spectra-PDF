//! The snapshot tool off Windows. No backend yet: both commands refuse by
//! name, and `platform_capabilities` reports `snapshot` false so the renderer
//! offers no entry.

use tauri::ipc::Request;

use crate::platform::{feature, Unsupported};

/// Uninhabited: no clipboard image exists to return.
#[derive(serde::Serialize)]
pub enum ClipboardImage {}

#[tauri::command]
pub fn copy_image_to_clipboard(
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<ClipboardImage, String> {
    let _ = (window, request);
    Err(Unsupported::new(feature::SNAPSHOT).into())
}

#[tauri::command]
pub fn save_snapshot_png(request: Request<'_>) -> Result<String, String> {
    let _ = request;
    Err(Unsupported::new(feature::SNAPSHOT).into())
}
