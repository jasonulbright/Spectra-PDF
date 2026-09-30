//! Scanning off Windows. No backend yet: every command refuses by name, and
//! `platform_capabilities` reports `scanning` false so the renderer offers no
//! scan entry. The command names and arguments match the Windows module so
//! the invoke surface is the same on every platform.

use crate::platform::{feature, Unsupported};

/// Uninhabited: no scan result, device list or capability report exists.
#[derive(serde::Serialize)]
pub enum Unavailable {}

#[derive(Default)]
pub struct ScannerSessions;

impl ScannerSessions {
    pub fn new() -> Self {
        Self
    }
}

fn refusal<T>() -> Result<T, String> {
    Err(Unsupported::new(feature::SCANNING).into())
}

#[tauri::command]
pub async fn list_scanners(last_used: Option<String>) -> Result<Unavailable, String> {
    let _ = last_used;
    refusal()
}

#[tauri::command]
pub async fn scanner_capabilities(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<Unavailable, String> {
    let _ = (sessions, device_id);
    refusal()
}

#[tauri::command]
pub async fn scanner_close(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<(), String> {
    let _ = (sessions, device_id);
    refusal()
}

#[tauri::command]
pub async fn scan_acquire(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
    settings: serde_json::Value,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<Unavailable, String> {
    let _ = (sessions, device_id, settings, on_event);
    refusal()
}

#[tauri::command]
pub async fn scan_cancel(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<(), String> {
    let _ = (sessions, device_id);
    refusal()
}

#[tauri::command]
pub async fn scan_discard(scratch: String) -> Result<(), String> {
    let _ = scratch;
    refusal()
}

#[tauri::command]
pub async fn scanner_select_dialog(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let _ = window;
    refusal()
}
