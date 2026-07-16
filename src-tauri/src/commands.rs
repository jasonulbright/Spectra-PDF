use crate::engine::{self, EngineState};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

// ── Path canonicalization (M7 — the path-identity gate) ──────────────────
//
// File identity is the raw path STRING app-wide (`state.files` is keyed on
// it; tabs/recents/PageRef.sourceDocId take string equality), and Windows
// hands the same file over as several spellings — case, slash direction,
// 8.3 short names, mapped drives. The fix is ONE rule: every path
// canonicalizes at the Rust boundary before the renderer ever sees it, so
// string identity IS identity for every existing consumer. `dunce` because
// std's canonicalize returns \\?\-prefixed verbatim paths on Windows, which
// would leak into titles and recents.

pub(crate) fn canonical_path(p: &str) -> String {
    dunce::canonicalize(p)
        .map(|pb| pb.to_string_lossy().to_string())
        // A path that doesn't resolve (not-yet-created Save As target, race)
        // passes through untouched — refusing here would break flows that
        // legitimately name new files.
        .unwrap_or_else(|_| p.to_string())
}

/// Renderer-callable form, for paths that arrive THROUGH the webview (file
/// drops) rather than from a Rust producer.
#[tauri::command]
pub async fn canonicalize_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    Ok(paths.iter().map(|p| canonical_path(p)).collect())
}

