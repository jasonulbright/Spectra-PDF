//! The HEALTH worker: a second Python sidecar that only ever inspects.
//!
//! The interactive sidecar is one strictly serial process with no cancel, so
//! anything handed to it runs to completion and everything queued behind it
//! waits. A health inspection is unbounded work over a document nobody asked
//! about — a hostile file can make one page's resource graph cost minutes —
//! and a bound negotiated inside the Python process cannot cover the part of
//! the cost that happens before Python gets a chance to check it (the open and
//! recovery of a damaged file, one enormous stream's decode). The only bound
//! that holds over an arbitrary document is the one enforced from outside the
//! process: a wall-clock deadline and a kill.
//!
//! So health runs HERE, in its own process, with its own router, its own
//! deadline and its own kill. Consequences that are the point:
//!
//! * The interactive engine never sees health work, so no user operation ever
//!   queues behind an inspection, whatever the inspection costs.
//! * A worker that overruns is killed. It holds no state the product needs —
//!   every run is a read of a file on disk — so the next health request simply
//!   spawns a new one.
//! * Killing it cannot lose a user's work, because it never had any.
//!
//! It is the same protocol and the same routing discipline as the interactive
//! engine: one worker serves every window, ids are rewritten to a process-wide
//! number on the way out and restored on the way back, and responses are
//! addressed with `emit_to` rather than broadcast. The router is a SEPARATE
//! instance from the interactive one so health work never appears in the
//! cross-window activity count — that count exists to explain why a user's
//! operation is waiting, and health never makes one wait.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::engine::EngineRouter;

/// How long one health request may run before the worker is killed.
///
/// Generous on purpose: this is not a performance budget (the Python side owns
/// those, and reports exceeding them as a finding). It is the bound of last
/// resort for the cost that lands before any Python check can run.
pub const HEALTH_DEADLINE: Duration = Duration::from_secs(30);

/// How often the deadline is tested.
pub const HEALTH_WATCH_INTERVAL: Duration = Duration::from_secs(1);

/// Overrides for the two durations above, in whole milliseconds.
///
/// The bound is a wall-clock number with no correct value: a machine slow
/// enough makes 30 s a false kill, and a test proving the kill cannot wait
/// 30 s for it. Read on every check rather than captured at spawn, so a change
/// reaches the worker already running. A malformed or absent value is the
/// compiled-in default — an override can only move the bound, never remove it.
pub const HEALTH_DEADLINE_ENV: &str = "SPECTRAPDF_HEALTH_DEADLINE_MS";
pub const HEALTH_WATCH_ENV: &str = "SPECTRAPDF_HEALTH_WATCH_MS";

fn millis_from_env(name: &str, fallback: Duration) -> Duration {
    match std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
    {
        Some(ms) => Duration::from_millis(ms),
        None => fallback,
    }
}

/// How long one health request may run, as configured now.
pub fn health_deadline() -> Duration {
    millis_from_env(HEALTH_DEADLINE_ENV, HEALTH_DEADLINE)
}

/// How long the watcher sleeps between checks, as configured now. Floored at
/// one millisecond: a zero-length sleep is a spin.
pub fn health_watch_interval() -> Duration {
    millis_from_env(HEALTH_WATCH_ENV, HEALTH_WATCH_INTERVAL).max(Duration::from_millis(1))
}

/// The health worker's own id router. A distinct type from the interactive
/// one so `app.state()` resolves to the right table.
pub struct HealthRouter(pub EngineRouter);

impl HealthRouter {
    pub fn new() -> Self {
        Self(EngineRouter::new())
    }
}

impl Default for HealthRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// When each outstanding health request was handed over.
///
/// The worker answers in order, so the FRONT of the queue is the request being
/// worked on and its age is the age of the work. A pure state machine over
/// timestamps supplied by the caller: the decision to kill is testable without
/// a process.
#[derive(Default)]
pub struct Watchdog {
    sent: std::sync::Mutex<VecDeque<Instant>>,
}

