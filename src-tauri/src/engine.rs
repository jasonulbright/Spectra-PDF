use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[cfg(target_os = "linux")]
use crate::process_job::WorkerChild as CommandChild;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// Maximum content bytes in one JSON-RPC frame in either direction, excluding
/// its newline delimiter. All three engine transports use the same wire limit.
pub(crate) const MAX_ENGINE_RPC_LINE_BYTES: usize = 256 * 1024 * 1024;
/// Which engine process serves a method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessClass {
    /// The window's own persistent process.
    Window,
    /// The window's persistent job process, started on its first job call.
    Job,
    /// A process started for one call and ended after its answer.
    Run,
    /// The app-wide health worker (`health_engine`).
    Health,
}

/// Every registered engine method and the process that serves it.
///
/// Rule for a new method: `Job` when the renderer issues it per page, per
/// document, per preview or per query and one call runs an external program
/// (Ghostscript, Tesseract, LibreOffice) or reads a list of files; `Run`
/// when one call covers a folder or one
/// indivisible external run the user starts as a separate action; `Window`
/// otherwise. Methods that share process state take one class:
/// `split_plan`/`split`, `list_csc_credentials`/`sign_pdf`,
/// `print_preview`/`print_preview_cleanup`, and
/// `render_separations`/`composite_separations`/`inspect_point`.
/// `open_document`, `open_document_attempt`, `open_pubkey_document` and
/// `unlock` rewrite the working copy in place, so they run only in the window
/// process. `tests/test_engine_route_table.py` fails when a registered method
/// has no row here or a row names no registered method.
pub(crate) const METHOD_CLASSES: &[(&str, ProcessClass)] = &[
    ("ping", ProcessClass::Window),
    ("merge", ProcessClass::Window),
    ("split", ProcessClass::Window),
    ("split_plan", ProcessClass::Window),
    ("rotate", ProcessClass::Window),
    ("delete", ProcessClass::Window),
    ("compress", ProcessClass::Job),
    ("grayscale", ProcessClass::Job),
    ("convert_cmyk", ProcessClass::Job),
    ("convert_pdfx", ProcessClass::Job),
    ("optimize", ProcessClass::Window),
    ("convert_pdfa", ProcessClass::Job),
    ("encrypt", ProcessClass::Window),
    ("grant_accessibility_permission", ProcessClass::Window),
    ("decrypt", ProcessClass::Window),
    ("encrypt_pubkey", ProcessClass::Window),
    ("decrypt_pubkey", ProcessClass::Window),
    ("open_pubkey_document", ProcessClass::Window),
    ("pubkey_reseal", ProcessClass::Window),
    ("pubkey_reattach", ProcessClass::Window),
    ("extract_text", ProcessClass::Window),
    ("search_in_files", ProcessClass::Job),
    ("search_text_regions", ProcessClass::Window),
    ("add_header_footer", ProcessClass::Window),
    ("set_page_boxes", ProcessClass::Window),
    ("content_crop", ProcessClass::Job),
    ("get_page_labels", ProcessClass::Window),
    ("set_page_labels", ProcessClass::Window),
    ("export_xfdf", ProcessClass::Window),
    ("import_xfdf", ProcessClass::Window),
    ("export_count_summary", ProcessClass::Window),
    ("list_attachments", ProcessClass::Window),
    ("add_attachment", ProcessClass::Window),
    ("extract_attachment", ProcessClass::Window),
    ("remove_attachment", ProcessClass::Window),
    ("get_portfolio", ProcessClass::Window),
    ("create_portfolio", ProcessClass::Window),
    ("make_portfolio", ProcessClass::Window),
    ("update_portfolio_member", ProcessClass::Window),
    ("extract_member_to_dir", ProcessClass::Window),
    ("list_layers", ProcessClass::Window),
    ("set_layer_visibility", ProcessClass::Window),
    ("check_accessibility", ProcessClass::Window),
    ("apply_accessibility_fixes", ProcessClass::Window),
    ("list_annotations", ProcessClass::Window),
    ("list_comments", ProcessClass::Window),
    ("summarize_comments", ProcessClass::Window),
    ("delete_all_annotations", ProcessClass::Window),
    ("preflight", ProcessClass::Job),
    ("list_preflight_profiles", ProcessClass::Window),
    ("validate_preflight_profile", ProcessClass::Window),
    ("apply_preflight_fixups", ProcessClass::Job),
    ("run_preflight_sweep", ProcessClass::Run),
    ("list_inks", ProcessClass::Window),
    ("render_separations", ProcessClass::Job),
    ("composite_separations", ProcessClass::Job),
    ("list_simulation_profiles", ProcessClass::Window),
    ("inspect_point", ProcessClass::Job),
    ("alias_ink", ProcessClass::Window),
    ("compare_ink_transforms", ProcessClass::Window),
    ("spot_to_process", ProcessClass::Window),
    ("ink_settings_defaults", ProcessClass::Window),
    ("add_printer_marks", ProcessClass::Window),
    ("remove_printer_marks", ProcessClass::Window),
    ("list_printer_marks", ProcessClass::Window),
    ("list_hairlines", ProcessClass::Window),
    ("fix_hairlines", ProcessClass::Window),
    ("list_transparency", ProcessClass::Window),
    ("flatten_transparency", ProcessClass::Job),
    ("list_outlines", ProcessClass::Window),
    ("trap_preset_defaults", ProcessClass::Window),
    ("validate_trap_preset", ProcessClass::Window),
    ("assign_trap_presets", ProcessClass::Window),
    ("list_trap_presets", ProcessClass::Window),
    ("emit_trapping_setup", ProcessClass::Window),
    ("export_postscript", ProcessClass::Job),
    ("get_struct_tree", ProcessClass::Window),
    ("set_struct_props", ProcessClass::Window),
    ("set_table_headers", ProcessClass::Window),
    ("tag_page_content", ProcessClass::Window),
    ("move_struct_node", ProcessClass::Window),
    ("delete_struct_node", ProcessClass::Window),
    ("add_struct_node", ProcessClass::Window),
    ("list_links", ProcessClass::Window),
    ("set_link_url", ProcessClass::Window),
    ("set_link_target", ProcessClass::Window),
    ("set_link_appearance", ProcessClass::Window),
    ("set_link_rect", ProcessClass::Window),
    ("list_named_destinations", ProcessClass::Window),
    ("delete_link", ProcessClass::Window),
    ("add_links", ProcessClass::Window),
    ("export_document", ProcessClass::Job),
    ("supported_export_formats", ProcessClass::Window),
    ("detect_tables", ProcessClass::Window),
    ("export_images", ProcessClass::Job),
    ("get_metadata", ProcessClass::Window),
    ("set_metadata", ProcessClass::Window),
    ("strip_metadata", ProcessClass::Window),
    ("get_pdf_version", ProcessClass::Window),
    ("set_pdf_version", ProcessClass::Window),
    ("get_initial_view", ProcessClass::Window),
    ("set_initial_view", ProcessClass::Window),
    ("get_advanced_properties", ProcessClass::Window),
    ("set_advanced_properties", ProcessClass::Window),
    ("set_document_language", ProcessClass::Window),
    ("set_document_title", ProcessClass::Window),
    ("set_page_tab_order", ProcessClass::Window),
    ("list_document_fonts", ProcessClass::Window),
    ("get_page_count", ProcessClass::Window),
    ("get_page_info", ProcessClass::Window),
    ("check_encrypted", ProcessClass::Window),
    ("unlock", ProcessClass::Window),
    ("open_document", ProcessClass::Window),
    ("open_document_attempt", ProcessClass::Window),
    ("close_document", ProcessClass::Window),
    ("document_permissions", ProcessClass::Window),
    ("share_document", ProcessClass::Window),
    ("sealed_plaintext", ProcessClass::Window),
    ("sealed_reseal", ProcessClass::Window),
    ("repair", ProcessClass::Window),
    ("rebuild", ProcessClass::Job),
    ("recover", ProcessClass::Window),
    ("check", ProcessClass::Window),
    ("document_health", ProcessClass::Health),
    ("document_health_begin", ProcessClass::Health),
    ("document_health_step", ProcessClass::Health),
    ("document_health_end", ProcessClass::Health),
    ("get_outline", ProcessClass::Window),
    ("set_outline", ProcessClass::Window),
    ("preview_structure_outline", ProcessClass::Window),
    ("outline_from_structure", ProcessClass::Window),
    ("read_aloud_page", ProcessClass::Window),
    ("find_url_links", ProcessClass::Window),
    ("create_links_from_urls", ProcessClass::Window),
    ("list_threads", ProcessClass::Window),
    ("set_threads", ProcessClass::Window),
    ("list_document_js", ProcessClass::Window),
    ("set_document_js", ProcessClass::Window),
    ("redact", ProcessClass::Window),
    ("remove_redaction_residue", ProcessClass::Window),
    ("search_and_redact", ProcessClass::Window),
    ("audit_hidden_information", ProcessClass::Window),
    ("sanitize_pdf", ProcessClass::Window),
    ("audit_space_usage", ProcessClass::Window),
    ("watermark", ProcessClass::Window),
    ("compare_text", ProcessClass::Window),
    ("compare_visual", ProcessClass::Job),
    ("read_form_fields", ProcessClass::Window),
    ("fill_form_fields", ProcessClass::Window),
    ("reset_form_fields", ProcessClass::Window),
    ("export_form_data", ProcessClass::Window),
    ("import_form_data", ProcessClass::Window),
    ("set_widget_visibility", ProcessClass::Window),
    ("detect_form_fields", ProcessClass::Job),
    ("create_detected_fields", ProcessClass::Window),
    ("prepare_form_fields", ProcessClass::Job),
    ("set_field_lock", ProcessClass::Window),
    ("author_vertical_field_font", ProcessClass::Window),
    ("author_choice_appearance", ProcessClass::Window),
    ("set_field_actions", ProcessClass::Window),
    ("set_field_description", ProcessClass::Window),
    ("apply_ocr_layer", ProcessClass::Window),
    ("recognize", ProcessClass::Job),
    ("recognize_raster", ProcessClass::Job),
    ("analyze_scan", ProcessClass::Job),
    ("enhance_scan", ProcessClass::Job),
    ("batch_ocr", ProcessClass::Run),
    ("ocr_file", ProcessClass::Job),
    ("remove_empty_folders", ProcessClass::Window),
    ("run_action", ProcessClass::Run),
    ("autotag", ProcessClass::Window),
    ("list_page_images", ProcessClass::Window),
    ("summarize_image_resolution", ProcessClass::Window),
    ("delete_page_image", ProcessClass::Window),
    ("replace_page_image", ProcessClass::Window),
    ("extract_page_image", ProcessClass::Window),
    ("transform_page_image", ProcessClass::Window),
    ("transform_page_images", ProcessClass::Window),
    ("delete_page_images", ProcessClass::Window),
    ("add_page_image", ProcessClass::Window),
    ("add_page_vector_graphic", ProcessClass::Window),
    ("crop_page_image", ProcessClass::Window),
    ("list_page_vectors", ProcessClass::Window),
    ("list_page_geometry", ProcessClass::Window),
    ("delete_page_vector", ProcessClass::Window),
    ("transform_page_vector", ProcessClass::Window),
    ("restyle_page_vector", ProcessClass::Window),
    ("set_image_opacity", ProcessClass::Window),
    ("replace_text_run", ProcessClass::Window),
    ("restyle_text_run", ProcessClass::Window),
    ("convert_text_run", ProcessClass::Window),
    ("list_text_paragraphs", ProcessClass::Window),
    ("replace_paragraph_text", ProcessClass::Window),
    ("merge_paragraph_with_previous", ProcessClass::Window),
    ("list_dictionaries", ProcessClass::Window),
    ("check_spelling", ProcessClass::Window),
    ("check_text", ProcessClass::Window),
    ("document_language", ProcessClass::Window),
    ("spelling_suggestions", ProcessClass::Window),
    ("add_user_dictionary", ProcessClass::Window),
    ("distill", ProcessClass::Job),
    ("create_pdf", ProcessClass::Job),
    ("list_source_folders", ProcessClass::Job),
    ("create_pdf_folders", ProcessClass::Run),
    ("list_system_fonts", ProcessClass::Window),
    ("add_text_box", ProcessClass::Window),
    ("measure_text_box", ProcessClass::Window),
    ("print", ProcessClass::Job),
    ("print_preview", ProcessClass::Job),
    ("print_preview_cleanup", ProcessClass::Job),
    ("printed_job", ProcessClass::Job),
    ("verify_signatures", ProcessClass::Window),
    ("sign_pdf", ProcessClass::Job),
    ("generate_signer", ProcessClass::Window),
    ("list_pkcs11_certificates", ProcessClass::Window),
    ("list_csc_credentials", ProcessClass::Job),
    ("preview_stamp_appearance", ProcessClass::Window),
    ("transplant_incremental", ProcessClass::Window),
    ("signature_policy", ProcessClass::Window),
    ("save_redaction_marks", ProcessClass::Window),
    ("list_redact_annotations", ProcessClass::Window),
];

/// The parameters of a `Run` method that name a file or folder. A run
/// process is given only the credentials of the working copies these name.
pub(crate) const RUN_PATH_PARAMS: &[&str] = &[
    "source",
    "sources",
    "dest",
    "moved_root",
    "error_root",
    "log_dir",
    "move_processed_root",
    "profile_path",
];

