use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// Maximum content bytes in one JSON-RPC frame in either direction, excluding
/// its newline delimiter. All three engine transports use the same wire limit.
pub(crate) const MAX_ENGINE_RPC_LINE_BYTES: usize = 256 * 1024 * 1024;
/// The interactive Python engine: one sidecar process PER WINDOW.
///
/// A worker answers one request at a time, so a long call (an in-place batch
/// OCR, an MRC compression, a large redaction) delays only the requests of the
/// window that owns the worker. A window's engine traffic reaches no other
/// process.
///
/// Every piece of engine-side state that outlives a request is created by the
/// window that uses it and is keyed by that window's own working-copy paths:
/// the credential registry (`open_document`, `share_document`,
/// `open_pubkey_document`), sealed readers and recipient handlers, and the
/// restricted-folder marks that `credentials.end_request` clears after each
/// request. Documents are owned by exactly one window, and a tab hand-off
/// re-opens the document into a new working copy in the receiving window, so
/// no request ever needs state that lives in another window's worker. Inside
/// one worker, requests stay strictly serial, which is the invariant those
/// modules are written against.
pub struct EngineState {
    workers: std::sync::Mutex<Workers>,
    next_generation: AtomicU64,
    launcher: Launcher,
}

#[derive(Default)]
struct Workers {
    live: HashMap<String, Arc<EngineWorker>>,
    /// Labels whose window was destroyed. A late send from a destroyed window
    /// must not spawn a worker that nothing would ever retire.
    retired: std::collections::HashSet<String>,
    /// Workers of destroyed windows still finishing a write.
    draining: Vec<Arc<EngineWorker>>,
}

/// How a worker process is launched.
enum Launcher {
    /// The bundled interpreter and engine under the resource directory.
    Resources,
    /// An explicit program and argument list.
    Command { program: String, args: Vec<String> },
}

/// One window's engine slot. The slot survives its process: a worker that
/// exits is respawned into the same slot by the next send.
pub struct EngineWorker {
    pub child: Mutex<Option<EngineChild>>,
    generation: AtomicU64,
    retiring: AtomicBool,
    closed: AtomicBool,
}

impl EngineWorker {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
            retiring: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }
    }

    /// True once the owning window has been destroyed.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

pub struct EngineChild {
    pub child: CommandChild,
    generation: u64,
    _job: crate::process_job::ProcessJob,
}

impl EngineChild {
    /// The number that ties this process to the routes it was sent.
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl EngineState {
    pub fn new() -> Self {
        Self::with_launcher(Launcher::Resources)
    }

    /// Workers are launched as `program args…` instead of the bundled
    /// interpreter and engine.
    pub fn with_command(program: impl Into<String>, args: Vec<String>) -> Self {
        Self::with_launcher(Launcher::Command { program: program.into(), args })
    }

    fn with_launcher(launcher: Launcher) -> Self {
        Self {
            workers: std::sync::Mutex::new(Workers::default()),
            next_generation: AtomicU64::new(1),
            launcher,
        }
    }

    fn lock_workers(&self) -> std::sync::MutexGuard<'_, Workers> {
        self.workers.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The slot of `label`'s worker, created on first use. Refused for a
    /// window that has been destroyed.
    pub fn worker(&self, label: &str) -> Result<Arc<EngineWorker>, String> {
        let mut workers = self.lock_workers();
        if workers.retired.contains(label) {
            return Err(WINDOW_CLOSED.to_string());
        }
        Ok(workers
            .live
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(EngineWorker::new()))
            .clone())
    }

    /// The slot of `label`'s worker when one exists.
    pub fn existing_worker(&self, label: &str) -> Option<Arc<EngineWorker>> {
        self.lock_workers().live.get(label).cloned()
    }

    /// Every worker with a process, including destroyed windows' workers
    /// that are still finishing a write.
    fn all_workers(&self) -> Vec<Arc<EngineWorker>> {
        let workers = self.lock_workers();
        workers.live.values().chain(workers.draining.iter()).cloned().collect()
    }

    fn set_draining(&self, worker: &Arc<EngineWorker>, draining: bool) {
        let mut workers = self.lock_workers();
        workers.draining.retain(|held| !Arc::ptr_eq(held, worker));
        if draining {
            workers.draining.push(worker.clone());
        }
    }

    /// Remove `label`'s slot for good and return it.
    fn retire(&self, label: &str) -> Option<Arc<EngineWorker>> {
        let mut workers = self.lock_workers();
        workers.retired.insert(label.to_string());
        let worker = workers.live.remove(label);
        if let Some(worker) = &worker {
            worker.closed.store(true, Ordering::SeqCst);
        }
        worker
    }

}

