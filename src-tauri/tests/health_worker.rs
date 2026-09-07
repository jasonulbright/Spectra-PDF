//! The health worker, live: a real Python process, a real deadline, a real kill.
//!
//! The unit tests in `health_engine.rs` cover the watchdog as a state machine
//! over timestamps. They cannot answer the question this file exists for —
//! whether an overdue request actually ends with a dead process and an
//! answered caller — because every one of those steps runs through an
//! `AppHandle`: the spawn, the id routing, the `emit_to` refusal, the kill.
//! So this test builds an app (Tauri's mock runtime) and drives the real
//! `health_engine::send`.
//!
//! Three properties, in the order a wedged worker meets them:
//!
//! 1. A request that outlives the deadline is REFUSED, with the English
//!    boundary message, addressed to the window that asked.
//! 2. The worker is gone afterwards — not merely forgotten by the state.
//! 3. The next request spawns a new worker and gets a real answer, so a kill
//!    costs the product one inspection rather than the feature.
//!
//! The deadline is driven to 0 ms through `SPECTRAPDF_HEALTH_DEADLINE_MS`
//! rather than by finding a document slow enough to overrun 30 s: a test that
//! races a Python process against a wall clock reports the machine's load, not
//! the code. With the bound at zero the first watchdog tick finds the request
//! overdue while the interpreter is still starting, which is the same code
//! path a genuinely pathological document takes 30 s later.
//!
//! Provisioning is the same as `cli_bytecode.rs`: an unprovisioned checkout
//! skips, and `SPECTRAPDF_REQUIRE_LIVE_CLI=1` turns that skip into a failure
//! so a runner that vendored the runtime cannot report green without having
//! launched the worker. The app resolves its resources beside the RUNNING
//! executable, which for an integration test is `target/<profile>/deps`, so
//! the provisioned `python/` and `engine/` are reached from there through
//! directory junctions — the runtime is hundreds of megabytes and nothing here
//! writes into it.

use std::path::Path;
use std::process::Command;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use spectrapdf_lib::health_engine::{self, HealthEngineState, HealthRouter};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};

const REQUIRE_LIVE: &str = "SPECTRAPDF_REQUIRE_LIVE_CLI";
const WINDOW: &str = "main";

/// The refusal `health_engine` answers a killed worker's callers with. Spelled
/// out here rather than imported: the message crosses a process boundary into
/// the ledger, so a change to it is a change to an interface and must fail a
/// test rather than travel silently.
const DEADLINE_REFUSAL: &str = "health inspection exceeded its deadline";

fn junction(link: &Path, target: &Path) {
    if link.exists() {
        return;
    }
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .expect("spawn cmd for mklink");
    assert!(
        status.success(),
        "mklink /J {} -> {}",
        link.display(),
        target.display()
    );
}