/// The process class of `method`. A method the table does not name runs in
/// the window process.
pub fn process_class(method: &str) -> ProcessClass {
    static CLASSES: OnceLock<HashMap<&'static str, ProcessClass>> = OnceLock::new();
    CLASSES
        .get_or_init(|| METHOD_CLASSES.iter().copied().collect())
        .get(method)
        .copied()
        .unwrap_or(ProcessClass::Window)
}

/// The role a spawned engine process plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Window,
    Job,
    Run,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Role::Window => "window",
            Role::Job => "job",
            Role::Run => "run",
        }
    }
}

/// The arguments every engine spawn appends after its own, so a process is
/// identified by role and window rather than by the script path it shares
/// with the health worker. The engine reads no `sys.argv`.
pub(crate) fn role_args(role: &str, window: Option<&str>) -> Vec<String> {
    let mut args = vec![format!("--spectra-role={role}")];
    if let Some(window) = window {
        args.push(format!("--spectra-window={window}"));
    }
    args
}

/// The interactive Python engine: per window, one persistent window process,
/// one persistent job process started on the window's first job call, and a
/// process per run call.
///
/// Each process answers one request at a time, so a long call delays only the
/// requests queued behind it in the same process; `METHOD_CLASSES` decides
/// which process a method reaches. A window's engine traffic reaches no other
/// window's processes.
///
/// Every piece of engine-side state that outlives a request is created by the
/// window that uses it and is keyed by that window's own working-copy paths:
/// the credential registry (`open_document`, `share_document`,
/// `open_pubkey_document`), sealed readers and recipient handlers, and the
/// restricted-folder marks that `credentials.end_request` clears after each
/// request. Documents are owned by exactly one window, and a tab hand-off
/// re-opens the document into a new working copy in the receiving window, so
/// no request ever needs state that lives in another window's processes.
/// Inside one process, requests stay strictly serial, which is the invariant
/// those modules are written against. That state dies with its process; a
/// window process that replaces one (a crash, an assent restart) is given the
/// window's credentials again before its first request (`CredentialLedger`).
/// A job or run process never receives the window's opens: before each of its
/// requests it is given, read-only, the held credentials it lacks (`Given`).
pub struct EngineState {
    workers: std::sync::Mutex<Workers>,
    runs: std::sync::Mutex<RunPool>,
    next_generation: AtomicU64,
    launcher: Launcher,
}

#[derive(Default)]
struct Workers {
    live: HashMap<String, Arc<EngineWorker>>,
    /// Each window's job process slot.
    jobs: HashMap<String, Arc<EngineWorker>>,
    /// Run processes that have been started and have not exited, with the
    /// window each serves.
    runs: Vec<(String, Arc<EngineWorker>)>,
    /// Labels whose window was destroyed. A late send from a destroyed window
    /// must not spawn a worker that nothing would ever retire.
    retired: std::collections::HashSet<String>,
    /// Workers of destroyed windows still finishing a write.
    draining: Vec<Arc<EngineWorker>>,
}

/// A run call that holds a route and waits for, or has just taken, a run slot.
pub(crate) struct QueuedRun {
    outer: u64,
    label: String,
    request: serde_json::Value,
}

/// The app-wide run slots: at most `cap` run processes at once, and the calls
/// waiting for a slot in arrival order.
pub(crate) struct RunPool {
    cap: usize,
    running: usize,
    queue: VecDeque<QueuedRun>,
}

impl RunPool {
    fn new(cap: usize) -> Self {
        Self { cap: cap.max(1), running: 0, queue: VecDeque::new() }
    }

    /// Take a slot for `run` when one is free; queue it otherwise.
    fn admit(&mut self, run: QueuedRun) -> Option<QueuedRun> {
        if self.running < self.cap {
            self.running += 1;
            Some(run)
        } else {
            self.queue.push_back(run);
            None
        }
    }

    /// A slot was given back. Returns the oldest queued call of a window that
    /// is not retired, which keeps the slot, and the calls of retired windows
    /// passed over on the way.
    fn release(&mut self, retired: impl Fn(&str) -> bool) -> (Option<QueuedRun>, Vec<QueuedRun>) {
        self.running = self.running.saturating_sub(1);
        let mut skipped = Vec::new();
        while let Some(run) = self.queue.pop_front() {
            if retired(&run.label) {
                skipped.push(run);
                continue;
            }
            self.running += 1;
            return (Some(run), skipped);
        }
        (None, skipped)
    }

    /// Remove the queued calls of window `label`.
    fn remove_label(&mut self, label: &str) -> Vec<QueuedRun> {
        let (gone, kept): (Vec<_>, Vec<_>) = self.queue.drain(..).partition(|run| run.label == label);
        self.queue = kept.into();
        gone
    }

    /// Remove every queued call.
    fn take_all(&mut self) -> Vec<QueuedRun> {
        self.queue.drain(..).collect()
    }
}

/// How a worker process is launched.
enum Launcher {
    /// The bundled interpreter and engine under the resource directory.
    Resources,
    /// An explicit program and argument list.
    Command { program: String, args: Vec<String> },
}

/// One engine slot of a window: its window process, its job process, or one
/// run process. A window or job slot survives its process: a process that
/// exits is respawned into the same slot by the next send.
pub struct EngineWorker {
    pub child: Mutex<Option<EngineChild>>,
    generation: AtomicU64,
    retiring: AtomicBool,
    closed: AtomicBool,
    role: Role,
    /// The window's own registrations; used in the window slot only.
    credentials: std::sync::Mutex<CredentialLedger>,
    /// What this slot's current process was given; job and run slots only.
    given: std::sync::Mutex<Given>,
    /// The lifetime binding of a run process whose input was closed after its
    /// answer, held until the process exits so its descendants stay bound.
    finishing: std::sync::Mutex<Option<LifetimeBinding>>,
}

impl EngineWorker {
    fn new(role: Role) -> Self {
        Self {
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
            retiring: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            role,
            credentials: std::sync::Mutex::new(CredentialLedger::default()),
            given: std::sync::Mutex::new(Given::default()),
            finishing: std::sync::Mutex::new(None),
        }
    }

    fn credentials(&self) -> std::sync::MutexGuard<'_, CredentialLedger> {
        self.credentials.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn given(&self) -> std::sync::MutexGuard<'_, Given> {
        self.given.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// True once the owning window has been destroyed.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

#[cfg(target_os = "linux")]
type LifetimeBinding = crate::process_job::ProcessJob;
#[cfg(not(target_os = "linux"))]
type LifetimeBinding = Option<crate::process_job::ProcessJob>;

pub struct EngineChild {
    pub child: CommandChild,
    generation: u64,
    _job: Option<crate::process_job::ProcessJob>,
}

impl EngineChild {
    /// The number that ties this process to the routes it was sent.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Close the process's input, so the engine returns at end of input after
    /// the requests already written. The returned binding keeps the process
    /// and its descendants bound to this one until it is dropped.
    fn close_input(self) -> LifetimeBinding {
        let EngineChild { child, _job, .. } = self;
        #[cfg(target_os = "linux")]
        {
            let _ = _job;
            child.into_job()
        }
        #[cfg(not(target_os = "linux"))]
        {
            drop(child);
            _job
        }
    }
}

/// The id prefix of the credential frames Rust writes before a process's
/// requests (`CredentialLedger::replay_frames`, `Given::delta`). No route
/// carries a string id; their answers are settled by the slot that wrote them.
/// The full id is `{prefix}{generation}:{n}`, so an answer settles only state
/// of the process generation that was sent the frame.
const REPLAY_ID_PREFIX: &str = "spectra-credential-replay:";

fn replay_id(generation: u64, n: u64) -> String {
    format!("{REPLAY_ID_PREFIX}{generation}:{n}")
}

/// The process generation named by a credential frame id.
fn replay_generation(id: &str) -> Option<u64> {
    id.strip_prefix(REPLAY_ID_PREFIX)?.split(':').next()?.parse().ok()
}

fn credential_frame(id: &str, method: &str, params: serde_json::Value) -> Secret {
    let mut line =
        Secret::new(serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string());
    line.push('\n');
    line
}

/// Told to a window whose worker was replaced and could not be given a
/// document's credential again; the payload names the working copy.
pub const CREDENTIAL_LOST_EVENT: &str = "engine:credential-lost";

type Secret = zeroize::Zeroizing<String>;

/// One credential a window registered in its worker. Passwords are zeroed
/// when the record is dropped.
#[derive(Clone, PartialEq, Eq)]
enum Registration {
    /// `open_document` with the user password of a still-encrypted copy.
    /// `grants` is what the open answered (`permissions`, `revision`, `p`),
    /// which another process is given without opening the file.
    Password { path: String, password: Secret, grants: Option<serde_json::Value> },
    /// `open_pubkey_document` or `pubkey_reattach`: the certificate that
    /// authenticates to the recipient lists again.
    Recipient { path: String, pfx: String, password: Secret, grants: Option<serde_json::Value> },
    /// `share_document`: a byte copy that opens with `path`'s credential.
    Alias { path: String, alias: String },
    /// `close_document`: applied when answered, whatever the answer.
    Close { path: String },
}

impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password { path, .. } => f.debug_struct("Password").field("path", path).finish_non_exhaustive(),
            Self::Recipient { path, pfx, .. } => {
                f.debug_struct("Recipient").field("path", path).field("pfx", pfx).finish_non_exhaustive()
            }
            Self::Alias { path, alias } => f.debug_struct("Alias").field("path", path).field("alias", alias).finish(),
            Self::Close { path } => f.debug_struct("Close").field("path", path).finish(),
        }
    }
}

/// The credentials a window's worker holds, kept for the life of the window
/// so a replacement worker (a crash, an assent restart) is given them again
/// before it serves a request. The engine's registry
/// (`engine/credentials.py`) is per process and lost with it. Held in memory
/// only; never written anywhere.
#[derive(Default)]
pub(crate) struct CredentialLedger {
    /// Each held record with a serial no other record of this window ever
    /// gets: a record closed and opened again is a new record to a job or run
    /// process, even when its fields are equal.
    held: Vec<(u64, Registration)>,
    next_serial: u64,
    /// Registrations written and not yet answered, by outer id.
    pending: HashMap<u64, Registration>,
    /// Replay frames not yet answered, by id.
    replaying: HashMap<String, Registration>,
}

fn ledger_key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn param_str(params: &serde_json::Value, name: &str) -> Option<String> {
    params.get(name).and_then(|v| v.as_str()).map(str::to_string)
}

fn param_secret(params: &serde_json::Value, name: &str) -> Secret {
    Secret::new(param_str(params, name).unwrap_or_default())
}

fn opener_of(result: Option<&serde_json::Value>) -> Option<&str> {
    result.and_then(|r| r.get("opener")).and_then(|o| o.as_str())
}

