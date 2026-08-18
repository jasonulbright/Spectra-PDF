pub mod cli;
mod clipboard_read;
mod commands;
pub mod create_pdf_sources;
mod print_to_pdf;
mod scheduler;
mod send_to;
mod snapshot;
mod watchers;
mod web_capture;
mod engine;
mod printers;
pub mod scanner;
pub mod app_windows;
pub mod session;
pub mod tabdrag;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};

/// When true, the app is exiting for real — don't prevent exit.
pub static QUITTING: AtomicBool = AtomicBool::new(false);

/// Mica exists from Windows 11 (build 22000; window-vibrancy uses the
/// documented backdrop API from 22523 and a fallback attribute below it).
/// Windows 10 has no equivalent worth shipping — its acrylic path lags
/// window drags — so unsupported builds keep an ordinary opaque window.
fn backdrop_supported(build: u32) -> bool {
    build >= 22000
}

/// Is "Transparency effects" on? (Settings ▸ Personalization ▸ Colours.)
/// Absent value means the Windows default, which is ON.
pub(crate) fn transparency_effects_enabled() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value::<u32, _>("EnableTransparency"))
        .map(|v| v != 0)
        .unwrap_or(true)
}

pub(crate) fn is_remote_session() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

/// Whether DWM will compose a backdrop, as opposed to accepting the request.
///
/// `apply_mica` wraps `DwmSetWindowAttribute`, whose success means the
/// attribute was recorded, not that the effect was drawn. DWM records and does
/// not draw when transparency effects are switched off (a local, supported
/// Win11 machine) or in a remote session. Reporting "mica" in either case
/// applies translucent shell styling over a material that was never painted;
/// the opaque fallback is the correct presentation there.
///
/// Pure so it can be pinned; the three environment reads stay outside it.
pub(crate) fn wants_backdrop(build: u32, remote: bool, transparency_on: bool) -> bool {
    backdrop_supported(build) && !remote && transparency_on
}