impl Watchdog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one request handed to the worker.
    pub fn armed(&self, at: Instant) {
        if let Ok(mut q) = self.sent.lock() {
            q.push_back(at);
        }
    }

    /// Record one answer. The worker is FIFO, so an answer retires the oldest.
    pub fn disarmed(&self) {
        if let Ok(mut q) = self.sent.lock() {
            q.pop_front();
        }
    }

    /// Forget everything outstanding — after a kill, nothing is coming back.
    pub fn cleared(&self) {
        if let Ok(mut q) = self.sent.lock() {
            q.clear();
        }
    }

    pub fn outstanding(&self) -> usize {
        self.sent.lock().map(|q| q.len()).unwrap_or(0)
    }

    /// Whether the request being worked on has run past `limit` by `now`.
    ///
    /// `saturating_duration_since` rather than subtraction: a `now` earlier
    /// than the send instant is not overdue, and must not panic.
    pub fn overdue(&self, now: Instant, limit: Duration) -> bool {
        let Ok(q) = self.sent.lock() else {
            return false;
        };
        match q.front() {
            Some(oldest) => now.saturating_duration_since(*oldest) > limit,
            None => false,
        }
    }
}

/// The health worker process, or none.
pub struct HealthEngineState {
    pub child: Arc<Mutex<Option<CommandChild>>>,
    pub watchdog: Arc<Watchdog>,
}

impl HealthEngineState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            watchdog: Arc::new(Watchdog::new()),
        }
    }
}

impl Default for HealthEngineState {
    fn default() -> Self {
        Self::new()
    }
}

/// The refusal an outstanding health request is answered with when its worker
/// is killed. English at the boundary, like every engine refusal; the ledger
/// records the run as failed (undetermined) and never renders this as UI copy.
const DEADLINE_REFUSAL: &str = "health inspection exceeded its deadline";

/// Answer every outstanding health request with a refusal.
///
/// A killed worker sends nothing further, so without this each window's
/// pending entry waits forever and the ledger row never settles. Addressed
/// per window with `emit_to`: `Emitter::emit` is an app-wide broadcast, and
/// one window's refusal is not another's.
fn refuse_outstanding<R: Runtime>(app: &AppHandle<R>) {
    let routes = app.state::<HealthRouter>().0.take_all();
    for (label, inner) in routes {
        let refusal = serde_json::json!({
            "jsonrpc": "2.0",
            "id": inner,
            "error": { "message": DEADLINE_REFUSAL },
        });
        let _ = app.emit_to(label.as_str(), "engine:response", refusal);
    }
}

/// Kill the health worker if it is running. The next health request spawns a
/// new one, so this is the whole of "respawn" as well.
pub async fn kill<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<HealthEngineState>();
    let killed = {
        let mut guard = state.child.lock().await;
        match guard.take() {
            Some(child) => {
                let _ = child.kill();
                true
            }
            None => false,
        }
    };
    state.watchdog.cleared();
    refuse_outstanding(app);
    killed
}

/// Kill the worker when the request it is working on has run past the
/// deadline. Returns whether it did.
pub async fn enforce_deadline<R: Runtime>(app: &AppHandle<R>) -> bool {
    let overdue = {
        let state = app.state::<HealthEngineState>();
        let watchdog = state.watchdog.clone();
        watchdog.overdue(Instant::now(), health_deadline())
    };
    if !overdue {
        return false;
    }
    let dropped = app.state::<HealthEngineState>().watchdog.outstanding();
    eprintln!(
        "[health] worker exceeded its deadline; killing ({} request(s) refused)",
        dropped
    );
    kill(app).await
}

/// Restore a response's original id and deliver it to the window that asked.
fn route_response<R: Runtime>(app: &AppHandle<R>, mut json: serde_json::Value) {
    app.state::<HealthEngineState>().watchdog.disarmed();
    let Some(outer) = json.get("id").and_then(|v| v.as_u64()) else {
        // An id-less line from this worker correlates to no request and no
        // window. The interactive engine's process-wide notices do not come
        // from here, so there is nothing to deliver it to.
        return;
    };
    let Some((label, inner)) = app.state::<HealthRouter>().0.take_route(outer) else {
        return;
    };
    if let Some(obj) = json.as_object_mut() {
        obj.insert("id".to_string(), inner);
    }
    let _ = app.emit_to(label.as_str(), "engine:response", json);
}