/// The grants an open answered, as a held credential carries them.
fn grants_of(result: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let result = result?;
    let permissions = result.get("permissions").filter(|p| p.is_object())?;
    Some(serde_json::json!({
        "permissions": permissions,
        "revision": result.get("revision").cloned().unwrap_or(serde_json::Value::Null),
        "p": result.get("p").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

impl CredentialLedger {
    /// The registration `request` makes when it succeeds, if any.
    fn registration_of(request: &serde_json::Value) -> Option<Registration> {
        let method = request.get("method")?.as_str()?;
        let params = request.get("params")?;
        let path = param_str(params, "path")?;
        match method {
            "open_document" | "open_document_attempt" => {
                Some(Registration::Password { path, password: param_secret(params, "password"), grants: None })
            }
            "open_pubkey_document" | "pubkey_reattach" => Some(Registration::Recipient {
                path,
                pfx: param_str(params, "pfx")?,
                password: param_secret(params, "password"),
                grants: None,
            }),
            "share_document" => Some(Registration::Alias { path, alias: param_str(params, "alias")? }),
            "close_document" => Some(Registration::Close { path }),
            _ => None,
        }
    }

    /// Note `request`, written under outer id `outer`.
    pub(crate) fn written(&mut self, outer: u64, request: &serde_json::Value) {
        if let Some(registration) = Self::registration_of(request) {
            self.pending.insert(outer, registration);
        }
    }

    /// Apply the answer to outer id `outer`. True when the answer closed a
    /// record.
    pub(crate) fn answered(&mut self, outer: u64, response: &serde_json::Value) -> bool {
        let Some(registration) = self.pending.remove(&outer) else {
            return false;
        };
        let result = response.get("result");
        match registration {
            Registration::Close { path } => {
                self.close(&path);
                return true;
            }
            Registration::Password { path, password, .. } => {
                let Some(result) = result else { return false };
                // `open_document_attempt` wraps the reply; a wrong password
                // leaves the record as it was.
                let document = match result.get("status").and_then(|s| s.as_str()) {
                    Some("opened") => result.get("document"),
                    Some(_) => return false,
                    None => Some(result),
                };
                self.forget_opener(&path);
                if opener_of(document) == Some("user") {
                    self.hold(Registration::Password { path, password, grants: grants_of(document) });
                }
            }
            Registration::Recipient { path, pfx, password, .. } => {
                if opener_of(result) == Some("recipient") {
                    self.forget_opener(&path);
                    self.hold(Registration::Recipient { path, pfx, password, grants: grants_of(result) });
                }
            }
            Registration::Alias { path, alias } => {
                if result.and_then(|r| r.get("shared")).and_then(|s| s.as_bool()) == Some(true) {
                    self.forget_alias(&alias);
                    self.hold(Registration::Alias { path, alias });
                }
            }
        }
        false
    }

    fn hold(&mut self, registration: Registration) {
        self.next_serial += 1;
        self.held.push((self.next_serial, registration));
    }

    /// The held records, for a job or run process's delta.
    fn held(&self) -> Vec<(u64, Registration)> {
        self.held.clone()
    }

    /// Settle the answer to replay frame `id`. A credential the replacement
    /// worker refused is forgotten; returns the working copy it belonged to
    /// when that copy is a document (not an alias), which now needs the user
    /// to unlock it again.
    pub(crate) fn replay_answered(&mut self, id: &str, response: &serde_json::Value) -> Option<String> {
        let registration = self.replaying.remove(id)?;
        let result = response.get("result");
        match registration {
            Registration::Password { path, .. } if opener_of(result) != Some("user") => {
                self.close(&path);
                Some(path)
            }
            Registration::Recipient { path, .. } if opener_of(result) != Some("recipient") => {
                self.forget_opener(&path);
                Some(path)
            }
            Registration::Alias { alias, .. }
                if result.and_then(|r| r.get("shared")).and_then(|s| s.as_bool()) != Some(true) =>
            {
                self.forget_alias(&alias);
                None
            }
            _ => None,
        }
    }

    fn forget_opener(&mut self, path: &str) {
        let key = ledger_key(path);
        self.held.retain(|(_, held)| match held {
            Registration::Password { path, .. } | Registration::Recipient { path, .. } => ledger_key(path) != key,
            _ => true,
        });
    }

    fn forget_alias(&mut self, alias: &str) {
        let key = ledger_key(alias);
        self.held.retain(|(_, held)| !matches!(held, Registration::Alias { alias, .. } if ledger_key(alias) == key));
    }

    /// `credentials.close_document`: the path's own record, and every alias
    /// of it when it is the document itself.
    fn close(&mut self, closed: &str) {
        let key = ledger_key(closed);
        self.held.retain(|(_, held)| match held {
            Registration::Password { path, .. } | Registration::Recipient { path, .. } => ledger_key(path) != key,
            Registration::Alias { path, alias } => ledger_key(path) != key && ledger_key(alias) != key,
            Registration::Close { .. } => false,
        });
    }

    /// Drop every credential; the secrets are zeroed as they drop.
    pub(crate) fn clear(&mut self) {
        self.held.clear();
        self.pending.clear();
        self.replaying.clear();
    }

    /// The frames that give a new worker every held credential: openers
    /// first, then the aliases that borrow from them. A replayed
    /// certificate open reattaches against the sealed original kept in the
    /// working folder (`pubkey_crypt.pubkey_reattach`). Each frame carries
    /// a secret, so it is zeroed when dropped.
    fn replay_frames(&mut self, generation: u64) -> Vec<Secret> {
        self.pending.clear();
        self.replaying.clear();
        let openers = self.held.iter().filter(|(_, h)| !matches!(h, Registration::Alias { .. }));
        let aliases = self.held.iter().filter(|(_, h)| matches!(h, Registration::Alias { .. }));
        let ordered: Vec<Registration> = openers.chain(aliases).map(|(_, held)| held.clone()).collect();
        let mut frames = Vec::new();
        for (n, held) in ordered.into_iter().enumerate() {
            let Some((method, params)) = held.replay_frame() else { continue };
            let id = replay_id(generation, n as u64);
            frames.push(credential_frame(&id, method, params));
            self.replaying.insert(id, held);
        }
        frames
    }
}

impl Registration {
    /// The frame that gives a replacement window process this record: it
    /// opens the document again, as the window's own open did. `None` for a
    /// close.
    fn replay_frame(&self) -> Option<(&'static str, serde_json::Value)> {
        Some(match self {
            Registration::Password { path, password, .. } => {
                ("open_document", serde_json::json!({ "path": path, "password": password.as_str() }))
            }
            Registration::Recipient { path, pfx, password, .. } => (
                "pubkey_reattach",
                serde_json::json!({ "path": path, "source": "", "pfx": pfx, "password": password.as_str() }),
            ),
            Registration::Alias { path, alias } => ("share_document", serde_json::json!({ "path": path, "alias": alias })),
            Registration::Close { .. } => return None,
        })
    }

    /// The frame that gives a job or run process this record. An opener is
    /// registered from the grants the window's open answered (`open_document`
    /// with `held`), so the process neither opens nor writes the working copy,
    /// its sealed original or its folder marker: another request of the
    /// window may be replacing those files under renderer locks this frame
    /// does not take. `None` for a close, and for an opener whose open
    /// answered no grants.
    fn held_frame(&self) -> Option<(&'static str, serde_json::Value)> {
        let held = |opener: &str, grants: &serde_json::Value| {
            let mut held = grants.clone();
            held["opener"] = serde_json::Value::from(opener);
            held
        };
        Some(match self {
            Registration::Password { path, password, grants } => (
                "open_document",
                serde_json::json!({ "path": path, "password": password.as_str(), "held": held("user", grants.as_ref()?) }),
            ),
            Registration::Recipient { path, grants, .. } => (
                "open_document",
                serde_json::json!({ "path": path, "password": "", "held": held("recipient", grants.as_ref()?) }),
            ),
            Registration::Alias { path, alias } => ("share_document", serde_json::json!({ "path": path, "alias": alias })),
            Registration::Close { .. } => return None,
        })
    }

    /// The path `close_document` names to drop this record from a process.
    fn closing_path(&self) -> &str {
        match self {
            Registration::Password { path, .. } | Registration::Recipient { path, .. } | Registration::Close { path } => path,
            Registration::Alias { alias, .. } => alias,
        }
    }

    fn is_alias(&self) -> bool {
        matches!(self, Registration::Alias { .. })
    }
}

/// The credentials one job or run process generation was given.
///
/// Before each request, the slot writes `held − given` (and a close for each
/// record in `given − held`) as frames in this order: closes, then openers,
/// then aliases. Closes come first because a path closed and opened again has
/// a close and a new opener in one delta, and a close written after the new
/// opener would drop it. Openers precede aliases because `share_document`
/// answers `shared: false` when its base is absent. In the engine a close of
/// a document also drops every alias lent from it, so closing a base takes
/// its aliases out of `sent`, and the alias step sends the live ones again.
#[derive(Default)]
pub(crate) struct Given {
    generation: u64,
    /// Records the process was sent, by the ledger serial.
    sent: Vec<(u64, Registration)>,
    /// Frames not yet answered, by id. A refused record stays in `sent`, so
    /// this generation is not sent it again.
    awaiting: HashMap<String, Registration>,
    frames: u64,
}

impl Given {
    /// Start over for process generation `generation`.
    fn reset(&mut self, generation: u64) {
        *self = Given { generation, ..Given::default() };
    }

    fn next_id(&mut self) -> String {
        let id = replay_id(self.generation, self.frames);
        self.frames += 1;
        id
    }

    /// The close frames for records sent to `generation` and no longer in
    /// `target`.
    fn close_stale(&mut self, generation: u64, target: &[(u64, Registration)]) -> Vec<Secret> {
        if self.generation != generation {
            self.reset(generation);
        }
        let live = |serial: &u64| target.iter().any(|(held, _)| held == serial);
        let mut frames = Vec::new();
        let stale_openers: Vec<(u64, Registration)> = self
            .sent
            .iter()
            .filter(|(serial, record)| !record.is_alias() && !live(serial))
            .cloned()
            .collect();
        for (serial, record) in stale_openers {
            let base = ledger_key(record.closing_path());
            self.sent.retain(|(sent, held)| {
                *sent != serial && !matches!(held, Registration::Alias { path, .. } if ledger_key(path) == base)
            });
            frames.push(self.close_frame(record.closing_path()));
        }
        let stale_aliases: Vec<(u64, Registration)> =
            self.sent.iter().filter(|(serial, _)| !live(serial)).cloned().collect();
        for (serial, record) in stale_aliases {
            self.sent.retain(|(sent, _)| *sent != serial);
            frames.push(self.close_frame(record.closing_path()));
        }
        frames
    }

    fn close_frame(&mut self, path: &str) -> Secret {
        let id = self.next_id();
        let frame = credential_frame(&id, "close_document", serde_json::json!({ "path": path }));
        self.awaiting.insert(id, Registration::Close { path: path.to_string() });
        frame
    }

    /// Every frame that brings `generation` to `target`: closes, then
    /// openers, then aliases.
    fn delta(&mut self, generation: u64, target: &[(u64, Registration)]) -> Vec<Secret> {
        let mut frames = self.close_stale(generation, target);
        let missing: Vec<(u64, Registration)> = target
            .iter()
            .filter(|(serial, _)| !self.sent.iter().any(|(sent, _)| sent == serial))
            .cloned()
            .collect();
        let openers = missing.iter().filter(|(_, record)| !record.is_alias());
        let aliases = missing.iter().filter(|(_, record)| record.is_alias());
        for (serial, record) in openers.chain(aliases) {
            let Some((method, params)) = record.held_frame() else { continue };
            let id = self.next_id();
            frames.push(credential_frame(&id, method, params));
            self.awaiting.insert(id, record.clone());
            self.sent.push((*serial, record.clone()));
        }
        frames
    }

    /// Settle the answer to frame `id`. Returns the path when this generation
    /// refused a credential the window holds; the window's own record stays.
    fn answered(&mut self, id: &str, response: &serde_json::Value) -> Option<String> {
        if replay_generation(id) != Some(self.generation) {
            return None;
        }
        let record = self.awaiting.remove(id)?;
        let result = response.get("result");
        let refused = match &record {
            Registration::Password { .. } => opener_of(result) != Some("user"),
            Registration::Recipient { .. } => opener_of(result) != Some("recipient"),
            Registration::Alias { .. } => {
                result.and_then(|r| r.get("shared")).and_then(|s| s.as_bool()) != Some(true)
            }
            Registration::Close { .. } => false,
        };
        if !refused {
            return None;
        }
        Some(record.closing_path().to_string())
    }
}

/// The held records a run call's process needs: those whose path one of its
/// path parameters names, and the opener each named alias borrows from.
fn run_records(held: &[(u64, Registration)], params: Option<&serde_json::Value>) -> Vec<(u64, Registration)> {
    let mut named = std::collections::HashSet::new();
    if let Some(params) = params {
        for key in RUN_PATH_PARAMS {
            match params.get(*key) {
                Some(serde_json::Value::String(path)) => {
                    named.insert(ledger_key(path));
                }
                Some(serde_json::Value::Array(paths)) => {
                    named.extend(paths.iter().filter_map(|p| p.as_str()).map(ledger_key));
                }
                _ => {}
            }
        }
    }
    let bases: std::collections::HashSet<String> = held
        .iter()
        .filter_map(|(_, record)| match record {
            Registration::Alias { path, alias } if named.contains(&ledger_key(alias)) => Some(ledger_key(path)),
            _ => None,
        })
        .collect();
    held.iter()
        .filter(|(_, record)| match record {
            Registration::Alias { alias, .. } => named.contains(&ledger_key(alias)),
            Registration::Password { path, .. } | Registration::Recipient { path, .. } => {
                let key = ledger_key(path);
                named.contains(&key) || bases.contains(&key)
            }
            Registration::Close { .. } => false,
        })
        .cloned()
        .collect()
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

    /// At most `cap` run processes at once instead of one per logical
    /// processor.
    pub fn with_run_cap(self, cap: usize) -> Self {
        *self.lock_runs() = RunPool::new(cap);
        self
    }

    fn with_launcher(launcher: Launcher) -> Self {
        let cap = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
        Self {
            workers: std::sync::Mutex::new(Workers::default()),
            runs: std::sync::Mutex::new(RunPool::new(cap)),
            next_generation: AtomicU64::new(1),
            launcher,
        }
    }

    fn lock_workers(&self) -> std::sync::MutexGuard<'_, Workers> {
        self.workers.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_runs(&self) -> std::sync::MutexGuard<'_, RunPool> {
        self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The slot of `label`'s window process, created on first use. Refused
    /// for a window that has been destroyed.
    pub fn worker(&self, label: &str) -> Result<Arc<EngineWorker>, String> {
        let mut workers = self.lock_workers();
        if workers.retired.contains(label) {
            return Err(WINDOW_CLOSED.to_string());
        }
        Ok(workers
            .live
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(EngineWorker::new(Role::Window)))
            .clone())
    }

    /// The slot of `label`'s job process, created on first use. Refused for a
    /// window that has been destroyed.
    fn job_worker(&self, label: &str) -> Result<Arc<EngineWorker>, String> {
        let mut workers = self.lock_workers();
        if workers.retired.contains(label) {
            return Err(WINDOW_CLOSED.to_string());
        }
        Ok(workers
            .jobs
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(EngineWorker::new(Role::Job)))
            .clone())
    }

    /// A new slot for one run process of `label`. Refused for a window that
    /// has been destroyed, so a queued call never starts after its window.
    fn run_worker(&self, label: &str) -> Result<Arc<EngineWorker>, String> {
        let mut workers = self.lock_workers();
        if workers.retired.contains(label) {
            return Err(WINDOW_CLOSED.to_string());
        }
        let worker = Arc::new(EngineWorker::new(Role::Run));
        workers.runs.push((label.to_string(), worker.clone()));
        Ok(worker)
    }

    fn forget_run(&self, worker: &Arc<EngineWorker>) {
        self.lock_workers().runs.retain(|(_, held)| !Arc::ptr_eq(held, worker));
    }

    /// The slot of `label`'s window process when one exists.
    pub fn existing_worker(&self, label: &str) -> Option<Arc<EngineWorker>> {
        self.lock_workers().live.get(label).cloned()
    }

    fn existing_job_worker(&self, label: &str) -> Option<Arc<EngineWorker>> {
        self.lock_workers().jobs.get(label).cloned()
    }

    /// The slot of `label` whose current process is generation `generation`.
    fn worker_of_generation(&self, label: &str, generation: u64) -> Option<Arc<EngineWorker>> {
        let workers = self.lock_workers();
        workers
            .live
            .get(label)
            .into_iter()
            .chain(workers.jobs.get(label))
            .chain(workers.runs.iter().filter(|(owner, _)| owner == label).map(|(_, worker)| worker))
            .chain(workers.draining.iter())
            .find(|worker| worker.generation.load(Ordering::SeqCst) == generation)
            .cloned()
    }

    /// Every slot with a process, including destroyed windows' slots that are
    /// still finishing a write.
    fn all_workers(&self) -> Vec<Arc<EngineWorker>> {
        let workers = self.lock_workers();
        let mut all: Vec<Arc<EngineWorker>> = Vec::new();
        let slots = workers
            .live
            .values()
            .chain(workers.jobs.values())
            .chain(workers.runs.iter().map(|(_, worker)| worker))
            .chain(workers.draining.iter());
        for worker in slots {
            if !all.iter().any(|held| Arc::ptr_eq(held, worker)) {
                all.push(worker.clone());
            }
        }
        all
    }

    fn set_draining(&self, worker: &Arc<EngineWorker>, draining: bool) {
        let mut workers = self.lock_workers();
        workers.draining.retain(|held| !Arc::ptr_eq(held, worker));
        if draining {
            workers.draining.push(worker.clone());
        }
    }

    /// Remove every slot of `label` for good and return them: the window
    /// slot, the job slot and its started run processes.
    fn retire(&self, label: &str) -> Vec<Arc<EngineWorker>> {
        let mut workers = self.lock_workers();
        workers.retired.insert(label.to_string());
        let mut retired: Vec<Arc<EngineWorker>> = Vec::new();
        retired.extend(workers.live.remove(label));
        retired.extend(workers.jobs.remove(label));
        retired.extend(workers.runs.iter().filter(|(owner, _)| owner == label).map(|(_, worker)| worker.clone()));
        for worker in &retired {
            worker.closed.store(true, Ordering::SeqCst);
            worker.credentials().clear();
        }
        retired
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

/// The process a route was written to, or that it waits for one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RouteWorker {
    /// A run call waiting for a run slot. It names no process, so it never
    /// matches a generation: no process can answer, fail or drain it.
    Queued { cancelled: bool },
    /// The process generation the request was written to.
    Generation(u64),
}

impl RouteWorker {
    fn is(self, generation: u64) -> bool {
        self == RouteWorker::Generation(generation)
    }
}

struct Route {
    label: String,
    inner: serde_json::Value,
    worker: RouteWorker,
    leases: Vec<Arc<crate::folder_claims::FolderLease>>,
    _workers: Vec<crate::folder_claims::WorkerLease>,
    _output_reservation: Option<crate::app_windows::EngineOutputReservation>,
}

impl Route {
    fn is_write(&self) -> bool {
        !self.leases.is_empty() || self._output_reservation.is_some()
    }
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

    fn register(&self, label: &str, inner: serde_json::Value, worker: RouteWorker,
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

    /// Remove a routing whatever its state, addressed or retained.
    fn remove(&self, outer: u64) -> Option<Route> {
        self.lock().remove(&outer)
    }

    /// Retire a routing only when worker generation `worker` owns it. A line
    /// from any other process leaves the route in place.
    fn take_from(&self, outer: u64, worker: u64) -> Option<Route> {
        let mut map = self.lock();
        if map.get(&outer).is_none_or(|route| !route.worker.is(worker)) {
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
            .filter_map(|(outer, route)| route.worker.is(worker).then_some(*outer))
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
        self.lock().values().any(|route| route.worker.is(worker))
    }

    /// The routed requests of worker generation `worker` that hold write
    /// protection.
    fn write_routes(&self, worker: u64) -> Vec<u64> {
        self.lock()
            .iter()
            .filter(|(_, route)| route.worker.is(worker) && route.is_write())
            .map(|(outer, _)| *outer)
            .collect()
    }

    /// Whether routing `outer` is still held.
    pub fn contains(&self, outer: u64) -> bool {
        self.lock().contains_key(&outer)
    }

    /// Mark queued routing `outer` cancelled. False when it is not queued.
    fn cancel_queued(&self, outer: u64) -> bool {
        match self.lock().get_mut(&outer) {
            Some(route) if matches!(route.worker, RouteWorker::Queued { .. }) => {
                route.worker = RouteWorker::Queued { cancelled: true };
                true
            }
            _ => false,
        }
    }

    /// Hand queued routing `outer` to process generation `generation`, whose
    /// process `retain` gives the route's folder leases. `Ok(None)` when the
    /// routing is gone or not queued; otherwise whether it was cancelled while
    /// it waited.
    fn start_queued(
        &self,
        outer: u64,
        generation: u64,
        retain: impl FnOnce(
            &[Arc<crate::folder_claims::FolderLease>],
        ) -> Result<Vec<crate::folder_claims::WorkerLease>, String>,
    ) -> Result<Option<bool>, String> {
        let mut map = self.lock();
        let Some(route) = map.get_mut(&outer) else {
            return Ok(None);
        };
        let RouteWorker::Queued { cancelled } = route.worker else {
            return Ok(None);
        };
        route._workers = retain(&route.leases)?;
        route.worker = RouteWorker::Generation(generation);
        Ok(Some(cancelled))
    }

    /// Retire every request belonging to one window. Routes that hold write
    /// protection are kept, unaddressed. Returns each retired or kept outer id
    /// with the process it was written to.
    pub(crate) fn take_label(&self, label: &str) -> Vec<(u64, RouteWorker)> {
        let mut map = self.lock();
        let ids: Vec<(u64, RouteWorker)> = map
            .iter()
            .filter_map(|(outer, route)| (route.label == label).then_some((*outer, route.worker)))
            .collect();
        for (outer, _) in &ids {
            if map.get(outer).is_some_and(Route::is_write) {
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

    /// `outer_for` with the process the request was written to.
    fn route_for(&self, label: &str, inner: &serde_json::Value) -> Option<(u64, RouteWorker)> {
        if label.is_empty() || inner.is_null() {
            return None;
        }
        self.lock()
            .iter()
            .filter(|(_, route)| route.label == label && route.inner == *inner)
            .map(|(outer, route)| (*outer, route.worker))
            .max_by_key(|(outer, _)| *outer)
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
    /// Retained routes of destroyed windows count, and so do queued run calls.
    pub fn writes_in_flight(&self, worker: Option<u64>) -> usize {
        self.lock()
            .values()
            .filter(|route| worker.is_none_or(|worker| route.worker.is(worker)))
            .filter(|route| route.is_write())
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
        RouteWorker::Generation(child.generation),
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
    route_with_leases(router, label, request, RouteWorker::Generation(0), Vec::new(), Vec::new(), None)
}

fn route_with_leases(router: &EngineRouter, label: &str, request: &mut serde_json::Value,
    worker: RouteWorker,
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
/// the process the request was written to; a run call still waiting for a
/// slot is marked, and the cancel follows its request when it starts.
pub async fn cancel_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    id: &serde_json::Value,
) -> Result<bool, String> {
    let router = app.state::<EngineRouter>();
    // A queued call can start between the lookup and the mark; the second
    // lookup then finds the process it started in.
    for _ in 0..2 {
        let Some((outer, worker)) = router.route_for(label, id) else {
            return Ok(false);
        };
        let generation = match worker {
            RouteWorker::Queued { .. } => {
                if router.cancel_queued(outer) {
                    return Ok(true);
                }
                continue;
            }
            RouteWorker::Generation(generation) => generation,
        };
        let Some(worker) = app.state::<EngineState>().worker_of_generation(label, generation) else {
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
        return Ok(true);
    }
    Ok(false)
}

/// Write one request to `label`'s engine, starting the process first when it
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
/// reservation is held by the route until the response retires it. The
/// method's `process_class` picks the window, job or run process.
pub(crate) async fn write_reserved_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: serde_json::Value,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
) -> Result<(), String> {
    let method = request.get("method").and_then(|m| m.as_str()).unwrap_or_default();
    match process_class(method) {
        ProcessClass::Job => write_job_request(app, label, request, output_reservation).await,
        ProcessClass::Run => write_run_request(app, label, request, output_reservation).await,
        ProcessClass::Window | ProcessClass::Health => {
            write_window_request(app, label, request, output_reservation).await
        }
    }
}

async fn write_window_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: serde_json::Value,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
) -> Result<(), String> {
    let worker = app.state::<EngineState>().worker(label)?;
    let mut guard = lock_started(&worker.child, || start_process(app, label, &worker)).await?;
    if worker.is_closed() {
        return Err(WINDOW_CLOSED.to_string());
    }
    let Some(child) = guard.as_mut() else {
        return Err("Engine not running".to_string());
    };
    write_routed(app, label, child, request, output_reservation, Some(&worker))
}

/// A job request: the job process is first given, read-only, every credential
/// the window holds that this process generation lacks (`Given::delta`).
async fn write_job_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: serde_json::Value,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let window = state.worker(label)?;
    let job = state.job_worker(label)?;
    let mut guard = lock_started(&job.child, || start_process(app, label, &job)).await?;
    if job.is_closed() {
        return Err(WINDOW_CLOSED.to_string());
    }
    let Some(child) = guard.as_mut() else {
        return Err("Engine not running".to_string());
    };
    let held = window.credentials().held();
    let frames = job.given().delta(child.generation, &held);
    write_frames(child, &frames)?;
    write_routed(app, label, child, request, output_reservation, None)
}

/// A run request is routed at once and starts in its own process when a run
/// slot is free; otherwise it waits in the app-wide queue and starts when a
/// run process exits.
async fn write_run_request<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    mut request: serde_json::Value,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
) -> Result<(), String> {
    let state = app.state::<EngineState>();
    state.worker(label)?;
    let router = app.state::<EngineRouter>();
    let leases = app.state::<crate::app_windows::ClaimState>().folder_leases(label);
    let Some(outer) = route_with_leases(
        &router,
        label,
        &mut request,
        RouteWorker::Queued { cancelled: false },
        leases,
        Vec::new(),
        output_reservation,
    ) else {
        return Err("A folder run request must have a response id.".to_string());
    };
    if let Err(error) = checked_line(&request) {
        router.remove(outer);
        return Err(error);
    }
    let run = QueuedRun { outer, label: label.to_string(), request };
    let admitted = state.lock_runs().admit(run);
    if let Some(run) = admitted {
        if let Err(error) = start_run(app, &run).await {
            router.remove(outer);
            return Err(error);
        }
    }
    Ok(())
}

/// The request as one protocol line, refused when it exceeds the frame limit.
fn checked_line(request: &serde_json::Value) -> Result<String, String> {
    let msg = serde_json::to_string(request).map_err(|e| format!("Serialize error: {}", e))?;
    if msg.len() > MAX_ENGINE_RPC_LINE_BYTES {
        return Err(format!(
            "Engine request exceeds the {} MiB limit.",
            MAX_ENGINE_RPC_LINE_BYTES / (1024 * 1024)
        ));
    }
    Ok(msg + "\n")
}

fn write_frames(child: &mut EngineChild, frames: &[Secret]) -> Result<(), String> {
    for frame in frames {
        child
            .child
            .write(frame.as_bytes())
            .map_err(|e| format!("Failed to write to engine: {}", e))?;
    }
    Ok(())
}

/// Route `request` to `child` and write it. `ledger` is the window slot whose
/// credential registrations the request may change.
fn write_routed<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    child: &mut EngineChild,
    mut request: serde_json::Value,
    output_reservation: Option<crate::app_windows::EngineOutputReservation>,
    ledger: Option<&EngineWorker>,
) -> Result<(), String> {
    let outer = route_request(app, label, &mut request, child, output_reservation)?;
    // Noted before the write: the answer can arrive before the write returns.
    if let (Some(outer), Some(window)) = (outer, ledger) {
        window.credentials().written(outer, &request);
    }
    let unroute = |app: &AppHandle<R>| {
        if let Some(outer) = outer {
            if let Some(window) = ledger {
                window.credentials().pending.remove(&outer);
            }
            unroute_request(app, outer);
        }
    };
    let line = match checked_line(&request) {
        Ok(line) => line,
        Err(error) => {
            unroute(app);
            return Err(error);
        }
    };
    if let Err(e) = child.child.write(line.as_bytes()) {
        unroute(app);
        return Err(format!("Failed to write to engine: {}", e));
    }
    Ok(())
}

/// Start `run` in a new run process. On failure the run slot is given back:
/// directly when no process was spawned, by the process's exit otherwise.
async fn start_run<R: Runtime>(app: &AppHandle<R>, run: &QueuedRun) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let worker = match state.run_worker(&run.label) {
        Ok(worker) => worker,
        Err(error) => {
            release_run_slot(app);
            return Err(error);
        }
    };
    let started = start_run_process(app, run, &worker).await;
    if started.is_err() {
        if worker.generation.load(Ordering::SeqCst) == 0 {
            state.forget_run(&worker);
            release_run_slot(app);
        } else if let Some(child) = worker.child.lock().await.take() {
            let _ = child.child.kill();
        }
    }
    started
}

async fn start_run_process<R: Runtime>(
    app: &AppHandle<R>,
    run: &QueuedRun,
    worker: &Arc<EngineWorker>,
) -> Result<(), String> {
    let mut guard = lock_started(&worker.child, || start_process(app, &run.label, worker)).await?;
    if worker.is_closed() {
        return Err(WINDOW_CLOSED.to_string());
    }
    let Some(child) = guard.as_mut() else {
        return Err("Engine not running".to_string());
    };
    let generation = child.generation;
    let pid = child.child.pid();
    let cancelled = app
        .state::<EngineRouter>()
        .start_queued(run.outer, generation, |leases| {
            leases.iter().map(|lease| lease.retain_in_worker(pid)).collect()
        })?
        .ok_or_else(|| WINDOW_CLOSED.to_string())?;
    let held = app
        .state::<EngineState>()
        .existing_worker(&run.label)
        .map(|window| window.credentials().held())
        .unwrap_or_default();
    let target = run_records(&held, run.request.get("params"));
    let frames = worker.given().delta(generation, &target);
    write_frames(child, &frames)?;
    let line = checked_line(&run.request)?;
    child.child.write(line.as_bytes()).map_err(|e| format!("Failed to write to engine: {}", e))?;
    if cancelled {
        child
            .child
            .write(cancel_frame(run.outer).as_bytes())
            .map_err(|e| format!("Failed to write to engine: {}", e))?;
    }
    Ok(())
}

/// A run slot was given back: start the oldest queued call of an open window.
fn release_run_slot<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<EngineState>();
    let retired = state.lock_workers().retired.clone();
    let (next, skipped) = state.lock_runs().release(|label| retired.contains(label));
    drop_queued(app, skipped);
    if let Some(run) = next {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = start_run(&app, &run).await {
                answer_unstarted(&app, run.outer, &error);
            }
        });
    }
}

/// Answer a queued call that could not start: its window is told the error,
/// and a write whose window has closed is reported as stopped.
fn answer_unstarted<R: Runtime>(app: &AppHandle<R>, outer: u64, error: &str) {
    let Some(route) = app.state::<EngineRouter>().remove(outer) else {
        return;
    };
    if route.label.is_empty() {
        if route.is_write() {
            notify_writes_stopped(app, 1);
        }
        return;
    }
    let payload = serde_json::json!({ "id": route.inner, "error": { "message": error } });
    let _ = app.emit_to(route.label.as_str(), "engine:response", payload);
}

/// Retire the routes of queued calls that will never start. The open windows
/// are told how many of them were writes.
fn drop_queued<R: Runtime>(app: &AppHandle<R>, runs: Vec<QueuedRun>) {
    let router = app.state::<EngineRouter>();
    let dropped = runs
        .into_iter()
        .filter_map(|run| router.remove(run.outer))
        .filter(Route::is_write)
        .count();
    if dropped > 0 {
        notify_writes_stopped(app, dropped);
    }
}

/// Undo a routing when the request never reached the sidecar.
pub fn unroute_request<R: Runtime>(app: &AppHandle<R>, outer: u64) {
    app.state::<EngineRouter>().take(outer);
}

/// Restore a response's original id and deliver it to the window that asked.
/// Only a route written to generation `generation` of `worker`'s slot can be
/// answered by that process's output.
fn route_response<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    generation: u64,
    worker: &Arc<EngineWorker>,
    mut json: serde_json::Value,
) {
    if let Some(id) = json.get("id").and_then(|v| v.as_str()).filter(|id| id.starts_with(REPLAY_ID_PREFIX)) {
        if replay_generation(id) != Some(generation) {
            return;
        }
        match worker.role {
            Role::Window => {
                let lost = worker.credentials().replay_answered(id, &json);
                if let Some(path) = lost {
                    eprintln!("[engine {label}] a replaced worker refused a document's credential");
                    let _ = app.emit_to(label, CREDENTIAL_LOST_EVENT, serde_json::json!({ "path": path }));
                }
            }
            Role::Job | Role::Run => {
                if worker.given().answered(id, &json).is_some() {
                    eprintln!(
                        "[engine {label} {}] refused a credential the window holds; its requests that need it fail there",
                        worker.role.name()
                    );
                }
            }
        }
        return;
    }
    let Some(outer) = json.get("id").and_then(|v| v.as_u64()) else {
        // An id-less line correlates to no request; the process serves one
        // window, so it goes to that window only.
        let _ = app.emit_to(label, "engine:response", json);
        return;
    };
    let Some(route) = app.state::<EngineRouter>().take_from(outer, generation) else {
        return;
    };
    if let Some(window) = app.state::<EngineState>().existing_worker(&route.label) {
        if window.credentials().answered(outer, &json) {
            let app = app.clone();
            let label = route.label.clone();
            tauri::async_runtime::spawn(async move { forward_closes(&app, &label).await });
        }
    }
    if worker.role == Role::Run {
        let worker = worker.clone();
        tauri::async_runtime::spawn(async move { finish_run(&worker, generation).await });
    }
    if let Some(obj) = json.as_object_mut() {
        obj.insert("id".to_string(), route.inner);
    }
    let _ = app.emit_to(route.label.as_str(), "engine:response", json);
}

/// Write the closes the window's job process is owed now, so a closed
/// document's credential does not wait for the window's next job request.
async fn forward_closes<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<EngineState>();
    let (Some(window), Some(job)) = (state.existing_worker(label), state.existing_job_worker(label)) else {
        return;
    };
    let mut guard = job.child.lock().await;
    let Some(child) = guard.as_mut() else {
        return;
    };
    let held = window.credentials().held();
    let frames = job.given().close_stale(child.generation, &held);
    let _ = write_frames(child, &frames);
}

