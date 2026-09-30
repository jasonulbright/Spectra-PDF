//! Web capture off Windows. No backend yet: both commands refuse by name, and
//! `platform_capabilities` reports `webCapture` false so the renderer offers
//! no entry.

use crate::platform::{feature, Unsupported};

/// Uninhabited: no capture result exists to return.
#[derive(serde::Serialize)]
pub enum CaptureResult {}

/// No capture window exists here, so no close can cancel one.
pub fn window_close_requested(_label: &str) {}

#[tauri::command]
pub fn discard_web_capture(capture_id: String) -> Result<(), String> {
    let _ = capture_id;
    Err(Unsupported::new(feature::WEB_CAPTURE).into())
}

#[tauri::command]
pub async fn capture_web_page(options: serde_json::Value) -> Result<CaptureResult, String> {
    let _ = options;
    Err(Unsupported::new(feature::WEB_CAPTURE).into())
}