impl Default for EngineState {
    fn default() -> Self {
        Self::new()
    }
}

/// The line `engine/__main__.py` writes to stderr once every handler is
/// registered.
const ENGINE_READY_LINE: &str = "engine: ready";

const WINDOW_CLOSED: &str = "This window has closed; its document engine is stopped.";

/// Which window each in-flight engine request belongs to.
///
/// A renderer correlates a response by its id alone against a map that is
/// module-scoped — so every renderer starts numbering at 1 and one window's
/// response would satisfy another window's pending entry for the same number.
/// The request id is rewritten to a process-global number on the way out and
/// restored on the way back, which makes the correlation unforgeable rather
/// than conventional. Each route also records the worker generation it was
/// written to, and a response is only accepted from that generation: one
/// worker can neither answer nor, by exiting, fail another worker's requests.
pub struct EngineRouter {
    next_outer: AtomicU64,
    by_outer: std::sync::Mutex<HashMap<u64, Route>>,
}

struct Route {
    label: String,
    inner: serde_json::Value,
    worker: u64,
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

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Route>> {
        self.by_outer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn register(&self, label: &str, inner: serde_json::Value, worker: u64,
        leases: Vec<Arc<crate::folder_claims::FolderLease>>,
        workers: Vec<crate::folder_claims::WorkerLease>,
        output_reservation: Option<crate::app_windows::EngineOutputReservation>) -> u64 {
        let outer = self.next_outer.fetch_add(1, Ordering::SeqCst);
        self.lock().insert(
            outer,
            Route {
                label: label.to_string(),
                inner,
                worker,
                leases,
                _workers: workers,
                _output_reservation: output_reservation,
            },
        );
        outer
    }

    fn take(&self, outer: u64) -> Option<Route> {
        self.lock()
            .remove(&outer)
            .filter(|route| !route.label.is_empty())
    }

    /// Retire a routing only when worker generation `worker` owns it. A line
    /// from any other process leaves the route in place.
    fn take_from(&self, outer: u64, worker: u64) -> Option<Route> {
        let mut map = self.lock();
        if map.get(&outer).is_none_or(|route| route.worker != worker) {
            return None;
        }
        map.remove(&outer).filter(|route| !route.label.is_empty())
    }

    /// Retire one routing, answering who asked and under which id.
    pub fn take_route(&self, outer: u64) -> Option<(String, serde_json::Value)> {
        self.take(outer).map(|route| (route.label, route.inner))
    }

    /// Retire EVERY routing. For a sidecar that has been killed: nothing is
    /// coming back, so each caller is owed an answer from whoever killed it.
    pub fn take_all(&self) -> Vec<(u64, String, serde_json::Value)> {
        self.lock()
            .drain()
            .filter(|(_, route)| !route.label.is_empty())
            .map(|(outer, route)| (outer, route.label, route.inner))
            .collect()
    }

    /// Retire every routing written to worker generation `worker`, which has
    /// stopped. Other workers' routes are untouched.
    pub fn take_worker(&self, worker: u64) -> Vec<(u64, String, serde_json::Value)> {
        let mut map = self.lock();
        let ids: Vec<u64> = map
            .iter()
            .filter_map(|(outer, route)| (route.worker == worker).then_some(*outer))
            .collect();
        ids.into_iter()
            .filter_map(|outer| map.remove(&outer).map(|route| (outer, route)))
            .filter(|(_, route)| !route.label.is_empty())
            .map(|(outer, route)| (outer, route.label, route.inner))
            .collect()
    }

    /// Whether any routing, addressed or retained, is still owed by worker
    /// generation `worker`.
    pub fn has_worker(&self, worker: u64) -> bool {
        self.lock().values().any(|route| route.worker == worker)
    }

    /// The routed requests of worker generation `worker` that hold write
    /// protection.
    fn write_routes(&self, worker: u64) -> Vec<u64> {
        self.lock()
            .iter()
            .filter(|(_, route)| route.worker == worker)
            .filter(|(_, route)| !route.leases.is_empty() || route._output_reservation.is_some())
            .map(|(outer, _)| *outer)
            .collect()
    }

    /// Whether routing `outer` is still held.
    pub fn contains(&self, outer: u64) -> bool {
        self.lock().contains_key(&outer)
    }

    /// Retire every request belonging to one window and return the process ids
    /// whose companion state must be retired with them.
    pub fn take_label(&self, label: &str) -> Vec<u64> {
        let mut map = self.lock();
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

    /// The process id of `label`'s own in-flight request `inner`. Only the
    /// window that issued a request can address it: another window's inner
    /// ids resolve to nothing, and a retired route resolves to nothing.
    pub fn outer_for(&self, label: &str, inner: &serde_json::Value) -> Option<u64> {
        self.route_for(label, inner).map(|(outer, _)| outer)
    }

    /// `outer_for` with the worker generation the request was written to.
    fn route_for(&self, label: &str, inner: &serde_json::Value) -> Option<(u64, u64)> {
        if label.is_empty() || inner.is_null() {
            return None;
        }
        self.lock()
            .iter()
            .filter(|(_, route)| route.label == label && route.inner == *inner)
            .map(|(outer, route)| (*outer, route.worker))
            .max()
    }

    /// How many requests each window has in flight.
    pub fn outstanding(&self) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for route in self.lock().values() {
            if route.label.is_empty() {
                continue;
            }
            *counts.entry(route.label.clone()).or_insert(0) += 1;
        }
        counts
    }

    /// How many routed requests hold write protection (an output reservation
    /// or a folder lease), on worker generation `worker` or on any worker.
    /// Retained routes of destroyed windows count.
    pub fn writes_in_flight(&self, worker: Option<u64>) -> usize {
        self.lock()
            .values()
            .filter(|route| worker.is_none_or(|worker| route.worker == worker))
            .filter(|route| !route.leases.is_empty() || route._output_reservation.is_some())
            .count()
    }
}

impl Default for EngineRouter {
    fn default() -> Self {
        Self::new()
    }
}


/// Rewrite an outbound request's id to a process-global number and remember
/// who asked and which worker generation it is written to. Returns the outer
/// id when one was allocated.
pub(crate) fn route_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: &mut serde_json::Value,
    child: &EngineChild,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
) -> Result<Option<u64>, String> {
    let pid = child.child.pid();
    let leases = app.state::<crate::app_windows::ClaimState>().folder_leases(label);
    let workers = leases.iter().map(|lease| lease.retain_in_worker(pid)).collect::<Result<Vec<_>, _>>()?;
    Ok(route_with_leases(
        &app.state::<EngineRouter>(),
        label,
        request,
        child.generation,
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
    route_with_leases(router, label, request, 0, Vec::new(), Vec::new(), None)
}

fn route_with_leases(router: &EngineRouter, label: &str, request: &mut serde_json::Value,
    worker: u64,
    leases: Vec<Arc<crate::folder_claims::FolderLease>>,
    workers: Vec<crate::folder_claims::WorkerLease>,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>) -> Option<u64> {
    let obj = request.as_object_mut()?;
    let inner = obj.get("id").cloned()?;
    if inner.is_null() {
        return None;
    }
    let outer = router.register(label, inner, worker, leases, workers, output_reservation);
    obj.insert("id".to_string(), serde_json::Value::from(outer));
    Some(outer)
}

/// The notification that asks the sidecar to stop request `outer` at its next
/// safe point (`engine/cancel.py`). It carries no id, so nothing answers it;
/// the cancelled request still answers under its own id.
pub(crate) fn cancel_frame(outer: u64) -> String {
    let mut line = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "$/cancelRequest",
        "params": { "id": outer },
    })
    .to_string();
    line.push('\n');
    line
}