/// A run process has answered its one call: close its input so it ends at end
/// of input. Its lifetime binding is held until it exits.
async fn finish_run(worker: &Arc<EngineWorker>, generation: u64) {
    let mut guard = worker.child.lock().await;
    if !guard.as_ref().is_some_and(|child| child.generation == generation) {
        return;
    }
    let binding = guard.take().expect("matched engine child").close_input();
    *worker.finishing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(binding);
    drop(guard);
    // Its slot is given back only at its exit; a process that outlives its
    // input (a thread its handler left running) is ended here instead.
    tokio::time::sleep(RUN_EXIT_GRACE).await;
    let lingering = worker.finishing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    if lingering.is_some() {
        eprintln!("[engine run] still running {} s after its answer; stopping it", RUN_EXIT_GRACE.as_secs());
    }
    drop(lingering);
}

/// How long a run process may keep running after its answer and the close
/// of its input before its lifetime binding is dropped, which kills it and
/// its descendants.
const RUN_EXIT_GRACE: Duration = Duration::from_secs(30);

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
    if let Some(launcher) = image_python() {
        return launcher.to_string_lossy().to_string();
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("failed to resolve resource dir");
    resource_dir
        .join(crate::platform::python_relative())
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
    let exe = resource_dir
        .join("tesseract")
        .join(crate::platform::program_relative("tesseract"));
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

/// The bundled Ghostscript path: the install tree's `ghostscript/gswin64c.exe`,
/// else an AppImage's own `bin/gs`; `None` when neither file exists.
///
/// A CANDIDATE, never the answer: a path string is not a capability, and an
/// explicit setting or `SPECTRAPDF_GS_PATH` outranks it. It is an input to
/// `gs::resolve` and nothing else may consume it. The verbatim prefix that
/// `resource_dir()` carries on Windows is stripped, because the path is shown
/// on the settings surface and handed to the engine as-is.
pub fn bundled_gs_candidate(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe = resource_dir.join("ghostscript").join("gswin64c.exe");
    if exe.is_file() {
        return Some(dunce::simplified(&exe).to_path_buf());
    }
    crate::gs::image_candidate()
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
    if let Some(launcher) = image_soffice() {
        return launcher.to_string_lossy().to_string();
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(crate::platform::soffice_relative());
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
/// - In an AppImage only: `SPECTRAPDF_IMAGE_ROOT`, the image's mount point,
///   which `platform_support` reads to start payload programs on the image's
///   dynamic loader; and `PYTHONTZPATH`, the host's time zone directories, then
///   the image's own `share/zoneinfo`. The engine's signature code resolves
///   named time zones, and a host without tzdata has none.
/// - `OPENBLAS_NUM_THREADS=1`: numpy's OpenBLAS otherwise reserves a thread
///   buffer per logical processor when it loads, in every engine process; the
///   engine's one BLAS call is a vector dot product. On Linux the health
///   worker's `RLIMIT_DATA` ceiling counts those buffers, and its import alone
///   exceeds the ceiling without this.
pub fn python_env() -> Vec<(String, String)> {
    let mut env = vec![
        ("PYTHONUTF8".to_string(), "1".to_string()),
        ("PYTHONNOUSERSITE".to_string(), "1".to_string()),
        ("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()),
        ("OPENBLAS_NUM_THREADS".to_string(), "1".to_string()),
        (
            crate::portable::ICC_ASSENT_ENV.to_string(),
            crate::portable::assent_env_value(crate::portable::icc_assent()).to_string(),
        ),
    ];
    if let Some(root) = image_root() {
        env.push((IMAGE_ROOT_ENV.to_string(), root.to_string_lossy().to_string()));
        if let Some(tzpath) = image_tzpath(&root) {
            env.push(("PYTHONTZPATH".to_string(), tzpath));
        }
    }
    env
}

/// Read by `engine/platform_support.py`.
pub const IMAGE_ROOT_ENV: &str = "SPECTRAPDF_IMAGE_ROOT";

/// The running AppImage's mount point. `APPDIR` alone is not proof: a process
/// started from another AppImage's environment inherits that image's `APPDIR`,
/// so this executable must itself lie inside it, and a system prefix such as
/// /usr holds no image loader, so the image's loader and payload must exist.
pub fn image_root() -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    let exe = std::env::current_exe().ok();
    image_root_from(appdir.as_deref(), exe.as_deref())
}

fn image_root_from(appdir: Option<&std::path::Path>, exe: Option<&std::path::Path>) -> Option<PathBuf> {
    let root = appdir.filter(|dir| dir.is_absolute())?.canonicalize().ok()?;
    let exe = exe?.canonicalize().ok()?;
    let carries_image = root.join("lib").join("ld-linux-x86-64.so.2").is_file()
        && root.join("lib").join("spectrapdf").is_dir();
    (exe.starts_with(&root) && carries_image).then_some(root)
}

/// An AppImage's LibreOffice launcher, which starts the payload's soffice.bin
/// on the image's own loader and libraries. The payload's `soffice` needs
/// libdbus and libcups from the host and does not start without them.
pub fn image_soffice() -> Option<PathBuf> {
    image_launcher(&image_root()?, &["libreoffice-launcher", "program", "soffice"])
}

/// An AppImage's engine interpreter launcher, which starts the payload's
/// Python on the image's own loader and libraries instead of the host's.
pub fn image_python() -> Option<PathBuf> {
    image_launcher(&image_root()?, &["python-launcher", "python3"])
}

fn image_launcher(root: &std::path::Path, relative: &[&str]) -> Option<PathBuf> {
    let launcher = relative.iter().fold(root.join("lib"), |path, part| path.join(part));
    launcher.is_file().then_some(launcher)
}

/// CPython's compiled-in time zone search path on Linux.
const SYSTEM_TZPATH: [&str; 4] = [
    "/usr/share/zoneinfo",
    "/usr/lib/zoneinfo",
    "/usr/share/lib/zoneinfo",
    "/etc/zoneinfo",
];

fn image_tzpath(root: &std::path::Path) -> Option<String> {
    let bundled = root.join("share").join("zoneinfo");
    if !bundled.is_dir() {
        return None;
    }
    let mut parts: Vec<String> = SYSTEM_TZPATH.iter().map(|dir| dir.to_string()).collect();
    parts.push(bundled.to_string_lossy().to_string());
    Some(parts.join(":"))
}

/// Interpreter argv for every engine child. The runtime's `._pth` runs
/// `import site`, which adds the user's `%APPDATA%\Python\Python3xx\site-packages`
/// and runs its `usercustomize` and `.pth` lines inside the engine; a `.pth`
/// line can also put a directory ahead of the shipped packages. `-s` removes
/// the user site. `-P` keeps the script's own directory off `sys.path`: a
/// runtime without a `._pth` file (Linux) otherwise puts `engine/` first,
/// and `engine/inspect.py` shadows the standard library's `inspect`, so
/// the interpreter fails during startup. `-I` is not used: it also implies
/// `-E`, which drops the `PYTHONUTF8` that `python_env` sets.
pub fn python_args(script: &str) -> Vec<String> {
    vec!["-s".to_string(), "-P".to_string(), script.to_string()]
}

/// Starts `label`'s window engine process and wires its stdout to that window.
/// Idempotent — if the process is already running, returns immediately.
pub async fn start<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let worker = app.state::<EngineState>().worker(label)?;
    start_process(app, label, &worker).await
}

/// The launcher's arguments, then this process's role and window.
fn spawn_args(launcher_args: Vec<String>, role: Role, label: &str) -> Vec<String> {
    let mut args = launcher_args;
    args.extend(role_args(role.name(), Some(label)));
    args
}

/// Start the process of `worker`'s slot for window `label`. Every process
/// class takes this one spawn path: a kill-on-close job object on Windows,
/// the spawner thread's death signal and the lease channel on Linux.
async fn start_process<R: Runtime>(app: &AppHandle<R>, label: &str, worker: &Arc<EngineWorker>) -> Result<(), String> {
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

    let (program, launcher_args) = match &state.launcher {
        Launcher::Resources => (
            get_python_path(app),
            python_args(&get_engine_script_path(app)),
        ),
        Launcher::Command { program, args } => (program.clone(), args.clone()),
    };
    let args = spawn_args(launcher_args, worker.role, label);

    #[cfg(not(target_os = "linux"))]
    let (mut rx, child, job) = {
        let (rx, child) = app
            .shell()
            .command(&program)
            .args(args)
            .envs(python_env().into_iter().collect::<HashMap<String, String>>())
            // The plugin's default line reader buffers until newline with no
            // cap. Read raw chunks so this process can bound each JSON-RPC
            // frame.
            .set_raw_out(true)
            .spawn()
            .map_err(|e| format!("Failed to start engine: {}", e))?;
        let job = match crate::process_job::contain(child.pid()) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("The engine process could not be contained: {error}"));
            }
        };
        (rx, child, job)
    };
    // Bound and leased at spawn: the lease channel exists only as an
    // inherited descriptor, and the lifetime binding only from `pre_exec`.
    #[cfg(target_os = "linux")]
    let (mut rx, child, job) = {
        let (rx, child) = crate::process_job::spawn_worker(
            &program,
            &args,
            python_env(),
            crate::process_job::Binding { lease_channel: true, memory_limit: None },
        )
        .map_err(|e| format!("Failed to start engine: {}", e))?;
        (rx, child, None)
    };
    let generation = state.next_generation.fetch_add(1, Ordering::SeqCst);
    worker.generation.store(generation, Ordering::SeqCst);
    let mut child = EngineChild { child, generation, _job: job };
    if worker.role == Role::Window {
        // Before any request of the window: a replacement worker is given every
        // credential the window registered in the worker it replaces.
        for frame in worker.credentials().replay_frames(generation) {
            if let Err(error) = child.child.write(frame.as_bytes()) {
                eprintln!("[engine {label}] credential replay failed: {error}");
                break;
            }
        }
    } else {
        worker.given().reset(generation);
    }
    *guard = Some(child);
    drop(guard);

    // Starting a window process imports the whole engine before the first
    // request is read; the window says so until the process reports ready. A
    // job or run start shows as the operation that is already running.
    let signals_start = worker.role == Role::Window;
    if signals_start {
        let _ = app.emit_to(label, "engine:starting", true);
    }
    let app_handle = app.clone();
    let worker = worker.clone();
    let label = label.to_string();
    let tag = match worker.role {
        Role::Window => label.clone(),
        role => format!("{label} {}", role.name()),
    };
    tauri::async_runtime::spawn(async move {
        let mut starting = signals_start;
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
                                route_response(&app_handle, &label, generation, &worker, json);
                            }
                        }
                    }
                    if chunk.oversized {
                        eprintln!(
                            "[engine {tag}] response line exceeded the {} MiB limit; stopping the engine",
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
                                eprintln!("[engine {tag}] failed to stop oversized worker: {error}");
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
                        eprintln!("[engine {tag}] {}", trimmed);
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(status) => {
                    eprintln!("[engine {tag}] exited with {:?}", status);
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
        } else {
            // A closed event stream also means the worker cannot answer. The
            // slot is cleared only when it still holds THIS generation; a
            // later worker spawned after an intentional restart is left alone.
            let mut guard = worker.child.lock().await;
            if guard.as_ref().is_some_and(|current| current.generation == generation) {
                guard.take(); // closes the job, including any surviving descendants
            }
            drop(guard);
            // Routes are keyed by generation, so this drains exactly the
            // requests this process was sent and never answered. A restart
            // that already drained them leaves nothing here.
            let stopped = stopped_responses(&app_handle.state::<EngineRouter>(), generation);
            deliver_stopped(&app_handle, stopped);
        }
        drop(worker.finishing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take());
        if worker.role != Role::Window {
            let mut given = worker.given();
            if given.generation == generation {
                given.reset(0);
            }
        }
        if worker.role == Role::Run {
            app_handle.state::<EngineState>().forget_run(&worker);
            release_run_slot(&app_handle);
        }
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

/// Ask every write in flight, in every process, to stop at its next safe
/// point, then wait up to `within` for them to end. For a session that is
/// ending. A run call still waiting for a slot is answered with the stopped
/// error and never starts.
pub async fn cancel_writes<R: Runtime>(app: &AppHandle<R>, within: Duration) {
    let queued = app.state::<EngineState>().lock_runs().take_all();
    let router = app.state::<EngineRouter>();
    let stopped: Vec<(String, serde_json::Value)> = queued
        .into_iter()
        .filter_map(|run| router.remove(run.outer))
        .filter(|route| !route.label.is_empty())
        .map(|route| {
            (route.label, serde_json::json!({ "id": route.inner, "error": { "message": ENGINE_STOPPED } }))
        })
        .collect();
    deliver_stopped(app, stopped);
    for worker in app.state::<EngineState>().all_workers() {
        let generation = worker.generation.load(Ordering::SeqCst);
        cancel_generation_writes(app, &worker, generation).await;
    }
    wait_until(Instant::now() + within, || router.writes_in_flight(None) == 0).await;
}

/// Stop the processes of a destroyed window: its window process, its job
/// process and its run processes.
///
/// The window's own routes are dropped; routes that hold write protection (an
/// output reservation, a folder lease) are kept, unaddressed, until the
/// process answers them. A run call still waiting for a slot is removed and
/// its reservation and leases released; when it was a write, the open windows
/// are told it was stopped. A process that owes nothing is killed at once. A
/// process that still owes such a route has every other request of that
/// window cancelled and keeps running until those writes finish. At the drain
/// deadline its writes are cancelled so they stop at a safe point; a process
/// still running `CANCEL_GRACE` later is killed. Either way its routes and
/// leases are released, and the open windows are told when a write was cut.
pub fn retire_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let state = app.state::<EngineState>();
    let first = app.state::<EngineRouter>().take_label(label);
    let workers = state.retire(label);
    let queued = state.lock_runs().remove_label(label);
    drop_queued(app, queued);
    let taken = Arc::new(std::sync::Mutex::new(first));
    for worker in workers {
        let app = app.clone();
        let label = label.to_string();
        let taken = taken.clone();
        tauri::async_runtime::spawn(async move { drain_retired(&app, &label, worker, &taken).await });
    }
}

async fn drain_retired<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    worker: Arc<EngineWorker>,
    taken: &std::sync::Mutex<Vec<(u64, RouteWorker)>>,
) {
    let mut guard = worker.child.lock().await;
    // A send holds the slot lock from its closed check through its write,
    // so every route this process will ever be sent exists by now.
    let router = app.state::<EngineRouter>();
    let routes = {
        let mut taken = taken.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        taken.extend(router.take_label(label));
        taken.clone()
    };
    let Some(generation) = guard.as_ref().map(EngineChild::generation) else {
        return;
    };
    if router.writes_in_flight(Some(generation)) == 0 {
        drop(guard);
        stop_generation(app, &worker, generation).await;
        return;
    }
    if let Some(child) = guard.as_mut() {
        for (outer, routed) in routes {
            if routed.is(generation) && !router.contains(outer) {
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
        cancel_generation_writes(app, &worker, generation).await;
        wait_until(Instant::now() + CANCEL_GRACE, || !router.has_worker(generation)).await;
    }
    stop_generation(app, &worker, generation).await;
    state.set_draining(&worker, false);
    if cut > 0 {
        notify_writes_stopped(app, cut);
    }
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
    stopped_responses_with_message(router, generation, ENGINE_STOPPED)
}

const ENGINE_STOPPED: &str = "The document engine stopped before completing the operation.";

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

    fn call(method: &str, params: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
    }

    fn answer(result: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": result })
    }

    fn replayed(ledger: &mut CredentialLedger) -> Vec<(String, serde_json::Value)> {
        ledger
            .replay_frames(1)
            .iter()
            .map(|line| {
                let frame: serde_json::Value = serde_json::from_str(line.as_str()).unwrap();
                assert!(frame["id"].as_str().unwrap().starts_with(REPLAY_ID_PREFIX));
                (frame["method"].as_str().unwrap().to_string(), frame["params"].clone())
            })
            .collect()
    }

    #[test]
    fn a_replacement_worker_is_given_every_credential_its_window_holds() {
        let mut ledger = CredentialLedger::default();
        ledger.written(1, &call("share_document", serde_json::json!({ "path": "W", "alias": "S" })));
        ledger.written(2, &call("open_document_attempt", serde_json::json!({ "path": "W", "password": "u" })));
        ledger.answered(2, &answer(serde_json::json!({ "status": "opened", "document": { "opener": "user" } })));
        ledger.answered(1, &answer(serde_json::json!({ "shared": true })));
        ledger.written(3, &call("open_pubkey_document", serde_json::json!({ "path": "R", "pfx": "k.pfx", "password": "p" })));
        ledger.answered(3, &answer(serde_json::json!({ "opener": "recipient" })));
        assert_eq!(
            replayed(&mut ledger),
            vec![
                ("open_document".to_string(), serde_json::json!({ "path": "W", "password": "u" })),
                (
                    "pubkey_reattach".to_string(),
                    serde_json::json!({ "path": "R", "source": "", "pfx": "k.pfx", "password": "p" })
                ),
                ("share_document".to_string(), serde_json::json!({ "path": "W", "alias": "S" })),
            ]
        );
        // Replay is repeatable: a second replacement gets the same frames.
        assert_eq!(replayed(&mut ledger).len(), 3);
    }

    #[test]
    fn a_credential_the_replacement_refuses_is_reported_once_and_forgotten() {
        let mut ledger = CredentialLedger::default();
        ledger.written(1, &call("open_document", serde_json::json!({ "path": "W", "password": "u" })));
        ledger.answered(1, &answer(serde_json::json!({ "encrypted": true, "opener": "user" })));
        ledger.written(2, &call("share_document", serde_json::json!({ "path": "W", "alias": "S" })));
        ledger.answered(2, &answer(serde_json::json!({ "shared": true })));
        ledger.written(3, &call("open_pubkey_document", serde_json::json!({ "path": "R", "pfx": "k", "password": "p" })));
        ledger.answered(3, &answer(serde_json::json!({ "opener": "recipient" })));
        let ids: Vec<String> = ledger
            .replay_frames(1)
            .iter()
            .map(|line| serde_json::from_str::<serde_json::Value>(line.as_str()).unwrap()["id"].as_str().unwrap().to_string())
            .collect();
        let refused = serde_json::json!({ "jsonrpc": "2.0", "id": ids[0], "error": { "code": -32000, "message": "invalid password" } });
        assert_eq!(ledger.replay_answered(&ids[0], &refused), Some("W".to_string()));
        assert_eq!(ledger.replay_answered(&ids[0], &refused), None);
        let accepted = answer(serde_json::json!({ "opener": "recipient" }));
        assert_eq!(ledger.replay_answered(&ids[1], &accepted), None);
        // The refused document and its alias are no longer replayed.
        let left = replayed(&mut ledger);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].0, "pubkey_reattach");
    }

    #[test]
    fn a_registration_prints_without_its_secret() {
        let held = Registration::Password { path: "W".into(), password: Secret::new("hunter2".into()), grants: None };
        let recipient = Registration::Recipient { path: "R".into(), pfx: "k".into(), password: Secret::new("hunter2".into()), grants: None };
        assert!(!format!("{held:?} {recipient:?}").contains("hunter2"));
    }

    #[test]
    fn only_a_credential_the_engine_accepted_is_replayed() {
        let mut ledger = CredentialLedger::default();
        ledger.written(1, &call("open_document_attempt", serde_json::json!({ "path": "W", "password": "x" })));
        ledger.answered(1, &answer(serde_json::json!({ "status": "wrong_password" })));
        ledger.written(2, &call("open_document", serde_json::json!({ "path": "O", "password": "owner" })));
        ledger.answered(2, &answer(serde_json::json!({ "encrypted": true, "opener": "owner" })));
        ledger.written(3, &call("open_pubkey_document", serde_json::json!({ "path": "R", "pfx": "k", "password": "bad" })));
        ledger.answered(3, &serde_json::json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "no" } }));
        ledger.written(4, &call("share_document", serde_json::json!({ "path": "P", "alias": "S" })));
        ledger.answered(4, &answer(serde_json::json!({ "shared": false })));
        ledger.written(5, &call("get_page_count", serde_json::json!({ "file": "W" })));
        ledger.answered(5, &answer(serde_json::json!({ "pages": 1 })));
        assert!(replayed(&mut ledger).is_empty());
    }

    #[test]
    fn a_closed_document_takes_its_aliases_out_of_the_replay() {
        let mut ledger = CredentialLedger::default();
        ledger.written(1, &call("open_document", serde_json::json!({ "path": "C:/w/Doc.pdf", "password": "u" })));
        ledger.answered(1, &answer(serde_json::json!({ "encrypted": true, "opener": "user" })));
        ledger.written(2, &call("share_document", serde_json::json!({ "path": "C:/w/Doc.pdf", "alias": "C:/w/a" })));
        ledger.answered(2, &answer(serde_json::json!({ "shared": true })));
        ledger.written(3, &call("share_document", serde_json::json!({ "path": "C:/w/Doc.pdf", "alias": "C:/w/b" })));
        ledger.answered(3, &answer(serde_json::json!({ "shared": true })));
        ledger.written(4, &call("close_document", serde_json::json!({ "path": "C:/w/a" })));
        ledger.answered(4, &answer(serde_json::json!({ "forgotten": true })));
        assert_eq!(replayed(&mut ledger).len(), 2);
        ledger.written(5, &call("close_document", serde_json::json!({ "path": r"c:\w\doc.pdf" })));
        ledger.answered(5, &answer(serde_json::json!({ "forgotten": true })));
        assert!(replayed(&mut ledger).is_empty());
    }

    #[test]
    fn an_answer_the_replacement_owes_nothing_is_forgotten_at_replay() {
        let mut ledger = CredentialLedger::default();
        ledger.written(1, &call("open_document", serde_json::json!({ "path": "W", "password": "u" })));
        assert!(replayed(&mut ledger).is_empty());
        ledger.answered(1, &answer(serde_json::json!({ "encrypted": true, "opener": "user" })));
        assert!(replayed(&mut ledger).is_empty());
    }

    #[test]
    fn an_image_is_recognized_only_around_its_own_executable() {
        let scratch = tempfile::tempdir().unwrap();
        let image = scratch.path().join("mount");
        let elsewhere = scratch.path().join("usr").join("bin");
        std::fs::create_dir_all(image.join("bin")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(image.join("bin").join("spectrapdf"), b"").unwrap();
        std::fs::write(elsewhere.join("spectrapdf"), b"").unwrap();
        let exe = image.join("bin").join("spectrapdf");
        assert_eq!(image_root_from(Some(&image), Some(&exe)), None, "a prefix without the image loader and payload");
        std::fs::create_dir_all(image.join("lib").join("spectrapdf")).unwrap();
        assert_eq!(image_root_from(Some(&image), Some(&exe)), None, "a prefix without the image loader");
        std::fs::write(image.join("lib").join("ld-linux-x86-64.so.2"), b"").unwrap();
        let root = image.canonicalize().unwrap();
        assert_eq!(
            image_root_from(Some(&image), Some(&image.join("bin").join("spectrapdf"))),
            Some(root)
        );
        assert_eq!(image_root_from(Some(&image), Some(&elsewhere.join("spectrapdf"))), None);
        assert_eq!(image_root_from(None, Some(&image.join("bin").join("spectrapdf"))), None);
        assert_eq!(
            image_root_from(Some(std::path::Path::new("mount")), Some(&image.join("bin").join("spectrapdf"))),
            None
        );
    }

    #[test]
    fn the_image_launchers_are_used_only_where_the_image_carries_them() {
        let scratch = tempfile::tempdir().unwrap();
        let soffice = ["libreoffice-launcher", "program", "soffice"];
        let python = ["python-launcher", "python3"];
        assert_eq!(image_launcher(scratch.path(), &soffice), None);
        assert_eq!(image_launcher(scratch.path(), &python), None);
        let program = scratch.path().join("lib").join("libreoffice-launcher").join("program");
        let interpreter = scratch.path().join("lib").join("python-launcher");
        std::fs::create_dir_all(&program).unwrap();
        std::fs::create_dir_all(&interpreter).unwrap();
        std::fs::write(program.join("soffice"), b"").unwrap();
        std::fs::write(interpreter.join("python3"), b"").unwrap();
        assert_eq!(image_launcher(scratch.path(), &soffice), Some(program.join("soffice")));
        assert_eq!(image_launcher(scratch.path(), &python), Some(interpreter.join("python3")));
    }

    #[test]
    fn an_image_child_reads_the_host_zones_before_the_image_copy() {
        let scratch = tempfile::tempdir().unwrap();
        assert_eq!(image_tzpath(scratch.path()), None);
        let zones = scratch.path().join("share").join("zoneinfo");
        std::fs::create_dir_all(&zones).unwrap();
        let tzpath = image_tzpath(scratch.path()).unwrap();
        assert!(tzpath.starts_with(&format!("{}:", SYSTEM_TZPATH.join(":"))));
        assert!(tzpath.ends_with(&*zones.to_string_lossy()));
    }

    #[test]
    fn the_engine_child_never_loads_the_user_site() {
        let script = r"C:\resources\engine\__startup__.py";
        assert_eq!(python_args(script), vec!["-s", "-P", script]);
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
        route_with_leases(router, label, &mut request, RouteWorker::Generation(worker), Vec::new(), Vec::new(), None).unwrap()
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
        assert_eq!(router.route_for("main", &serde_json::json!(5)), Some((mine, RouteWorker::Generation(10))));
        assert_eq!(router.route_for("doc-1", &serde_json::json!(5)), Some((theirs, RouteWorker::Generation(11))));
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
            &router, "doc-1", &mut write, RouteWorker::Generation(12), Vec::new(), Vec::new(), Some(reservation),
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
        let retired = state.retire("doc-1").pop().expect("slot existed");
        assert!(retired.is_closed());
        assert!(state.worker("doc-1").is_err());
        assert!(state.existing_worker("doc-1").is_none());
        assert!(state.retire("doc-3").is_empty());
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
            RouteWorker::Generation(0),
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
        let path = crate::native_path(r"C:\export\result.pdf");
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
            RouteWorker::Generation(0),
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

    #[cfg(windows)]
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
                RouteWorker::Generation(0),
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

#[cfg(test)]
mod concurrency_tests {
    use super::*;

    fn call(method: &str, params: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
    }

    fn answer(result: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": result })
    }

    fn permissions() -> serde_json::Value {
        serde_json::json!({ "print": true, "copy": false })
    }

    fn open_user(ledger: &mut CredentialLedger, outer: u64, path: &str, password: &str) {
        ledger.written(outer, &call("open_document", serde_json::json!({ "path": path, "password": password })));
        ledger.answered(outer, &answer(serde_json::json!({
            "encrypted": true, "opener": "user", "permissions": permissions(), "revision": 6, "p": -1852,
        })));
    }

    fn open_recipient(ledger: &mut CredentialLedger, outer: u64, path: &str) {
        ledger.written(outer, &call("open_pubkey_document", serde_json::json!({ "path": path, "pfx": "k", "password": "p" })));
        ledger.answered(outer, &answer(serde_json::json!({ "opener": "recipient", "permissions": permissions(), "p": -4 })));
    }

    fn share(ledger: &mut CredentialLedger, outer: u64, path: &str, alias: &str) {
        ledger.written(outer, &call("share_document", serde_json::json!({ "path": path, "alias": alias })));
        ledger.answered(outer, &answer(serde_json::json!({ "shared": true })));
    }

    fn close(ledger: &mut CredentialLedger, outer: u64, path: &str) {
        ledger.written(outer, &call("close_document", serde_json::json!({ "path": path })));
        assert!(ledger.answered(outer, &answer(serde_json::json!({ "forgotten": true }))));
    }

    /// `(id, method, params)` of each frame.
    fn read(frames: Vec<Secret>) -> Vec<(String, String, serde_json::Value)> {
        frames
            .iter()
            .map(|line| {
                assert!(line.ends_with('\n'));
                let frame: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
                (
                    frame["id"].as_str().unwrap().to_string(),
                    frame["method"].as_str().unwrap().to_string(),
                    frame["params"].clone(),
                )
            })
            .collect()
    }

    fn methods(frames: &[(String, String, serde_json::Value)]) -> Vec<(String, String)> {
        frames
            .iter()
            .map(|(_, method, params)| {
                let named = params.get("alias").or_else(|| params.get("path")).and_then(|p| p.as_str()).unwrap();
                (method.clone(), named.to_string())
            })
            .collect()
    }

    fn pair(method: &str, path: &str) -> (String, String) {
        (method.to_string(), path.to_string())
    }

    #[test]
    fn every_method_is_classified_once_and_each_class_has_its_size() {
        let mut seen = std::collections::HashSet::new();
        for (method, _) in METHOD_CLASSES {
            assert!(seen.insert(*method), "{method} is classified twice");
        }
        let count = |class: ProcessClass| METHOD_CLASSES.iter().filter(|(_, c)| *c == class).count();
        assert_eq!(count(ProcessClass::Window), 179);
        assert_eq!(count(ProcessClass::Job), 34);
        assert_eq!(count(ProcessClass::Run), 4);
        assert_eq!(count(ProcessClass::Health), 4);
        for (method, class) in METHOD_CLASSES {
            assert_eq!(process_class(method), *class, "{method}");
        }
        assert_eq!(process_class("distill"), ProcessClass::Job);
        assert_eq!(process_class("preflight"), ProcessClass::Job, "its coverage check renders with Ghostscript");
        assert_eq!(process_class("batch_ocr"), ProcessClass::Run);
        assert_eq!(process_class("get_page_count"), ProcessClass::Window);
        assert_eq!(process_class("a_method_no_table_names"), ProcessClass::Window);
        for method in ["open_document", "open_document_attempt", "open_pubkey_document", "unlock"] {
            assert_eq!(process_class(method), ProcessClass::Window, "{method} rewrites in place");
        }
        for group in [
            &["split_plan", "split"][..],
            &["list_csc_credentials", "sign_pdf"][..],
            &["print_preview", "print_preview_cleanup"][..],
            &["render_separations", "composite_separations", "inspect_point"][..],
        ] {
            assert!(group.iter().all(|m| process_class(m) == process_class(group[0])), "{group:?}");
        }
    }

    #[test]
    fn each_spawn_carries_its_role_and_window_after_the_launcher_arguments() {
        let script = "C:/resources/engine/__startup__.py";
        let launcher = python_args(script);
        assert_eq!(
            spawn_args(launcher.clone(), Role::Job, "doc-2"),
            vec!["-s", "-P", script, "--spectra-role=job", "--spectra-window=doc-2"]
        );
        assert_eq!(spawn_args(launcher.clone(), Role::Window, "main")[3..], ["--spectra-role=window", "--spectra-window=main"]);
        assert_eq!(spawn_args(launcher, Role::Run, "main")[3], "--spectra-role=run");
        assert_eq!(role_args("health", None), vec!["--spectra-role=health"]);
    }

    #[test]
    fn every_engine_spawn_loads_one_blas_thread() {
        assert!(python_env().iter().any(|(k, v)| k == "OPENBLAS_NUM_THREADS" && v == "1"));
    }

    #[test]
    fn a_job_generation_answers_and_fails_only_its_own_routes() {
        let router = EngineRouter::new();
        let route = |inner: u64, generation: u64| {
            let mut request = serde_json::json!({ "id": inner });
            route_with_leases(&router, "main", &mut request, RouteWorker::Generation(generation), Vec::new(), Vec::new(), None)
                .unwrap()
        };
        let window = route(1, 10);
        let job = route(2, 11);
        assert!(router.take_from(job, 10).is_none(), "the window process answered a job route");
        let stopped = stopped_responses(&router, 11);
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].1["id"], 2);
        assert!(router.contains(window));
        assert!(router.has_worker(10));
        assert!(!router.has_worker(11));
    }

    #[test]
    fn a_cancel_finds_the_slot_that_holds_the_routes_generation() {
        let state = EngineState::new();
        let window = state.worker("main").unwrap();
        let job = state.job_worker("main").unwrap();
        let run = state.run_worker("main").unwrap();
        let other = state.job_worker("doc-1").unwrap();
        for (worker, generation) in [(&window, 5), (&job, 6), (&run, 7), (&other, 8)] {
            worker.generation.store(generation, Ordering::SeqCst);
        }
        assert!(Arc::ptr_eq(&state.worker_of_generation("main", 5).unwrap(), &window));
        assert!(Arc::ptr_eq(&state.worker_of_generation("main", 6).unwrap(), &job));
        assert!(Arc::ptr_eq(&state.worker_of_generation("main", 7).unwrap(), &run));
        assert!(state.worker_of_generation("main", 8).is_none(), "another window's process");
        assert!(state.worker_of_generation("doc-1", 6).is_none());
    }

    #[test]
    fn retire_takes_every_slot_of_the_window_and_every_class_is_a_worker() {
        let state = EngineState::new();
        state.worker("main").unwrap();
        state.job_worker("main").unwrap();
        state.run_worker("main").unwrap();
        state.worker("doc-1").unwrap();
        assert_eq!(state.all_workers().len(), 4);
        let retired = state.retire("main");
        assert_eq!(retired.len(), 3);
        assert!(retired.iter().all(|worker| worker.is_closed()));
        let roles: Vec<Role> = retired.iter().map(|worker| worker.role).collect();
        assert!(roles.contains(&Role::Window) && roles.contains(&Role::Job) && roles.contains(&Role::Run));
        assert!(state.job_worker("main").is_err());
        assert!(state.run_worker("main").is_err(), "a queued call started after its window closed");
    }

    #[test]
    fn writes_in_flight_count_window_job_and_queued_run_writes() {
        let scratch = tempfile::tempdir().unwrap();
        let claims = crate::app_windows::ClaimState::with_registry(scratch.path().join("claims"));
        let router = EngineRouter::new();
        let route = |name: &str, worker: RouteWorker| {
            let output = scratch.path().join(name).to_string_lossy().into_owned();
            let reservation = claims.claim_engine_output(&output, "main").unwrap();
            let mut request = serde_json::json!({ "id": 1 });
            route_with_leases(&router, "main", &mut request, worker, Vec::new(), Vec::new(), Some(reservation)).unwrap()
        };
        route("w.pdf", RouteWorker::Generation(10));
        route("j.pdf", RouteWorker::Generation(11));
        let queued = route("r.pdf", RouteWorker::Queued { cancelled: false });
        assert_eq!(router.writes_in_flight(None), 3);
        assert_eq!(router.writes_in_flight(Some(11)), 1);
        router.take_label("main");
        assert_eq!(router.writes_in_flight(None), 3, "a closed window's writes are retained");
        assert!(router.remove(queued).is_some_and(|route| route.is_write()));
        assert_eq!(router.writes_in_flight(None), 2);
    }

    #[test]
    fn a_job_process_is_given_closes_then_openers_then_aliases() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        share(&mut ledger, 2, "W", "S");
        let mut given = Given::default();
        let first = read(given.delta(3, &ledger.held()));
        assert_eq!(methods(&first), vec![pair("open_document", "W"), pair("share_document", "S")]);
        assert_eq!(first[0].2["password"], "u");
        assert!(read(given.delta(3, &ledger.held())).is_empty(), "a delta repeats what was given");

        close(&mut ledger, 3, "S");
        open_user(&mut ledger, 4, "X", "x");
        share(&mut ledger, 5, "X", "T");
        let second = read(given.delta(3, &ledger.held()));
        assert_eq!(
            methods(&second),
            vec![pair("close_document", "S"), pair("open_document", "X"), pair("share_document", "T")]
        );
        let ids: std::collections::HashSet<&String> = first.iter().chain(&second).map(|(id, _, _)| id).collect();
        assert_eq!(ids.len(), 5);
        assert!(ids.iter().all(|id| replay_generation(id) == Some(3)));
    }

    #[test]
    fn a_job_process_is_given_an_opener_as_grants_and_never_an_open_of_the_file() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        open_recipient(&mut ledger, 2, "R");
        let frames = read(Given::default().delta(3, &ledger.held()));
        assert_eq!(methods(&frames), vec![pair("open_document", "W"), pair("open_document", "R")]);
        let (user, recipient) = (&frames[0].2, &frames[1].2);
        assert_eq!(user["password"], "u");
        assert_eq!(user["held"], serde_json::json!({ "opener": "user", "permissions": permissions(), "revision": 6, "p": -1852 }));
        assert_eq!(recipient["held"], serde_json::json!({ "opener": "recipient", "permissions": permissions(), "revision": null, "p": -4 }));
        assert!(recipient.get("pfx").is_none() && recipient["password"] == "", "a certificate frame carries its key");
        // The window's own replacement still opens the document again.
        let replay = ledger.replay_frames(4);
        let replayed: Vec<serde_json::Value> =
            replay.iter().map(|line| serde_json::from_str(line.trim_end()).unwrap()).collect();
        assert_eq!(replayed[0]["method"], "open_document");
        assert!(replayed[0]["params"].get("held").is_none());
        assert_eq!(replayed[1]["method"], "pubkey_reattach");
    }

    #[test]
    fn an_opener_that_answered_no_grants_is_not_given_to_a_job_process() {
        let mut ledger = CredentialLedger::default();
        ledger.written(1, &call("open_document", serde_json::json!({ "path": "W", "password": "u" })));
        ledger.answered(1, &answer(serde_json::json!({ "encrypted": true, "opener": "user" })));
        assert_eq!(ledger.held().len(), 1);
        assert!(Given::default().delta(3, &ledger.held()).is_empty());
    }

    #[test]
    fn an_owner_password_open_never_reaches_a_job_process() {
        let mut ledger = CredentialLedger::default();
        ledger.written(1, &call("open_document", serde_json::json!({ "path": "O", "password": "owner" })));
        ledger.answered(1, &answer(serde_json::json!({ "encrypted": true, "opener": "owner" })));
        ledger.written(2, &call("open_document_attempt", serde_json::json!({ "path": "P", "password": "owner" })));
        ledger.answered(2, &answer(serde_json::json!({ "status": "opened", "document": { "opener": "owner" } })));
        ledger.written(3, &call("unlock", serde_json::json!({ "file": "Q", "password": "owner" })));
        ledger.answered(3, &answer(serde_json::json!({ "unlocked": true })));
        assert!(Given::default().delta(3, &ledger.held()).is_empty());
    }

    #[test]
    fn a_run_process_is_given_only_the_credentials_its_parameters_name() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "C:/w/Doc.pdf", "u");
        share(&mut ledger, 2, "C:/w/Doc.pdf", "C:/w/stage.pdf");
        open_recipient(&mut ledger, 3, "R");
        open_user(&mut ledger, 4, "X", "x");
        let held = ledger.held();
        let named = |params: serde_json::Value| -> Vec<(String, String)> {
            let target = run_records(&held, Some(&params));
            methods(&read(Given::default().delta(9, &target)))
        };
        assert_eq!(
            named(serde_json::json!({ "source": "c:\\w\\STAGE.pdf", "dest": "C:/out" })),
            vec![pair("open_document", "C:/w/Doc.pdf"), pair("share_document", "C:/w/stage.pdf")]
        );
        assert_eq!(named(serde_json::json!({ "sources": ["X"], "dest": "C:/out" })), vec![pair("open_document", "X")]);
        assert!(named(serde_json::json!({ "source": "C:/originals", "dest": "C:/out", "lang": "X" })).is_empty());
        assert!(run_records(&held, None).is_empty());
    }

    #[test]
    fn credential_frame_ids_are_unique_across_generations() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        let mut given = Given::default();
        let third = read(given.delta(3, &ledger.held()));
        let fourth = read(given.delta(4, &ledger.held()));
        assert_eq!(methods(&fourth), vec![pair("open_document", "W")], "a new generation is given everything");
        assert_ne!(third[0].0, fourth[0].0);
        assert_eq!(replay_generation(&third[0].0), Some(3));
        assert_eq!(replay_generation(&fourth[0].0), Some(4));
        let window_ids: Vec<String> = ledger
            .replay_frames(7)
            .iter()
            .map(|line| serde_json::from_str::<serde_json::Value>(line.as_str()).unwrap()["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(replay_generation(&window_ids[0]), Some(7));
    }

    #[test]
    fn an_answer_with_another_generations_id_settles_nothing() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        let mut given = Given::default();
        let old = read(given.delta(3, &ledger.held()));
        given.delta(4, &ledger.held());
        let refused = serde_json::json!({ "id": old[0].0, "error": { "message": "invalid password" } });
        assert_eq!(given.answered(&old[0].0, &refused), None);
        assert_eq!(given.awaiting.len(), 1, "the current generation's frame was settled");
        assert_eq!(given.answered("spectra-credential-replay:4:99", &refused), None, "an id no frame carried");
    }

    #[test]
    fn a_password_reply_that_is_not_a_user_open_is_a_job_only_refusal() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        let mut given = Given::default();
        let frames = read(given.delta(3, &ledger.held()));
        let owner = serde_json::json!({ "id": frames[0].0, "result": { "encrypted": true, "opener": "owner" } });
        assert_eq!(given.answered(&frames[0].0, &owner), Some("W".to_string()));
        assert!(read(given.delta(3, &ledger.held())).is_empty(), "a refusal is retried in the same generation");
        assert_eq!(ledger.held().len(), 1, "the window's own record changed");
        assert_eq!(read(given.delta(4, &ledger.held())).len(), 1, "a new generation tries again");
    }

    #[test]
    fn a_job_only_refusal_leaves_the_window_ledger_untouched() {
        let mut ledger = CredentialLedger::default();
        open_recipient(&mut ledger, 1, "R");
        let mut given = Given::default();
        let frames = read(given.delta(3, &ledger.held()));
        assert_eq!(methods(&frames), vec![pair("open_document", "R")]);
        let refused = serde_json::json!({ "id": frames[0].0, "error": { "message": "the certificate file is gone" } });
        assert_eq!(given.answered(&frames[0].0, &refused), Some("R".to_string()));
        assert_eq!(ledger.held().len(), 1);
        assert_eq!(ledger.replay_frames(9).len(), 1, "the window's replacement still gets the credential");
    }

    #[test]
    fn given_is_dropped_when_its_generation_ends() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        let mut given = Given::default();
        given.delta(3, &ledger.held());
        assert_eq!(given.sent.len(), 1);
        assert_eq!(given.awaiting.len(), 1);
        given.reset(0);
        assert!(given.sent.is_empty() && given.awaiting.is_empty());
    }

    #[test]
    fn a_reopen_with_another_password_sends_the_close_the_new_opener_and_every_alias_again() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        share(&mut ledger, 2, "W", "S1");
        share(&mut ledger, 3, "W", "S2");
        let mut given = Given::default();
        assert_eq!(read(given.delta(3, &ledger.held())).len(), 3);
        ledger.written(4, &call("open_document_attempt", serde_json::json!({ "path": "W", "password": "v" })));
        ledger.answered(4, &answer(serde_json::json!({
            "status": "opened", "document": { "opener": "user", "permissions": permissions(), "revision": 6, "p": -4 },
        })));
        let frames = read(given.delta(3, &ledger.held()));
        assert_eq!(
            methods(&frames),
            vec![
                pair("close_document", "W"),
                pair("open_document", "W"),
                pair("share_document", "S1"),
                pair("share_document", "S2"),
            ]
        );
        assert_eq!(frames[1].2["password"], "v");
    }

    #[test]
    fn a_closed_base_takes_its_aliases_out_of_a_job_process() {
        let mut ledger = CredentialLedger::default();
        open_user(&mut ledger, 1, "W", "u");
        share(&mut ledger, 2, "W", "S");
        let mut given = Given::default();
        given.delta(3, &ledger.held());
        close(&mut ledger, 3, "W");
        assert_eq!(methods(&read(given.close_stale(3, &ledger.held()))), vec![pair("close_document", "W")]);
        assert!(given.sent.is_empty());
        assert!(given.close_stale(5, &ledger.held()).is_empty(), "a fresh generation holds nothing to close");
    }

    fn queued(outer: u64, label: &str) -> QueuedRun {
        QueuedRun { outer, label: label.to_string(), request: serde_json::json!({ "id": outer }) }
    }

    #[test]
    fn a_run_above_the_cap_waits_and_starts_when_a_run_ends() {
        let mut pool = RunPool::new(1);
        assert!(pool.admit(queued(1, "main")).is_some());
        assert!(pool.admit(queued(2, "main")).is_none());
        assert!(pool.admit(queued(3, "doc-1")).is_none());
        let (next, skipped) = pool.release(|_| false);
        assert_eq!(next.map(|run| run.outer), Some(2));
        assert!(skipped.is_empty());
        assert_eq!(pool.running, 1);
        assert_eq!(pool.release(|_| false).0.map(|run| run.outer), Some(3));
        assert!(pool.release(|_| false).0.is_none());
        assert_eq!(pool.running, 0);
    }

    #[test]
    fn the_pool_never_starts_a_call_of_a_retired_window() {
        let mut pool = RunPool::new(1);
        pool.admit(queued(1, "main"));
        pool.admit(queued(2, "doc-1"));
        pool.admit(queued(3, "main"));
        let (next, skipped) = pool.release(|label| label == "doc-1");
        assert_eq!(next.map(|run| run.outer), Some(3));
        assert_eq!(skipped.iter().map(|run| run.outer).collect::<Vec<_>>(), vec![2]);
        pool.admit(queued(4, "doc-2"));
        assert_eq!(pool.remove_label("doc-2").len(), 1);
        assert!(pool.take_all().is_empty());
    }

    #[test]
    fn a_queued_route_never_matches_a_generation() {
        let scratch = tempfile::tempdir().unwrap();
        let claims = crate::app_windows::ClaimState::with_registry(scratch.path().join("claims"));
        let output = scratch.path().join("out").to_string_lossy().into_owned();
        let reservation = claims.claim_engine_output_folder(&output, "main").unwrap();
        let router = EngineRouter::new();
        let mut request = serde_json::json!({ "id": 5 });
        let outer = route_with_leases(
            &router, "main", &mut request, RouteWorker::Queued { cancelled: false }, Vec::new(), Vec::new(), Some(reservation),
        )
        .unwrap();
        for generation in [0, 1, outer, u64::MAX] {
            assert!(router.take_worker(generation).is_empty());
            assert!(!router.has_worker(generation));
            assert!(router.write_routes(generation).is_empty());
            assert!(router.take_from(outer, generation).is_none());
            assert_eq!(router.writes_in_flight(Some(generation)), 0);
        }
        assert_eq!(router.writes_in_flight(None), 1, "a queued write counts as a write");
        assert_eq!(router.outer_for("main", &serde_json::json!(5)), Some(outer));
    }

    #[test]
    fn a_cancel_of_a_queued_call_is_carried_to_its_start() {
        let router = EngineRouter::new();
        let mut first = serde_json::json!({ "id": 1 });
        let mut second = serde_json::json!({ "id": 2 });
        let cancelled = route_with_leases(
            &router, "main", &mut first, RouteWorker::Queued { cancelled: false }, Vec::new(), Vec::new(), None,
        )
        .unwrap();
        let plain = route_with_leases(
            &router, "main", &mut second, RouteWorker::Queued { cancelled: false }, Vec::new(), Vec::new(), None,
        )
        .unwrap();
        assert!(router.cancel_queued(cancelled));
        assert_eq!(router.start_queued(cancelled, 9, |_| Ok(Vec::new())), Ok(Some(true)));
        assert_eq!(router.start_queued(plain, 10, |_| Ok(Vec::new())), Ok(Some(false)));
        assert!(router.has_worker(9) && router.has_worker(10));
        assert!(!router.cancel_queued(cancelled), "a started call is cancelled through its process");
        assert_eq!(router.start_queued(cancelled, 11, |_| Ok(Vec::new())), Ok(None));
        assert_eq!(router.start_queued(999, 11, |_| Ok(Vec::new())), Ok(None));
    }
}