/// When true, the binary is running under end-to-end test control:
/// single-instance hijacking and tray-persistence are disabled so each WDIO
/// session gets a clean launch and exit. Enabled via the SPECTRAPDF_E2E
/// environment variable.
pub(crate) fn is_e2e_mode() -> bool {
    std::env::var("SPECTRAPDF_E2E").is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let e2e = is_e2e_mode();

    let mut builder = tauri::Builder::default()
        .manage(engine::EngineState::new())
        .manage(engine::EngineRouter::new())
        .manage(app_windows::BackdropState::new())
        .manage(app_windows::WindowRegistry::new())
        .manage(app_windows::ClaimState::new())
        .manage(tabdrag::StripRegistry::new())
        .manage(session::SessionState::new())
        .manage(scanner::ScannerSessions::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // In-app W3C WebDriver server (TRIAL). Double-gated on purpose: the
    // `webdriver` Cargo feature keeps it out of a release binary at compile
    // time, and SPECTRAPDF_E2E keeps it from binding a port even in a
    // feature-enabled build that someone runs by hand. It exposes full
    // automation over HTTP, so "never in production" is enforced, not trusted.
    #[cfg(feature = "webdriver")]
    if e2e {
        builder = builder.plugin(tauri_plugin_webdriver::init());
    }

    if !e2e {
        builder = builder.plugin(
            tauri_plugin_single_instance::init(|app, argv, _cwd| {
                // Second instance launched — forward file args to existing window
                let files: Vec<String> = argv
                    .iter()
                    .skip(1)
                    .filter(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".pdf"))
                    // The path-identity gate: argv is the wild-west
                    // producer — Explorer, scripts and shells spell the same
                    // file every way there is.
                    .map(|a| commands::canonical_path(a))
                    .collect();
                let merge = argv.iter().any(|a| a == "--merge");
                // One target window, chosen by ownership then focus: broadcast
                // here mints an independent working copy of the same file per
                // window, and the loser's whole edit session vanishes on
                // whichever save lands last.
                app_windows::route_open(app, files, merge);
            }),
        );
    }

    let builder = builder
        .invoke_handler(tauri::generate_handler![
            commands::open_files_dialog,
            commands::save_file_dialog,
            commands::pick_certificate_file,
            commands::pick_create_pdf_sources,
            commands::pick_dictionary_files,
            commands::pick_watermark_image,
            commands::pick_watermark_pdf,
            commands::pick_pem_file,
            commands::pick_icc_file,
            commands::pick_pkcs11_module,
            commands::pick_any_file,
            commands::pick_any_files,
            commands::pick_folder_dialog,
            commands::list_pdfs_recursive,
            commands::copy_file_creating_dirs,
            commands::ensure_parent_dirs,
            commands::paths_same_file,
            commands::read_file_binary,
            commands::pick_image_file,
            commands::save_image_file_dialog,
            commands::pick_form_data_file,
            commands::save_form_data_file,
            commands::save_report_file,
            commands::write_report_file,
            commands::write_profile_file,
            commands::write_action_file,

            commands::read_file_buffer,
            commands::create_working_copy,
            commands::snapshot,
            commands::restore_snapshot,
            commands::save_as,
            commands::get_gs_path,
            commands::get_tesseract_path,
            commands::get_soffice_path,
            commands::get_edit_font_path,
            commands::get_dictionary_path,
            commands::user_dictionary_dir,
            commands::list_printers,
            commands::printer_capabilities,
            scanner::list_scanners,
            scanner::scanner_capabilities,
            scanner::scanner_close,
            scanner::scanner_select_dialog,
            scanner::scan_acquire,
            scanner::scan_cancel,
            scanner::scan_discard,
            commands::canonicalize_paths,
            commands::portfolio_member_dir,
            commands::open_portfolio_member_file,
            commands::get_bundled_gs_info,
            commands::detect_external_gs,
            commands::get_app_version,
            commands::open_third_party_licenses,
            commands::reveal_in_file_manager,
            commands::open_releases_page,
            commands::get_system_accent_color,
            commands::get_window_backdrop,
            commands::append_operation_log,
            commands::move_file_creating_dirs,
            commands::create_batch_scratch,
            commands::delete_batch_scratch,
            commands::write_batch_log,
            commands::get_batch_log_dir,
            commands::prune_batch_logs,
            commands::open_batch_log_folder,
            send_to::stage_send_copy,
            send_to::send_by_email,
            watchers::list_watched_folders,
            watchers::upsert_watched_folder,
            watchers::delete_watched_folder,
            print_to_pdf::virtual_printer_status,
            print_to_pdf::install_virtual_printer,
            print_to_pdf::uninstall_virtual_printer,
            scheduler::create_scheduled_run,
            scheduler::list_scheduled_runs,
            scheduler::delete_scheduled_run,
            scheduler::run_scheduled_now,
            scheduler::set_scheduled_run_enabled,
            commands::start_engine,
            commands::send_to_engine,
            commands::check_auto_update_disabled,
            commands::get_startup_enabled,
            commands::set_startup_enabled,
            commands::set_start_minimized,
            commands::set_restore_windows_on_launch,
            commands::confirm_close,
            commands::close_window,
            commands::request_quit,
            commands::quit_cancelled,
            commands::set_tab_order,
            commands::hide_to_tray,
            app_windows::open_new_window,
            app_windows::claim_document,
            app_windows::release_document,
            app_windows::claim_output_root,
            app_windows::release_output_root,
            app_windows::focus_app_window,
            app_windows::take_pending_opens,
            tabdrag::register_strip_rect,
            tabdrag::tabdrag_track,
            tabdrag::tabdrag_hover_index,
            tabdrag::tabdrag_cancel,
            tabdrag::tabdrag_resolve,
            tabdrag::tabdrag_drop,
            tabdrag::move_document_to_new_window,
            snapshot::copy_image_to_clipboard,
            snapshot::save_snapshot_png,
            clipboard_read::read_clipboard_source,
            web_capture::capture_web_page,
        ])
        .setup(move |app| {
            // The battery's fallback spec launches with
            // SPECTRAPDF_E2E_FORCE_OPAQUE=1 so the opaque presentation runs
            // live on a machine where Mica would compose (spec 94; the RDP/
            // transparency-off case is otherwise unreachable on a dev box).
            app_windows::build_app_window(&app.handle().clone(), app_windows::MAIN_LABEL, e2e, false)?;

            let args: Vec<String> = std::env::args().collect();
            // Under end-to-end control the window is force-shown below, so the
            // preference must not decide anything about visibility here.
            let start_minimized = !e2e
                && (args.iter().any(|a| a == "--minimized")
                    || commands::read_start_minimized(&*app));

            // The main window's geometry comes back on every launch — it
            // belongs to the window, not to the session — while the documents
            // and the second window wait on the preference.
            session::apply_launch(
                &app.handle().clone(),
                commands::read_restore_windows_on_launch(&*app),
                e2e,
                !start_minimized,
            );

            // Watched folders: resume every enabled watcher. Deliberately
            // BEFORE the e2e early-return — the watchers are part of the
            // product under test.
            app.manage(watchers::WatcherState::new());
            watchers::start_all(app.handle());

            // The virtual printer's loopback listener — also part of the
            // product under test (e2e streams a job straight at the port).
            app.manage(print_to_pdf::PrinterState::new());
            print_to_pdf::start_listener(app.handle());

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
                    // Every workspace window comes back: the tray hides them
                    // all, so restoring only one strands the rest.
                    "show" => app_windows::show_all_app_windows(app),
                    "merge" => {
                        let target = app_windows::route_target(app);
                        app_windows::focus_label(app, &target);
                        let _ = app.emit_to(target.as_str(), "app:trayAction", "merge");
                    }
                    "quit" => {
                        // Before the exit, not after: every window is still
                        // standing and still holding the documents the session
                        // records.
                        session::capture_and_seal(app);
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
                        app_windows::show_all_app_windows(tray.app_handle());
                    }
                })
                .build(app)?;

            // Window starts hidden (visible: false in tauri.conf.json).
            // Show it unless --minimized flag or startup config says to stay hidden.
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
                .map(|a| commands::canonical_path(a))
                .collect();
            let merge = args.iter().any(|a| a == "--merge");

            if !files.is_empty() {
                // Queued immediately and drained by whichever window asks: the
                // payload waits in the registry rather than riding an event a
                // renderer that has not mounted yet cannot receive.
                app_windows::route_open(&app.handle().clone(), files, merge);
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // A window that hosts no renderer cannot answer a close, so
                    // it keeps the default one: it never prompts about unsaved
                    // documents, never counts toward the last-window quit
                    // decision, and never holds the close open. The page
                    // capture reads its own window's close as a cancel and
                    // destroys the window itself.
                    if !app_windows::is_app_window(window.label()) {
                        web_capture::window_close_requested(window.label());
                        return;
                    }
                    // Under end-to-end control the LAST workspace window keeps
                    // the default close so a driver session exits cleanly.
                    // Every other close runs the product's own path, which is
                    // the only place the two-window quit hazard is reachable.
                    if e2e && app_windows::app_window_count(app) <= 1 {
                        return;
                    }
                    // Prevent the default close — let the renderer decide
                    api.prevent_close();
                    // Addressed, not broadcast: the other window's renderer
                    // would run the same unsaved-changes flow and close a
                    // window nobody asked to close.
                    let _ = app.emit_to(window.label(), "app:beforeClose", ());
                }
                tauri::WindowEvent::Focused(true) => {
                    app_windows::on_window_focused(app, window.label());
                }
                // The strip registry hears geometry changes here rather than
                // from the renderer: this side learns of them first, and a rect
                // that lags one frame behind a human-speed drag still names the
                // right window.
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    tabdrag::on_window_geometry_changed(app, window);
                    session::on_window_geometry_changed(app, window.label());
                }
                // The session capture runs FIRST: it reads the claims that the
                // line below it drops, and the last window's destruction is the
                // one quit path that never passes through `close_window`.
                tauri::WindowEvent::Destroyed => {
                    session::on_window_destroyed(app, window.label());
                    tabdrag::on_window_destroyed(app, window.label());
                    app_windows::on_window_destroyed(app, window.label());
                }
                _ => {}
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
    use super::{backdrop_supported, wants_backdrop};

    #[test]
    fn backdrop_gate_is_the_win11_floor() {
        assert!(!backdrop_supported(19045)); // Win10 22H2
        assert!(!backdrop_supported(21999));
        assert!(backdrop_supported(22000)); // Win11 21H2 (fallback attribute)
        assert!(backdrop_supported(22631)); // Win11 23H2 (documented backdrop API)
    }

    #[test]
    fn translucent_styling_needs_composition_not_just_support() {
        // The OS build alone is not enough: DWM records the attribute without
        // drawing in both of these cases.
        assert!(
            !wants_backdrop(26200, false, false),
            "transparency effects OFF on a supported build must fall back"
        );
        assert!(
            !wants_backdrop(26200, true, true),
            "a remote session must fall back"
        );

        // Composing local Win11: unchanged, still translucent.
        assert!(wants_backdrop(26200, false, true));
        assert!(wants_backdrop(22000, false, true));

        // Below the floor stays opaque whatever the other signals say.
        assert!(!wants_backdrop(19045, false, true));
    }

    #[test]
    fn canonical_path_unifies_windows_spellings() {
        // The path-identity gate: case, slash direction and 8.3 short
        // names must all resolve to ONE string, and the result must not wear
        // std::fs::canonicalize's \\?\ verbatim prefix.
        let dir = std::env::temp_dir().join("opstudio-canon-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Sample File.pdf");
        std::fs::write(&file, b"x").unwrap();

        let canonical = crate::commands::canonical_path(&file.to_string_lossy());
        assert!(!canonical.starts_with(r"\\?\"), "{canonical}");

        let lower = file.to_string_lossy().to_lowercase();
        let slashy = file.to_string_lossy().replace('\\', "/");
        assert_eq!(crate::commands::canonical_path(&lower), canonical);
        assert_eq!(crate::commands::canonical_path(&slashy), canonical);

        // A path that doesn't exist passes through untouched — Save As
        // targets are usually new files.
        let ghost = dir.join("does-not-exist.pdf");
        let ghost_str = ghost.to_string_lossy().to_string();
        assert_eq!(crate::commands::canonical_path(&ghost_str), ghost_str);

        std::fs::remove_dir_all(&dir).ok();
    }
}