// ── File dialogs ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_files_dialog(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    // Parenting makes the native dialog modal to the app window — without it
    // the main window stays interactive and can stack dialogs.
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF Files", &["pdf", "pdfx"])
        .blocking_pick_files();

    match result {
        Some(paths) => {
            let mut out = Vec::new();
            for p in paths {
                if let Ok(pb) = p.into_path() {
                    out.push(canonical_path(&pb.to_string_lossy()));
                }
            }
            Ok(out)
        }
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn save_file_dialog(
    app: AppHandle,
    window: tauri::WebviewWindow,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF Files", &["pdf", "pdfx"]);
    if let Some(ref path) = default_path {
        builder = builder.set_file_name(path);
    }
    let result = builder.blocking_save_file();
    match result {
        Some(path) => match path.into_path() {
            // An EXISTING target canonicalizes (overwrite flows can be
            // reopened later under the same spelling); a brand-new file
            // fails to resolve and passes through as the dialog spelled it.
            Ok(pb) => Ok(Some(canonical_path(&pb.to_string_lossy()))),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick a PKCS#12 signer file (.pfx/.p12) for signing. Separate from the PDF
/// picker (different filter); window-parented for the same modality reason.
#[tauri::command]
pub async fn pick_certificate_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PKCS#12 signer", &["pfx", "p12"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick a PEM/DER signer component (private key or certificate) — the PEM
/// signer source's two file inputs. Loose filter: key/cert files wear many
/// extensions in the wild, so "all files" stays one click away.
#[tauri::command]
pub async fn pick_pem_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PEM/DER key or certificate", &["pem", "key", "crt", "cer", "der"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

// ── File operations ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_file_buffer(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| format!("Failed to read {}: {}", file_path, e))
}

#[tauri::command]
pub async fn create_working_copy(file_path: String) -> Result<String, String> {
    let work_dir = std::env::temp_dir()
        .join("openpdfstudio")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let filename = Path::new(&file_path)
        .file_name()
        .ok_or("Invalid filename")?;
    let dest = work_dir.join(filename);
    fs::copy(&file_path, &dest)
        .map_err(|e| format!("Failed to copy: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn snapshot(working_path: String) -> Result<String, String> {
    let path = Path::new(&working_path);
    let dir = path.parent().ok_or("Invalid path")?;
    let stem = path.file_stem().ok_or("Invalid filename")?.to_string_lossy();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let snap_path = dir.join(format!("{}_snap_{}{}", stem, timestamp, ext));

    fs::copy(&working_path, &snap_path)
        .map_err(|e| format!("Failed to snapshot: {}", e))?;

    Ok(snap_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn restore_snapshot(
    working_path: String,
    snapshot_path: String,
) -> Result<(), String> {
    fs::copy(&snapshot_path, &working_path)
        .map_err(|e| format!("Failed to restore: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn save_as(working_path: String, dest_path: String) -> Result<(), String> {
    fs::copy(&working_path, &dest_path)
        .map_err(|e| format!("Failed to save: {}", e))?;
    Ok(())
}

// ── App info ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_gs_path(app: AppHandle) -> Result<String, String> {
    Ok(engine::get_gs_path(&app))
}

#[tauri::command]
pub async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

// ── Ghostscript detection ────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct GsInfo {
    pub path: String,
    pub version: String,
    pub product: String,
    pub vendor: String,
}

/// Query the bundled GS info (version from --version).
#[tauri::command]
pub async fn get_bundled_gs_info(app: AppHandle) -> Result<GsInfo, String> {
    let path = engine::get_gs_path(&app);
    let version = run_gs_version(&path)?;
    Ok(GsInfo {
        path,
        version,
        product: "GPL Ghostscript".to_string(),
        vendor: "Artifex Software".to_string(),
    })
}

/// Detect external Ghostscript from ARP registry. Returns None if not found.
#[tauri::command]
pub async fn detect_external_gs() -> Result<Option<GsInfo>, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let uninstall_paths = [
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];

    for uninstall_path in &uninstall_paths {
        let Ok(key) = hklm.open_subkey_with_flags(uninstall_path, KEY_READ) else {
            continue;
        };
        for name in key.enum_keys().flatten() {
            if !name.to_lowercase().contains("ghostscript") {
                continue;
            }
            let Ok(subkey) = key.open_subkey_with_flags(&name, KEY_READ) else {
                continue;
            };
            let display_name: String = subkey
                .get_value("DisplayName")
                .unwrap_or_default();
            let mut install_location: String = subkey
                .get_value("InstallLocation")
                .unwrap_or_default();
            let display_version: String = subkey
                .get_value("DisplayVersion")
                .unwrap_or_default();
            let publisher: String = subkey
                .get_value("Publisher")
                .unwrap_or_default();

            // Fallback: parse install dir from UninstallString if InstallLocation is empty
            if install_location.is_empty() {
                let uninstall_str: String = subkey
                    .get_value("UninstallString")
                    .unwrap_or_default();
                if !uninstall_str.is_empty() {
                    let clean = uninstall_str.trim_matches('"');
                    if let Some(parent) = std::path::Path::new(clean).parent() {
                        install_location = parent.to_string_lossy().to_string();
                    }
                }
            }

            if install_location.is_empty() {
                continue;
            }

            // Find the console exe
            let install_path = std::path::Path::new(&install_location);
            let exe = install_path.join("bin").join("gswin64c.exe");
            if !exe.exists() {
                // Try gswin32c.exe
                let exe32 = install_path.join("bin").join("gswin32c.exe");
                if !exe32.exists() {
                    continue;
                }
                let version = run_gs_version(&exe32.to_string_lossy()).unwrap_or(display_version);
                return Ok(Some(GsInfo {
                    path: exe32.to_string_lossy().to_string(),
                    version,
                    product: display_name,
                    vendor: if publisher.is_empty() { "Artifex Software".to_string() } else { publisher },
                }));
            }

            let version = run_gs_version(&exe.to_string_lossy()).unwrap_or(display_version);
            return Ok(Some(GsInfo {
                path: exe.to_string_lossy().to_string(),
                version,
                product: display_name,
                vendor: if publisher.is_empty() { "Artifex Software".to_string() } else { publisher },
            }));
        }
    }

    Ok(None)
}

fn run_gs_version(exe_path: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new(exe_path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run GS: {}", e))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        Err("Empty version output".to_string())
    } else {
        Ok(version)
    }
}

// ── Printers ─────────────────────────────────────────────────────────────

/// Installed Windows printers + the default — the Print dialog's picker.
#[tauri::command]
pub async fn list_printers() -> Result<crate::printers::PrinterList, String> {
    crate::printers::enumerate()
}

// ── System accent color ──────────────────────────────────────────────────

/// Windows accent color as "#RRGGBB".
///
/// Primary source is WinRT `UISettings` — the documented accent API, which
/// works in unpackaged Win32 processes and needs no user customization to
/// exist. The DWM registry value is kept as fallback; it is only written
/// once a profile customizes its colors, so it can be absent on stock
/// machines.
#[tauri::command]
pub async fn get_system_accent_color() -> Result<Option<String>, String> {
    Ok(accent_from_uisettings().or_else(accent_from_registry))
}

fn accent_from_uisettings() -> Option<String> {
    use windows::UI::ViewManagement::{UIColorType, UISettings};
    let ui = UISettings::new().ok()?;
    let c = ui.GetColorValue(UIColorType::Accent).ok()?;
    Some(format!("#{:02X}{:02X}{:02X}", c.R, c.G, c.B))
}

fn accent_from_registry() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags("SOFTWARE\\Microsoft\\Windows\\DWM", KEY_READ)
        .ok()?;
    let abgr: u32 = key.get_value("AccentColor").ok()?;
    // Registry stores ABGR, convert to RGB
    let r = abgr & 0xFF;
    let g = (abgr >> 8) & 0xFF;
    let b = (abgr >> 16) & 0xFF;
    Some(format!("#{:02X}{:02X}{:02X}", r, g, b))
}

// ── Window backdrop ──────────────────────────────────────────────────────

/// Which backdrop setup applied to the main window ("mica" or "none").
/// The renderer stamps this on <html data-backdrop> before first paint and
/// keys translucent shell styling on it.
#[tauri::command]
pub async fn get_window_backdrop(
    state: tauri::State<'_, crate::BackdropState>,
) -> Result<String, String> {
    Ok(state.0.to_string())
}

// ── Operation log ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn append_operation_log(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let app_data = app.path().app_data_dir().map_err(|e| format!("{}", e))?;
    fs::create_dir_all(&app_data).ok();
    let log_path = app_data.join("operations.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log: {}", e))?;
    writeln!(f, "{}", line).map_err(|e| format!("Failed to write log: {}", e))?;
    Ok(())
}

// ── Engine (Python sidecar) ───────────────────────────────────────────────

#[tauri::command]
pub async fn start_engine(app: AppHandle) -> Result<(), String> {
    engine::start(&app).await
}

#[tauri::command]
pub async fn send_to_engine(
    app: AppHandle,
    request: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut guard = state.child.lock().await;
    if let Some(ref mut child) = *guard {
        let msg = serde_json::to_string(&request)
            .map_err(|e| format!("Serialize error: {}", e))?;
        child
            .write((msg + "\n").as_bytes())
            .map_err(|e| format!("Failed to write to engine: {}", e))?;
        Ok(())
    } else {
        Err("Engine not running".to_string())
    }
}

// ── Window lifecycle ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn confirm_close(app: AppHandle) -> Result<(), String> {
    // Set the quitting flag so ExitRequested handler allows exit
    crate::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.destroy();
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    Ok(())
}

// ── Startup config (Rust-readable settings for pre-window decisions) ─────

/// Write start-minimized preference to a JSON file that Rust reads before
/// showing the window. This avoids the flash caused by renderer-side hide.
#[tauri::command]
pub async fn set_start_minimized(app: AppHandle, enabled: bool) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| format!("{}", e))?;
    fs::create_dir_all(&app_data).ok();
    let config_path = app_data.join("startup.json");
    let json = serde_json::json!({ "startMinimized": enabled });
    fs::write(&config_path, json.to_string())
        .map_err(|e| format!("Failed to write startup config: {}", e))?;
    Ok(())
}

