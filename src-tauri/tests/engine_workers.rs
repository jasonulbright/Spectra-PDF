//! The interactive engine, live: real Python processes per window.
//!
//! The unit tests in `engine.rs` cover routing as a table. This file answers
//! what only real processes can: that a short call from one window completes
//! while another window's long call is still running, that a cheap call of a
//! window answers while that window's job process runs a long job, that a
//! cancel reaches the process holding the request, that one process's death
//! fails only its own calls, that a destroyed window's processes are stopped
//! for good, that a job process is given the window's credentials read-only,
//! and that run calls wait for a slot and end with their answer.
//!
//! The processes run `tests/fixtures/engine_worker_harness.py`: the real
//! engine from `src/engine` plus a cancellable `test_sleep`, a `test_pid`, and
//! a gated handler in place of `distill` (a job method) and
//! `create_pdf_folders` (a run method). An unprovisioned checkout (no
//! interpreter under `resources/python`) skips, and
//! `SPECTRAPDF_REQUIRE_LIVE_CLI=1` turns that skip into a failure.

use std::collections::HashMap;
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
    let python = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("resources").join("python");
    let python = if cfg!(windows) { python.join("python.exe") } else { python.join("bin").join("python3") };
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

#[cfg(windows)]
fn alive(pid: u64) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("spawn tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

/// A zombie still has a `/proc` entry; it no longer runs.
#[cfg(unix)]
fn alive(pid: u64) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    stat.rsplit_once(") ").is_some_and(|(_, rest)| !rest.starts_with('Z'))
}

#[cfg(windows)]
fn kill(pid: u64) {
    let status = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status().expect("spawn taskkill");
    assert!(status.success());
}

#[cfg(unix)]
fn kill(pid: u64) {
    let status = Command::new("kill").args(["-9", &pid.to_string()]).status().expect("spawn kill");
    assert!(status.success());
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
    live_app_with(python, None)
}

/// A live app whose run processes are capped at `run_cap` when given.
fn live_app_with(python: &Path, run_cap: Option<usize>) -> Live {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let harness = manifest.join("tests").join("fixtures").join("engine_worker_harness.py");
    let engine_parent = manifest.join("..").join("src");
    let state = EngineState::with_command(
        python.to_string_lossy().into_owned(),
        vec![
            "-s".to_string(),
            harness.to_string_lossy().into_owned(),
            engine_parent.to_string_lossy().into_owned(),
        ],
    );
    let state = match run_cap {
        Some(cap) => state.with_run_cap(cap),
        None => state,
    };
    let app = mock_builder()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
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
    kill(pid_a);

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
    kill(pid);
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

/// One window's responses, kept by id, so waiting for one id never discards
/// another id's answer.
struct Inbox<'a> {
    rx: &'a Receiver<String>,
    held: HashMap<u64, serde_json::Value>,
}

impl<'a> Inbox<'a> {
    fn new(rx: &'a Receiver<String>) -> Self {
        Self { rx, held: HashMap::new() }
    }

    fn keep(&mut self, payload: String) {
        let json: serde_json::Value = serde_json::from_str(&payload).expect("response is JSON");
        if let Some(id) = json.get("id").and_then(|v| v.as_u64()) {
            self.held.insert(id, json);
        }
    }

    /// Whether `id` has been answered by now.
    fn answered(&mut self, id: u64) -> bool {
        while let Ok(payload) = self.rx.try_recv() {
            self.keep(payload);
        }
        self.held.contains_key(&id)
    }

