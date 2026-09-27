use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// Maximum content bytes in one JSON-RPC frame in either direction, excluding
/// its newline delimiter. All three engine transports use the same wire limit.
pub(crate) const MAX_ENGINE_RPC_LINE_BYTES: usize = 256 * 1024 * 1024;

/// Manages the Python JSON-RPC engine sidecar process.
pub struct EngineState {
    pub child: Arc<Mutex<Option<EngineChild>>>,
    retiring: AtomicBool,
}

pub struct EngineChild {
    pub child: CommandChild,
    _job: crate::process_job::ProcessJob,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            retiring: AtomicBool::new(false),
        }
    }
}

/// Which window each in-flight engine request belongs to.
///
/// One sidecar serves every window, and a renderer correlates a response by
/// its id alone against a map that is module-scoped — so every renderer starts
/// numbering at 1 and one window's response satisfies another window's pending
/// entry for the same number. The request id is rewritten to a process-global
/// number on the way out and restored on the way back, which makes the
/// correlation unforgeable rather than conventional: a renderer that does not
/// namespace its ids is not a participant that got it wrong, it simply cannot
/// see another window's traffic.
pub struct EngineRouter {
    next_outer: AtomicU64,
    by_outer: std::sync::Mutex<HashMap<u64, Route>>,
}

struct Route {
    label: String,
    inner: serde_json::Value,
    leases: Vec<Arc<crate::folder_claims::FolderLease>>,
    _workers: Vec<crate::folder_claims::WorkerLease>,
    _output_reservation: Option<crate::app_windows::EngineOutputReservation>,
}

impl EngineRouter {
    pub fn new() -> Self {
        Self {
            next_outer: AtomicU64::new(1),
            by_outer: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, label: &str, inner: serde_json::Value,
        leases: Vec<Arc<crate::folder_claims::FolderLease>>,
        workers: Vec<crate::folder_claims::WorkerLease>,
        output_reservation: Option<crate::app_windows::EngineOutputReservation>) -> u64 {
        let outer = self.next_outer.fetch_add(1, Ordering::SeqCst);
        let mut map = self
            .by_outer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.insert(
            outer,
            Route {
                label: label.to_string(),
                inner,
                leases,
                _workers: workers,
                _output_reservation: output_reservation,
            },
        );
        outer
    }

    fn take(&self, outer: u64) -> Option<Route> {
        self.by_outer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&outer)
            .filter(|route| !route.label.is_empty())
    }

    /// Retire one routing, answering who asked and under which id.
    pub fn take_route(&self, outer: u64) -> Option<(String, serde_json::Value)> {
        self.take(outer).map(|route| (route.label, route.inner))
    }

    /// Retire EVERY routing. For a sidecar that has been killed: nothing is
    /// coming back, so each caller is owed an answer from whoever killed it.
    pub fn take_all(&self) -> Vec<(u64, String, serde_json::Value)> {
        let mut map = self
            .by_outer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.drain().filter(|(_, route)| !route.label.is_empty())
            .map(|(outer, route)| (outer, route.label, route.inner))
            .collect()
    }

    /// Retire every request belonging to one window and return the process ids
    /// whose companion state must be retired with them.
    pub fn take_label(&self, label: &str) -> Vec<u64> {
        let mut map = self
            .by_outer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let ids: Vec<u64> = map
            .iter()
            .filter_map(|(outer, route)| (route.label == label).then_some(*outer))
            .collect();
        for outer in &ids {
            if map.get(outer).is_some_and(|route| {
                !route.leases.is_empty() || route._output_reservation.is_some()
            }) {
                // Retain active write protection, not the destroyed UI's
                // delivery address. The eventual response removes the entry.
                map.get_mut(outer).unwrap().label.clear();
            } else {
                map.remove(outer);
            }
        }
        ids
    }

    /// Drop a destroyed window's outstanding requests. Their responses then
    /// land on no route and are discarded, which is the correct fate for a
    /// call whose caller is gone.
    pub fn drop_label(&self, label: &str) {
        self.take_label(label);
    }

