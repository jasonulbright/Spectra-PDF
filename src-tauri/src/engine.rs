use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// Manages the Python JSON-RPC engine sidecar process.
pub struct EngineState {
    pub child: Arc<Mutex<Option<CommandChild>>>,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
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
}

impl EngineRouter {
    pub fn new() -> Self {
        Self {
            next_outer: AtomicU64::new(1),
            by_outer: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, label: &str, inner: serde_json::Value) -> u64 {
        let outer = self.next_outer.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut map) = self.by_outer.lock() {
            map.insert(
                outer,
                Route {
                    label: label.to_string(),
                    inner,
                },
            );
        }
        outer
    }

    fn take(&self, outer: u64) -> Option<Route> {
        self.by_outer.lock().ok()?.remove(&outer)
    }

    /// Drop a destroyed window's outstanding requests. Their responses then
    /// land on no route and are discarded, which is the correct fate for a
    /// call whose caller is gone.
    pub fn drop_label(&self, label: &str) {
        if let Ok(mut map) = self.by_outer.lock() {
            map.retain(|_, route| route.label != label);
        }
    }

    /// How many requests each window has in flight.
    pub fn outstanding(&self) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        if let Ok(map) = self.by_outer.lock() {
            for route in map.values() {
                *counts.entry(route.label.clone()).or_insert(0) += 1;
            }
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
pub fn route_request(app: &AppHandle, label: &str, request: &mut serde_json::Value) -> Option<u64> {
    let obj = request.as_object_mut()?;
    let inner = obj.get("id").cloned()?;
    if inner.is_null() {
        return None;
    }
    let outer = app.state::<EngineRouter>().register(label, inner);
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
pub fn get_engine_script_path(app: &AppHandle) -> String {
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
pub fn get_python_path(app: &AppHandle) -> String {
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
        ("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()),
        (
            crate::portable::ICC_ASSENT_ENV.to_string(),
            crate::portable::assent_env_value(crate::portable::icc_assent()).to_string(),
        ),
    ]
}

/// Starts the Python engine sidecar and wires stdout to the webview.
/// Idempotent — if the engine is already running, returns immediately.
pub async fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();

    // Already running — don't spawn another
    {
        let guard = state.child.lock().await;
        if guard.is_some() {
            return Ok(());
        }
    }

    let python_path = get_python_path(app);
    let script_path = get_engine_script_path(app);

    let shell = app.shell();
    let (mut rx, child) = shell
        .command(&python_path)
        .args([&script_path])
        .envs(python_env().into_iter().collect::<HashMap<String, String>>())
        .spawn()
        .map_err(|e| format!("Failed to start engine: {}", e))?;

    // Store the child process handle
    *state.child.lock().await = Some(child);

    // Forward stdout lines to the webview as engine:response events
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
    });

    Ok(())
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
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
}