    fn take(&mut self, id: u64, within: Duration) -> serde_json::Value {
        let deadline = Instant::now() + within;
        loop {
            if let Some(json) = self.held.remove(&id) {
                return json;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            let payload = self
                .rx
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no response for id {id} within {within:?}"));
            self.keep(payload);
        }
    }
}

/// A call to the harness's gated handler: `distill` reaches the window's job
/// process, `create_pdf_folders` a run process.
fn gated(id: u64, method: &str, gate: &Path) -> serde_json::Value {
    request(id, method, serde_json::json!({ "gate": gate.to_string_lossy() }))
}

/// The gated handler's answer: its pid, whether it was cancelled, and the
/// `[method, succeeded]` log of the requests its process served before it.
fn gated_result(reply: &serde_json::Value) -> (u64, bool, Vec<(String, bool)>) {
    let result = &reply["result"];
    let pid = result["pid"].as_u64().unwrap_or_else(|| panic!("no pid: {reply}"));
    let log = result["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry[0].as_str().unwrap_or_default().to_string(), entry[1].as_bool().unwrap()))
        .collect();
    (pid, result["cancelled"].as_bool().unwrap(), log)
}

#[test]
fn a_cheap_call_answers_while_its_windows_job_runs() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let gate = scratch.path().join("gate");
    let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("sample.pdf");
    let pid_a = pid_of(&live, A, 100);
    let mut inbox = Inbox::new(&live.a);

    send(&live, A, gated(1, "distill", &gate));
    send(&live, A, request(2, "ping", serde_json::json!({})));
    assert_eq!(inbox.take(2, Duration::from_secs(60))["result"]["status"], "ok");
    send(&live, A, request(3, "get_page_count", serde_json::json!({ "file": sample.to_string_lossy() })));
    let pages = inbox.take(3, Duration::from_secs(60));
    assert!(pages["result"]["pages"].as_u64().is_some_and(|n| n > 0), "{pages}");
    assert!(!gate.exists());
    assert!(!inbox.answered(1), "the job answered before its gate existed");

    std::fs::write(&gate, b"").unwrap();
    let (pid_job, cancelled, _) = gated_result(&inbox.take(1, Duration::from_secs(60)));
    assert!(!cancelled);
    assert_ne!(pid_job, pid_a, "the job ran in the window process");
    assert_eq!(pid_of(&live, A, 4), pid_a);
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_cancel_reaches_the_job_process_and_the_handler_answers_its_partial_result() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let gate = scratch.path().join("never");
    let mut inbox = Inbox::new(&live.a);
    send(&live, A, gated(1, "distill", &gate));
    assert!(!tauri::async_runtime::block_on(engine::cancel_request(&handle, B, &serde_json::json!(1))).unwrap());
    // The request is in the job process's FIFO once the send returns, so the
    // cancel finds it whether or not the handler has started.
    assert!(tauri::async_runtime::block_on(engine::cancel_request(&handle, A, &serde_json::json!(1))).unwrap());
    let reply = inbox.take(1, Duration::from_secs(120));
    assert!(reply.get("error").is_none(), "a cancelled job failed: {reply}");
    let (_, cancelled, _) = gated_result(&reply);
    assert!(cancelled, "the handler finished without seeing the cancel");
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_destroyed_windows_window_and_job_processes_both_stop() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let gate = scratch.path().join("gate");
    std::fs::write(&gate, b"").unwrap();
    let pid_window = pid_of(&live, A, 100);
    send(&live, A, gated(1, "distill", &gate));
    let (pid_job, _, _) = gated_result(&await_response(&live.a, 1, Duration::from_secs(120)));
    assert_ne!(pid_window, pid_job);
    assert!(alive(pid_window) && alive(pid_job));
    engine::retire_window(&handle, A);
    wait_dead(pid_window, Duration::from_secs(30));
    wait_dead(pid_job, Duration::from_secs(30));
    assert!(
        tauri::async_runtime::block_on(engine::write_request(&handle, A, gated(2, "distill", &gate))).is_err(),
        "a destroyed window started a job process"
    );
    engine::retire_window(&handle, B);
}

#[test]
fn a_closed_windows_job_write_drains_before_its_processes_stop() {
    let _guard = DRAIN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var(engine::ENGINE_DRAIN_ENV);
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let open = scratch.path().join("open");
    let gate = scratch.path().join("gate");
    std::fs::write(&open, b"").unwrap();
    let out = scratch.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let pid_window = pid_of(&live, B, 100);
    let root = claim_output(&live, B, &out);
    send(&live, B, gated(1, "distill", &open));
    let (pid_job, _, _) = gated_result(&await_response(&live.b, 1, Duration::from_secs(120)));

    send(&live, B, gated(2, "distill", &gate));
    engine::retire_window(&handle, B);
    live.app.state::<ClaimState>().release_label(B);
    assert!(
        !tauri::async_runtime::block_on(engine::wait_for_writes(&handle, Duration::from_secs(2))),
        "a closed window's job write was cut off"
    );
    assert!(alive(pid_job));
    assert!(
        !live.app.state::<ClaimState>().claim_roots(std::slice::from_ref(&root), A).unwrap().granted,
        "the write's folder was released while the job was running"
    );
    std::fs::write(&gate, b"").unwrap();
    assert!(tauri::async_runtime::block_on(engine::wait_for_writes(&handle, Duration::from_secs(60))));
    wait_dead(pid_job, Duration::from_secs(30));
    wait_dead(pid_window, Duration::from_secs(30));
    assert!(
        live.app.state::<ClaimState>().claim_roots(std::slice::from_ref(&root), A).unwrap().granted,
        "the finished job kept its folder"
    );
    engine::retire_window(&handle, A);
}

#[test]
fn an_assent_restart_replaces_an_idle_job_process() {
    let _guard = DRAIN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var(engine::ENGINE_DRAIN_ENV);
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let gate = scratch.path().join("gate");
    std::fs::write(&gate, b"").unwrap();
    send(&live, A, gated(1, "distill", &gate));
    let (before, _, _) = gated_result(&await_response(&live.a, 1, Duration::from_secs(120)));
    tauri::async_runtime::block_on(engine::restart_for_assent(&handle));
    wait_dead(before, Duration::from_secs(10));
    send(&live, A, gated(2, "distill", &gate));
    let (after, _, _) = gated_result(&await_response(&live.a, 2, Duration::from_secs(120)));
    assert_ne!(before, after);
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

/// The methods of every line the gated handler's process had received when
/// it answered.
fn gated_received(reply: &serde_json::Value) -> Vec<String> {
    reply["result"]["received"]
        .as_array()
        .unwrap()
        .iter()
        .map(|method| method.as_str().unwrap_or_default().to_string())
        .collect()
}

#[test]
fn a_job_process_is_given_the_windows_credentials_read_only() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let path = |name: &str| root.join(name.replace('/', std::path::MAIN_SEPARATOR_STR)).to_string_lossy().into_owned();
    let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("sample.pdf");
    let sample = sample.to_string_lossy().into_owned();
    for folder in ["pw", "cert", "owner"] {
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
    call_ok(&live, B, 4, "encrypt", serde_json::json!({
        "file": sample, "output": path("owner/doc.pdf"), "user_password": "u2", "owner_password": "o2",
    }));
    std::fs::copy(path("pw/doc.pdf"), path("pw/stage.pdf")).unwrap();

    assert_eq!(call_ok(&live, B, 5, "open_document", serde_json::json!({ "path": path("pw/doc.pdf"), "password": "u" }))["opener"], "user");
    assert_eq!(call_ok(&live, B, 6, "share_document", serde_json::json!({ "path": path("pw/doc.pdf"), "alias": path("pw/stage.pdf") }))["shared"], true);
    assert_eq!(call_ok(&live, B, 7, "open_pubkey_document", serde_json::json!({
        "path": path("cert/doc.pdf"), "pfx": pfx, "password": "test-pass",
    }))["opener"], "recipient");
    let owner = call_ok(&live, B, 8, "open_document_attempt", serde_json::json!({ "path": path("owner/doc.pdf"), "password": "o2" }));
    assert_eq!(owner["document"]["opener"], "owner");

    // Every document reads in the job process, including the user-password
    // copy and its stage, which open only with the credential.
    let found = call_ok(&live, B, 9, "search_in_files", serde_json::json!({
        "paths": [path("pw/doc.pdf"), path("pw/stage.pdf"), path("cert/doc.pdf"), path("owner/doc.pdf")],
        "query": "a",
    }));
    assert_eq!(found["errors"], serde_json::json!([]), "{found}");
    assert_eq!(found["files_searched"], 4, "{found}");

    let gate = root.join("gate");
    std::fs::write(&gate, b"").unwrap();
    send(&live, B, gated(10, "distill", &gate));
    let (pid_job, _, log) = gated_result(&await_response(&live.b, 10, Duration::from_secs(120)));
    assert_ne!(pid_job, pid_of(&live, B, 11));
    let ran = |method: &str| log.iter().filter(|(m, _)| m == method).count();
    assert_eq!(ran("open_document"), 2, "the user and the certificate credential: {log:?}");
    assert_eq!(ran("share_document"), 1, "{log:?}");
    for in_place in ["open_document_attempt", "open_pubkey_document", "pubkey_reattach", "unlock"] {
        assert_eq!(ran(in_place), 0, "the job process ran {in_place}: {log:?}");
    }
    assert!(log.iter().all(|(_, ok)| *ok), "a credential frame was refused: {log:?}");

    // A document closed in the window leaves the job process at once, not
    // with the window's next job request: the job process receives the close
    // while its only request is still running.
    let waiting = root.join("waiting");
    send(&live, B, gated(12, "distill", &waiting));
    call_ok(&live, B, 13, "close_document", serde_json::json!({ "path": path("pw/doc.pdf") }));
    std::fs::write(&waiting, b"close_document").unwrap();
    let reply = await_response(&live.b, 12, Duration::from_secs(120));
    let received = gated_received(&reply);
    assert_eq!(received.iter().filter(|m| *m == "close_document").count(), 1, "{received:?}");
    send(&live, B, request(14, "search_in_files", serde_json::json!({ "paths": [path("pw/stage.pdf")], "query": "a" })));
    let closed = await_response(&live.b, 14, Duration::from_secs(120));
    assert_ne!(closed["result"]["errors"], serde_json::json!([]), "a closed document's alias still opened: {closed}");
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

/// The bytes and modification time of `path`.
fn file_state(path: &Path) -> (Vec<u8>, std::time::SystemTime) {
    (std::fs::read(path).unwrap(), std::fs::metadata(path).unwrap().modified().unwrap())
}

/// Hold `path` open so that no other handle may read, write or replace it.
#[cfg(windows)]
fn hold_exclusively(path: &Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
}

#[test]
fn a_job_process_given_credentials_never_opens_or_writes_the_documents_files() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("sample.pdf");
    let sample = sample.to_string_lossy().into_owned();
    for folder in ["pw", "cert", "other"] {
        std::fs::create_dir(root.join(folder)).unwrap();
    }
    let pw = root.join("pw").join("doc.pdf");
    let cert = root.join("cert").join("doc.pdf");
    let other = root.join("other").join("doc.pdf");
    std::fs::copy(&sample, &other).unwrap();
    let identity = call_ok(&live, A, 1, "test_identity", serde_json::json!({ "folder": root.to_string_lossy() }));
    call_ok(&live, A, 2, "encrypt", serde_json::json!({
        "file": sample, "output": pw.to_string_lossy(), "user_password": "u", "owner_password": "o",
    }));
    call_ok(&live, A, 3, "encrypt_pubkey", serde_json::json!({
        "file": sample, "output": cert.to_string_lossy(), "certs": [identity["cert"]],
    }));
    call_ok(&live, A, 4, "open_document", serde_json::json!({ "path": pw.to_string_lossy(), "password": "u" }));
    call_ok(&live, A, 5, "open_pubkey_document", serde_json::json!({
        "path": cert.to_string_lossy(), "pfx": identity["pfx"], "password": "test-pass",
    }));
    // Every file the window's opens read or wrote: the working copies, the
    // sealed original and the folder marker of the certificate open.
    let files = [
        pw.clone(),
        cert.clone(),
        root.join("cert").join("spectra-recipient.sealed"),
        root.join("cert").join("spectra-recipient.json"),
    ];
    let before: Vec<_> = files.iter().map(|file| file_state(file)).collect();
    #[cfg(windows)]
    let held: Vec<std::fs::File> = files.iter().map(|file| hold_exclusively(file)).collect();

    // The job request names another document; the window's credentials
    // reach the job process first.
    let gate = root.join("gate");
    std::fs::write(&gate, b"").unwrap();
    send(&live, A, gated(6, "distill", &gate));
    let (_, _, log) = gated_result(&await_response(&live.a, 6, Duration::from_secs(120)));
    let found = call_ok(&live, A, 7, "search_in_files", serde_json::json!({ "paths": [other.to_string_lossy()], "query": "a" }));
    assert_eq!(found["errors"], serde_json::json!([]), "{found}");
    #[cfg(windows)]
    drop(held);

    assert_eq!(
        log,
        vec![("open_document".to_string(), true), ("open_document".to_string(), true)],
        "the job process touched a document's files to take its credential"
    );
    for (file, state) in files.iter().zip(before) {
        assert!(file_state(file) == state, "{} changed", file.display());
    }
    // The registered credentials work once a request names the documents.
    let read = call_ok(&live, A, 8, "search_in_files", serde_json::json!({
        "paths": [pw.to_string_lossy(), cert.to_string_lossy()], "query": "a",
    }));
    assert_eq!(read["errors"], serde_json::json!([]), "{read}");
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_job_process_is_given_a_certificate_credential_without_its_key_file() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let doc = root.join("cert").join("doc.pdf").to_string_lossy().into_owned();
    std::fs::create_dir(root.join("cert")).unwrap();
    let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("sample.pdf");
    let identity = call_ok(&live, A, 1, "test_identity", serde_json::json!({ "folder": root.to_string_lossy() }));
    call_ok(&live, A, 2, "encrypt_pubkey", serde_json::json!({
        "file": sample.to_string_lossy(), "output": doc, "certs": [identity["cert"]],
    }));
    let pfx = identity["pfx"].as_str().unwrap().to_string();
    call_ok(&live, A, 3, "open_pubkey_document", serde_json::json!({ "path": doc, "pfx": pfx, "password": "test-pass" }));
    let (tx, lost) = channel::<String>();
    live.app.get_webview_window(A).unwrap().listen(engine::CREDENTIAL_LOST_EVENT, move |event| {
        let _ = tx.send(event.payload().to_string());
    });
    std::fs::rename(&pfx, root.join("moved.pfx")).unwrap();

    let gate = root.join("gate");
    std::fs::write(&gate, b"").unwrap();
    send(&live, A, gated(4, "distill", &gate));
    let (_, _, log) = gated_result(&await_response(&live.a, 4, Duration::from_secs(120)));
    assert_eq!(log, vec![("open_document".to_string(), true)], "the job process needed the key file");
    let found = call_ok(&live, A, 5, "search_in_files", serde_json::json!({ "paths": [doc], "query": "a" }));
    assert_eq!(found["errors"], serde_json::json!([]), "{found}");
    let window_read = call_ok(&live, A, 6, "document_permissions", serde_json::json!({ "path": doc }));
    assert_eq!(window_read["opener"], "recipient", "the window process lost the credential");
    assert!(lost.recv_timeout(Duration::from_secs(2)).is_err(), "a credential-lost notice reached the window");
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_run_process_that_outlives_its_input_is_stopped_and_gives_back_its_slot() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app_with(&python, Some(1));
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let gate = scratch.path().join("gate");
    std::fs::write(&gate, b"").unwrap();
    let mut inbox = Inbox::new(&live.a);
    send(&live, A, request(1, "create_pdf_folders", serde_json::json!({ "gate": gate.to_string_lossy(), "linger": true })));
    let (lingering, _, _) = gated_result(&inbox.take(1, Duration::from_secs(120)));
    send(&live, A, gated(2, "create_pdf_folders", &gate));
    // The only slot is held until the first process ends, which it does not
    // do on its own; the second call starts once that process is stopped.
    let (second, _, _) = gated_result(&inbox.take(2, Duration::from_secs(180)));
    assert_ne!(second, lingering);
    wait_dead(lingering, Duration::from_secs(30));
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_run_call_runs_in_its_own_process_which_ends_after_its_answer() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app(&python);
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let gate = scratch.path().join("gate");
    std::fs::write(&gate, b"").unwrap();
    let pid_window = pid_of(&live, A, 100);
    send(&live, A, gated(1, "distill", &gate));
    let (pid_job, _, _) = gated_result(&await_response(&live.a, 1, Duration::from_secs(120)));
    send(&live, A, gated(2, "create_pdf_folders", &gate));
    let (pid_run, cancelled, log) = gated_result(&await_response(&live.a, 2, Duration::from_secs(120)));
    assert!(!cancelled);
    assert!(log.is_empty(), "a run process served another request first: {log:?}");
    assert!(pid_run != pid_window && pid_run != pid_job);
    wait_dead(pid_run, Duration::from_secs(30));
    send(&live, A, gated(3, "create_pdf_folders", &gate));
    let (second, _, _) = gated_result(&await_response(&live.a, 3, Duration::from_secs(120)));
    assert_ne!(second, pid_run);
    wait_dead(second, Duration::from_secs(30));
    assert!(alive(pid_window) && alive(pid_job));
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}

#[test]
fn a_run_above_the_cap_waits_for_a_slot_and_a_closed_windows_queued_write_is_reported() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app_with(&python, Some(1));
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let first = scratch.path().join("first");
    let never = scratch.path().join("never");
    let out = scratch.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let root = claim_output(&live, B, &out);
    let (tx, stopped) = channel::<String>();
    live.app.get_webview_window(A).unwrap().listen("engine:writeStopped", move |event| {
        let _ = tx.send(event.payload().to_string());
    });
    let mut inbox = Inbox::new(&live.a);

    send(&live, A, gated(1, "create_pdf_folders", &first));
    send(&live, B, gated(1, "create_pdf_folders", &first));
    send(&live, A, gated(2, "create_pdf_folders", &never));
    assert_eq!(handle.state::<EngineRouter>().writes_in_flight(None), 1, "the queued write does not count");
    assert!(tauri::async_runtime::block_on(engine::cancel_request(&handle, A, &serde_json::json!(2))).unwrap());

    engine::retire_window(&handle, B);
    live.app.state::<ClaimState>().release_label(B);
    assert_eq!(stopped.recv_timeout(Duration::from_secs(30)).unwrap(), "1");
    assert_eq!(handle.state::<EngineRouter>().writes_in_flight(None), 0);
    assert!(
        live.app.state::<ClaimState>().claim_roots(std::slice::from_ref(&root), A).unwrap().granted,
        "the dropped call kept its folder"
    );
    assert!(!inbox.answered(2), "a queued call answered before a slot was free");

    std::fs::write(&first, b"").unwrap();
    let (pid_first, _, _) = gated_result(&inbox.take(1, Duration::from_secs(120)));
    // The queued call starts when the first run ends, and its cancel follows
    // its request into the new process.
    let (pid_second, cancelled, _) = gated_result(&inbox.take(2, Duration::from_secs(120)));
    assert!(cancelled, "the cancel of the queued call was lost");
    assert_ne!(pid_first, pid_second);
    engine::retire_window(&handle, A);
}

#[test]
fn cancel_writes_stops_a_running_run_and_answers_a_queued_one() {
    let Some(python) = provisioned_python() else { return };
    let live = live_app_with(&python, Some(1));
    let handle = live.app.handle().clone();
    let scratch = tempfile::tempdir().unwrap();
    let never = scratch.path().join("never");
    let out = scratch.path().join("out");
    std::fs::create_dir(&out).unwrap();
    claim_output(&live, A, &out);
    let mut inbox = Inbox::new(&live.a);
    send(&live, A, gated(1, "create_pdf_folders", &never));
    send(&live, A, gated(2, "create_pdf_folders", &never));
    assert_eq!(handle.state::<EngineRouter>().writes_in_flight(None), 2);
    tauri::async_runtime::block_on(engine::cancel_writes(&handle, Duration::from_secs(60)));
    let queued = inbox.take(2, Duration::from_secs(10));
    assert!(
        queued["error"]["message"].as_str().is_some_and(|m| m.contains("stopped")),
        "the queued call was not told it stopped: {queued}"
    );
    let (_, cancelled, _) = gated_result(&inbox.take(1, Duration::from_secs(120)));
    assert!(cancelled);
    assert_eq!(handle.state::<EngineRouter>().writes_in_flight(None), 0);
    live.app.state::<ClaimState>().release_label(A);
    engine::retire_window(&handle, A);
    engine::retire_window(&handle, B);
}