/// Ask the sidecar to stop one of the CALLING window's own requests, named by
/// the id that window issued. Returns false when that window has no such
/// request in flight.
#[tauri::command]
pub async fn cancel_engine_request(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: serde_json::Value,
) -> Result<bool, String> {
    cancel_request(&app, window.label(), &id).await
}

/// `cancel_engine_request` for window `label`. The cancel is written only to
/// the worker process the request was written to.
pub async fn cancel_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    id: &serde_json::Value,
) -> Result<bool, String> {
    let Some((outer, generation)) = app.state::<EngineRouter>().route_for(label, id) else {
        return Ok(false);
    };
    let Some(worker) = app.state::<EngineState>().existing_worker(label) else {
        return Ok(false);
    };
    let mut guard = worker.child.lock().await;
    let Some(child) = guard.as_mut().filter(|child| child.generation == generation) else {
        return Ok(false);
    };
    child
        .child
        .write(cancel_frame(outer).as_bytes())
        .map_err(|e| format!("Failed to write to engine: {}", e))?;
    Ok(true)
}

/// Write one request to `label`'s worker, starting the worker first when it
/// is not running. The id is rewritten before the write so the response can be
/// addressed back to the window that asked; a write that never lands releases
/// the routing so the table cannot grow entries no response will ever retire.
pub async fn write_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: serde_json::Value,
) -> Result<(), String> {
    write_reserved_request(app, label, request, None).await
}

