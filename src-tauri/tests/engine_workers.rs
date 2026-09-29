//! The interactive engine, live: one real Python worker per window.
//!
//! The unit tests in `engine.rs` cover routing as a table. This file answers
//! what only real processes can: that a short call from one window completes
//! while another window's long call is still running, that a cancel reaches
//! the worker holding the request, that one worker's death fails only its own
//! window's calls, and that a destroyed window's worker is stopped for good.
//!
//! The workers run `tests/fixtures/engine_worker_harness.py`: the real engine
//! from `src/engine` plus a cancellable `test_sleep` and a `test_pid`, which
//! the shipped engine does not register. An unprovisioned checkout (no
//! `resources/python/python.exe`) skips, and `SPECTRAPDF_REQUIRE_LIVE_CLI=1`
//! turns that skip into a failure.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use spectrapdf_lib::app_windows::ClaimState;
use spectrapdf_lib::engine::{self, EngineRouter, EngineState};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};

const REQUIRE_LIVE: &str = "SPECTRAPDF_REQUIRE_LIVE_CLI";
const A: &str = "main";
const B: &str = "doc-1";

fn provisioned_python() -> Option<PathBuf> {
    let python = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("resources")
        .join("python")
        .join("python.exe");
    if python.is_file() {
        return Some(python);
    }
    assert!(
        std::env::var_os(REQUIRE_LIVE).is_none_or(|v| v != "1"),
        "{REQUIRE_LIVE}=1 but {} is not provisioned",
        python.display()
    );
    eprintln!("skipped: {} is not provisioned", python.display());
    None
}