/// Start the health worker and wire its stdout to the webview. Idempotent.
pub async fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    {
        let state = app.state::<HealthEngineState>();
        let guard = state.child.lock().await;
        if guard.is_some() {
            return Ok(());
        }
    }

    let python_path = crate::engine::get_python_path(app);
    let script_path = crate::engine::get_engine_script_path(app);

    let shell = app.shell();
    let (mut rx, child) = shell
        .command(&python_path)
        .args([&script_path])
        .envs(
            crate::engine::python_env()
                .into_iter()
                .collect::<HashMap<String, String>>(),
        )
        .spawn()
        .map_err(|e| format!("Failed to start health worker: {}", e))?;

    *app.state::<HealthEngineState>().child.lock().await = Some(child);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim();
                    if !trimmed.is_empty() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            route_response(&app_handle, json);
                        }
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    let msg = String::from_utf8_lossy(&line);
                    let trimmed = msg.trim();
                    if !trimmed.is_empty() {
                        eprintln!("[health] {}", trimmed);
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                    eprintln!("[health] exited with {:?}", status);
                    // Whether this was our own deadline kill or a crash, every
                    // request outstanding against it is now unanswerable.
                    let state = app_handle.state::<HealthEngineState>();
                    state.watchdog.cleared();
                    *state.child.lock().await = None;
                    refuse_outstanding(&app_handle);
                    break;
                }
                _ => {}
            }
        }
    });

    // The watchdog rides the worker: it exits when the worker it was started
    // for is gone, so a respawn gets exactly one new watcher rather than
    // stacking one per spawn.
    let watched = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(health_watch_interval()).await;
            let running = watched
                .state::<HealthEngineState>()
                .child
                .lock()
                .await
                .is_some();
            if !running {
                break;
            }
            enforce_deadline(&watched).await;
        }
    });

    Ok(())
}

/// Hand one health request to the worker, spawning it if it is not running.
pub async fn send<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: serde_json::Value,
) -> Result<(), String> {
    start(app).await?;
    let mut request = request;
    let outer = crate::engine::route_with(&app.state::<HealthRouter>().0, label, &mut request);
    let unroute = |app: &AppHandle<R>| {
        if let Some(outer) = outer {
            app.state::<HealthRouter>().0.take_route(outer);
        }
    };
    let state = app.state::<HealthEngineState>();
    let mut guard = state.child.lock().await;
    let Some(child) = guard.as_mut() else {
        unroute(app);
        return Err("Health worker not running".to_string());
    };
    let msg = match serde_json::to_string(&request) {
        Ok(msg) => msg,
        Err(e) => {
            unroute(app);
            return Err(format!("Serialize error: {}", e));
        }
    };
    if let Err(e) = child.write((msg + "\n").as_bytes()) {
        unroute(app);
        return Err(format!("Failed to write to health worker: {}", e));
    }
    drop(guard);
    // Armed AFTER the write: the deadline measures the worker's time, not the
    // time this command spent getting the bytes to it.
    state.watchdog.armed(Instant::now());
    Ok(())
}

