use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// Manages the Python JSON-RPC engine sidecar process.
pub struct EngineState {
    pub child: Arc<Mutex<Option<CommandChild>>>,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }
}

/// Resolves the path to the Python engine startup script.
pub fn get_engine_script_path(app: &AppHandle) -> String {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    resource_dir
        .join("engine")
        .join("__startup__.py")
        .to_string_lossy()
        .to_string()
}

/// Resolves the path to the embedded Python executable.
pub fn get_python_path(app: &AppHandle) -> String {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    resource_dir
        .join("python")
        .join("python.exe")
        .to_string_lossy()
        .to_string()
}

/// Resolves the path to the bundled Ghostscript executable.
pub fn get_gs_path(app: &AppHandle) -> String {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    resource_dir
        .join("ghostscript")
        .join("gswin64c.exe")
        .to_string_lossy()
        .to_string()
}

/// The bundled fallback font for Edit ▸ Text's convert-to-compatible-font
/// The bundled fallback-font DIRECTORY (7.4 + 9.B1): the vendored
/// Liberation family (Sans/Serif/Mono, OFL) lives in resources/fonts,
/// same class as the gs/python runtimes. Returns the DIR — the engine
/// (font_fallback.resolve_fallback_font) picks the face matching the
/// run's own font so a serif document's converted text stays serif.
pub fn get_edit_font_path(app: &AppHandle) -> String {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    resource_dir
        .join("fonts")
        .to_string_lossy()
        .to_string()
}

/// Resolves LibreOffice's `soffice` for O1 export. Prefers the vendored copy
/// (resources/libreoffice, assembled by a setup script and gitignored like the
/// gs / python runtimes) and falls back to a standard system install, so a dev
/// build without the bundle still exports. "" when none is found — the engine
/// then refuses the export with a clear message rather than crashing.
pub fn get_soffice_path(app: &AppHandle) -> String {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir
            .join("libreoffice")
            .join("program")
            .join("soffice.exe");
        if bundled.is_file() {
            return bundled.to_string_lossy().to_string();
        }
    }
    crate::cli::soffice_system_fallback()
}

/// Starts the Python engine sidecar and wires stdout to the webview.
/// Idempotent — if the engine is already running, returns immediately.
pub async fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();

    // Already running — don't spawn another
    {
        let guard = state.child.lock().await;
        if guard.is_some() {
            return Ok(());
        }
    }

    let python_path = get_python_path(app);
    let script_path = get_engine_script_path(app);

    let shell = app.shell();
    let (mut rx, child) = shell
        .command(&python_path)
        .args([&script_path])
        // The JSON-RPC channel is UTF-8 by contract; without this an embedded
        // Python on Windows decodes stdin as cp1252 and mojibakes every
        // non-ASCII value (the engine also reconfigures its own stdio — this
        // is the spawner half of the fix).
        .env("PYTHONUTF8", "1")
        .spawn()
        .map_err(|e| format!("Failed to start engine: {}", e))?;

    // Store the child process handle
    *state.child.lock().await = Some(child);

    // Forward stdout lines to the webview as engine:response events
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim();
                    if !trimmed.is_empty() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.emit("engine:response", json);
                            }
                        }
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    let msg = String::from_utf8_lossy(&line);
                    let trimmed = msg.trim();
                    if !trimmed.is_empty() {
                        eprintln!("[engine] {}", trimmed);
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                    eprintln!("[engine] exited with {:?}", status);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}