/// Read start-minimized from the config file. Used by lib.rs setup().
pub fn read_start_minimized(app: &tauri::App) -> bool {
    let Ok(app_data) = app.path().app_data_dir() else {
        return false;
    };
    let config_path = app_data.join("startup.json");
    let Ok(contents) = fs::read_to_string(&config_path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    json.get("startMinimized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

// ── Enterprise policy ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_auto_update_disabled() -> Result<bool, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    match hklm.open_subkey("SOFTWARE\\Open PDF Studio") {
        Ok(key) => {
            let value: Result<u32, _> = key.get_value("DisableAutoUpdate");
            Ok(value.unwrap_or(0) == 1)
        }
        Err(_) => Ok(false),
    }
}

// ── Startup (Start with Windows) ─────────────────────────────────────────

const STARTUP_REG_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_REG_VALUE: &str = "OpenPDFStudio";

/// Read the current state of the "Start with Windows" registry entry.
/// Returns (enabled, minimized) — minimized is true if the --minimized flag is present.
#[tauri::command]
pub async fn get_startup_enabled() -> Result<(bool, bool), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey_with_flags(STARTUP_REG_KEY, KEY_READ) else {
        return Ok((false, false));
    };
    let value: Result<String, _> = key.get_value(STARTUP_REG_VALUE);
    match value {
        Ok(val) => {
            let minimized = val.contains("--minimized");
            Ok((true, minimized))
        }
        Err(_) => Ok((false, false)),
    }
}

/// Set or remove the "Start with Windows" registry entry.
/// When start_minimized is true, appends --minimized to the command.
#[tauri::command]
pub async fn set_startup_enabled(
    enabled: bool,
    start_minimized: bool,
) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(STARTUP_REG_KEY, KEY_WRITE)
        .map_err(|e| format!("Failed to open Run key: {}", e))?;

    if enabled {
        // Get the current exe path
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?;
        let mut value = format!("\"{}\"", exe_path.to_string_lossy());
        if start_minimized {
            value.push_str(" --minimized");
        }
        key.set_value(STARTUP_REG_VALUE, &value)
            .map_err(|e| format!("Failed to set startup entry: {}", e))?;
    } else {
        // Remove the entry (ignore error if it doesn't exist)
        let _ = key.delete_value(STARTUP_REG_VALUE);
    }

    Ok(())
}