/// Whether a pid is still a running process.
fn alive(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("spawn tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

fn request(id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// The response carrying `id`, discarding any other traffic on the channel.
fn await_response(rx: &Receiver<String>, id: u64, within: Duration) -> serde_json::Value {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "no response for id {id} within {within:?}");
        let payload = rx
            .recv_timeout(left)
            .unwrap_or_else(|e| panic!("no response for id {id}: {e}"));
        let json: serde_json::Value =
            serde_json::from_str(&payload).unwrap_or_else(|e| panic!("bad payload {payload}: {e}"));
        if json.get("id").and_then(|v| v.as_u64()) == Some(id) {
            return json;
        }
    }
}

/// Serializes the two live-process tests in this file. Both drive real
/// worker processes through `SPECTRAPDF_HEALTH_DEADLINE_MS` /
/// `SPECTRAPDF_HEALTH_WATCH_MS`, which are process-wide env vars — libtest
/// runs test functions as threads in one process by default, so two such
/// tests running concurrently stomp each other's deadline/watch settings
/// (observed: a begin call racing another test's zeroed deadline never
/// returns a token). The mock-app tests below touch no env vars and need no
/// lock.
static LIVE_PROCESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn an_overdue_request_is_refused_the_worker_dies_and_the_next_request_respawns_it() {
    let _guard = LIVE_PROCESS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // The test binary is `target/<profile>/deps/...`; the runtime is
    // provisioned one level up, beside the product executable.
    let here = std::env::current_exe().expect("test exe");
    let here_dir = here.parent().expect("test exe dir").to_path_buf();
    let exe_dir = here_dir.parent().expect("profile dir").to_path_buf();
    let python = exe_dir.join("python").join("python.exe");
    let engine = exe_dir.join("engine");
    if !python.is_file() || !engine.join("__startup__.py").is_file() {
        assert!(
            std::env::var_os(REQUIRE_LIVE).map_or(true, |v| v != "1"),
            "{REQUIRE_LIVE}=1 but no provisioned python/engine under {} (python: {}, engine: {})",
            exe_dir.display(),
            python.is_file(),
            engine.join("__startup__.py").is_file()
        );
        eprintln!(
            "skipped: no provisioned python/engine under {} (see punchlist § Dev environment notes)",
            exe_dir.display()
        );
        return;
    }

    // Where the app under test will look: beside the RUNNING binary, which is
    // the test binary, not the product one.
    junction(&here_dir.join("python"), &exe_dir.join("python"));
    junction(&here_dir.join("engine"), &engine);

    // A watcher that ticks once a second cannot observe anything a test is
    // willing to wait for; the deadline itself stays at the shipped default
    // until the overdue case is set up.
    std::env::set_var(health_engine::HEALTH_WATCH_ENV, "25");
    std::env::remove_var(health_engine::HEALTH_DEADLINE_ENV);

    let app = mock_builder()
        .plugin(tauri_plugin_shell::init())
        .manage(HealthEngineState::new())
        .manage(HealthRouter::new())
        .build(mock_context(noop_assets()))
        .expect("build mock app");
    let window = WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App("index.html".into()))
        .build()
        .expect("build mock window");

    let (tx, rx) = channel::<String>();
    window.listen("engine:response", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    let handle = app.handle().clone();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("sample.pdf");
    let file = fixture.to_string_lossy().to_string();

    // ── 1. Overdue ────────────────────────────────────────────────────────
    // Zero is a bound every request is past, so this is the wedged worker
    // without a document engineered to wedge one.
    std::env::set_var(health_engine::HEALTH_DEADLINE_ENV, "0");
    tauri::async_runtime::block_on(health_engine::send(
        &handle,
        WINDOW,
        request(1, "document_health_begin", serde_json::json!({ "file": file })),
    ))
    .expect("send the overdue request");

    let refused = await_response(&rx, 1, Duration::from_secs(60));
    assert_eq!(
        refused
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str()),
        Some(DEADLINE_REFUSAL),
        "the overdue request was not refused: {refused}"
    );
    assert!(
        refused.get("result").is_none(),
        "a refusal must not also carry a result: {refused}"
    );

    // ── 2. The worker is gone ─────────────────────────────────────────────
    let held = tauri::async_runtime::block_on(async {
        handle
            .state::<HealthEngineState>()
            .child
            .lock()
            .await
            .is_some()
    });
    assert!(!held, "the killed worker is still held as the current one");
    assert_eq!(
        handle.state::<HealthEngineState>().watchdog.outstanding(),
        0,
        "the kill left the watchdog armed, so the respawned worker inherits a deadline"
    );

    // ── 3. The next request respawns and answers ──────────────────────────
    std::env::remove_var(health_engine::HEALTH_DEADLINE_ENV);
    tauri::async_runtime::block_on(health_engine::send(
        &handle,
        WINDOW,
        request(2, "document_health_begin", serde_json::json!({ "file": file })),
    ))
    .expect("send after the kill");

    let answered = await_response(&rx, 2, Duration::from_secs(120));
    let result = answered
        .get("result")
        .unwrap_or_else(|| panic!("the respawned worker did not answer: {answered}"));
    assert_eq!(
        handle.state::<HealthEngineState>().watchdog.outstanding(),
        0,
        "a fast response left a phantom watchdog entry behind"
    );
    assert_eq!(
        result.get("status").and_then(|v| v.as_str()),
        Some("collected"),
        "unexpected health head: {result}"
    );
    let token = result
        .get("token")
        .and_then(|v| v.as_str())
        .expect("run token")
        .to_string();
    assert!(!token.is_empty(), "a stepped run needs a token: {result}");

    tauri::async_runtime::block_on(health_engine::send(
        &handle,
        WINDOW,
        request(3, "document_health_end", serde_json::json!({ "token": token })),
    ))
    .expect("send the run's end");
    let ended = await_response(&rx, 3, Duration::from_secs(60));
    assert!(
        ended.get("result").is_some(),
        "ending the run failed: {ended}"
    );

    // ── The kill is an OS-level kill ──────────────────────────────────────
    // Read from the live worker, so the pid is one that certainly existed.
    let pid = tauri::async_runtime::block_on(async {
        handle
            .state::<HealthEngineState>()
            .child
            .lock()
            .await
            .as_ref()
            .map(|c| c.pid())
    })
    .expect("the respawned worker is running");
    assert!(alive(pid), "the worker answering requests is not running");

    assert!(tauri::async_runtime::block_on(health_engine::kill(&handle)));
    assert!(
        !alive(pid),
        "the kill barrier returned before the health worker died (pid {pid})"
    );

    // ── 4. Two windows cannot both win the check-then-spawn race ─────────
    let before = handle.state::<HealthEngineState>().worker_generation();
    let first = request(
        4,
        "document_health_begin",
        serde_json::json!({ "file": file }),
    );
    let second = request(
        5,
        "document_health_begin",
        serde_json::json!({ "file": file }),
    );
    let (sent_a, sent_b) = tauri::async_runtime::block_on(async {
        tokio::join!(
            health_engine::send(&handle, WINDOW, first),
            health_engine::send(&handle, WINDOW, second),
        )
    });
    sent_a.expect("first simultaneous send");
    sent_b.expect("second simultaneous send");
    assert_eq!(
        handle.state::<HealthEngineState>().worker_generation(),
        before + 1,
        "simultaneous sends spawned more than one worker generation"
    );
    assert!(tauri::async_runtime::block_on(health_engine::kill(&handle)));

    std::env::remove_var(health_engine::HEALTH_WATCH_ENV);
}