    /// How many requests each window has in flight.
    pub fn outstanding(&self) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        let map = self
            .by_outer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for route in map.values() {
            if route.label.is_empty() {
                continue;
            }
            *counts.entry(route.label.clone()).or_insert(0) += 1;
        }
        counts
    }
}

impl Default for EngineRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// Tell each window how much engine work the OTHER windows have in flight.
///
/// The sidecar is strictly serial, so a long run started in one window stalls
/// every other window's next operation. Each window's own queue can only show
/// its own work, so without this the wait renders as a hang. The count is a
/// number, never the other window's document.
pub fn publish_activity(app: &AppHandle) {
    let labels = crate::app_windows::app_window_labels(app);
    if labels.len() < 2 {
        // One window can only ever be waiting on itself, and its own operation
        // queue already says so.
        for label in &labels {
            let _ = app.emit_to(label.as_str(), "engine:otherWindows", 0usize);
        }
        return;
    }
    let counts = app.state::<EngineRouter>().outstanding();
    let total: usize = counts.values().sum();
    for label in labels {
        let mine = counts.get(&label).copied().unwrap_or(0);
        let _ = app.emit_to(label.as_str(), "engine:otherWindows", total - mine);
    }
}

/// Rewrite an outbound request's id to a process-global number and remember
/// who asked. Returns the outer id when one was allocated.
pub(crate) fn route_request(
    app: &AppHandle,
    label: &str,
    request: &mut serde_json::Value,
    pid: u32,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
) -> Result<Option<u64>, String> {
    let leases = app.state::<crate::app_windows::ClaimState>().folder_leases(label);
    let workers = leases.iter().map(|lease| lease.retain_in_worker(pid)).collect::<Result<Vec<_>, _>>()?;
    Ok(route_with_leases(
        &app.state::<EngineRouter>(),
        label,
        request,
        leases,
        workers,
        output_reservation,
    ))
}

/// The same rewrite against a NAMED router. Each sidecar keeps its own table:
/// two routers may hand out the same outer number and never confuse each
/// other, because a response is only ever looked up in the table belonging to
/// the process that emitted it.
pub fn route_with(
    router: &EngineRouter,
    label: &str,
    request: &mut serde_json::Value,
) -> Option<u64> {
    route_with_leases(router, label, request, Vec::new(), Vec::new(), None)
}

fn route_with_leases(router: &EngineRouter, label: &str, request: &mut serde_json::Value,
    leases: Vec<Arc<crate::folder_claims::FolderLease>>,
    workers: Vec<crate::folder_claims::WorkerLease>,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>) -> Option<u64> {
    let obj = request.as_object_mut()?;
    let inner = obj.get("id").cloned()?;
    if inner.is_null() {
        return None;
    }
    let outer = router.register(label, inner, leases, workers, output_reservation);
    obj.insert("id".to_string(), serde_json::Value::from(outer));
    Some(outer)
}

/// Undo a routing when the request never reached the sidecar.
pub fn unroute_request(app: &AppHandle, outer: u64) {
    app.state::<EngineRouter>().take(outer);
}

/// Restore a response's original id and deliver it to the window that asked.
fn route_response(app: &AppHandle, mut json: serde_json::Value) {
    let Some(outer) = json.get("id").and_then(|v| v.as_u64()) else {
        // Nothing correlates an id-less line to one window, and the engine only
        // emits them as process-wide notices.
        let _ = app.emit("engine:response", json);
        return;
    };
    let Some(route) = app.state::<EngineRouter>().take(outer) else {
        return;
    };
    if let Some(obj) = json.as_object_mut() {
        obj.insert("id".to_string(), route.inner);
    }
    let _ = app.emit_to(route.label.as_str(), "engine:response", json);
    publish_activity(app);
}