/// `write_request` for a request whose output path is already claimed; the
/// reservation is held by the route until the response retires it.
pub(crate) async fn write_reserved_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    mut request: serde_json::Value,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
) -> Result<(), String> {
    let worker = app.state::<EngineState>().worker(label)?;
    let mut guard = lock_started(&worker.child, || start_worker(app, label, &worker)).await?;
    if worker.is_closed() {
        return Err(WINDOW_CLOSED.to_string());
    }
    let Some(child) = guard.as_mut() else {
        return Err("Engine not running".to_string());
    };
    let outer = route_request(app, label, &mut request, child, output_reservation)?;
    let unroute = |app: &AppHandle<R>| {
        if let Some(outer) = outer {
            unroute_request(app, outer);
        }
    };
    let msg = match serde_json::to_string(&request) {
        Ok(msg) => msg,
        Err(e) => {
            unroute(app);
            return Err(format!("Serialize error: {}", e));
        }
    };
    if msg.len() > MAX_ENGINE_RPC_LINE_BYTES {
        unroute(app);
        return Err(format!(
            "Engine request exceeds the {} MiB limit.",
            MAX_ENGINE_RPC_LINE_BYTES / (1024 * 1024)
        ));
    }
    if let Err(e) = child.child.write((msg + "\n").as_bytes()) {
        unroute(app);
        return Err(format!("Failed to write to engine: {}", e));
    }
    drop(guard);
    Ok(())
}

/// Undo a routing when the request never reached the sidecar.
pub fn unroute_request<R: Runtime>(app: &AppHandle<R>, outer: u64) {
    app.state::<EngineRouter>().take(outer);
}

/// Restore a response's original id and deliver it to the window that asked.
/// Only a route written to worker generation `generation` can be answered by
/// that worker's output.
fn route_response<R: Runtime>(app: &AppHandle<R>, label: &str, generation: u64, mut json: serde_json::Value) {
    let Some(outer) = json.get("id").and_then(|v| v.as_u64()) else {
        // An id-less line correlates to no request; the worker serves one
        // window, so it goes to that window only.
        let _ = app.emit_to(label, "engine:response", json);
        return;
    };
    let Some(route) = app.state::<EngineRouter>().take_from(outer, generation) else {
        return;
    };
    if let Some(obj) = json.as_object_mut() {
        obj.insert("id".to_string(), route.inner);
    }
    let _ = app.emit_to(route.label.as_str(), "engine:response", json);
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

/// Starts `label`'s engine worker and wires its stdout to that window.
/// Idempotent — if the worker is already running, returns immediately.
pub async fn start<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let worker = app.state::<EngineState>().worker(label)?;
    start_worker(app, label, &worker).await
}

async fn start_worker<R: Runtime>(app: &AppHandle<R>, label: &str, worker: &Arc<EngineWorker>) -> Result<(), String> {
    let state = app.state::<EngineState>();

    // Hold the startup lock until the child and its lifetime guard are ready.
    let mut guard = worker.child.lock().await;
    if worker.is_closed() {
        return Err(WINDOW_CLOSED.to_string());
    }
    if worker.retiring.load(Ordering::SeqCst) {
        return Err("The document engine is stopping after an oversized response.".to_string());
    }
    if guard.is_some() {
        return Ok(());
    }

    let (program, args) = match &state.launcher {
        Launcher::Resources => (
            get_python_path(app),
            python_args(&get_engine_script_path(app)),
        ),
        Launcher::Command { program, args } => (program.clone(), args.clone()),
    };

    let shell = app.shell();
    let (mut rx, child) = shell
        .command(&program)
        .args(args)
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
    let generation = state.next_generation.fetch_add(1, Ordering::SeqCst);
    worker.generation.store(generation, Ordering::SeqCst);
    *guard = Some(EngineChild { child, generation, _job: job });
    drop(guard);

    // Starting a worker imports the whole engine before the first request is
    // read; the window says so until the worker reports ready.
    let _ = app.emit_to(label, "engine:starting", true);
    let app_handle = app.clone();
    let worker = worker.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let mut starting = true;
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
                                route_response(&app_handle, &label, generation, json);
                            }
                        }
                    }
                    if chunk.oversized {
                        eprintln!(
                            "[engine {label}] response line exceeded the {} MiB limit; stopping the engine",
                            MAX_ENGINE_RPC_LINE_BYTES / (1024 * 1024)
                        );
                        oversized_stdout = true;
                        let mut guard = worker.child.lock().await;
                        if guard
                            .as_ref()
                            .is_some_and(|current| current.generation == generation)
                        {
                            worker.retiring.store(true, Ordering::SeqCst);
                            let current = guard.take().expect("matched engine child");
                            let EngineChild { child, _job, .. } = current;
                            retiring_job = Some(_job);
                            claimed_oversize = true;
                            if let Err(error) = child.kill() {
                                eprintln!("[engine {label}] failed to stop oversized worker: {error}");
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
                    if starting && trimmed.contains(ENGINE_READY_LINE) {
                        starting = false;
                        let _ = app_handle.emit_to(label.as_str(), "engine:starting", false);
                    }
                    if !trimmed.is_empty() {
                        eprintln!("[engine {label}] {}", trimmed);
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                    eprintln!("[engine {label}] exited with {:?}", status);
                    break;
                }
                _ => {}
            }
        }
        if starting {
            let _ = app_handle.emit_to(label.as_str(), "engine:starting", false);
        }
        if claimed_oversize {
            // The Terminated event has arrived (or the stream closed), so no
            // replacement may overlap this worker. Drain its routes before
            // allowing the next start to create a child.
            drop(retiring_job.take());
            let stopped = stopped_responses_with_message(
                &app_handle.state::<EngineRouter>(),
                generation,
                "The engine response exceeded the 256 MiB limit. The operation was stopped.",
            );
            deliver_stopped(&app_handle, stopped);
            worker.retiring.store(false, Ordering::SeqCst);
            return;
        }
        // A closed event stream also means the worker cannot answer. The slot
        // is cleared only when it still holds THIS generation; a later worker
        // spawned after an intentional restart is left alone.
        let mut guard = worker.child.lock().await;
        if guard.as_ref().is_some_and(|current| current.generation == generation) {
            guard.take(); // closes the job, including any surviving descendants
        }
        drop(guard);
        // Routes are keyed by generation, so this drains exactly the requests
        // this process was sent and never answered. A restart that already
        // drained them leaves nothing here.
        let stopped = stopped_responses(&app_handle.state::<EngineRouter>(), generation);
        deliver_stopped(&app_handle, stopped);
    });

    Ok(())
}

