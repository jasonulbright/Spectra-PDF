//! One unsaved-changes prompt on screen at a time for windows the user
//! cannot see.
//!
//! A quit asks every window to run its close flow at once. A window hidden to
//! the tray or minimized would otherwise raise its prompt out of sight, and
//! several of them would all pull themselves forward together. A window that
//! is not visible takes a turn here, is brought forward, and prompts; the next
//! one waits until that answer is given, that window is destroyed or reloads,
//! or the wait bound passes.
//!
//! The turn orders only when a window is shown. It never decides whether a
//! prompt appears or what its answer does, so no outcome of it, the bound
//! included, can drop or save a document.

use std::collections::HashSet;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// A holder that has not answered within this bound is presumed wedged; the
/// next window is shown and prompts beside it rather than waiting forever.
pub const TURN_WAIT_BOUND: Duration = Duration::from_secs(300);

#[derive(Default)]
struct Inner {
    holder: Option<(String, u64)>,
    next_token: u64,
    /// Destroyed labels. A wait for one of them ends, and a turn it would
    /// take is never held.
    gone: HashSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Acquired {
    Turn(u64),
    /// The waiting window was destroyed; there is nothing to prompt.
    Gone,
    /// The bound passed with another window still holding the turn.
    TimedOut,
}

#[derive(Default)]
pub struct PromptTurns {
    inner: Mutex<Inner>,
    freed: Condvar,
}

impl PromptTurns {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait until no other window holds the turn, then take it.
    pub fn acquire(&self, label: &str, bound: Duration) -> Acquired {
        let deadline = Instant::now() + bound;
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if inner.gone.contains(label) {
                return Acquired::Gone;
            }
            if !inner.holder.as_ref().is_some_and(|(held, _)| held != label) {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                return Acquired::TimedOut;
            }
            inner = self
                .freed
                .wait_timeout(inner, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        inner.next_token += 1;
        let token = inner.next_token;
        inner.holder = Some((label.to_string(), token));
        Acquired::Turn(token)
    }

    /// Give the turn back. A token that no longer names the holder changes
    /// nothing, so a late release cannot free another window's turn.
    pub fn release(&self, token: u64) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.holder.as_ref().is_some_and(|(_, t)| *t == token) {
            inner.holder = None;
            self.freed.notify_all();
            return true;
        }
        false
    }

    /// Free a turn held by `label` whose renderer can no longer answer it: a
    /// reload drops the prompt without running its release.
    pub fn release_label(&self, label: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.holder.as_ref().is_some_and(|(held, _)| held == label) {
            inner.holder = None;
            self.freed.notify_all();
        }
    }

    /// A destroyed window can never answer, whether it holds the turn or is
    /// still waiting for it.
    pub fn forget(&self, label: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.gone.insert(label.to_string());
        if inner.holder.as_ref().is_some_and(|(held, _)| held == label) {
            inner.holder = None;
        }
        self.freed.notify_all();
    }
}

/// Take a prompt turn for the calling window when the user cannot see it, and
/// bring it forward. A visible, restored window gets no turn and is untouched.
#[tauri::command]
pub async fn prompt_turn_begin(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<u64>, String> {
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    if visible && !minimized {
        return Ok(None);
    }
    let label = window.label().to_string();
    let runner = app.clone();
    let waited = label.clone();
    let acquired = tauri::async_runtime::spawn_blocking(move || {
        runner.state::<PromptTurns>().acquire(&waited, TURN_WAIT_BOUND)
    })
    .await
    .map_err(|e| e.to_string())?;
    let token = match acquired {
        Acquired::Gone => return Ok(None),
        Acquired::Turn(token) => Some(token),
        Acquired::TimedOut => None,
    };
    // Destroyed between the wait and here: its forget ran before the turn
    // was taken and would never run again.
    if app.get_webview_window(&label).is_none() {
        if let Some(token) = token {
            app.state::<PromptTurns>().release(token);
        }
        return Ok(None);
    }
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    crate::app_windows::show_when_ready(&app, &label, true);
    Ok(token)
}

#[tauri::command]
pub async fn prompt_turn_end(app: AppHandle, token: u64) -> Result<(), String> {
    app.state::<PromptTurns>().release(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const LONG: Duration = Duration::from_secs(30);

    #[test]
    fn second_window_waits_for_the_first_answer() {
        let turns = Arc::new(PromptTurns::new());
        let Acquired::Turn(first) = turns.acquire("main", LONG) else { panic!() };
        let waiter = {
            let turns = turns.clone();
            std::thread::spawn(move || turns.acquire("doc-1", LONG))
        };
        std::thread::sleep(Duration::from_millis(100));
        assert!(!waiter.is_finished());
        assert!(turns.release(first));
        assert!(matches!(waiter.join().unwrap(), Acquired::Turn(t) if t != first));
    }

    #[test]
    fn destroyed_holder_frees_the_turn() {
        let turns = Arc::new(PromptTurns::new());
        let _ = turns.acquire("main", LONG);
        let waiter = {
            let turns = turns.clone();
            std::thread::spawn(move || turns.acquire("doc-1", LONG))
        };
        std::thread::sleep(Duration::from_millis(50));
        turns.forget("main");
        assert!(matches!(waiter.join().unwrap(), Acquired::Turn(_)));
    }

    #[test]
    fn window_destroyed_while_waiting_takes_no_turn() {
        let turns = Arc::new(PromptTurns::new());
        let Acquired::Turn(held) = turns.acquire("main", LONG) else { panic!() };
        let waiter = {
            let turns = turns.clone();
            std::thread::spawn(move || turns.acquire("doc-1", LONG))
        };
        std::thread::sleep(Duration::from_millis(50));
        turns.forget("doc-1");
        assert_eq!(waiter.join().unwrap(), Acquired::Gone);
        assert!(turns.release(held));
        assert!(matches!(turns.acquire("doc-2", LONG), Acquired::Turn(_)));
    }

    #[test]
    fn window_destroyed_before_waiting_takes_no_turn() {
        let turns = PromptTurns::new();
        turns.forget("doc-1");
        assert_eq!(turns.acquire("doc-1", LONG), Acquired::Gone);
        assert!(turns.inner.lock().unwrap().holder.is_none());
    }

    #[test]
    fn reloaded_holder_frees_the_turn() {
        let turns = PromptTurns::new();
        let _ = turns.acquire("main", LONG);
        turns.release_label("main");
        assert!(matches!(turns.acquire("doc-1", LONG), Acquired::Turn(_)));
    }

    #[test]
    fn wedged_holder_times_the_waiter_out() {
        let turns = PromptTurns::new();
        let _ = turns.acquire("main", LONG);
        assert_eq!(turns.acquire("doc-1", Duration::from_millis(50)), Acquired::TimedOut);
    }

    #[test]
    fn stale_token_does_not_release_a_newer_turn() {
        let turns = PromptTurns::new();
        let Acquired::Turn(old) = turns.acquire("main", LONG) else { panic!() };
        assert!(turns.release(old));
        let _new = turns.acquire("doc-1", LONG);
        assert!(!turns.release(old));
        turns.release_label("main");
        assert!(turns.inner.lock().unwrap().holder.is_some());
    }

    #[test]
    fn same_window_reacquires_without_waiting() {
        let turns = PromptTurns::new();
        let _ = turns.acquire("main", LONG);
        let Acquired::Turn(again) = turns.acquire("main", LONG) else { panic!() };
        assert!(turns.release(again));
    }
}