/// Resolves the path to the Python engine startup script.
pub fn get_engine_script_path<R: Runtime>(app: &AppHandle<R>) -> String {
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
pub fn get_python_path<R: Runtime>(app: &AppHandle<R>) -> String {
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

/// Resolves the path to the vendored native Tesseract.
///
/// Recognition is a SUBPROCESS, which is the property that matters: it is what
/// lets the CLI and a scheduled run under a service account recognise at all,
/// where a WASM recognizer would need a WebView and a service account has no
/// interactive desktop to host one in. The GUI routes here too -- one
/// recognizer, never two that can disagree about the same page.
pub fn get_tesseract_path(app: &AppHandle) -> String {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    let exe = resource_dir.join("tesseract").join("tesseract.exe");
    // `dunce::simplified` STRIPS the `\?\` verbatim prefix that
    // `resource_dir()` carries on Windows, and that is load-bearing rather
    // than cosmetic: Tesseract derives its tessdata directory from the
    // executable path we hand it, and it CANNOT open a data file through a
    // verbatim path. The symptom is "Error opening data file ... Failed
    // loading language 'eng'" while the file plainly exists -- so every page
    // recognises to nothing, silently. Same reason `commands::canonical_path`
    // is dunce-backed.
    dunce::simplified(&exe).to_string_lossy().to_string()
}

/// The vendored Ghostscript path, if this build still carries one.
///
/// A CANDIDATE, never the answer: Ghostscript is user-supplied, the resource
/// tree may hold no copy at all, and a path string is not a capability. It is
/// the last input to `gs::resolve` and nothing else may consume it.
pub fn bundled_gs_candidate(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe = resource_dir.join("ghostscript").join("gswin64c.exe");
    exe.is_file().then_some(exe)
}

/// Resolves a USABLE Ghostscript, or "" when there is none.
///
/// The empty string is the honest answer for "no capability": every consumer
/// that used to receive a path to a file that might not exist now receives
/// either a probed, runnable program or nothing, and the engine's own
/// authority refuses by name on nothing.
pub fn get_gs_path(app: &AppHandle) -> String {
    let bundled = bundled_gs_candidate(app);
    let answer = crate::gs::resolve(None, bundled.as_deref());
    if answer.available {
        answer.path
    } else {
        String::new()
    }
}

/// The bundled fallback-font DIRECTORY for Edit ▸ Text's
/// convert-to-compatible-font: the vendored
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

/// The bundled spelling-dictionary DIRECTORY (resources/dictionaries).
///
/// Returns the DIR, not one dictionary: the engine resolves a language tag
/// against what is on disk, so a request for `en-GB` and a request for `en`
/// both land somewhere real without the renderer knowing the file layout.
/// Same class as the fonts directory, and `dunce::simplified` for the same
/// reason — a verbatim `\\?\` prefix travels into a path the engine opens.
pub fn get_dictionary_path(app: &AppHandle) -> String {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    let dir = resource_dir.join("dictionaries");
    dunce::simplified(&dir).to_string_lossy().to_string()
}

/// The bundled colour-profile DIRECTORY (resources/icc).
///
/// Returns the DIR, not one profile, for the same reason as the dictionaries:
/// the engine resolves a profile by its DESCRIPTION against what is on disk,
/// so a request for a press condition lands on a real file without the
/// renderer knowing the file layout. `dunce::simplified` for the same reason
/// too — a verbatim `\\?\` prefix travels into a path the engine opens, and
/// the profile bytes are embedded into the document from it.
///
/// A missing directory is not resolved away here: the engine's own
/// `icc_profiles.profile_dir` falls back to the source-tree layout, and a
/// directory with no profiles in it refuses BY NAME rather than converting
/// against nothing.
pub fn get_icc_path(app: &AppHandle) -> String {
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    let dir = resource_dir.join("icc");
    dunce::simplified(&dir).to_string_lossy().to_string()
}

/// Resolves LibreOffice's `soffice` for Office export. Prefers the vendored copy
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

/// The environment every Python spawn carries, whichever launcher spawns it.
///
/// One table, not per-site `.env` calls: the windowed engine and the headless
/// CLI (which scheduled and watched-folder runs re-enter through) spawn the
/// same interpreter, and a variable set on one spawn site and not the other
/// is a divergence no test of either site sees.
///
/// - `PYTHONUTF8`: the JSON-RPC channel is UTF-8 by contract; without it an
///   embedded Python on Windows decodes stdin as cp1252 and mojibakes every
///   non-ASCII value (the engine also reconfigures its own stdio).
/// - `PYTHONDONTWRITEBYTECODE`: the installed tree is a payload, not a cache;
///   without it the interpreter writes `__pycache__` beside every engine
///   module it imports, so the install directory grows files no uninstall
///   removes. `__startup__.py` also sets `sys.dont_write_bytecode` so a
///   launcher that misses this table is still covered.
/// - The colour-profile assent, told to the engine rather than looked up by
///   it: the installed and portable containers keep the record in different
///   places, and this binary is the one authority on which container it is.
///   `icc_profiles` refuses to open a profile when this says "0". See
///   `portable::assent_env_value`.
pub fn python_env() -> Vec<(String, String)> {
    vec![
        ("PYTHONUTF8".to_string(), "1".to_string()),
        ("PYTHONNOUSERSITE".to_string(), "1".to_string()),
        ("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()),
        (
            crate::portable::ICC_ASSENT_ENV.to_string(),
            crate::portable::assent_env_value(crate::portable::icc_assent()).to_string(),
        ),
    ]
}

/// Interpreter argv for every engine child. The runtime's `._pth` runs
/// `import site`, which adds the user's `%APPDATA%\Python\Python3xx\site-packages`
/// and runs its `usercustomize` and `.pth` lines inside the engine; a `.pth`
/// line can also put a directory ahead of the shipped packages. `-s` removes
/// the user site. `-I` is not used: it also implies `-E`, which drops the
/// `PYTHONUTF8` that `python_env` sets.
pub fn python_args(script: &str) -> Vec<String> {
    vec!["-s".to_string(), script.to_string()]
}

/// Starts the Python engine sidecar and wires stdout to the webview.
/// Idempotent — if the engine is already running, returns immediately.
pub async fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();

    // Hold the startup lock until the child and its lifetime guard are ready.
    let mut guard = state.child.lock().await;
    if state.retiring.load(Ordering::SeqCst) {
        return Err("The document engine is stopping after an oversized response.".to_string());
    }
    if guard.is_some() {
        return Ok(());
    }

    let python_path = get_python_path(app);
    let script_path = get_engine_script_path(app);

    let shell = app.shell();
    let (mut rx, child) = shell
        .command(&python_path)
        .args(python_args(&script_path))
        .envs(python_env().into_iter().collect::<HashMap<String, String>>())
        // The plugin's default line reader buffers until newline with no cap.
        // Read raw chunks so this process can bound each JSON-RPC frame.
        .set_raw_out(true)
        .spawn()
        .map_err(|e| format!("Failed to start engine: {}", e))?;

    let job = match crate::process_job::ProcessJob::attach(child.pid()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("The engine process could not be contained: {error}"));
        }
    };
    let pid = child.pid();
    *guard = Some(EngineChild { child, _job: job });

    // Forward stdout lines to the webview as engine:response events
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout_line = Vec::new();
        let mut oversized_stdout = false;
        let mut claimed_oversize = false;
        let mut retiring_job = None;
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                    if oversized_stdout {
                        continue;
                    }
                    let chunk = append_stdout_chunk(
                        &mut stdout_line,
                        &bytes,
                        MAX_ENGINE_RPC_LINE_BYTES,
                    );
                    for line in chunk.completed {
                        if !line.iter().all(u8::is_ascii_whitespace) {
                            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&line) {
                                route_response(&app_handle, json);
                            }
                        }
                    }
                    if chunk.oversized {
                        eprintln!(
                            "[engine] response line exceeded the {} MiB limit; stopping the engine",
                            MAX_ENGINE_RPC_LINE_BYTES / (1024 * 1024)
                        );
                        oversized_stdout = true;
                        let state = app_handle.state::<EngineState>();
                        let mut guard = state.child.lock().await;
                        if guard
                            .as_ref()
                            .is_some_and(|current| current.child.pid() == pid)
                        {
                            state.retiring.store(true, Ordering::SeqCst);
                            let current = guard.take().expect("matched engine child");
                            let EngineChild { child, _job } = current;
                            retiring_job = Some(_job);
                            claimed_oversize = true;
                            if let Err(error) = child.kill() {
                                eprintln!("[engine] failed to stop oversized worker: {error}");
                                // Closing the kill-on-close job is the
                                // fallback if the direct process kill fails.
                                drop(retiring_job.take());
                            }
                        }
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(bytes) => {
                    let msg = String::from_utf8_lossy(&bytes);
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
        if claimed_oversize {
            // The Terminated event has arrived (or the stream closed), so no
            // replacement may overlap this worker. Drain its routes before
            // allowing the next start to create a child.
            drop(retiring_job.take());
            let stopped = stopped_responses_with_message(
                &app_handle.state::<EngineRouter>(),
                "The engine response exceeded the 256 MiB limit. The operation was stopped.",
            );
            deliver_stopped(&app_handle, stopped);
            app_handle
                .state::<EngineState>()
                .retiring
                .store(false, Ordering::SeqCst);
            return;
        }
        // A closed event stream also means the worker cannot answer. Ignore a
        // previous worker's late termination after an intentional restart.
        let state = app_handle.state::<EngineState>();
        let mut guard = state.child.lock().await;
        if guard.as_ref().is_some_and(|current| current.child.pid() == pid) {
            guard.take(); // closes the job, including any surviving descendants
            let stopped = stopped_responses(&app_handle.state::<EngineRouter>());
            drop(guard);
            deliver_stopped(&app_handle, stopped);
        }
    });

    Ok(())
}