/// How long a worker may keep running to finish a write in flight after its
/// window closed, before an assent restart, or before the app exits. A worker
/// still writing at the deadline is killed.
pub const ENGINE_DRAIN_DEADLINE: Duration = Duration::from_secs(600);

/// Override of `ENGINE_DRAIN_DEADLINE` in whole milliseconds, read on every
/// drain. A malformed or absent value is the compiled-in default.
pub const ENGINE_DRAIN_ENV: &str = "SPECTRAPDF_ENGINE_DRAIN_MS";

const DRAIN_POLL: Duration = Duration::from_millis(50);

/// The drain deadline as configured now.
pub fn engine_drain_deadline() -> Duration {
    std::env::var(ENGINE_DRAIN_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map_or(ENGINE_DRAIN_DEADLINE, Duration::from_millis)
}

/// Poll `done` until it holds or `deadline` passes. True when it held.
async fn wait_until(deadline: Instant, done: impl Fn() -> bool) -> bool {
    loop {
        if done() {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        tokio::time::sleep(DRAIN_POLL.min(deadline - now)).await;
    }
}

/// Wait, bounded by `within`, until no worker holds a write in flight.
/// True when every write finished.
pub async fn wait_for_writes<R: Runtime>(app: &AppHandle<R>, within: Duration) -> bool {
    let router = app.state::<EngineRouter>();
    wait_until(Instant::now() + within, || router.writes_in_flight(None) == 0).await
}

/// Tell every open window that a closed window's write was stopped before it
/// finished. The count is the number of writes that were cut.
fn notify_writes_stopped<R: Runtime>(app: &AppHandle<R>, cut: usize) {
    let labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| crate::app_windows::is_app_window(label))
        .collect();
    for label in labels {
        let _ = app.emit_to(label.as_str(), "engine:writeStopped", cut);
    }
}

/// After the drain deadline, how long a cancelled write is given to reach its
/// next safe point before its worker is killed.
const CANCEL_GRACE: Duration = Duration::from_secs(30);

/// Ask every write of worker generation `generation` to stop at its next safe
/// point. Nothing is written when the slot holds another generation.
async fn cancel_generation_writes<R: Runtime>(app: &AppHandle<R>, worker: &EngineWorker, generation: u64) {
    let mut guard = worker.child.lock().await;
    let Some(child) = guard.as_mut().filter(|child| child.generation == generation) else {
        return;
    };
    for outer in app.state::<EngineRouter>().write_routes(generation) {
        let _ = child.child.write(cancel_frame(outer).as_bytes());
    }
}

/// Ask every write in flight, in every worker, to stop at its next safe point,
/// then wait up to `within` for them to end. For a session that is ending.
pub async fn cancel_writes<R: Runtime>(app: &AppHandle<R>, within: Duration) {
    for worker in app.state::<EngineState>().all_workers() {
        let generation = worker.generation.load(Ordering::SeqCst);
        cancel_generation_writes(app, &worker, generation).await;
    }
    let router = app.state::<EngineRouter>();
    wait_until(Instant::now() + within, || router.writes_in_flight(None) == 0).await;
}

/// Stop the worker of a destroyed window.
///
/// The window's own routes are dropped; routes that hold write protection (an
/// output reservation, a folder lease) are kept, unaddressed, until the worker
/// answers them. A worker that owes nothing is killed at once. A worker that
/// still owes such a route has every other request of that window cancelled
/// and keeps running until those writes finish. At the drain deadline its
/// writes are cancelled so they stop at a safe point; a worker still running
/// `CANCEL_GRACE` later is killed. Either way its routes and leases are
/// released, and the open windows are told when a write was cut.
pub fn retire_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let first = app.state::<EngineRouter>().take_label(label);
    let Some(worker) = app.state::<EngineState>().retire(label) else {
        return;
    };
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let mut guard = worker.child.lock().await;
        // A send holds the slot lock from its closed check through its write,
        // so every route this window will ever register exists by now.
        let router = app.state::<EngineRouter>();
        let late = router.take_label(&label);
        let Some(generation) = guard.as_ref().map(EngineChild::generation) else {
            return;
        };
        if router.writes_in_flight(Some(generation)) == 0 {
            drop(guard);
            stop_generation(&app, &worker, generation).await;
            return;
        }
        if let Some(child) = guard.as_mut() {
            for outer in first.into_iter().chain(late) {
                if !router.contains(outer) {
                    let _ = child.child.write(cancel_frame(outer).as_bytes());
                }
            }
        }
        drop(guard);
        let state = app.state::<EngineState>();
        state.set_draining(&worker, true);
        let deadline = Instant::now() + engine_drain_deadline();
        let mut cut = 0;
        if !wait_until(deadline, || !router.has_worker(generation)).await {
            // Every write still running here is stopped before it finishes,
            // whether the cancel or the kill ends it.
            cut = router.writes_in_flight(Some(generation));
            eprintln!("[engine {label}] drain deadline passed; cancelling its writes");
            cancel_generation_writes(&app, &worker, generation).await;
            wait_until(Instant::now() + CANCEL_GRACE, || !router.has_worker(generation)).await;
        }
        stop_generation(&app, &worker, generation).await;
        state.set_draining(&worker, false);
        if cut > 0 {
            notify_writes_stopped(&app, cut);
        }
    });
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
    generation: u64,
    message: &str,
) -> Vec<(String, serde_json::Value)> {
    router
        .take_worker(generation)
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

/// Drops every running worker so the next call in each window spawns one
/// carrying the current colour-profile assent.
///
/// The assent rides an environment variable, which a live subprocess read once
/// at spawn — so a mid-session acceptance reaches the engine only through a new
/// process. An idle worker is stopped before this returns. A worker with a
/// write in flight is stopped in the background once that write finishes, or
/// at the drain deadline, so the caller never waits on it; its pending
/// requests are answered with the stopped error. `start` is idempotent, so the
/// next operation brings one back.
pub async fn restart_for_assent<R: Runtime>(app: &AppHandle<R>) {
    let deadline = Instant::now() + engine_drain_deadline();
    for worker in app.state::<EngineState>().all_workers() {
        let generation = worker.child.lock().await.as_ref().map(EngineChild::generation);
        let Some(generation) = generation else {
            continue;
        };
        if app.state::<EngineRouter>().writes_in_flight(Some(generation)) == 0 {
            stop_generation(app, &worker, generation).await;
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let router = app.state::<EngineRouter>();
            wait_until(deadline, || router.writes_in_flight(Some(generation)) == 0).await;
            stop_generation(&app, &worker, generation).await;
        });
    }
}

