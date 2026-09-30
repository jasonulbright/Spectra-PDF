//! Engine writes in flight, as the app's exit and the Windows session see them.
//!
//! A write is a routed engine request that holds write protection (an output
//! reservation or a folder lease). The process exit ends every engine worker,
//! so the last window does not close while one is running unless the user
//! chooses to stop it, and a logoff or shutdown is held with a stated reason
//! for as long as one runs.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Writes in flight at the watcher's last look.
static WRITES: AtomicUsize = AtomicUsize::new(0);

/// The app, for the window procedure, which receives no context of its own.
static APP: OnceLock<AppHandle> = OnceLock::new();

const WATCH_INTERVAL: Duration = Duration::from_millis(250);

/// Windows allows a window about five seconds to answer `WM_ENDSESSION`
/// before it offers to end the process; the cancel is given most of that.
pub const SESSION_END_GRACE: Duration = Duration::from_secs(4);

/// What closing the last window does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LastClose {
    /// Hide to the tray; nothing ends.
    Hide,
    /// Writes are running: the window stays until they finish or the user
    /// chooses to stop them.
    FinishWrites,
    /// Exit the app.
    Exit,
}

/// The decision for a close of the last window.
pub fn last_close(minimize_to_tray: bool, force: bool, writes: usize) -> LastClose {
    if minimize_to_tray {
        LastClose::Hide
    } else if writes > 0 && !force {
        LastClose::FinishWrites
    } else {
        LastClose::Exit
    }
}

/// Whether a session end is answered "not now". Only while writes run.
pub fn blocks_session_end(writes: usize) -> bool {
    writes > 0
}

/// The shutdown reason text, set by the renderer in the user's language.
#[derive(Default)]
pub struct ShutdownReason {
    text: Mutex<String>,
    #[cfg_attr(not(windows), allow(dead_code))]
    blocked: Mutex<HashSet<isize>>,
}

impl ShutdownReason {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Writes in flight now, across every worker.
#[tauri::command]
pub fn engine_writes_in_flight(app: AppHandle) -> usize {
    app.state::<crate::engine::EngineRouter>().writes_in_flight(None)
}

/// The reason Windows shows while a logoff or shutdown waits on a write.
#[tauri::command]
pub fn set_shutdown_block_reason(app: AppHandle, text: String) {
    let state = app.state::<ShutdownReason>();
    *state.text.lock().unwrap_or_else(|e| e.into_inner()) = text;
}

/// Watch the count of writes in flight: tell every window when it changes,
/// hold the Windows session while it is above zero, and watch each app
/// window for the session-end messages.
pub fn spawn_watcher(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = usize::MAX;
        loop {
            let count = app.state::<crate::engine::EngineRouter>().writes_in_flight(None);
            WRITES.store(count, Ordering::SeqCst);
            if count != last {
                for label in crate::app_windows::app_window_labels(&app) {
                    let _ = app.emit_to(label.as_str(), "engine:writesInFlight", count);
                }
            }
            sync_windows(&app, count > 0);
            last = count;
            tokio::time::sleep(WATCH_INTERVAL).await;
        }
    });
}

/// Writes in flight at this moment, read from the router rather than from
/// the watcher's last sample.
#[cfg_attr(not(windows), allow(dead_code))]
fn writes_now() -> usize {
    APP.get().map_or_else(
        || WRITES.load(Ordering::SeqCst),
        |app| app.state::<crate::engine::EngineRouter>().writes_in_flight(None),
    )
}

#[cfg(windows)]
use windows_session::sync_windows;

/// A logoff or shutdown is not held off Windows yet: the session-end hold
/// arrives with the process-model backend.
#[cfg(not(windows))]
fn sync_windows(_app: &AppHandle, _hold: bool) {}

#[cfg(windows)]
mod windows_session {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tauri::{AppHandle, Manager};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{WM_ENDSESSION, WM_QUERYENDSESSION};

    use super::{blocks_session_end, writes_now, ShutdownReason, APP, SESSION_END_GRACE};

    /// Set by the first window to handle a session-ending `WM_ENDSESSION`; every
    /// other window then returns at once instead of cancelling again.
    static SESSION_ENDING: AtomicBool = AtomicBool::new(false);

    /// The block reason until the renderer supplies one in the user's language.
    const FALLBACK_REASON: &str = "Spectra PDF is still writing a file.";

    const SESSION_WATCH_ID: usize = 0x5350_5752;

    /// Apply the block reason to every app window while `hold`, remove it
    /// otherwise, and subclass any window not yet watched. Runs on the thread
    /// that owns the windows, as both calls require.
    pub(super) fn sync_windows(app: &AppHandle, hold: bool) {
        let hwnds: Vec<isize> = crate::app_windows::app_window_labels(app)
            .into_iter()
            .filter_map(|label| app.get_webview_window(&label))
            .filter_map(|window| window.hwnd().ok())
            .map(|hwnd| hwnd.0 as isize)
            .collect();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = handle.state::<ShutdownReason>();
            let mut reason = state.text.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if reason.is_empty() {
                reason = FALLBACK_REASON.to_string();
            }
            let mut blocked = state.blocked.lock().unwrap_or_else(|e| e.into_inner());
            blocked.retain(|hwnd| hwnds.contains(hwnd));
            for &raw in &hwnds {
                let hwnd = HWND(raw as *mut c_void);
                unsafe {
                    let _ = SetWindowSubclass(hwnd, Some(on_session_message), SESSION_WATCH_ID, 0);
                }
                let held = blocked.contains(&raw);
                if hold && !held {
                    let wide: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
                    if unsafe { ShutdownBlockReasonCreate(hwnd, PCWSTR(wide.as_ptr())) }.is_ok() {
                        blocked.insert(raw);
                    }
                } else if !hold && held {
                    let _ = unsafe { ShutdownBlockReasonDestroy(hwnd) };
                    blocked.remove(&raw);
                }
            }
        });
    }

    /// `WM_QUERYENDSESSION` is refused while a write runs; Windows then shows
    /// the block reason and lets the user wait or end the session anyway. On a
    /// `WM_ENDSESSION` that ends the session, each write is cancelled so it stops
    /// at its next safe point, within the few seconds Windows allows.
    unsafe extern "system" fn on_session_message(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if message == WM_QUERYENDSESSION && blocks_session_end(writes_now()) {
            return LRESULT(0);
        }
        if message == WM_ENDSESSION && wparam.0 != 0 && writes_now() > 0 {
            if SESSION_ENDING.swap(true, Ordering::SeqCst) {
                return LRESULT(0);
            }
            if let Some(app) = APP.get() {
                let app = app.clone();
                tauri::async_runtime::block_on(async move {
                    crate::engine::cancel_writes(&app, SESSION_END_GRACE).await;
                });
            }
            return LRESULT(0);
        }
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_close_waits_only_for_writes_the_user_has_not_chosen_to_stop() {
        assert_eq!(last_close(false, false, 0), LastClose::Exit);
        assert_eq!(last_close(false, false, 2), LastClose::FinishWrites);
        assert_eq!(last_close(false, true, 2), LastClose::Exit);
        assert_eq!(last_close(true, false, 2), LastClose::Hide);
        assert_eq!(last_close(true, true, 0), LastClose::Hide);
    }

    #[test]
    fn a_session_end_is_held_only_while_a_write_runs() {
        assert!(!blocks_session_end(0));
        assert!(blocks_session_end(1));
    }
}