/// Add raw sidecar bytes to a partial frame, returning completed frames and
/// whether the next pending frame would exceed its limit. Completed frames
/// earlier in the same chunk remain usable even if a later frame is oversized.
/// CR and LF are both accepted as line endings; the engine emits LF.
pub(crate) struct AppendedStdoutChunk {
    pub completed: Vec<Vec<u8>>,
    pub oversized: bool,
}

pub(crate) fn append_stdout_chunk(
    pending: &mut Vec<u8>,
    chunk: &[u8],
    max_line_bytes: usize,
) -> AppendedStdoutChunk {
    let mut completed = Vec::new();
    let mut start = 0;
    while start < chunk.len() {
        let delimiter = chunk[start..]
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r');
        let end = delimiter.map_or(chunk.len(), |offset| start + offset);
        let segment = &chunk[start..end];
        if segment.len() > max_line_bytes.saturating_sub(pending.len()) {
            return AppendedStdoutChunk {
                completed,
                oversized: true,
            };
        }
        pending.extend_from_slice(segment);
        if delimiter.is_some() {
            completed.push(std::mem::take(pending));
            start = end + 1;
        } else {
            break;
        }
    }
    AppendedStdoutChunk {
        completed,
        oversized: false,
    }
}

#[derive(Debug)]
pub(crate) enum BoundedLineError {
    TooLong,
    Io(std::io::Error),
}