/// Stop `worker` when it still runs generation `generation`, answering its
/// pending requests with the stopped error.
async fn stop_generation<R: Runtime>(app: &AppHandle<R>, worker: &EngineWorker, generation: u64) {
    let mut guard = worker.child.lock().await;
    if guard.as_ref().is_none_or(|child| child.generation != generation) {
        return;
    }
    let stopped = stop_and_drain(&mut guard, &app.state::<EngineRouter>(), |child| {
        let _ = child.child.kill();
    });
    drop(guard);
    deliver_stopped(app, stopped);
}

/// Empties the slot and retires every request routed to the worker it held,
/// in one step under the slot lock. The killed child's monitor then finds the
/// slot empty or holding another generation and its own drain finds nothing,
/// because `take_worker` removes each route as it returns it: a request is
/// failed exactly once whichever path runs.
fn stop_and_drain<T: Generational>(
    slot: &mut Option<T>,
    router: &EngineRouter,
    kill: impl FnOnce(T),
) -> Vec<(String, serde_json::Value)> {
    let Some(child) = slot.take() else {
        return Vec::new();
    };
    let generation = child.generation();
    kill(child);
    stopped_responses(router, generation)
}

trait Generational {
    fn generation(&self) -> u64;
}

impl Generational for EngineChild {
    fn generation(&self) -> u64 {
        self.generation
    }
}

