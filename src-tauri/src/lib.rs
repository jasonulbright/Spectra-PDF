pub mod cli;
mod commands;
mod engine;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};

/// When true, the app is exiting for real — don't prevent exit.
pub static QUITTING: AtomicBool = AtomicBool::new(false);

/// Which window backdrop setup actually applied ("mica" or "none"). The
/// renderer keys translucent styling on this and keeps today's solid look
/// otherwise.
pub struct BackdropState(pub &'static str);

/// Mica exists from Windows 11 (build 22000; window-vibrancy uses the
/// documented backdrop API from 22523 and a fallback attribute below it).
/// Windows 10 has no equivalent worth shipping — its acrylic path lags
/// window drags — so unsupported builds keep an ordinary opaque window.
fn backdrop_supported(build: u32) -> bool {
    build >= 22000
}

/// When true, the binary is running under end-to-end test control:
/// single-instance hijacking and tray-persistence are disabled so each WDIO
/// session gets a clean launch and exit. Enabled via the SPECTRAPDF_E2E
/// environment variable.
fn is_e2e_mode() -> bool {
    std::env::var("SPECTRAPDF_E2E").is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let e2e = is_e2e_mode();

    let mut builder = tauri::Builder::default()
        .manage(engine::EngineState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    if !e2e {
        builder = builder.plugin(
            tauri_plugin_single_instance::init(|app, argv, _cwd| {
                // Second instance launched — forward file args to existing window
                let files: Vec<String> = argv
                    .iter()
                    .skip(1)
                    .filter(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".pdf"))
                    .cloned()
                    .collect();
                let merge = argv.iter().any(|a| a == "--merge");

                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    if !files.is_empty() {
                        let payload = serde_json::json!({ "files": files, "merge": merge });
                        let _ = window.emit("app:openFile", payload);
                    }
                }
            }),
        );
    }

    let builder = builder
        .invoke_handler(tauri::generate_handler![
            commands::open_files_dialog,
            commands::save_file_dialog,
            commands::pick_certificate_file,
            commands::pick_pem_file,

            commands::read_file_buffer,
            commands::create_working_copy,
            commands::snapshot,
            commands::restore_snapshot,
            commands::save_as,
            commands::get_gs_path,
            commands::get_bundled_gs_info,
            commands::detect_external_gs,
            commands::get_app_version,
            commands::get_system_accent_color,
            commands::get_window_backdrop,
            commands::append_operation_log,
            commands::start_engine,
            commands::send_to_engine,
            commands::check_auto_update_disabled,
            commands::get_startup_enabled,
            commands::set_startup_enabled,
            commands::set_start_minimized,
            commands::confirm_close,
            commands::hide_to_tray,
        ])
        .setup(move |app| {
            // The main window is built here rather than in tauri.conf.json:
            // `transparent` is a creation-time property (tao's DWM
            // blur-behind region + wry's WebView2 background color) and is
            // only wanted where a backdrop can compose. Tauri's own
            // windowEffects/set_effects path discards the vibrancy Result,
            // so Mica is applied directly and the outcome recorded for the
            // renderer to key translucent styling on.
            let wants_backdrop =
                backdrop_supported(windows_version::OsVersion::current().build);
            let window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("Spectra PDF")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(800.0, 600.0)
                    .center()
                    .visible(false)
                    .transparent(wants_backdrop)
                    .build()?;
            let backdrop = if wants_backdrop && window_vibrancy::apply_mica(&window, None).is_ok()
            {
                "mica"
            } else {
                // A transparent window whose HTML paints opaque renders
                // identically to an opaque one, so a failed apply on a
                // supported build still degrades cleanly.
                "none"
            };
            app.manage(BackdropState(backdrop));

            if e2e {
                // E2E: skip tray + force-show window; every launch must be
                // self-contained and exit cleanly when the WDIO session ends.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return Ok(());
            }
            // Build system tray
            let show = MenuItem::with_id(app, "show", "Show Spectra PDF", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let merge = MenuItem::with_id(app, "merge", "Quick Merge", true, None::<&str>)?;
            let separator2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &separator, &merge, &separator2, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .tooltip("Spectra PDF")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "merge" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("app:trayAction", "merge");
                        }
                    }
                    "quit" => {
                        QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Window starts hidden (visible: false in tauri.conf.json).
            // Show it unless --minimized flag or startup config says to stay hidden.
            let args: Vec<String> = std::env::args().collect();
            let start_minimized = args.iter().any(|a| a == "--minimized")
                || commands::read_start_minimized(app);

            if !start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            // Handle CLI file args on first launch
            let files: Vec<String> = args
                .iter()
                .skip(1)
                .filter(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".pdf"))
                .cloned()
                .collect();
            let merge = args.iter().any(|a| a == "--merge");

            if !files.is_empty() {
                let app_handle = app.handle().clone();
                let payload = serde_json::json!({ "files": files, "merge": merge });
                // Emit after window is ready
                tauri::async_runtime::spawn(async move {
                    // Small delay to let renderer initialize
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("app:openFile", payload);
                    }
                });
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            if e2e {
                return; // Let default close behaviour apply — no unsaved-changes prompt.
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the default close — let the renderer decide
                api.prevent_close();
                // Tell the renderer to check for unsaved changes
                let _ = window.emit("app:beforeClose", ());
            }
        });

    builder
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(move |_app, event| {
            if let RunEvent::ExitRequested { api, .. } = &event {
                if !e2e && !QUITTING.load(Ordering::SeqCst) {
                    // Keep the app running when the window is hidden to tray
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::backdrop_supported;

    #[test]
    fn backdrop_gate_is_the_win11_floor() {
        assert!(!backdrop_supported(19045)); // Win10 22H2
        assert!(!backdrop_supported(21999));
        assert!(backdrop_supported(22000)); // Win11 21H2 (fallback attribute)
        assert!(backdrop_supported(22631)); // Win11 23H2 (documented backdrop API)
    }
}