/// Read one newline-delimited protocol frame without letting `read_line`
/// grow its destination beyond the shared engine RPC limit. A final frame at
/// EOF is returned without a newline, matching `BufRead::read_line`.
pub(crate) fn read_bounded_line<R: std::io::BufRead>(
    reader: &mut R,
    max_line_bytes: usize,
) -> Result<Option<Vec<u8>>, BoundedLineError> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(BoundedLineError::Io)?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        // Match the raw sidecar readers: CR and LF each delimit a frame. A
        // CRLF pair is seen as an extra empty frame on the next call, which
        // the CLI already ignores; this keeps the content limit independent
        // of Windows newline translation.
        let delimiter = available
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r');
        let content_len = delimiter.unwrap_or(available.len());
        if content_len > max_line_bytes.saturating_sub(line.len()) {
            return Err(BoundedLineError::TooLong);
        }
        line.extend_from_slice(&available[..content_len]);
        let consumed = content_len + usize::from(delimiter.is_some());
        reader.consume(consumed);
        if delimiter.is_some() {
            return Ok(Some(line));
        }
    }
}

fn stopped_responses_with_message(
    router: &EngineRouter,
    message: &str,
) -> Vec<(String, serde_json::Value)> {
    router
        .take_all()
        .into_iter()
        .map(|(_, label, inner)| {
            (
                label,
                serde_json::json!({
                    "id": inner, "error": { "message": message }
                }),
            )
        })
        .collect()
}