/// The "engine stopped" error for every request still routed to worker
/// generation `generation`, keyed by the window that asked. Dropping the
/// routes also releases their leases.
fn stopped_responses(router: &EngineRouter, generation: u64) -> Vec<(String, serde_json::Value)> {
    stopped_responses_with_message(
        router,
        generation,
        "The document engine stopped before completing the operation.",
    )
}

fn deliver_stopped<R: Runtime>(app: &AppHandle<R>, stopped: Vec<(String, serde_json::Value)>) {
    for (label, payload) in stopped {
        let _ = app.emit_to(label.as_str(), "engine:response", payload);
    }
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
    fn a_route_that_never_reached_the_engine_is_dropped() {
        let router = EngineRouter::new();
        let mut request = serde_json::json!({"id": 7});
        let outer = route_with(&router, "main", &mut request).unwrap();
        assert_eq!(router.outstanding().get("main"), Some(&1));

        assert!(router.take(outer).is_some());
        assert!(router.outstanding().is_empty());
    }

    #[test]
    fn a_window_can_address_only_its_own_in_flight_request_for_cancel() {
        let router = EngineRouter::new();
        let mut mine = serde_json::json!({"id": 5});
        let mut theirs = serde_json::json!({"id": 5});
        let my_outer = route_with(&router, "main", &mut mine).unwrap();
        let their_outer = route_with(&router, "doc-1", &mut theirs).unwrap();
        assert_ne!(my_outer, their_outer);

        let five = serde_json::json!(5);
        assert_eq!(router.outer_for("main", &five), Some(my_outer));
        assert_eq!(router.outer_for("doc-1", &five), Some(their_outer));
        assert_eq!(router.outer_for("main", &serde_json::json!(6)), None);
        assert_eq!(router.outer_for("main", &serde_json::json!("5")), None);
        assert_eq!(router.outer_for("doc-2", &five), None);
        assert_eq!(router.outer_for("", &five), None);
        assert_eq!(router.outer_for("main", &serde_json::Value::Null), None);

        // An outer id cannot be passed in place of an inner one.
        assert_eq!(router.outer_for("main", &serde_json::json!(their_outer)), None);

        assert!(router.take(my_outer).is_some());
        assert_eq!(router.outer_for("main", &five), None);
    }

    #[test]
    fn a_destroyed_windows_request_is_no_longer_addressable() {
        let router = EngineRouter::new();
        let mut request = serde_json::json!({"id": 1});
        route_with(&router, "doc-1", &mut request).unwrap();
        router.drop_label("doc-1");
        assert_eq!(router.outer_for("doc-1", &serde_json::json!(1)), None);
    }

    #[test]
    fn the_cancel_frame_is_an_id_less_notification_naming_the_outer_id() {
        let line = cancel_frame(42);
        assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
        let frame: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(frame["jsonrpc"], "2.0");
        assert_eq!(frame["method"], "$/cancelRequest");
        assert_eq!(frame["params"]["id"], 42);
        assert!(frame.get("id").is_none());
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

    impl Generational for u32 {
        fn generation(&self) -> u64 {
            u64::from(*self)
        }
    }

    fn routed(router: &EngineRouter, label: &str, inner: u64, worker: u64) -> u64 {
        let mut request = serde_json::json!({"id": inner});
        route_with_leases(router, label, &mut request, worker, Vec::new(), Vec::new(), None).unwrap()
    }

    #[test]
    fn an_assent_restart_fails_each_pending_request_exactly_once() {
        let router = EngineRouter::new();
        routed(&router, "main", 41, 7);
        let other = routed(&router, "doc-1", 41, 8);
        let mut slot = Some(7u32);
        let mut killed = Vec::new();
        let stopped = stop_and_drain(&mut slot, &router, |pid| killed.push(pid));
        assert_eq!(killed, vec![7]);
        assert!(slot.is_none());
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].0, "main");
        assert_eq!(stopped[0].1["id"], 41);
        assert!(stopped[0].1["error"]["message"].as_str().unwrap().contains("stopped"));
        // The killed child's monitor drains after the restart; nothing is left.
        assert!(stopped_responses(&router, 7).is_empty());
        // Another window's worker keeps its request.
        assert!(router.contains(other));
        assert_eq!(router.outstanding().get("doc-1"), Some(&1));
    }

    #[test]
    fn a_response_is_accepted_only_from_the_worker_the_request_was_written_to() {
        let router = EngineRouter::new();
        let a = routed(&router, "main", 1, 10);
        let b = routed(&router, "doc-1", 1, 11);
        // Worker 11 echoing worker 10's outer id retires nothing.
        assert!(router.take_from(a, 11).is_none());
        assert!(router.contains(a));
        let route = router.take_from(a, 10).expect("worker 10 answers its own request");
        assert_eq!(route.label, "main");
        assert_eq!(route.inner, serde_json::json!(1));
        assert!(router.take_from(a, 10).is_none());
        assert_eq!(router.take_from(b, 11).map(|route| route.label), Some("doc-1".to_string()));
    }

    #[test]
    fn one_workers_exit_fails_only_its_own_requests() {
        let router = EngineRouter::new();
        routed(&router, "main", 1, 10);
        routed(&router, "main", 2, 10);
        let survivor = routed(&router, "doc-1", 1, 11);
        let stopped = stopped_responses(&router, 10);
        let mut ids: Vec<_> = stopped
            .iter()
            .map(|(label, payload)| (label.clone(), payload["id"].as_u64().unwrap()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![("main".to_string(), 1), ("main".to_string(), 2)]);
        assert!(!router.has_worker(10));
        assert!(router.has_worker(11));
        assert!(router.contains(survivor));
    }

    #[test]
    fn a_cancel_names_the_worker_that_holds_the_request() {
        let router = EngineRouter::new();
        let mine = routed(&router, "main", 5, 10);
        let theirs = routed(&router, "doc-1", 5, 11);
        assert_eq!(router.route_for("main", &serde_json::json!(5)), Some((mine, 10)));
        assert_eq!(router.route_for("doc-1", &serde_json::json!(5)), Some((theirs, 11)));
        assert_eq!(router.route_for("doc-2", &serde_json::json!(5)), None);
    }

    #[test]
    fn a_retained_write_keeps_its_worker_owed_after_the_window_is_dropped() {
        let scratch = tempfile::tempdir().unwrap();
        let state = crate::app_windows::ClaimState::with_registry(scratch.path().join("claims"));
        let output = scratch.path().join("out.pdf").to_string_lossy().into_owned();
        let reservation = state.claim_engine_output(&output, "doc-1").unwrap();
        let router = EngineRouter::new();
        let mut write = serde_json::json!({"id": 1});
        let kept = route_with_leases(
            &router, "doc-1", &mut write, 12, Vec::new(), Vec::new(), Some(reservation),
        )
        .unwrap();
        let read = routed(&router, "doc-1", 2, 12);
        let dropped = router.take_label("doc-1");
        assert_eq!(dropped.len(), 2);
        assert!(router.contains(kept));
        assert!(!router.contains(read));
        assert!(router.has_worker(12));
        assert_eq!(router.writes_in_flight(Some(12)), 1);
        assert_eq!(router.writes_in_flight(Some(13)), 0);
        assert_eq!(router.writes_in_flight(None), 1);
        // The retained route is unaddressed: its answer reaches no window.
        assert!(router.take_from(kept, 12).is_none());
        assert!(!router.has_worker(12));
        assert_eq!(router.writes_in_flight(None), 0);
    }

    #[tokio::test]
    async fn a_drain_wait_ends_when_the_condition_holds_or_at_its_deadline() {
        let start = Instant::now();
        assert!(wait_until(start + Duration::from_secs(5), || true).await);
        assert!(start.elapsed() < Duration::from_secs(1));
        let flag = Arc::new(AtomicBool::new(false));
        let setter = flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            setter.store(true, Ordering::SeqCst);
        });
        assert!(wait_until(Instant::now() + Duration::from_secs(5), || flag.load(Ordering::SeqCst)).await);
        let start = Instant::now();
        assert!(!wait_until(start + Duration::from_millis(200), || false).await);
        assert!(start.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn a_destroyed_window_cannot_respawn_its_worker() {
        let state = EngineState::new();
        let first = state.worker("doc-1").unwrap();
        assert!(Arc::ptr_eq(&first, &state.worker("doc-1").unwrap()));
        assert!(!Arc::ptr_eq(&first, &state.worker("doc-2").unwrap()));
        let retired = state.retire("doc-1").expect("slot existed");
        assert!(retired.is_closed());
        assert!(state.worker("doc-1").is_err());
        assert!(state.existing_worker("doc-1").is_none());
        assert!(state.retire("doc-3").is_none());
        assert!(state.worker("doc-3").is_err());
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
            0,
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
            0,
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
                0,
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