/// A token minted before a deadline kill names a run that lived in the
/// killed process's memory. The respawned worker holds no such run — its
/// `_RUNS` table starts empty like any freshly spawned process — so stepping
/// the pre-kill token against the new process must report the run as lost
/// rather than silently resuming or hanging.
#[test]
fn a_pre_kill_token_stepped_against_the_respawned_worker_reports_the_run_lost() {
    let _guard = LIVE_PROCESS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let here = std::env::current_exe().expect("test exe");
    let here_dir = here.parent().expect("test exe dir").to_path_buf();
    let exe_dir = here_dir.parent().expect("profile dir").to_path_buf();
    let python = exe_dir.join("python").join("python.exe");
    let engine = exe_dir.join("engine");
    if !python.is_file() || !engine.join("__startup__.py").is_file() {
        assert!(
            std::env::var_os(REQUIRE_LIVE).map_or(true, |v| v != "1"),
            "{REQUIRE_LIVE}=1 but no provisioned python/engine under {} (python: {}, engine: {})",
            exe_dir.display(),
            python.is_file(),
            engine.join("__startup__.py").is_file()
        );
        eprintln!(
            "skipped: no provisioned python/engine under {} (see punchlist § Dev environment notes)",
            exe_dir.display()
        );
        return;
    }

    junction(&here_dir.join("python"), &exe_dir.join("python"));
    junction(&here_dir.join("engine"), &engine);

    std::env::set_var(health_engine::HEALTH_WATCH_ENV, "25");
    std::env::remove_var(health_engine::HEALTH_DEADLINE_ENV);

    let app = mock_builder()
        .plugin(tauri_plugin_shell::init())
        .manage(HealthEngineState::new())
        .manage(HealthRouter::new())
        .build(mock_context(noop_assets()))
        .expect("build mock app");
    let window = WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App("index.html".into()))
        .build()
        .expect("build mock window");

    let (tx, rx) = channel::<String>();
    window.listen("engine:response", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    let handle = app.handle().clone();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("sample.pdf");
    let file = fixture.to_string_lossy().to_string();

    // ── 1. A normal run, before any kill: capture its token ────────────────
    tauri::async_runtime::block_on(health_engine::send(
        &handle,
        WINDOW,
        request(1, "document_health_begin", serde_json::json!({ "file": file })),
    ))
    .expect("send the pre-kill begin");
    let begun = await_response(&rx, 1, Duration::from_secs(60));
    let stale_token = begun
        .get("result")
        .and_then(|r| r.get("token"))
        .and_then(|v| v.as_str())
        .expect("pre-kill begin returns a token")
        .to_string();

    // ── 2. Kill the worker outright ─────────────────────────────────────────
    // The behaviour under test is what a FRESH process does with a stale
    // token, not the deadline race that produces the kill (that race is
    // already covered by the sibling test above) — a warm interpreter can
    // answer a small fixture inside one watchdog tick, so racing the
    // deadline here would make this test flaky for a property it does not
    // exist to prove. `kill` is the same call the deadline enforcement
    // makes internally.
    let old_pid = tauri::async_runtime::block_on(async {
        handle
            .state::<HealthEngineState>()
            .child
            .lock()
            .await
            .as_ref()
            .map(|c| c.pid())
    })
    .expect("a worker is running before the kill");
    assert!(
        tauri::async_runtime::block_on(health_engine::kill(&handle)),
        "expected a running worker to kill"
    );
    // `kill` is a lifecycle barrier: it returns only after this generation's
    // Terminated event. The immediate send below is deliberately not padded
    // with a polling loop; that old workaround hid the respawn race.
    assert!(!alive(old_pid), "the pre-kill worker (pid {old_pid}) never exited");

    // ── 3. Step the PRE-KILL token against the newly respawned process ─────
    std::env::remove_var(health_engine::HEALTH_DEADLINE_ENV);
    tauri::async_runtime::block_on(health_engine::send(
        &handle,
        WINDOW,
        request(3, "document_health_step", serde_json::json!({ "token": stale_token })),
    ))
    .expect("send the stale-token step");
    let stepped = await_response(&rx, 3, Duration::from_secs(60));
    let result = stepped
        .get("result")
        .unwrap_or_else(|| panic!("stale-token step did not return a result: {stepped}"));
    assert_eq!(
        result.get("done").and_then(|v| v.as_bool()),
        Some(true),
        "a run the new process never held must report done: {result}"
    );
    let facts = result
        .get("facts")
        .and_then(|v| v.as_array())
        .expect("result carries a facts array");
    assert!(
        facts
            .iter()
            .any(|f| f.get("code").and_then(|k| k.as_str()) == Some("health.runLost")),
        "expected a health.runLost fact for the pre-kill token, got: {result}"
    );

    std::env::remove_var(health_engine::HEALTH_WATCH_ENV);
}