fn alive(pid: u64) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("spawn tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

fn request(id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// Any response delivered to a window within `within`.
fn next_response(rx: &Receiver<String>, within: Duration) -> Option<serde_json::Value> {
    rx.recv_timeout(within)
        .ok()
        .map(|payload| serde_json::from_str(&payload).expect("response is JSON"))
}

/// The response carrying `id`, discarding any other traffic.
fn await_response(rx: &Receiver<String>, id: u64, within: Duration) -> serde_json::Value {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let json = next_response(rx, left)
            .unwrap_or_else(|| panic!("no response for id {id} within {within:?}"));
        if json.get("id").and_then(|v| v.as_u64()) == Some(id) {
            return json;
        }
    }
}

struct Live {
    app: tauri::App<MockRuntime>,
    a: Receiver<String>,
    b: Receiver<String>,
}

fn live_app(python: &Path) -> Live {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let harness = manifest.join("tests").join("fixtures").join("engine_worker_harness.py");
    let engine_parent = manifest.join("..").join("src");
    let app = mock_builder()
        .plugin(tauri_plugin_shell::init())
        .manage(EngineState::with_command(
            python.to_string_lossy().into_owned(),
            vec![
                "-s".to_string(),
                harness.to_string_lossy().into_owned(),
                engine_parent.to_string_lossy().into_owned(),
            ],
        ))
        .manage(EngineRouter::new())
        .manage(ClaimState::new())
        .build(mock_context(noop_assets()))
        .expect("build mock app");
    let mut receivers = Vec::new();
    for label in [A, B] {
        let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
            .build()
            .expect("build mock window");
        let (tx, rx) = channel::<String>();
        window.listen("engine:response", move |event| {
            let _ = tx.send(event.payload().to_string());
        });
        receivers.push(rx);
    }
    let b = receivers.pop().unwrap();
    let a = receivers.pop().unwrap();
    Live { app, a, b }
}

fn send(live: &Live, label: &str, req: serde_json::Value) {
    let handle = live.app.handle().clone();
    tauri::async_runtime::block_on(engine::write_request(&handle, label, req))
        .unwrap_or_else(|e| panic!("send to {label}: {e}"));
}

fn pid_of(live: &Live, label: &str, id: u64) -> u64 {
    send(live, label, request(id, "test_pid", serde_json::json!({})));
    let rx = if label == A { &live.a } else { &live.b };
    let reply = await_response(rx, id, Duration::from_secs(120));
    reply["result"].as_u64().unwrap_or_else(|| panic!("no pid: {reply}"))
}

#[test]
fn a_short_call_in_one_window_completes_while_another_windows_long_call_runs() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();

    // Both workers are up before the race starts, so the timing below
    // measures queueing and not interpreter start-up.
    let pid_a = pid_of(&live, A, 100);
    let pid_b = pid_of(&live, B, 100);
    assert_ne!(pid_a, pid_b, "two windows share one worker process");

    // Window A starts a call that would run for two minutes.
    send(&live, A, request(1, "test_sleep", serde_json::json!({ "seconds": 120 })));

    // Window B uses the SAME inner id; it is answered by its own worker, and
    // only window B hears it.
    let started = Instant::now();
    send(&live, B, request(1, "test_pid", serde_json::json!({})));
    let reply = await_response(&live.b, 1, Duration::from_secs(20));
    assert_eq!(reply["result"].as_u64(), Some(pid_b), "unexpected reply: {reply}");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "window B waited behind window A"
    );
    assert!(
        next_response(&live.a, Duration::from_millis(200)).is_none(),
        "window A's long call answered early or window A heard window B"
    );

    // A cancel from window B cannot reach window A's request.
    assert!(!tauri::async_runtime::block_on(engine::cancel_request(
        &handle,
        B,
        &serde_json::json!(1)
    ))
    .unwrap());
    // Window A's own cancel stops it at the next safe point.
    assert!(tauri::async_runtime::block_on(engine::cancel_request(
        &handle,
        A,
        &serde_json::json!(1)
    ))
    .unwrap());
    let cancelled = await_response(&live.a, 1, Duration::from_secs(20));
    assert!(cancelled.get("error").is_some(), "the cancelled call did not fail: {cancelled}");

    // The same worker keeps serving window A.
    assert_eq!(pid_of(&live, A, 2), pid_a);
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn one_workers_death_fails_only_its_own_windows_calls_and_the_next_call_respawns_it() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let pid_a = pid_of(&live, A, 100);
    let pid_b = pid_of(&live, B, 100);

    send(&live, A, request(1, "test_sleep", serde_json::json!({ "seconds": 120 })));
    send(&live, B, request(1, "test_sleep", serde_json::json!({ "seconds": 3 })));
    let status = Command::new("taskkill")
        .args(["/F", "/PID", &pid_a.to_string()])
        .status()
        .expect("spawn taskkill");
    assert!(status.success());

    let stopped = await_response(&live.a, 1, Duration::from_secs(30));
    assert!(
        stopped["error"]["message"].as_str().is_some_and(|m| m.contains("stopped")),
        "window A was not told its worker stopped: {stopped}"
    );
    let finished = await_response(&live.b, 1, Duration::from_secs(30));
    assert_eq!(finished["result"]["slept"].as_u64(), Some(3), "window B's call was disturbed: {finished}");
    assert_eq!(pid_of(&live, B, 2), pid_b);

    let respawned = pid_of(&live, A, 2);
    assert_ne!(respawned, pid_a);
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_destroyed_windows_worker_is_stopped_and_never_respawned() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let pid_b = pid_of(&live, B, 100);
    let pid_a = pid_of(&live, A, 100);

    send(&live, B, request(1, "test_sleep", serde_json::json!({ "seconds": 120 })));
    engine::retire_window(&handle, B);
    let deadline = Instant::now() + Duration::from_secs(30);
    while alive(pid_b) {
        assert!(Instant::now() < deadline, "the destroyed window's worker is still running");
        std::thread::sleep(Duration::from_millis(100));
    }
    let refused = tauri::async_runtime::block_on(engine::write_request(
        &handle,
        B,
        request(2, "test_pid", serde_json::json!({})),
    ));
    assert!(refused.is_err(), "a destroyed window spawned a new worker");
    assert!(
        handle.state::<EngineRouter>().outstanding().get(B).is_none(),
        "the destroyed window still has routed requests"
    );

    // The other window's worker is untouched.
    assert_eq!(pid_of(&live, A, 2), pid_a);
    engine::retire_window(&handle, A);
    let deadline = Instant::now() + Duration::from_secs(30);
    while alive(pid_a) {
        assert!(Instant::now() < deadline, "an idle retired worker is still running");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The drain deadline is a process-wide environment variable; the tests that
/// read or set it run one at a time.
static DRAIN_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Give window `label` a folder claim, so every request it sends is a write.
fn claim_output(live: &Live, label: &str, root: &Path) -> String {
    let root = root.to_string_lossy().into_owned();
    let outcome = live
        .app
        .state::<ClaimState>()
        .claim_roots(std::slice::from_ref(&root), label)
        .expect("claim the output folder");
    assert!(outcome.granted, "the output folder was not granted to {label}");
    root
}

fn wait_dead(pid: u64, within: Duration) {
    let deadline = Instant::now() + within;
    while alive(pid) {
        assert!(Instant::now() < deadline, "pid {pid} is still running");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn a_closed_windows_write_finishes_before_its_worker_stops_and_the_exit_wait_covers_it() {
    let _guard = DRAIN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var(engine::ENGINE_DRAIN_ENV);
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let pid_b = pid_of(&live, B, 100);
    let root = claim_output(&live, B, scratch.path());

    send(&live, B, request(1, "test_sleep", serde_json::json!({ "seconds": 3 })));
    let started = Instant::now();
    engine::retire_window(&handle, B);
    live.app.state::<ClaimState>().release_label(B);
    std::thread::sleep(Duration::from_millis(800));
    assert!(alive(pid_b), "a closed window's write was cut off");
    assert!(
        !live.app.state::<ClaimState>().claim_roots(std::slice::from_ref(&root), A).unwrap().granted,
        "the write's folder was released while the write was running"
    );

    // The same wait the app's exit takes.
    assert!(tauri::async_runtime::block_on(engine::wait_for_writes(&handle, Duration::from_secs(60))));
    assert!(started.elapsed() >= Duration::from_secs(2), "the exit wait returned before the write finished");
    wait_dead(pid_b, Duration::from_secs(30));
    assert!(
        live.app.state::<ClaimState>().claim_roots(std::slice::from_ref(&root), A).unwrap().granted,
        "the finished write kept its folder"
    );
    engine::retire_window(&handle, A);
}

#[test]
fn a_closed_windows_hung_write_is_stopped_at_the_drain_deadline_and_reported() {
    let _guard = DRAIN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let pid_b = pid_of(&live, B, 100);
    let root = claim_output(&live, B, scratch.path());
    let (tx, stopped_rx) = channel::<String>();
    live.app
        .get_webview_window(A)
        .unwrap()
        .listen("engine:writeStopped", move |event| {
            let _ = tx.send(event.payload().to_string());
        });

    std::env::set_var(engine::ENGINE_DRAIN_ENV, "500");
    send(&live, B, request(1, "test_sleep", serde_json::json!({ "seconds": 120 })));
    engine::retire_window(&handle, B);
    live.app.state::<ClaimState>().release_label(B);
    let cut = stopped_rx
        .recv_timeout(Duration::from_secs(30))
        .expect("no write-stopped notice reached the open window");
    std::env::remove_var(engine::ENGINE_DRAIN_ENV);
    assert_eq!(cut, "1");
    wait_dead(pid_b, Duration::from_secs(30));
    assert_eq!(handle.state::<EngineRouter>().writes_in_flight(None), 0);
    assert!(
        live.app.state::<ClaimState>().claim_roots(std::slice::from_ref(&root), A).unwrap().granted,
        "the stopped write kept its folder"
    );
    engine::retire_window(&handle, A);
}

#[test]
fn an_assent_restart_returns_at_once_and_replaces_a_writing_worker_after_its_write() {
    let _guard = DRAIN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var(engine::ENGINE_DRAIN_ENV);
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let pid_a = pid_of(&live, A, 100);
    let pid_b = pid_of(&live, B, 100);
    claim_output(&live, A, scratch.path());

    send(&live, A, request(1, "test_sleep", serde_json::json!({ "seconds": 3 })));
    let asked = Instant::now();
    tauri::async_runtime::block_on(engine::restart_for_assent(&handle));
    assert!(asked.elapsed() < Duration::from_secs(2), "the caller waited on a write in flight");
    // The idle worker is already stopped when the call returns.
    wait_dead(pid_b, Duration::from_secs(10));
    assert!(alive(pid_a), "the write in flight was cut");
    let finished = await_response(&live.a, 1, Duration::from_secs(10));
    assert_eq!(finished["result"]["slept"].as_u64(), Some(3), "the restart cut the write: {finished}");
    wait_dead(pid_a, Duration::from_secs(30));
    wait_dead(pid_b, Duration::from_secs(30));
    assert_ne!(pid_of(&live, A, 2), pid_a);
    assert_ne!(pid_of(&live, B, 2), pid_b);
    live.app.state::<ClaimState>().release_label(A);
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

fn call_ok(live: &Live, label: &str, id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    send(live, label, request(id, method, params));
    let rx = if label == A { &live.a } else { &live.b };
    let reply = await_response(rx, id, Duration::from_secs(120));
    assert!(reply.get("error").is_none(), "{method} failed: {reply}");
    reply["result"].clone()
}

#[test]
fn password_and_certificate_documents_keep_working_after_their_worker_is_replaced() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let path = |name: &str| root.join(name.replace('/', "\\")).to_string_lossy().into_owned();
    let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("sample.pdf");
    let sample = sample.to_string_lossy().into_owned();
    for folder in ["pw", "cert"] {
        std::fs::create_dir(root.join(folder)).unwrap();
    }
    let identity = call_ok(&live, B, 1, "test_identity", serde_json::json!({ "folder": path("") }));
    let pfx = identity["pfx"].as_str().unwrap().to_string();
    call_ok(&live, B, 2, "encrypt", serde_json::json!({
        "file": sample, "output": path("pw/doc.pdf"), "user_password": "u", "owner_password": "o",
    }));
    call_ok(&live, B, 3, "encrypt_pubkey", serde_json::json!({
        "file": sample, "output": path("cert/doc.pdf"), "certs": [identity["cert"]],
    }));
    std::fs::copy(path("pw/doc.pdf"), path("pw/stage.pdf")).unwrap();

    let opened = call_ok(&live, B, 4, "open_document", serde_json::json!({ "path": path("pw/doc.pdf"), "password": "u" }));
    assert_eq!(opened["opener"], "user");
    let shared = call_ok(&live, B, 5, "share_document", serde_json::json!({ "path": path("pw/doc.pdf"), "alias": path("pw/stage.pdf") }));
    assert_eq!(shared["shared"], true);
    let opened = call_ok(&live, B, 6, "open_pubkey_document", serde_json::json!({
        "path": path("cert/doc.pdf"), "pfx": pfx, "password": "test-pass",
    }));
    assert_eq!(opened["opener"], "recipient");
    let pid = pid_of(&live, B, 7);

    tauri::async_runtime::block_on(engine::restart_for_assent(&handle));
    wait_dead(pid, Duration::from_secs(10));
    assert_ne!(pid_of(&live, B, 8), pid);

    for (id, file) in [(9, "pw/doc.pdf"), (10, "pw/stage.pdf")] {
        let pages = call_ok(&live, B, id, "get_page_count", serde_json::json!({ "file": path(file) }));
        assert!(pages["pages"].as_u64().is_some_and(|n| n > 0), "{file}: {pages}");
    }
    let held = call_ok(&live, B, 11, "document_permissions", serde_json::json!({ "path": path("pw/doc.pdf") }));
    assert_eq!(held["opener"], "user");
    let resealed = call_ok(&live, B, 12, "pubkey_reseal", serde_json::json!({
        "path": path("cert/doc.pdf"), "output": path("cert/stage.sealed"),
    }));
    assert_eq!(resealed["output"].as_str(), Some(path("cert/stage.sealed").as_str()), "{resealed}");

    // A worker that crashes is replaced the same way.
    let pid = pid_of(&live, B, 13);
    assert!(Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status().unwrap().success());
    wait_dead(pid, Duration::from_secs(10));
    let pages = call_ok(&live, B, 14, "get_page_count", serde_json::json!({ "file": path("pw/doc.pdf") }));
    assert!(pages["pages"].as_u64().is_some_and(|n| n > 0), "{pages}");

    // A closed document is not given back.
    call_ok(&live, B, 15, "close_document", serde_json::json!({ "path": path("pw/doc.pdf") }));
    tauri::async_runtime::block_on(engine::restart_for_assent(&handle));
    send(&live, B, request(16, "get_page_count", serde_json::json!({ "file": path("pw/doc.pdf") })));
    let refused = await_response(&live.b, 16, Duration::from_secs(120));
    assert!(refused.get("error").is_some(), "a closed document still opened: {refused}");
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_credential_the_replacement_worker_refuses_is_told_to_its_window() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let doc = scratch.path().join("doc.pdf").to_string_lossy().into_owned();
    let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("sample.pdf");
    call_ok(&live, B, 1, "encrypt", serde_json::json!({
        "file": sample.to_string_lossy(), "output": doc, "user_password": "u", "owner_password": "o",
    }));
    call_ok(&live, B, 2, "open_document", serde_json::json!({ "path": doc, "password": "u" }));
    let (tx, lost) = channel::<String>();
    live.app.get_webview_window(B).unwrap().listen(engine::CREDENTIAL_LOST_EVENT, move |event| {
        let _ = tx.send(event.payload().to_string());
    });
    let pid = pid_of(&live, B, 3);
    std::fs::remove_file(&doc).unwrap();
    tauri::async_runtime::block_on(engine::restart_for_assent(&handle));
    wait_dead(pid, Duration::from_secs(10));
    pid_of(&live, B, 4);
    let payload: serde_json::Value =
        serde_json::from_str(&lost.recv_timeout(Duration::from_secs(60)).expect("no credential-lost event")).unwrap();
    assert_eq!(payload["path"].as_str(), Some(doc.as_str()));
    // Forgotten: the next replacement does not refuse it again.
    let pid = pid_of(&live, B, 5);
    tauri::async_runtime::block_on(engine::restart_for_assent(&handle));
    wait_dead(pid, Duration::from_secs(10));
    pid_of(&live, B, 6);
    assert!(lost.recv_timeout(Duration::from_secs(2)).is_err());
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}