/// Drops the running engine so the next call spawns one carrying the current
/// colour-profile assent.
///
/// The assent rides an environment variable, which a live subprocess read once
/// at spawn — so a mid-session acceptance reaches the engine only through a new
/// process. Safe at any moment the user can click the dialog's button: the
/// engine holds nothing across calls, and `start` is idempotent, so the next
/// operation brings one back.
pub async fn restart_for_assent(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut guard = state.child.lock().await;
    let stopped = stop_and_drain(&mut guard, &app.state::<EngineRouter>(), |child| {
        let _ = child.child.kill();
    });
    drop(guard);
    deliver_stopped(app, stopped);
}

/// Empties the slot and retires every routed request in one step under the
/// slot lock. The killed child's monitor then finds the slot empty or holding
/// another pid and skips its own drain, and `take_all` removes each route as it
/// returns it, so a request is failed exactly once whichever path runs.
fn stop_and_drain<T>(slot: &mut Option<T>, router: &EngineRouter, kill: impl FnOnce(T)) -> Vec<(String, serde_json::Value)> {
    if let Some(child) = slot.take() {
        kill(child);
    }
    stopped_responses(router)
}

/// The "engine stopped" error for every request still routed, keyed by the
/// window that asked. Dropping the routes also releases their leases.
fn stopped_responses(router: &EngineRouter) -> Vec<(String, serde_json::Value)> {
    stopped_responses_with_message(
        router,
        "The document engine stopped before completing the operation.",
    )
}

fn deliver_stopped(app: &AppHandle, stopped: Vec<(String, serde_json::Value)>) {
    for (label, payload) in stopped {
        let _ = app.emit_to(label.as_str(), "engine:response", payload);
    }
    publish_activity(app);
}

/// Locks the engine slot, starting an engine first when the slot is empty.
///
/// The renderer starts the engine once per window mount, so a slot emptied
/// mid-session (assent restart, worker exit) stays empty unless the send path
/// itself respawns; without this every later request fails "Engine not running".
pub async fn lock_started<'a, T, F, Fut>(
    slot: &'a Mutex<Option<T>>,
    start: F,
) -> Result<tokio::sync::MutexGuard<'a, Option<T>>, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    {
        let guard = slot.lock().await;
        if guard.is_some() {
            return Ok(guard);
        }
    }
    start().await?;
    let guard = slot.lock().await;
    if guard.is_none() {
        return Err("Engine not running".to_string());
    }
    Ok(guard)
}