// ── Mock-app tests: no live process, just routing and `emit_to` addressing ──
//
// These need no provisioned python/engine and never skip: they drive
// `health_engine::kill` and `health_engine::on_window_destroyed` against a
// mock `AppHandle` with two windows, asserting the per-window `emit_to`
// contract without spawning anything. They live here rather than in
// `health_engine.rs`'s own `#[cfg(test)] mod tests` because linking
// `tauri::test`'s mock runtime into THIS crate's `--lib` unit-test binary
// (as opposed to this separate integration-test binary) corrupts the
// produced executable on this toolchain: `cargo test --lib` fails every
// test with `STATUS_ENTRYPOINT_NOT_FOUND` before any test body runs, with
// the lib crate-type `["staticlib", "cdylib", "rlib"]` combined with the
// mock runtime's WebView2 linkage the suspected cause. The identical
// `AppHandle`-driven code runs cleanly from this integration binary.

fn mock_request(id: &str) -> serde_json::Value {
    serde_json::json!({ "id": id })
}

/// Two windows, each with its own listener for `engine:response`, sharing no
/// state but the app.
fn two_window_mock_app() -> (
    tauri::AppHandle<tauri::test::MockRuntime>,
    Receiver<serde_json::Value>,
    Receiver<serde_json::Value>,
) {
    let app = mock_builder()
        .manage(HealthRouter::new())
        .manage(HealthEngineState::new())
        .build(mock_context(noop_assets()))
        .expect("build mock app");
    let window_a = WebviewWindowBuilder::new(&app, "window-a", WebviewUrl::App("index.html".into()))
        .build()
        .expect("build window-a");
    let window_b = WebviewWindowBuilder::new(&app, "window-b", WebviewUrl::App("index.html".into()))
        .build()
        .expect("build window-b");

    let (tx_a, rx_a) = channel::<serde_json::Value>();
    window_a.listen("engine:response", move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).expect("payload is JSON");
        let _ = tx_a.send(payload);
    });
    let (tx_b, rx_b) = channel::<serde_json::Value>();
    window_b.listen("engine:response", move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).expect("payload is JSON");
        let _ = tx_b.send(payload);
    });

    (app.handle().clone(), rx_a, rx_b)
}