/// Drop a destroyed window's outstanding health requests.
pub fn on_window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    app.state::<HealthRouter>().0.drop_label(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Instant, secs: u64) -> Instant {
        base.checked_add(Duration::from_secs(secs)).unwrap()
    }

    #[test]
    fn nothing_outstanding_is_never_overdue() {
        let dog = Watchdog::new();
        let base = Instant::now();
        assert!(!dog.overdue(at(base, 10_000), HEALTH_DEADLINE));
        assert_eq!(dog.outstanding(), 0);
    }

    #[test]
    fn the_request_being_worked_on_is_the_one_that_can_overrun() {
        let dog = Watchdog::new();
        let base = Instant::now();
        dog.armed(base);
        assert!(!dog.overdue(at(base, 29), HEALTH_DEADLINE));
        assert!(dog.overdue(at(base, 31), HEALTH_DEADLINE));
    }

    #[test]
    fn a_later_request_does_not_reset_the_deadline_of_the_one_in_flight() {
        // The worker is FIFO: a second request queued behind a stuck one must
        // not make the stuck one look young. Measuring from the NEWEST send is
        // how a wedged worker survives forever under steady traffic.
        let dog = Watchdog::new();
        let base = Instant::now();
        dog.armed(base);
        dog.armed(at(base, 29));
        assert!(dog.overdue(at(base, 31), HEALTH_DEADLINE));
    }

    #[test]
    fn an_answer_retires_the_oldest_send() {
        let dog = Watchdog::new();
        let base = Instant::now();
        dog.armed(base);
        dog.armed(at(base, 29));
        dog.disarmed();
        assert_eq!(dog.outstanding(), 1);
        // Only the second request is left, and it is 2s old at t=31.
        assert!(!dog.overdue(at(base, 31), HEALTH_DEADLINE));
        assert!(dog.overdue(at(base, 60), HEALTH_DEADLINE));
    }

    #[test]
    fn a_kill_clears_the_queue_so_the_respawned_worker_starts_unarmed() {
        // What `kill` does to the watchdog, and what the next `send` therefore
        // sees: nothing outstanding, so a fresh worker is never killed for the
        // age of the request that killed its predecessor.
        let dog = Watchdog::new();
        let base = Instant::now();
        dog.armed(base);
        assert!(dog.overdue(at(base, 31), HEALTH_DEADLINE));
        dog.cleared();
        assert_eq!(dog.outstanding(), 0);
        assert!(!dog.overdue(at(base, 31), HEALTH_DEADLINE));
        dog.armed(at(base, 31));
        assert!(!dog.overdue(at(base, 40), HEALTH_DEADLINE));
    }

    #[test]
    fn disarming_more_than_was_armed_is_not_a_panic() {
        // A worker can emit a line that correlates to no route (a crash
        // notice, a duplicate). The queue must underflow to empty, not wrap.
        let dog = Watchdog::new();
        dog.disarmed();
        dog.disarmed();
        assert_eq!(dog.outstanding(), 0);
    }

    #[test]
    fn three_queued_requests_are_overdue_at_the_fronts_age_not_the_backs() {
        // Only the first of three is slow; the watchdog must report overdue
        // at the FRONT's age (the request actually being worked on), not the
        // age of the third, most-recently-queued one.
        let dog = Watchdog::new();
        let base = Instant::now();
        dog.armed(base); // front: slow
        dog.armed(at(base, 1));
        dog.armed(at(base, 2)); // back: fresh
        assert_eq!(dog.outstanding(), 3);
        // At t=31 the front is 31s old (overdue past the 30s deadline) even
        // though the back is only 29s old.
        assert!(dog.overdue(at(base, 31), HEALTH_DEADLINE));
        // At t=29 nothing has crossed the deadline yet.
        assert!(!dog.overdue(at(base, 29), HEALTH_DEADLINE));
    }

    // ── SPECTRAPDF_HEALTH_DEADLINE_MS / SPECTRAPDF_HEALTH_WATCH_MS parsing ──
    //
    // `millis_from_env` must never panic on hostile input and must never
    // silently produce a value the caller did not intend from garbage.

    fn with_env<T>(name: &str, value: Option<&str>, f: impl FnOnce() -> T) -> T {
        // Serialized: env vars are process-global, and these tests run
        // concurrently with the rest of the crate's test binary.
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        match value {
            Some(v) => std::env::set_var(name, v),
            None => std::env::remove_var(name),
        }
        let result = f();
        std::env::remove_var(name);
        result
    }

    const PROBE_ENV: &str = "SPECTRAPDF_HEALTH_TEST_PROBE_MS";
    const FALLBACK: Duration = Duration::from_millis(12345);

    #[test]
    fn missing_env_is_the_compiled_default() {
        with_env(PROBE_ENV, None, || {
            assert_eq!(millis_from_env(PROBE_ENV, FALLBACK), FALLBACK);
        });
    }

    #[test]
    fn empty_env_is_the_compiled_default() {
        with_env(PROBE_ENV, Some(""), || {
            assert_eq!(millis_from_env(PROBE_ENV, FALLBACK), FALLBACK);
        });
    }

    #[test]
    fn whitespace_only_env_is_the_compiled_default() {
        with_env(PROBE_ENV, Some("   \t  "), || {
            assert_eq!(millis_from_env(PROBE_ENV, FALLBACK), FALLBACK);
        });
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        with_env(PROBE_ENV, Some("  250  "), || {
            assert_eq!(
                millis_from_env(PROBE_ENV, FALLBACK),
                Duration::from_millis(250)
            );
        });
    }

    #[test]
    fn negative_env_is_the_compiled_default() {
        // A u64 parse of a negative number is an error, not a wrap.
        with_env(PROBE_ENV, Some("-100"), || {
            assert_eq!(millis_from_env(PROBE_ENV, FALLBACK), FALLBACK);
        });
    }

    #[test]
    fn zero_env_is_honored_as_zero() {
        // Zero is a valid, parseable u64 — the deadline test relies on this
        // (`HEALTH_DEADLINE_ENV=0` to force every request overdue). Only the
        // watch INTERVAL floors away from zero, not the deadline.
        with_env(PROBE_ENV, Some("0"), || {
            assert_eq!(millis_from_env(PROBE_ENV, FALLBACK), Duration::from_millis(0));
        });
    }

    #[test]
    fn non_numeric_env_is_the_compiled_default() {
        with_env(PROBE_ENV, Some("not-a-number"), || {
            assert_eq!(millis_from_env(PROBE_ENV, FALLBACK), FALLBACK);
        });
    }

    #[test]
    fn huge_env_parses_without_panic() {
        with_env(PROBE_ENV, Some(&u64::MAX.to_string()), || {
            assert_eq!(
                millis_from_env(PROBE_ENV, FALLBACK),
                Duration::from_millis(u64::MAX)
            );
        });
    }

    #[test]
    fn watch_interval_floors_zero_to_one_millisecond_so_it_never_busy_loops() {
        with_env(HEALTH_WATCH_ENV, Some("0"), || {
            assert_eq!(health_watch_interval(), Duration::from_millis(1));
        });
    }

    #[test]
    fn watch_interval_default_is_unaffected_by_garbage_env() {
        with_env(HEALTH_WATCH_ENV, Some("garbage"), || {
            assert_eq!(health_watch_interval(), HEALTH_WATCH_INTERVAL);
        });
    }

    #[test]
    fn deadline_default_is_unaffected_by_garbage_env() {
        with_env(HEALTH_DEADLINE_ENV, Some("-5"), || {
            assert_eq!(health_deadline(), HEALTH_DEADLINE);
        });
    }

    // ── Cross-window and cross-router routing ───────────────────────────

    #[test]
    fn health_router_and_engine_router_hold_the_same_outer_id_and_each_resolves_only_its_own() {
        // Two independent routers, each with its own counter starting at 1:
        // the SAME numeric outer id names a different route in each table.
        // A response that arrived on one process must never resolve against
        // the other's table.
        let health = HealthRouter::new();
        let interactive = crate::engine::EngineRouter::new();

        let mut req_a = serde_json::json!({"id": 1, "method": "health"});
        let outer_a = crate::engine::route_with(&health.0, "window-a", &mut req_a)
            .expect("health router allocates an outer id");

        let mut req_b = serde_json::json!({"id": 1, "method": "interactive"});
        let outer_b = crate::engine::route_with(&interactive, "window-b", &mut req_b)
            .expect("interactive router allocates an outer id");

        // Both routers start their counters at 1 independently, so the outer
        // ids collide numerically.
        assert_eq!(outer_a, outer_b);

        let (label, inner) = health
            .0
            .take_route(outer_a)
            .expect("health router resolves its own route");
        assert_eq!(label, "window-a");
        assert_eq!(inner, serde_json::json!(1));

        // The interactive router's route for the SAME numeric id is untouched
        // by resolving the health router's route.
        let (label, inner) = interactive
            .take_route(outer_b)
            .expect("interactive router still resolves its own route");
        assert_eq!(label, "window-b");
        assert_eq!(inner, serde_json::json!(1));

        // Both are now retired in their own tables.
        assert!(health.0.take_route(outer_a).is_none());
        assert!(interactive.take_route(outer_b).is_none());
    }

    // Mock-`AppHandle` tests that exercise `kill`'s per-window `emit_to`
    // addressing and `on_window_destroyed`'s route scoping live in
    // `tests/health_worker.rs` instead of here: linking `tauri::test`'s mock
    // runtime into THIS crate's own `--lib` unit-test binary (as opposed to a
    // separate integration-test binary) corrupts the produced executable's
    // import table on this toolchain (`cargo test --lib` then fails every
    // test with `STATUS_ENTRYPOINT_NOT_FOUND` before any test body runs, lib
    // crate-type `["staticlib", "cdylib", "rlib"]` combined with the mock
    // runtime's WebView2 linkage). The same `AppHandle`-driven assertions run
    // correctly from the separate `tests/health_worker.rs` binary.
}