#[cfg(test)]
mod start_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn the_engine_child_never_loads_the_user_site() {
        let script = r"C:\resources\engine\__startup__.py";
        assert_eq!(python_args(script), vec!["-s", script]);
        let env = python_env();
        assert!(env.iter().any(|(k, v)| k == "PYTHONNOUSERSITE" && v == "1"));
        assert!(env.iter().any(|(k, v)| k == "PYTHONUTF8" && v == "1"));
    }

    #[test]
    fn raw_stdout_framing_handles_split_lines_and_enforces_the_limit() {
        let mut pending = Vec::new();
        let chunk = append_stdout_chunk(&mut pending, b"{\"id", 8);
        assert!(chunk.completed.is_empty());
        assert!(!chunk.oversized);
        let chunk = append_stdout_chunk(&mut pending, b"\":1}\r\n{}\n", 8);
        assert_eq!(
            chunk.completed,
            vec![b"{\"id\":1}".to_vec(), b"".to_vec(), b"{}".to_vec()]
        );
        assert!(!chunk.oversized);
        assert!(pending.is_empty());

        let chunk = append_stdout_chunk(&mut pending, b"1234", 4);
        assert!(chunk.completed.is_empty());
        assert!(!chunk.oversized);
        assert!(append_stdout_chunk(&mut pending, b"5", 4).oversized);
        assert_eq!(pending, b"1234");
        pending.clear();

        // A valid frame before an oversized one in the same OS read remains
        // deliverable; only the bad frame and later bytes are discarded.
        let chunk = append_stdout_chunk(&mut pending, b"okay\n12345\nlater\n", 4);
        assert_eq!(chunk.completed, vec![b"okay".to_vec()]);
        assert!(chunk.oversized);

        let nul_line = br#"{"id":"i\u0000d","result":"x\u0000y"}"#;
        let mut nul_frame = nul_line.to_vec();
        nul_frame.push(b'\n');
        let chunk = append_stdout_chunk(&mut pending, &nul_frame, 64);
        assert!(!chunk.oversized);
        let response: serde_json::Value =
            serde_json::from_slice(&chunk.completed[0]).unwrap();
        assert_eq!(response["id"], "i\0d");
        assert_eq!(response["result"], "x\0y");
    }

    #[test]
    fn buffered_rpc_reads_are_bounded_and_leave_later_frames_available() {
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(b"four\r\nlast"));
        assert_eq!(
            read_bounded_line(&mut reader, 4).unwrap(),
            Some(b"four".to_vec())
        );
        assert_eq!(read_bounded_line(&mut reader, 4).unwrap(), Some(Vec::new()));
        assert_eq!(read_bounded_line(&mut reader, 4).unwrap(), Some(b"last".to_vec()));
        assert_eq!(read_bounded_line(&mut reader, 4).unwrap(), None);

        let mut oversized = std::io::BufReader::new(std::io::Cursor::new(b"fives\n"));
        assert!(matches!(
            read_bounded_line(&mut oversized, 4),
            Err(BoundedLineError::TooLong)
        ));
    }

    #[tokio::test]
    async fn an_emptied_slot_is_refilled_before_the_send() {
        let slot = Mutex::new(Some(1u32));
        slot.lock().await.take();
        let starts = AtomicUsize::new(0);
        let guard = lock_started(&slot, || async {
            starts.fetch_add(1, Ordering::SeqCst);
            *slot.lock().await = Some(2);
            Ok(())
        }).await.unwrap();
        assert_eq!(*guard, Some(2));
        drop(guard);
        let guard = lock_started(&slot, || async { panic!("a live engine is not restarted") }).await.unwrap();
        assert_eq!(*guard, Some(2));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_assent_restart_fails_each_pending_request_exactly_once() {
        let router = EngineRouter::new();
        let mut request = serde_json::json!({"id": 41});
        route_with(&router, "main", &mut request).unwrap();
        let mut slot = Some(7u32);
        let mut killed = Vec::new();
        let stopped = stop_and_drain(&mut slot, &router, |pid| killed.push(pid));
        assert_eq!(killed, vec![7]);
        assert!(slot.is_none());
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].0, "main");
        assert_eq!(stopped[0].1["id"], 41);
        assert!(stopped[0].1["error"]["message"].as_str().unwrap().contains("stopped"));
        assert!(router.outstanding().is_empty());
        // The killed child's monitor drains after the restart; nothing is left.
        assert!(stopped_responses(&router).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_callers_on_an_empty_slot_spawn_once() {
        let slot: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
        let spawns = Arc::new(AtomicUsize::new(0));
        let caller = |slot: Arc<Mutex<Option<u32>>>, spawns: Arc<AtomicUsize>| async move {
            let start_slot = slot.clone();
            let guard = lock_started(&slot, || async move {
                let mut inner = start_slot.lock().await;
                if inner.is_none() {
                    tokio::task::yield_now().await;
                    *inner = Some(spawns.fetch_add(1, Ordering::SeqCst) as u32 + 100);
                }
                Ok(())
            }).await.unwrap();
            *guard
        };
        let (a, b) = tokio::join!(
            tokio::spawn(caller(slot.clone(), spawns.clone())),
            tokio::spawn(caller(slot.clone(), spawns.clone())),
        );
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(a.unwrap(), Some(100));
        assert_eq!(b.unwrap(), Some(100));
    }

    #[tokio::test]
    async fn a_failed_start_reports_the_start_error() {
        let slot: Mutex<Option<u32>> = Mutex::new(None);
        let err = lock_started(&slot, || async { Err("Failed to start engine: x".to_string()) }).await.unwrap_err();
        assert_eq!(err, "Failed to start engine: x");
    }
}