/// Route one outstanding request per window through the health router,
/// returning each request's outer (process-wide) id.
fn route_two_outstanding(app: &tauri::AppHandle<tauri::test::MockRuntime>) -> (u64, u64) {
    let mut req_a = mock_request("call-a");
    let outer_a =
        spectrapdf_lib::engine::route_with(&app.state::<HealthRouter>().0, "window-a", &mut req_a)
            .expect("route call for window-a");
    let mut req_b = mock_request("call-b");
    let outer_b =
        spectrapdf_lib::engine::route_with(&app.state::<HealthRouter>().0, "window-b", &mut req_b)
            .expect("route call for window-b");
    (outer_a, outer_b)
}

#[test]
fn kill_refuses_every_outstanding_request_addressed_to_its_own_window_only() {
    let (app, rx_a, rx_b) = two_window_mock_app();
    route_two_outstanding(&app);
    app.state::<HealthEngineState>().watchdog.armed(Instant::now());
    app.state::<HealthEngineState>().watchdog.armed(Instant::now());

    // No child process was ever started, so `kill` reports it killed nothing
    // — but it must still refuse every outstanding route, exactly as it does
    // when a real overdue worker dies.
    assert!(
        !tauri::async_runtime::block_on(health_engine::kill(&app)),
        "no child was running"
    );

    let msg_a = rx_a
        .recv_timeout(Duration::from_secs(5))
        .expect("window-a receives its own refusal");
    let msg_b = rx_b
        .recv_timeout(Duration::from_secs(5))
        .expect("window-b receives its own refusal");

    assert_eq!(msg_a["id"], serde_json::json!("call-a"));
    assert_eq!(msg_a["error"]["message"], serde_json::json!(DEADLINE_REFUSAL));
    assert_eq!(msg_b["id"], serde_json::json!("call-b"));
    assert_eq!(msg_b["error"]["message"], serde_json::json!(DEADLINE_REFUSAL));

    // Nothing further arrives on either channel: a kill answers each
    // outstanding request exactly once, and window-a's refusal never reaches
    // window-b's channel or vice versa (no broadcast).
    assert!(rx_a.recv_timeout(Duration::from_millis(200)).is_err());
    assert!(rx_b.recv_timeout(Duration::from_millis(200)).is_err());
}

#[test]
fn kill_leaves_the_route_table_and_watchdog_empty_for_the_respawn() {
    let (app, rx_a, rx_b) = two_window_mock_app();
    route_two_outstanding(&app);
    app.state::<HealthEngineState>().watchdog.armed(Instant::now());
    app.state::<HealthEngineState>().watchdog.armed(Instant::now());

    tauri::async_runtime::block_on(health_engine::kill(&app));
    let _ = rx_a.recv_timeout(Duration::from_secs(5));
    let _ = rx_b.recv_timeout(Duration::from_secs(5));

    assert_eq!(
        app.state::<HealthEngineState>().watchdog.outstanding(),
        0,
        "a respawned worker must start with an unarmed watchdog"
    );

    // The route table works cleanly after the kill: a NEW route registered
    // post-kill resolves, proving the table is a live, working table (not
    // merely empty because routing itself broke).
    let mut probe = mock_request("probe-after-kill");
    let outer = spectrapdf_lib::engine::route_with(&app.state::<HealthRouter>().0, "window-a", &mut probe)
        .expect("route a fresh probe");
    assert!(app.state::<HealthRouter>().0.take_route(outer).is_some());
}

#[test]
fn window_destroyed_drops_only_that_labels_routes_and_never_kills_the_worker() {
    let (app, rx_a, rx_b) = two_window_mock_app();
    let (outer_a, outer_b) = route_two_outstanding(&app);

    health_engine::on_window_destroyed(&app, "window-a");

    // window-a's route is gone; window-b's survives untouched.
    assert!(app.state::<HealthRouter>().0.take_route(outer_a).is_none());
    let (label, inner) = app
        .state::<HealthRouter>()
        .0
        .take_route(outer_b)
        .expect("window-b's route survives window-a's destruction");
    assert_eq!(label, "window-b");
    assert_eq!(inner, serde_json::json!("call-b"));

    // No refusal was emitted to either window: destroying one window is not
    // a kill, and an abandoned route is dropped silently, not answered.
    assert!(rx_a.recv_timeout(Duration::from_millis(200)).is_err());
    assert!(rx_b.recv_timeout(Duration::from_millis(200)).is_err());

    // The worker was never touched by the window destruction: nothing here
    // called `kill`, so a subsequent kill still reports there was no
    // running child left over from before.
    assert!(!tauri::async_runtime::block_on(health_engine::kill(&app)));
}