#[cfg(test)]
mod lease_tests {
    use super::*;

    #[test]
    fn an_engine_output_stays_claimed_until_its_response_retires_the_route() {
        let scratch = tempfile::tempdir().unwrap();
        let registry = scratch.path().join("claims");
        let state = crate::app_windows::ClaimState::with_registry(registry);
        let output = scratch.path().join("result.pdf").to_string_lossy().into_owned();
        let reservation = state.claim_engine_output(&output, "doc-1").unwrap();
        let leases = state.folder_leases("doc-1");
        assert_eq!(leases.len(), 1);

        let router = EngineRouter::new();
        let mut request = serde_json::json!({"id": 7});
        let outer = route_with_leases(
            &router,
            "doc-1",
            &mut request,
            leases,
            Vec::new(),
            Some(reservation),
        )
        .unwrap();

        // Window destruction releases ordinary claims, while the routed
        // output remains protected until the sidecar replies or is retired.
        state.release_label("doc-1");
        router.drop_label("doc-1");
        assert_eq!(state.folder_leases("doc-1").len(), 1);
        assert!(router.take_route(outer).is_none());
        assert!(state.folder_leases("doc-1").is_empty());
    }

    #[test]
    fn an_output_reservation_survives_router_poison_and_window_destruction() {
        use std::panic::{catch_unwind, AssertUnwindSafe};

        let state = crate::app_windows::ClaimState::new();
        let router = EngineRouter::new();
        let path = r"C:\export\result.pdf";
        let reservation = state.claim_engine_output(path, "doc-1").unwrap();

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _routes = router.by_outer.lock().unwrap();
            panic!("poison the test route map");
        }));

        let mut request = serde_json::json!({"id": 7});
        let outer = route_with_leases(
            &router,
            "doc-1",
            &mut request,
            Vec::new(),
            Vec::new(),
            Some(reservation),
        )
        .unwrap();

        state.release_label("doc-1");
        router.drop_label("doc-1");
        assert_eq!(state.folder_leases("doc-1").len(), 1);
        assert!(!state
            .claim_document(path, "doc-2", crate::app_windows::ClaimMode::Write)
            .granted);

        // The response is discarded because its original window is gone; the
        // reservation retires with that response route.
        assert!(router.take_route(outer).is_none());
        assert!(state.folder_leases("doc-1").is_empty());
        assert!(state
            .claim_document(path, "doc-2", crate::app_windows::ClaimMode::Write)
            .granted);
    }

    #[test]
    fn closing_a_window_keeps_its_folders_until_work_finishes() {
        for terminate in [false, true] {
            let scratch = tempfile::tempdir().unwrap();
            let registry = scratch.path().join("claims");
            let roots = vec![scratch.path().join("output").to_string_lossy().into_owned()];
            let lease = Arc::new(crate::folder_claims::claim_in(&registry, &roots).unwrap());
            let router = EngineRouter::new();
            let mut request = serde_json::json!({"id": 7});
            let outer = route_with_leases(
                &router,
                "doc-1",
                &mut request,
                vec![lease.clone()],
                Vec::new(),
                None,
            )
            .unwrap();
            router.drop_label("doc-1");
            drop(lease);
            assert!(router.outstanding().is_empty());
            assert!(matches!(crate::folder_claims::claim_in(&registry, &roots), Err(crate::folder_claims::ClaimError::Busy(_))));
            if terminate { assert!(router.take_all().is_empty()); }
            else { assert!(router.take_route(outer).is_none()); }
            assert!(crate::folder_claims::claim_in(&registry, &roots).is_ok());
        }
    }
}
