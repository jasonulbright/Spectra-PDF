//! Capture a web page as a PDF, through the webview's own Chromium renderer.
//!
//! The offline posture forbids the ENGINE fetching, and nothing here changes
//! that: `engine/` gains no network code. What this module adds is a
//! user-initiated, VISIBLE browser window. It loads what the URL serves,
//! exactly as any browser would, and the user watches it do so — a hidden
//! fetcher and a shown one differ by precisely the property that makes this
//! acceptable.
//!
//! The renderer is WebView2's `ICoreWebView2_7::PrintToPdf`, which is
//! Chromium's own print pipeline. No new dependency: `webview2-com` is
//! already in the tree at the version tauri resolves, and the live
//! controller comes from Tauri's `PlatformWebview`.
//!
//! Enforced here rather than assumed:
//!   * `http` / `https` / `file` only — every other scheme refuses by name;
//!   * a web crawl follows only links whose HOST AND SCHEME match the start;
//!     redirects and later top-level navigation obey the same boundary, and a
//!     local-file crawl stays under the selected page's canonical parent;
//!   * the one exception is the start page's own first load: a redirect that
//!     only upgrades http to https or adds or removes a leading `www.` moves
//!     the scope to its target, and the scope is fixed from then on;
//!   * one window, navigated in turn — never a fan-out of hidden webviews;
//!   * one capture at a time, and the window is destroyed on every exit path;
//!   * closing the window cancels the run, and a cancelled run SAYS so rather
//!     than reporting what it managed to reach as a finished capture;
//!   * a page budget bounds the run absolutely, and a truncated run SAYS so;
//!   * the window's thread is borrowed only long enough to START each browser
//!     call and is released before the wait, so a capture never withholds
//!     another window's events for the length of a crawl.

use std::cell::Cell;
use std::ffi::c_void;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::WM_CLOSE;
// The WebView2 bindings are generated against windows-core 0.61; an interface
// cast and a PCWSTR argument only typecheck against THAT crate's traits, not
// the 0.62 the rest of this binary uses.
use windows_core_webview2::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment, ICoreWebView2Environment6, ICoreWebView2PrintSettings,
    ICoreWebView2WebResourceResponse, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, COREWEBVIEW2_WEB_ERROR_STATUS,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
};
use webview2_com::{
    take_pwstr, ExecuteScriptCompletedHandler, NavigationCompletedEventHandler,
    NavigationStartingEventHandler, PrintToPdfCompletedHandler, WebResourceRequestedEventHandler,
};

/// The window a capture runs in. One label, so a second capture cannot open a
/// second window behind the first.
pub const CAPTURE_LABEL: &str = "web-capture";

/// Identifies this module's window subclass on the capture window.
const CLOSE_WATCH_ID: usize = 1;

/// How long one navigation may take before the capture refuses. Generous: a
/// cold DNS lookup plus a heavy page is seconds, and a refusal here costs the
/// user the whole capture.
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(90);
/// How long `PrintToPdf` may take for one page.
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the link harvest may take.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a step that only reads the browser may take. It does no work of
/// its own, so this bounds the dispatch to the window's thread and nothing
/// else.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(20);
/// Settling time after `NavigationCompleted` before printing — late webfonts
/// and lazy images land in this window, and printing at the instant of
/// navigation-complete captures a page mid-layout.
const SETTLE: Duration = Duration::from_millis(1200);
/// How often a wait looks up to check for a cancel.
const WAIT_SLICE: Duration = Duration::from_millis(25);

/// The absolute ceiling on a crawl, whatever the caller asks for.
pub const MAX_PAGES_CEILING: u32 = 100;
pub const MAX_DEPTH_CEILING: u32 = 3;

const RUNTIME_TOO_OLD: &str = "This machine's web runtime is too old to render a page to PDF";

static CAPTURING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

fn cancelled() -> bool {
    CANCELLED.load(Ordering::SeqCst)
}

fn request_cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}

fn clear_cancel() {
    CANCELLED.store(false, Ordering::SeqCst);
}

/// A close the app's window-event path observed, by window label.
///
/// The capture window is not a workspace window: its close is a cancel, and
/// the capture destroys the window itself on the way out.
pub fn window_close_requested(label: &str) {
    if label == CAPTURE_LABEL {
        request_cancel();
    }
}

/// The capture window's close.
///
/// Swallowed while a capture is in flight: the window belongs to the capture,
/// which destroys it on the way out, so the default close must not race that
/// with a teardown of its own. With no capture in flight it chains through and
/// the window closes the ordinary way.
unsafe extern "system" fn on_capture_window_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_CLOSE && CAPTURING.load(Ordering::SeqCst) {
        request_cancel();
        return LRESULT(0);
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// Make the capture window's close cancel the capture.
///
/// A failed install is not fatal: the close then falls to the app's
/// window-event path, which does not prevent it, so the window still closes.
fn watch_close(hwnd: usize) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        let _ = SetWindowSubclass(
            HWND(hwnd as *mut c_void),
            Some(on_capture_window_message),
            CLOSE_WATCH_ID,
            0,
        );
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub url: String,
    /// 0 = this page only. Clamped to `MAX_DEPTH_CEILING`.
    #[serde(default)]
    pub depth: u32,
    /// Clamped to `MAX_PAGES_CEILING`; 0 means 1.
    #[serde(default)]
    pub max_pages: u32,
    /// Inches. Defaults to Letter when either is absent or not positive.
    #[serde(default)]
    pub page_width_in: f64,
    #[serde(default)]
    pub page_height_in: f64,
    /// `portrait` | `landscape`.
    #[serde(default)]
    pub orientation: String,
    #[serde(default)]
    pub margin_in: f64,
    #[serde(default)]
    pub headers_footers: bool,
    #[serde(default)]
    pub backgrounds: bool,
    /// 0.1 – 2.0. Out of range or absent means 1.0.
    #[serde(default)]
    pub scale: f64,
}

#[derive(Serialize, Clone)]
pub struct CapturedPage {
    pub url: String,
    pub title: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// Opaque identity used to release this run's temporary PDFs. Its
    /// directory is confined to this process and is also reclaimed after a
    /// crashed process exits.
    pub capture_id: String,
    pub pages: Vec<CapturedPage>,
    /// How many URLs were reached, including any that failed.
    pub visited: usize,
    /// The frontier still had URLs when the page budget ran out.
    pub truncated: bool,
    /// The capture window was closed before the run finished. Structured
    /// rather than an error string: a cancelled run is not a failure, and the
    /// caller decides what to say about it without matching on message text.
    pub cancelled: bool,
    /// Per-URL failures. A capture that lost a page SAYS which one.
    pub failures: Vec<String>,
    /// The host a start-page redirect tried to reach outside the capture's
    /// scope. Structured so the caller names the refusal in the user's
    /// language instead of showing the browser's cancellation status.
    pub refused_redirect: Option<String>,
}

/// The origin a capture may navigate within.
///
/// `settled` is false only while the start page's first load is in flight;
/// only then may a redirect move the scope (see `start_redirect_scope`).
struct CaptureScope {
    start_scheme: String,
    start_host: String,
    scheme: String,
    host: String,
    started: bool,
    settled: bool,
    load_observed: bool,
    refused_host: Option<String>,
    /// Top-level targets this scope refused, fragment removed. The document
    /// request for each is answered locally, because a cancelled navigation
    /// can still have issued its request.
    refused_documents: HashSet<String>,
    /// Insertion order of `refused_documents`, oldest first, for the cap.
    refused_order: VecDeque<String>,
    /// A navigation was cancelled without a readable target: every document
    /// request is answered locally until a navigation is admitted.
    refused_unknown: bool,
}

/// Refused targets kept for request blocking; the oldest drops first.
const REFUSED_DOCUMENTS_CAP: usize = 256;

/// The request identity a document fetch and a navigation share. Both URIs
/// arrive in the browser's canonical spelling; the resource filter removes the
/// fragment, so only the fragment is cut here.
fn document_key(target: &str) -> &str {
    target.split('#').next().unwrap_or(target)
}

impl CaptureScope {
    fn new(scheme: String, host: String) -> Self {
        Self {
            start_scheme: scheme.clone(),
            start_host: host.clone(),
            scheme,
            host,
            started: false,
            settled: false,
            load_observed: false,
            refused_host: None,
            refused_documents: HashSet::new(),
            refused_order: VecDeque::new(),
            refused_unknown: false,
        }
    }

    /// Whether a document request must be answered locally instead of sent.
    fn blocks_document(&self, uri: &str) -> bool {
        self.refused_unknown || self.refused_documents.contains(document_key(uri))
    }

    /// Record a cancelled navigation whose target could not be read.
    fn refuse_unknown(&mut self) {
        self.refused_unknown = true;
    }

    fn remember_refused(&mut self, key: &str) {
        if !self.refused_documents.insert(key.to_string()) {
            return;
        }
        self.refused_order.push_back(key.to_string());
        while self.refused_order.len() > REFUSED_DOCUMENTS_CAP {
            if let Some(oldest) = self.refused_order.pop_front() {
                self.refused_documents.remove(&oldest);
            }
        }
    }

    /// Decide one top-level navigation. Redirects are judged against the
    /// ORIGINAL start, so a chain cannot walk the host one step at a time.
    /// A refusal before the crawl has seen the first load end records the
    /// target host, whether a redirect or a script caused it.
    fn admit(&mut self, target: &str, redirected: bool, local_root: Option<&Path>) -> bool {
        let key = document_key(target);
        let admitted = self.judge(target, redirected, local_root);
        if admitted {
            self.refused_unknown = false;
            if self.refused_documents.remove(key) {
                self.refused_order.retain(|refused| refused != key);
            }
        } else {
            self.remember_refused(key);
        }
        admitted
    }

    fn judge(&mut self, target: &str, redirected: bool, local_root: Option<&Path>) -> bool {
        if !redirected && self.started {
            self.settled = true;
        }
        if link_in_scope(target, &self.scheme, &self.host, local_root) {
            self.started = true;
            return true;
        }
        if self.started && !self.settled && redirected {
            if let Some((scheme, host)) =
                start_redirect_scope(&self.start_scheme, &self.start_host, target)
                    .filter(|(scheme, _)| self.scheme != "https" || scheme == "https")
            {
                self.scheme = scheme;
                self.host = host;
                return true;
            }
        }
        if self.started && !self.load_observed {
            self.refused_host = Some(
                url::Url::parse(target)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_string))
                    .unwrap_or_else(|| target.to_string()),
            );
        }
        false
    }
}

type SharedScope = Arc<Mutex<CaptureScope>>;

fn scope_snapshot(scope: &SharedScope) -> (String, String) {
    let scope = scope.lock().unwrap_or_else(|poison| poison.into_inner());
    (scope.scheme.clone(), scope.host.clone())
}

fn settle_scope(scope: &SharedScope) -> Option<String> {
    let mut scope = scope.lock().unwrap_or_else(|poison| poison.into_inner());
    scope.settled = true;
    scope.load_observed = true;
    scope.refused_host.clone()
}

#[derive(Deserialize)]
struct HarvestedLinks {
    links: Vec<String>,
    truncated: bool,
}

/// A URL this capture may load, normalised.
///
/// Scheme-gated at the boundary rather than in the dialog: the dialog is one
/// caller, and a gate only the caller honours is a gate a second caller
/// silently skips.
pub fn validate_url(raw: &str) -> Result<(String, String, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a web address to capture".to_string());
    }
    // A bare host is what people type. Everything else must name its scheme.
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else if trimmed.contains(':') {
        // `javascript:…`, `data:…`, `mailto:…` — named, and refused below.
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&candidate)
        .map_err(|_| format!("{trimmed} is not a web address"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "file") {
        return Err(format!(
            "Only http, https and file addresses can be captured, not {scheme}"
        ));
    }
    // Store a URL-standard authority key, not the spelling the user typed.
    // WebView2 reports canonical URLs: it removes default ports and converts
    // internationalized names to ASCII. Using the same normalization keeps
    // the initial navigation inside its own scope.
    let host = if scheme == "file" {
        String::new()
    } else {
        let host = parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| format!("{trimmed} names no host"))?;
        let port = parsed
            .port_or_known_default()
            .ok_or_else(|| format!("{trimmed} names no supported web port"))?;
        format!("{}:{port}", host.to_ascii_lowercase())
    };
    Ok((candidate, scheme, host))
}

/// The scope a redirect of the start page's first load moves the capture to,
/// or `None` when the redirect leaves the site.
///
/// Admitted: the same host upgraded from http to https (default port to
/// default port only), and the same scheme and port with a leading `www.`
/// added or removed; both together are also admitted. Every other change of
/// scheme, host or port is a different site. A registrable-domain comparison
/// would need the public suffix list; without it `a.example` and `b.example`
/// cannot be told apart from `a.co.uk` and `b.co.uk`.
pub fn start_redirect_scope(scheme: &str, host: &str, target: &str) -> Option<(String, String)> {
    let (_, next_scheme, next_host) = validate_url(target).ok()?;
    let (name, port) = host.rsplit_once(':')?;
    let (next_name, next_port) = next_host.rsplit_once(':')?;
    let transport = if next_scheme == scheme {
        next_port == port
    } else {
        scheme == "http" && next_scheme == "https" && port == "80" && next_port == "443"
    };
    let www = |bare: &str, prefixed: &str| {
        !bare.is_empty() && prefixed.strip_prefix("www.") == Some(bare)
    };
    let same_site = next_name == name || www(name, next_name) || www(next_name, name);
    (scheme != "file" && transport && same_site).then_some((next_scheme, next_host))
}

/// Is `candidate` in the same origin as the capture's start?
///
/// Host AND scheme, both. A crawl that followed http from an https start
/// would silently downgrade the transport for every page after the first.
pub fn same_origin(candidate: &str, scheme: &str, host: &str) -> bool {
    match validate_url(candidate) {
        // File URLs all have an empty host; treating that as an origin would
        // let a local page crawl into every readable path on the machine.
        Ok((_, s, h)) => s != "file" && s == scheme && h == host,
        Err(_) => false,
    }
}

/// The canonical directory containing a local file selected for capture.
///
/// A `file:` URL has no network origin. Its crawl boundary is instead the
/// selected file's parent directory, resolved through any symlink or
/// junction in that directory so later links cannot escape through one.
fn local_file_root(start: &str) -> Result<PathBuf, String> {
    let url = url::Url::parse(start)
        .map_err(|_| "The local page address could not be read".to_string())?;
    let path = url
        .to_file_path()
        .map_err(|_| "The local page address does not name a local file".to_string())?;
    if !std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
        return Err("The local page address does not name an existing file".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The local page has no containing folder".to_string())?;
    std::fs::canonicalize(parent)
        .map_err(|_| "The local page's containing folder could not be resolved".to_string())
}

/// Whether a candidate `file:` URL resolves below the selected page's
/// directory. Canonicalization follows links before containment is checked;
/// `Path::starts_with` compares complete path components.
fn local_file_below(root: &Path, candidate: &str) -> bool {
    let Ok(url) = url::Url::parse(candidate) else {
        return false;
    };
    if url.scheme() != "file" {
        return false;
    }
    let Ok(path) = url.to_file_path() else {
        return false;
    };
    std::fs::canonicalize(path).is_ok_and(|path| path.starts_with(root))
}

fn clamp(options: &CaptureOptions) -> (u32, u32) {
    let depth = options.depth.min(MAX_DEPTH_CEILING);
    let budget = if options.max_pages == 0 {
        1
    } else {
        options.max_pages.min(MAX_PAGES_CEILING)
    };
    (depth, budget)
}

/// How many distinct URLs a crawl may hold in mind at once. Bounded off the
/// page budget so a link-dense site cannot grow the frontier without limit.
fn frontier_cap(budget: u32) -> u32 {
    budget * 4 + 16
}

fn link_in_scope(link: &str, scheme: &str, host: &str, local_root: Option<&Path>) -> bool {
    if scheme == "file" {
        local_root.is_some_and(|root| local_file_below(root, link))
    } else {
        same_origin(link, scheme, host)
    }
}

/// Queue eligible links and say when the bounded frontier omitted any.
fn enqueue_links(
    links: Vec<String>,
    scheme: &str,
    host: &str,
    local_root: Option<&Path>,
    next_level: u32,
    budget: u32,
    seen: &mut Vec<String>,
    frontier: &mut Vec<(String, u32)>,
) -> bool {
    let cap = frontier_cap(budget);
    let mut truncated = false;
    for link in links {
        if !link_in_scope(&link, scheme, host, local_root)
            || seen.iter().any(|known| known == &link)
        {
            continue;
        }
        if seen.len() as u32 >= cap {
            truncated = true;
            continue;
        }
        seen.push(link.clone());
        frontier.push((link, next_level));
    }
    truncated
}

fn decode_harvested_links(raw: &str) -> Result<HarvestedLinks, String> {
    // ExecuteScript returns JSON for the script result; the script itself
    // returns a JSON string, so this boundary deliberately parses twice.
    let encoded: String = serde_json::from_str(raw)
        .map_err(|e| format!("the page's link result was not readable: {e}"))?;
    serde_json::from_str(&encoded)
        .map_err(|e| format!("the page's link list was not readable: {e}"))
}

fn capture_root() -> PathBuf {
    std::env::temp_dir().join("spectrapdf").join("web-capture")
}

/// One capture's files. The process id lets startup reclaim a killed
/// process's directory without touching another live app instance; the UUID
/// prevents runs in this process from sharing or replacing files.
struct CaptureScratch {
    id: uuid::Uuid,
    dir: PathBuf,
    retained: bool,
}

impl CaptureScratch {
    fn new() -> Result<Self, String> {
        Self::new_at(&capture_root(), std::process::id())
    }

    fn new_at(root: &Path, pid: u32) -> Result<Self, String> {
        std::fs::create_dir_all(root)
            .map_err(|e| format!("Cannot create the capture scratch folder: {e}"))?;
        let id = uuid::Uuid::new_v4();
        let dir = root.join(format!("{id}.{pid}"));
        std::fs::create_dir(&dir)
            .map_err(|e| format!("Cannot create the capture's private folder: {e}"))?;
        Ok(Self {
            id,
            dir,
            retained: false,
        })
    }

    fn capture_id(&self) -> String {
        self.id.to_string()
    }

    fn retain(&mut self) {
        self.retained = true;
    }
}

impl Drop for CaptureScratch {
    fn drop(&mut self) {
        if !self.retained {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn discard_capture_at(root: &Path, capture_id: &str, pid: u32) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(capture_id)
        .map_err(|_| "The capture scratch identity is invalid".to_string())?;
    if id.get_version_num() != 4 || id.to_string() != capture_id {
        return Err("The capture scratch identity is invalid".to_string());
    }
    let dir = root.join(format!("{id}.{pid}"));
    let metadata = match std::fs::symlink_metadata(&dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!("Could not inspect the capture scratch folder: {error}"))
        }
    };
    if !metadata.file_type().is_dir() {
        return Err("The capture scratch path is not a regular folder".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Cannot locate the capture scratch folder: {e}"))?;
    let parent = dir
        .parent()
        .ok_or_else(|| "The capture scratch path is invalid".to_string())?
        .canonicalize()
        .map_err(|e| format!("Cannot locate the capture scratch folder: {e}"))?;
    if parent != canonical_root {
        return Err("The capture scratch path is outside its folder".to_string());
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Could not remove the capture scratch folder: {e}"))
}

/// Release the temporary PDFs for one completed capture from this process.
/// The renderer can name only an opaque UUID; the command supplies its own
/// process id and never accepts a filesystem path.
#[tauri::command]
pub fn discard_web_capture(capture_id: String) -> Result<(), String> {
    discard_capture_at(&capture_root(), &capture_id, std::process::id())
}

/// Why a capture step did not succeed. Cancellation is separated from failure
/// because it produces no per-URL message: the window was closed, and a list
/// of the steps that broke while it was being torn down names nothing that
/// went wrong.
enum StepError {
    Cancelled,
    Failed(String),
}

/// The live browser interfaces, for the length of one step.
///
/// COM pointers into the window's single-threaded apartment: not `Send`, so
/// they cannot be carried across dispatches and are taken fresh on the
/// window's own thread each time. Nothing here outlives the dispatch that
/// acquired it, which is what makes destroying the window safe at any moment
/// the window's thread is not inside a step.
struct Browser {
    webview: ICoreWebView2_7,
    environment: ICoreWebView2Environment6,
}

impl Browser {
    fn acquire(platform: &tauri::webview::PlatformWebview) -> Result<Self, String> {
        let controller = platform.controller();
        let core = unsafe { controller.CoreWebView2() }
            .map_err(|e| format!("The capture window has no browser: {e}"))?;
        // The interface PrintToPdf lives on. No version is pinned (the
        // standing rule); the cast is attempted and its failure is a NAMED
        // refusal, never a silent blank capture.
        let webview: ICoreWebView2_7 = core.cast().map_err(|_| RUNTIME_TOO_OLD.to_string())?;
        let environment: ICoreWebView2Environment6 = platform
            .environment()
            .cast()
            .map_err(|_| RUNTIME_TOO_OLD.to_string())?;
        Ok(Self {
            webview,
            environment,
        })
    }
}

/// Start one browser call on the window's own thread, and wait for it HERE.
///
/// This split is the whole discipline. Every WebView2 callback is delivered on
/// the message queue of the thread that made the call, so that thread has to
/// be back inside its event loop when the callback arrives — a wait there is
/// the deadlock. `start` therefore only ISSUES the call and returns, releasing
/// the thread, and the completion is awaited on the caller's thread, which
/// owns no message queue anyone is waiting on.
///
/// It is also what keeps a capture from freezing the rest of the app: the
/// window's thread is held for the length of one call rather than the length
/// of a crawl, so events bound for other windows are never withheld.
fn run_step<T, F>(
    window: &WebviewWindow,
    timeout: Duration,
    timed_out: &str,
    start: F,
) -> Result<T, StepError>
where
    T: Send + 'static,
    F: FnOnce(&Browser, mpsc::Sender<Result<T, String>>) -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Result<T, String>>();
    let refused = tx.clone();
    window
        .with_webview(move |platform| {
            if let Err(err) = Browser::acquire(&platform).and_then(|browser| start(&browser, tx)) {
                let _ = refused.send(Err(err));
            }
        })
        .map_err(|e| StepError::Failed(format!("Could not reach the capture window: {e}")))?;
    wait_step(&rx, timeout, timed_out)
}

/// Enforce the start page's scope for every top-level navigation made by this
/// capture, including redirects and script or meta-refresh navigation during
/// the settle and print steps. The capture window is destroyed on every exit,
/// so the event registration has exactly the capture's lifetime.
fn guard_navigation_scope(
    window: &WebviewWindow,
    scope: SharedScope,
    local_root: Option<PathBuf>,
) -> Result<(), StepError> {
    run_step(
        window,
        DISPATCH_TIMEOUT,
        "the capture scope could not be enforced",
        move |browser, tx| {
            let blocker_scope = scope.clone();
            let environment: ICoreWebView2Environment = browser
                .environment
                .cast()
                .map_err(|e| format!("Could not enforce the capture scope: {e}"))?;
            let blocker = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let request = unsafe { args.Request() }?;
                let mut uri = PWSTR::null();
                unsafe { request.Uri(&mut uri) }?;
                let uri = take_pwstr(uri);
                let blocked = blocker_scope
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .blocks_document(&uri);
                if blocked {
                    let reason = HSTRING::from("Blocked");
                    let headers = HSTRING::from("");
                    let mut response = std::ptr::null_mut();
                    // No content stream: the response carries a status only.
                    let created = unsafe {
                        (Interface::vtable(&environment).CreateWebResourceResponse)(
                            Interface::as_raw(&environment),
                            std::ptr::null_mut(),
                            403,
                            PCWSTR(reason.as_ptr()),
                            PCWSTR(headers.as_ptr()),
                            &mut response,
                        )
                    };
                    if created.is_ok() && !response.is_null() {
                        let response =
                            unsafe { ICoreWebView2WebResourceResponse::from_raw(response) };
                        unsafe { args.SetResponse(&response) }?;
                    }
                }
                Ok(())
            }));
            let mut blocker_token = 0i64;
            let every_uri = HSTRING::from("*");
            unsafe {
                browser.webview.AddWebResourceRequestedFilter(
                    PCWSTR(every_uri.as_ptr()),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                )
            }
            .and_then(|_| unsafe {
                browser
                    .webview
                    .add_WebResourceRequested(&blocker, &mut blocker_token)
            })
            .map_err(|e| format!("Could not enforce the capture scope: {e}"))?;
            let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut uri = PWSTR::null();
                    let target = unsafe { args.Uri(&mut uri) }.ok().map(|_| take_pwstr(uri));
                    let mut flag = BOOL::from(false);
                    let redirected =
                        unsafe { args.IsRedirected(&mut flag) }.is_ok() && flag.as_bool();
                    let mut guard = scope.lock().unwrap_or_else(|poison| poison.into_inner());
                    let allowed = match target.as_deref() {
                        Some(target) => guard.admit(target, redirected, local_root.as_deref()),
                        None => {
                            guard.refuse_unknown();
                            false
                        }
                    };
                    drop(guard);
                    if !allowed {
                        let _ = unsafe { args.SetCancel(true) };
                    }
                }
                Ok(())
            }));
            let mut token = 0i64;
            unsafe {
                browser
                    .webview
                    .add_NavigationStarting(&handler, &mut token)
            }
            .map_err(|e| format!("Could not enforce the capture scope: {e}"))?;
            let _ = tx.send(Ok(()));
            Ok(())
        },
    )
}

/// Wait for a step's completion off the window's thread.
///
/// A disconnect is not a timeout: it means every sender was dropped, which
/// happens when the dispatch is discarded or the browser tears its handlers
/// down — in both cases the window is gone.
fn wait_step<T>(
    rx: &mpsc::Receiver<Result<T, String>>,
    timeout: Duration,
    timed_out: &str,
) -> Result<T, StepError> {
    let expiry = Instant::now() + timeout;
    loop {
        match rx.recv_timeout(WAIT_SLICE) {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(err)) => return Err(StepError::Failed(err)),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(if cancelled() {
                    StepError::Cancelled
                } else {
                    StepError::Failed("the capture window closed".to_string())
                })
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if cancelled() {
            return Err(StepError::Cancelled);
        }
        if Instant::now() >= expiry {
            return Err(StepError::Failed(timed_out.to_string()));
        }
    }
}

/// Navigate, and wait for the navigation to complete.
fn navigate(window: &WebviewWindow, url: &str) -> Result<(), StepError> {
    let target = url.to_string();
    let timed_out = format!("{url} did not finish loading in time");
    run_step(window, NAVIGATION_TIMEOUT, &timed_out, move |browser, tx| {
        // Navigation-complete is an EVENT, not a completion: left registered
        // it would fire again for every later page in the crawl, so the
        // handler removes its own registration. The token is set before the
        // handler can run — nothing pumps this thread's queue between the
        // registration and the assignment.
        let token = Rc::new(Cell::new(0i64));
        let owned = token.clone();
        let handler = NavigationCompletedEventHandler::create(Box::new(move |source, args| {
            let outcome = match args {
                Some(args) => {
                    let mut ok = BOOL::from(false);
                    let _ = unsafe { args.IsSuccess(&mut ok) };
                    if ok.as_bool() {
                        Ok(())
                    } else {
                        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                        let _ = unsafe { args.WebErrorStatus(&mut status) };
                        Err(format!("the page could not be loaded (status {})", status.0))
                    }
                }
                None => Err("the page could not be loaded".to_string()),
            };
            let _ = tx.send(outcome);
            if let Some(source) = source {
                let _ = unsafe { source.remove_NavigationCompleted(owned.get()) };
            }
            Ok(())
        }));
        let mut registered = 0i64;
        unsafe {
            browser
                .webview
                .add_NavigationCompleted(&handler, &mut registered)
        }
        .map_err(|e| format!("Could not watch the capture window: {e}"))?;
        token.set(registered);
        let wide = HSTRING::from(target.as_str());
        unsafe { browser.webview.Navigate(PCWSTR(wide.as_ptr())) }
            .map_err(|e| format!("Could not open {target}: {e}"))?;
        Ok(())
    })
}

/// Render the settled page into `path`.
fn print_page(
    window: &WebviewWindow,
    path: &std::path::Path,
    options: &CaptureOptions,
    scheme: String,
    host: String,
    local_root: Option<PathBuf>,
) -> Result<String, StepError> {
    let target = path.to_path_buf();
    let opts = options.clone();
    let final_url = run_step(
        window,
        PRINT_TIMEOUT,
        "the page did not finish rendering in time",
        move |browser, tx| {
            let settings = build_settings(&browser.environment, &opts)?;
            let mut uri = PWSTR::null();
            unsafe { browser.webview.Source(&mut uri) }
                .map_err(|e| format!("Could not read the page address before printing: {e}"))?;
            let final_url = take_pwstr(uri);
            if !link_in_scope(&final_url, &scheme, &host, local_root.as_deref()) {
                return Err("the page navigated outside the capture's permitted scope".to_string());
            }
            // The print is asynchronous and the settings must outlive this
            // call, so a reference rides in the completion handler and is
            // released with it.
            let kept = settings.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                drop(kept);
                let outcome = if hr.is_ok() && ok {
                    Ok(())
                } else {
                    Err("the page could not be rendered to PDF".to_string())
                };
                let _ = tx.send(outcome.map(|()| final_url));
                Ok(())
            }));
            let wide = HSTRING::from(target.to_string_lossy().as_ref());
            unsafe {
                browser
                    .webview
                    .PrintToPdf(PCWSTR(wide.as_ptr()), &settings, &handler)
            }
            .map_err(|e| format!("Could not render the page to PDF: {e}"))?;
            Ok(())
        },
    )?;
    if !path.is_file() {
        return Err(StepError::Failed("the capture produced no PDF".to_string()));
    }
    // The completion carries the exact source read immediately before the
    // print call; it is the address whose document produced this PDF.
    // `run_step` above has already waited for that completion.
    Ok(final_url)
}

/// Same-document links, in document order, de-duplicated by the script so the
/// frontier does not carry a hundred copies of a nav bar.
fn harvest_links(window: &WebviewWindow) -> Result<HarvestedLinks, StepError> {
    let raw = run_step(
        window,
        SCRIPT_TIMEOUT,
        "the page's links did not arrive in time",
        move |browser, tx| {
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_, json| {
                let _ = tx.send(Ok(json.to_string()));
                Ok(())
            }));
            let script: HSTRING = HSTRING::from(
                r#"(function(){var a=document.links,s=new Set(),o=[],n=Math.min(a.length,10000),t=a.length>n;
                   for(let i=0;i<n;i++){
                     let h;try{h=new URL(a[i].href,document.baseURI).href;}catch(e){continue;}
                     h=h.split('#')[0];if(!h||s.has(h))continue;
                     if(h.length>2048){t=true;continue;}
                     if(o.length>=400){t=true;break;}
                     s.add(h);o.push(h);
                   }
                   return JSON.stringify({links:o,truncated:t});})()"#,
            );
            unsafe {
                browser
                    .webview
                    .ExecuteScript(PCWSTR(script.as_ptr()), &handler)
            }
            .map_err(|e| format!("Could not read the page's links: {e}"))?;
            Ok(())
        },
    )?;
    decode_harvested_links(&raw).map_err(StepError::Failed)
}

fn page_title(window: &WebviewWindow) -> String {
    run_step(
        window,
        DISPATCH_TIMEOUT,
        "the page title did not arrive in time",
        |browser, tx| {
            let mut raw = PWSTR::null();
            let title = if unsafe { browser.webview.DocumentTitle(&mut raw) }.is_ok() {
                take_pwstr(raw)
            } else {
                String::new()
            };
            let _ = tx.send(Ok(title));
            Ok(())
        },
    )
    .unwrap_or_default()
}

/// Abandon whatever the window is still loading.
///
/// Issued without waiting: this runs only once the capture is already
/// cancelled, so a wait would return on the flag and prove nothing. Ordering
/// carries it instead — this and the destroy are both messages to the window's
/// thread and are delivered in the order they were sent.
fn abandon_navigation(window: &WebviewWindow) {
    let _ = window.with_webview(|platform| {
        if let Ok(browser) = Browser::acquire(&platform) {
            let _ = unsafe { browser.webview.Stop() };
        }
    });
}

/// Let the page settle before printing. False when the capture was cancelled.
fn settle_pause() -> bool {
    let expiry = Instant::now() + SETTLE;
    while Instant::now() < expiry {
        if cancelled() {
            return false;
        }
        std::thread::sleep(WAIT_SLICE);
    }
    !cancelled()
}

fn build_settings(
    environment: &ICoreWebView2Environment6,
    options: &CaptureOptions,
) -> Result<ICoreWebView2PrintSettings, String> {
    let settings = unsafe { environment.CreatePrintSettings() }
        .map_err(|e| format!("Could not prepare the page settings: {e}"))?;
    let width = if options.page_width_in > 0.0 { options.page_width_in } else { 8.5 };
    let height = if options.page_height_in > 0.0 { options.page_height_in } else { 11.0 };
    let margin = if options.margin_in.is_finite() && options.margin_in >= 0.0 {
        options.margin_in
    } else {
        0.0
    };
    let scale = if (0.1..=2.0).contains(&options.scale) { options.scale } else { 1.0 };
    let landscape = options.orientation.eq_ignore_ascii_case("landscape");
    unsafe {
        let _ = settings.SetPageWidth(width);
        let _ = settings.SetPageHeight(height);
        let _ = settings.SetOrientation(if landscape {
            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
        } else {
            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
        });
        let _ = settings.SetMarginTop(margin);
        let _ = settings.SetMarginBottom(margin);
        let _ = settings.SetMarginLeft(margin);
        let _ = settings.SetMarginRight(margin);
        let _ = settings.SetScaleFactor(scale);
        let _ = settings.SetShouldPrintBackgrounds(options.backgrounds);
        let _ = settings.SetShouldPrintHeaderAndFooter(options.headers_footers);
    }
    Ok(settings)
}

/// Capture one page, or a bounded same-origin crawl from it.
#[tauri::command]
pub async fn capture_web_page(
    app: AppHandle,
    options: CaptureOptions,
) -> Result<CaptureResult, String> {
    let (start, scheme, host) = validate_url(&options.url)?;
    let local_root = if scheme == "file" {
        Some(local_file_root(&start)?)
    } else {
        None
    };
    let (depth, budget) = clamp(&options);

    if CAPTURING.swap(true, Ordering::SeqCst) {
        return Err("A capture is already running".to_string());
    }
    // A close seen while no capture was running must not cancel this one.
    clear_cancel();
    let mut scratch = match CaptureScratch::new() {
        Ok(scratch) => scratch,
        Err(error) => {
            CAPTURING.store(false, Ordering::SeqCst);
            return Err(error);
        }
    };
    let capture_id = scratch.capture_id();
    let result = run_capture(
        &app,
        options,
        start,
        scheme,
        host,
        local_root,
        depth,
        budget,
        scratch.dir.clone(),
        capture_id,
    )
    .await;
    if matches!(&result, Ok(result) if !result.cancelled && !result.pages.is_empty()) {
        scratch.retain();
    }
    CAPTURING.store(false, Ordering::SeqCst);
    // Every exit path — success, refusal, cancellation, a cancel that raced
    // completion. No interface into this window's browser outlives the
    // dispatch that took it, and a destroy is processed on the same thread as
    // those dispatches, so the two can never interleave.
    if let Some(window) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = window.destroy();
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_capture(
    app: &AppHandle,
    options: CaptureOptions,
    start: String,
    scheme: String,
    host: String,
    local_root: Option<PathBuf>,
    depth: u32,
    budget: u32,
    scratch_dir: PathBuf,
    capture_id: String,
) -> Result<CaptureResult, String> {
    if app.get_webview_window(CAPTURE_LABEL).is_some() {
        return Err("A capture window is already open".to_string());
    }
    // about:blank, then navigate: the window must EXIST and be visible before
    // anything is fetched, so the user sees the browser that is about to make
    // the request rather than one that already made it.
    let window = WebviewWindowBuilder::new(
        app,
        CAPTURE_LABEL,
        WebviewUrl::External(
            "about:blank"
                .parse()
                .map_err(|e| format!("Could not prepare the capture window: {e}"))?,
        ),
    )
    .title(if host.is_empty() {
        "Capturing a local page".to_string()
    } else {
        format!("Capturing {host}")
    })
    .inner_size(1200.0, 900.0)
    .center()
    .visible(true)
    .build()
    .map_err(|e| format!("Could not open the capture window: {e}"))?;

    // The subclass goes on from the window's own thread, and ahead of every
    // step: both are messages to that thread, delivered in the order sent.
    let hwnd = window.hwnd().map(|h| h.0 as usize).unwrap_or(0);
    let _ = window.with_webview(move |_| watch_close(hwnd));

    let scope: SharedScope = Arc::new(Mutex::new(CaptureScope::new(scheme, host)));
    match guard_navigation_scope(&window, scope.clone(), local_root.clone()) {
        Ok(()) => {}
        Err(StepError::Cancelled) => return Ok(cancelled_result(capture_id)),
        Err(StepError::Failed(error)) => return Err(error),
    }

    let worker = window.clone();
    let opts = options.clone();
    let worker_scratch = scratch_dir;
    let worker_capture_id = capture_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<CaptureResult, String> {
        // Reach the browser once before the crawl, so a runtime that cannot
        // render to PDF refuses BY NAME here rather than as a page that
        // failed to print.
        match run_step(
            &worker,
            DISPATCH_TIMEOUT,
            "The capture window did not answer in time",
            |_, tx| {
                let _ = tx.send(Ok(()));
                Ok(())
            },
        ) {
            Ok(()) => {}
            Err(StepError::Cancelled) => return Ok(cancelled_result(worker_capture_id)),
            Err(StepError::Failed(err)) => return Err(err),
        }
        Ok(crawl(
            &worker,
            &opts,
            &start,
            &scope,
            local_root.as_deref(),
            depth,
            budget,
            &worker_scratch,
            worker_capture_id,
        ))
    })
    .await
    .map_err(|e| format!("The capture did not run: {e}"))?;

    let mut result = outcome?;
    if result.cancelled {
        result.pages.clear();
        return Ok(result);
    }
    // A cancelled run reports itself rather than refusing: the refusal below
    // names a capture that was tried and produced nothing, which is a
    // different thing from one that was stopped.
    if result.pages.is_empty() && result.refused_redirect.is_some() {
        return Ok(result);
    }
    if result.pages.is_empty() && !result.cancelled {
        let detail = result
            .failures
            .first()
            .cloned()
            .unwrap_or_else(|| "nothing could be captured".to_string());
        return Err(detail);
    }
    Ok(result)
}

/// A cancellation no crawl answered: the window was closed before the crawl
/// reached it, so there is nothing to report but the cancellation itself.
fn cancelled_result(capture_id: String) -> CaptureResult {
    finish(capture_id, true, 0, 0, Vec::new(), 0, Vec::new())
}

/// Assemble the run's verdict. Apart from the loop so the relationship between
/// stopping, truncation and failure is stated in one place: a cancelled run
/// did not reach the page limit, and saying it did reports the wrong reason
/// for a short capture.
fn finish(
    capture_id: String,
    stopped: bool,
    cursor: usize,
    frontier: usize,
    pages: Vec<CapturedPage>,
    visited: usize,
    failures: Vec<String>,
) -> CaptureResult {
    CaptureResult {
        capture_id,
        truncated: !stopped && cursor < frontier,
        cancelled: stopped,
        pages,
        visited,
        failures,
        refused_redirect: None,
    }
}

/// Breadth-first over the same origin, one window navigated in turn.
#[allow(clippy::too_many_arguments)]
fn crawl(
    window: &WebviewWindow,
    options: &CaptureOptions,
    start: &str,
    scope: &SharedScope,
    local_root: Option<&Path>,
    depth: u32,
    budget: u32,
    scratch_dir: &Path,
    capture_id: String,
) -> CaptureResult {
    let mut seen: Vec<String> = vec![start.to_string()];
    let mut frontier: Vec<(String, u32)> = vec![(start.to_string(), 0)];
    let mut pages: Vec<CapturedPage> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    let mut visited = 0usize;
    let mut cursor = 0usize;
    let mut stopped = false;
    let mut link_limit_reported = false;
    let mut refused_redirect = None;

    while cursor < frontier.len() {
        if pages.len() as u32 >= budget {
            break;
        }
        if cancelled() {
            stopped = true;
            break;
        }
        let (url, level) = frontier[cursor].clone();
        cursor += 1;
        visited += 1;

        let navigated = navigate(window, &url);
        let refused = if visited == 1 { settle_scope(scope) } else { None };
        match navigated {
            Ok(()) => {}
            Err(StepError::Cancelled) => {
                stopped = true;
                break;
            }
            Err(StepError::Failed(_)) if refused.is_some() => {
                refused_redirect = refused;
                break;
            }
            Err(StepError::Failed(err)) => {
                failures.push(format!("{url}: {err}"));
                continue;
            }
        }
        let (scheme, host) = scope_snapshot(scope);
        if !settle_pause() {
            stopped = true;
            break;
        }

        let path = scratch_dir.join(format!("page-{:03}.pdf", pages.len()));
        let final_url = match print_page(
            window,
            &path,
            options,
            scheme.clone(),
            host.clone(),
            local_root.map(Path::to_path_buf),
        ) {
            Ok(final_url) => final_url,
            Err(StepError::Cancelled) => {
                stopped = true;
                break;
            }
            Err(StepError::Failed(err)) => {
                let _ = std::fs::remove_file(&path);
                failures.push(format!("{url}: {err}"));
                continue;
            }
        };
        let title = page_title(window);
        pages.push(CapturedPage {
            url: final_url.clone(),
            title: if title.trim().is_empty() {
                final_url.clone()
            } else {
                title
            },
            path: path.to_string_lossy().to_string(),
        });

        if level < depth {
            match harvest_links(window) {
                Ok(harvested) => {
                    if harvested.truncated && !link_limit_reported {
                        failures.push(format!(
                            "{url}: the page's link list reached its capture limit; some linked pages may be missing"
                        ));
                        link_limit_reported = true;
                    }
                    if enqueue_links(
                        harvested.links,
                        &scheme,
                        &host,
                        local_root,
                        level + 1,
                        budget,
                        &mut seen,
                        &mut frontier,
                    ) && !link_limit_reported
                    {
                        failures.push(format!(
                            "{url}: the crawl's link frontier reached its capture limit; some linked pages may be missing"
                        ));
                        link_limit_reported = true;
                    }
                }
                Err(StepError::Cancelled) => {
                    stopped = true;
                    break;
                }
                Err(StepError::Failed(err)) => failures.push(format!("{url}: {err}")),
            }
        }
    }

    if stopped {
        abandon_navigation(window);
    }

    let mut result = finish(
        capture_id,
        stopped,
        cursor,
        frontier.len(),
        pages,
        visited,
        failures,
    );
    result.refused_redirect = refused_redirect;
    result
}

#[cfg(test)]
mod tests {
    use super::{
        cancelled, cancelled_result, clamp, clear_cancel, decode_harvested_links,
        discard_capture_at, enqueue_links, finish, frontier_cap, link_in_scope, local_file_root,
        same_origin, settle_scope, start_redirect_scope, Arc, CaptureScope, Mutex, REFUSED_DOCUMENTS_CAP, validate_url, window_close_requested, CaptureOptions, CaptureScratch,
        CapturedPage, CAPTURE_LABEL, MAX_DEPTH_CEILING, MAX_PAGES_CEILING,
    };

    fn options(depth: u32, max_pages: u32) -> CaptureOptions {
        CaptureOptions {
            url: String::new(),
            depth,
            max_pages,
            page_width_in: 0.0,
            page_height_in: 0.0,
            orientation: String::new(),
            margin_in: 0.0,
            headers_footers: false,
            backgrounds: false,
            scale: 0.0,
        }
    }

    #[test]
    fn a_bare_host_becomes_https() {
        let (url, scheme, host) = validate_url("example.test/a").unwrap();
        assert_eq!(url, "https://example.test/a");
        assert_eq!(scheme, "https");
        assert_eq!(host, "example.test:443");
    }

    #[test]
    fn only_three_schemes_are_capturable() {
        for raw in ["javascript:alert(1)", "data:text/html,x", "about:blank", "mailto:a@b.test"] {
            assert!(validate_url(raw).is_err(), "{raw} must refuse");
        }
        assert!(validate_url("http://example.test/").is_ok());
        assert!(validate_url("https://example.test/").is_ok());
        assert!(validate_url("file:///c:/tmp/page.html").is_ok());
    }

    #[test]
    fn the_host_ignores_userinfo_and_case() {
        let (_, _, host) = validate_url("HTTPS://User:pw@Example.TEST:8443/x").unwrap();
        assert_eq!(host, "example.test:8443");
    }

    #[test]
    fn same_origin_uses_the_browser_canonical_authority() {
        let (_, scheme, default_port) = validate_url("https://example.test:443/start").unwrap();
        assert_eq!(default_port, "example.test:443");
        assert!(same_origin("https://example.test/next", &scheme, &default_port));

        let (_, scheme, idn) = validate_url("https://bücher.example/start").unwrap();
        assert_eq!(idn, "xn--bcher-kva.example:443");
        assert!(same_origin(
            "https://xn--bcher-kva.example/next",
            &scheme,
            &idn
        ));

        assert!(!same_origin(
            "https://example.test:444/next",
            "https",
            "example.test:443"
        ));
        // Links and later navigations stay in the exact origin; only the
        // start page's first load may move it (`start_redirect_scope`).
        assert!(!same_origin(
            "https://www.example.test/next",
            "https",
            "example.test:443"
        ));
        assert!(!same_origin(
            "https://example.test/next",
            "http",
            "example.test:80"
        ));
    }

    fn moved(scheme: &str, host: &str, target: &str) -> Option<(String, String)> {
        start_redirect_scope(scheme, host, target)
    }

    fn scope(scheme: &str, host: &str) -> Option<(String, String)> {
        Some((scheme.to_string(), host.to_string()))
    }

    #[test]
    fn a_start_redirect_may_upgrade_to_https_on_the_same_host() {
        assert_eq!(
            moved("http", "example.test:80", "https://example.test/"),
            scope("https", "example.test:443")
        );
        assert_eq!(
            moved("http", "example.test:80", "https://example.test:443/a"),
            scope("https", "example.test:443")
        );
        // A non-default port on either side is a different service.
        assert_eq!(moved("http", "example.test:8080", "https://example.test/"), None);
        assert_eq!(moved("http", "example.test:80", "https://example.test:8443/"), None);
        // Never a downgrade.
        assert_eq!(moved("https", "example.test:443", "http://example.test/"), None);
    }

    #[test]
    fn a_start_redirect_may_add_or_remove_a_leading_www() {
        assert_eq!(
            moved("https", "example.test:443", "https://www.example.test/"),
            scope("https", "www.example.test:443")
        );
        assert_eq!(
            moved("https", "www.example.test:443", "https://EXAMPLE.test/"),
            scope("https", "example.test:443")
        );
        assert_eq!(
            moved("http", "localhost:8123", "http://www.localhost:8123/start"),
            scope("http", "www.localhost:8123")
        );
        assert_eq!(
            moved("http", "example.test:80", "https://www.example.test/"),
            scope("https", "www.example.test:443")
        );
        assert_eq!(
            moved("https", "xn--bcher-kva.example:443", "https://www.bücher.example/"),
            scope("https", "www.xn--bcher-kva.example:443")
        );
        // The port is part of the site.
        assert_eq!(moved("http", "localhost:8123", "http://www.localhost:8124/"), None);
    }

    #[test]
    fn a_redirect_chain_is_judged_against_the_original_start() {
        let mut scope = CaptureScope::new("http".into(), "example.test:80".into());
        assert!(scope.admit("http://example.test/", false, None));
        assert!(scope.admit("https://example.test/", true, None));
        assert!(scope.admit("https://www.example.test/", true, None));
        assert!(!scope.admit("https://www.www.example.test/", true, None));
        assert_eq!(scope.refused_host.as_deref(), Some("www.www.example.test"));
        assert!(scope.admit("https://example.test/back", true, None));
        assert!(!scope.admit("http://example.test/", true, None));

        let mut scope = CaptureScope::new("https".into(), "www.example.test:443".into());
        assert!(scope.admit("https://www.example.test/", false, None));
        assert!(scope.admit("https://example.test/", true, None));
        assert!(!scope.admit("https://www.www.www.example.test/", true, None));
    }

    #[test]
    fn only_refused_top_level_targets_block_their_document_request() {
        let mut scope = CaptureScope::new("http".into(), "example.test:80".into());
        assert!(scope.admit("http://example.test/", false, None));
        assert!(!scope.blocks_document("http://example.test/"));
        assert!(!scope.blocks_document("https://cdn.other.test/frame.html"));
        assert!(!scope.admit("https://other.test/landing#top", false, None));
        assert!(scope.blocks_document("https://other.test/landing"));
        assert!(!scope.blocks_document("https://other.test/elsewhere"));

        // A start redirect that moves the scope admits a target an earlier
        // hop refused, and its request goes out again.
        let mut scope = CaptureScope::new("http".into(), "example.test:80".into());
        assert!(scope.admit("http://example.test/", false, None));
        assert!(!scope.admit("http://www.example.test/", false, None));
        assert!(scope.blocks_document("http://www.example.test/"));
        scope.settled = false;
        assert!(scope.admit("http://www.example.test/", true, None));
        assert!(!scope.blocks_document("http://www.example.test/"));
    }

    #[test]
    fn refused_document_keys_are_the_browser_spelling_less_the_fragment() {
        let mut scope = CaptureScope::new("http".into(), "example.test:80".into());
        assert!(scope.admit("http://example.test/", false, None));
        let target = "https://other.test/a%20b/'|^`?q='|^`#frag'|";
        assert!(!scope.admit(target, false, None));
        assert!(scope.blocks_document("https://other.test/a%20b/'|^`?q='|^`"));
        assert!(!scope.blocks_document("https://other.test/a%20b/%27%7C%5E%60?q='|^`"));
    }

    #[test]
    fn refused_documents_are_capped_oldest_first() {
        let mut scope = CaptureScope::new("http".into(), "example.test:80".into());
        assert!(scope.admit("http://example.test/", false, None));
        for i in 0..=REFUSED_DOCUMENTS_CAP {
            assert!(!scope.admit(&format!("https://other.test/{i}"), false, None));
        }
        assert_eq!(scope.refused_documents.len(), REFUSED_DOCUMENTS_CAP);
        assert_eq!(scope.refused_order.len(), REFUSED_DOCUMENTS_CAP);
        assert!(!scope.blocks_document("https://other.test/0"));
        assert!(scope.blocks_document("https://other.test/1"));
        assert!(scope.blocks_document(&format!("https://other.test/{REFUSED_DOCUMENTS_CAP}")));
        // A repeat refusal does not grow the record.
        assert!(!scope.admit("https://other.test/1", false, None));
        assert_eq!(scope.refused_order.len(), REFUSED_DOCUMENTS_CAP);
    }

    #[test]
    fn an_unreadable_refused_target_blocks_documents_until_an_admission() {
        let mut scope = CaptureScope::new("http".into(), "example.test:80".into());
        assert!(scope.admit("http://example.test/", false, None));
        scope.refuse_unknown();
        assert!(scope.blocks_document("https://anything.test/"));
        assert!(scope.blocks_document("http://example.test/next"));
        assert!(scope.admit("http://example.test/next", false, None));
        assert!(!scope.blocks_document("https://anything.test/"));
    }

    #[test]
    fn a_script_navigation_off_site_during_the_first_load_names_its_host() {
        let scope = Arc::new(Mutex::new(CaptureScope::new(
            "https".into(),
            "example.test:443".into(),
        )));
        {
            let mut guard = scope.lock().unwrap();
            assert!(guard.admit("https://example.test/", false, None));
            assert!(!guard.admit("https://evil.test/landing", false, None));
            // A script navigation is never a redirect, so it cannot move the scope.
            assert!(!guard.admit("https://www.example.test/", true, None));
        }
        assert_eq!(settle_scope(&scope).as_deref(), Some("www.example.test"));
        let mut guard = scope.lock().unwrap();
        guard.refused_host = None;
        assert!(!guard.admit("https://later.test/", false, None));
        assert_eq!(guard.refused_host, None, "only the first load is reported");
    }

    #[test]
    fn a_start_redirect_to_another_site_is_refused() {
        for target in [
            "https://evil.test/",
            "https://example.test.evil.test/",
            "https://wwwexample.test/",
            "https://www.www.example.test/",
            "https://shop.example.test/",
            "https://www.evil.test/",
            "http://127.0.0.1/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
        ] {
            assert_eq!(moved("https", "example.test:443", target), None, "{target}");
        }
        // A bare `www` is not the apex of anything.
        assert_eq!(moved("https", "www:443", "https://www./"), None);
        assert_eq!(moved("file", "", "file:///C:/other.html"), None);
    }

    #[test]
    fn a_crawl_cannot_leave_its_origin() {
        assert!(same_origin(
            "https://example.test/b",
            "https",
            "example.test:443"
        ));
        assert!(!same_origin(
            "https://other.test/b",
            "https",
            "example.test:443"
        ));
        // Scheme too: an https start must not follow http.
        assert!(!same_origin(
            "http://example.test/b",
            "https",
            "example.test:443"
        ));
        assert!(!same_origin("javascript:void(0)", "https", "example.test"));
        // File URLs have no host, but they do not share one filesystem-wide origin.
        assert!(!same_origin("file:///C:/Users/Public/secret.pdf", "file", ""));
    }

    #[test]
    fn redirected_targets_are_checked_against_the_start_scope() {
        assert!(link_in_scope(
            "https://example.test/final",
            "https",
            "example.test:443",
            None
        ));
        assert!(!link_in_scope(
            "https://other.test/final",
            "https",
            "example.test:443",
            None
        ));
        assert!(!link_in_scope(
            "http://example.test/final",
            "https",
            "example.test:443",
            None
        ));
        assert!(!link_in_scope(
            "https://example.test:444/final",
            "https",
            "example.test:443",
            None
        ));

        let temp = tempfile::tempdir().unwrap();
        let site = temp.path().join("site");
        let outside = temp.path().join("outside.html");
        std::fs::create_dir_all(&site).unwrap();
        let inside = site.join("final.html");
        std::fs::write(&inside, "inside").unwrap();
        std::fs::write(&outside, "outside").unwrap();
        let root = std::fs::canonicalize(&site).unwrap();
        let inside_url = url::Url::from_file_path(&inside).unwrap().to_string();
        let outside_url = url::Url::from_file_path(&outside).unwrap().to_string();
        assert!(link_in_scope(&inside_url, "file", "", Some(&root)));
        assert!(!link_in_scope(&outside_url, "file", "", Some(&root)));
    }

    #[test]
    fn depth_and_budget_are_clamped_not_trusted() {
        assert_eq!(clamp(&options(99, 9999)), (MAX_DEPTH_CEILING, MAX_PAGES_CEILING));
        // A zero budget still captures the page the user asked for.
        assert_eq!(clamp(&options(0, 0)), (0, 1));
        assert_eq!(clamp(&options(1, 12)), (1, 12));
    }

    #[test]
    fn an_address_with_no_page_refuses() {
        assert!(validate_url("").is_err());
        assert!(validate_url("https://").is_err());
    }

    #[test]
    fn the_frontier_admits_only_unseen_same_origin_links() {
        let mut seen = vec!["https://example.test/a".to_string()];
        let mut frontier = Vec::new();
        assert!(!enqueue_links(
            [
                "https://example.test/b",
                "https://example.test/a", // Already queued.
                "https://other.test/b",   // Another site.
                "http://example.test/b",  // Downgraded transport.
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            "https",
            "example.test:443",
            None,
            1,
            10,
            &mut seen,
            &mut frontier,
        ));
        assert_eq!(seen, ["https://example.test/a", "https://example.test/b"]);
        assert_eq!(frontier, [("https://example.test/b".to_string(), 1)]);

        // A full frontier refuses another legal link and reports the loss.
        let mut full: Vec<String> = (0..frontier_cap(10))
            .map(|i| format!("https://example.test/{i}"))
            .collect();
        let mut no_room = Vec::new();
        assert!(enqueue_links(
            vec!["https://example.test/overflow".to_string()],
            "https",
            "example.test:443",
            None,
            1,
            10,
            &mut full,
            &mut no_room,
        ));
        assert!(no_room.is_empty());
    }

    #[test]
    fn link_harvest_reports_capped_and_malformed_results() {
        let payload = r#"{"links":["https://example.test/next"],"truncated":true}"#;
        let raw = serde_json::to_string(payload).unwrap();
        let harvested = decode_harvested_links(&raw).unwrap();
        assert_eq!(harvested.links, ["https://example.test/next"]);
        assert!(harvested.truncated);
        assert!(decode_harvested_links("not json").is_err());
        assert!(decode_harvested_links("\"[]\"").is_err());
    }

    #[test]
    fn an_omitted_eligible_link_marks_the_crawl_truncated() {
        let mut seen: Vec<String> = (0..frontier_cap(10))
            .map(|i| format!("https://example.test/{i}"))
            .collect();
        let mut frontier = Vec::new();
        assert!(enqueue_links(
            vec!["https://example.test/omitted".to_string()],
            "https",
            "example.test:443",
            None,
            1,
            10,
            &mut seen,
            &mut frontier,
        ));
        assert!(frontier.is_empty());

        // Out-of-scope links do not claim the crawl lost an eligible page.
        assert!(!enqueue_links(
            vec!["https://other.test/".to_string()],
            "https",
            "example.test:443",
            None,
            1,
            10,
            &mut seen,
            &mut frontier,
        ));
    }

    #[test]
    fn a_local_file_crawl_stays_under_the_starting_page_folder() {
        let temp = tempfile::tempdir().unwrap();
        let site = temp.path().join("site");
        std::fs::create_dir_all(site.join("nested")).unwrap();
        let start = site.join("index.html");
        let inside = site.join("nested").join("page.html");
        let outside = temp.path().join("private.html");
        std::fs::write(&start, "start").unwrap();
        std::fs::write(&inside, "inside").unwrap();
        std::fs::write(&outside, "private").unwrap();

        let start_url = url::Url::from_file_path(&start).unwrap().to_string();
        let inside_url = url::Url::from_file_path(&inside).unwrap().to_string();
        let outside_url = url::Url::from_file_path(&outside).unwrap().to_string();
        let case_variant_url = inside_url.replace("/site/", "/SITE/");
        let root = local_file_root(&start_url).unwrap();
        let mut seen = vec![start_url];
        let mut frontier = Vec::new();

        assert!(!enqueue_links(
            vec![inside_url.clone()],
            "file",
            "",
            Some(&root),
            1,
            10,
            &mut seen,
            &mut frontier,
        ));
        assert_eq!(frontier[0].0, inside_url);
        assert!(!enqueue_links(
            vec![case_variant_url],
            "file",
            "",
            Some(&root),
            1,
            10,
            &mut seen,
            &mut frontier,
        ));
        assert!(!enqueue_links(
            vec![outside_url.clone()],
            "file",
            "",
            Some(&root),
            1,
            10,
            &mut seen,
            &mut frontier,
        ));
        assert!(!enqueue_links(
            vec![outside_url],
            "file",
            "",
            None,
            1,
            10,
            &mut seen,
            &mut frontier,
        ));
    }

    #[test]
    fn only_the_capture_windows_close_cancels_a_capture() {
        // One test rather than several: the flag is process-wide, so a second
        // test asserting on it would race this one.
        clear_cancel();
        window_close_requested("main");
        window_close_requested("doc-1");
        assert!(!cancelled(), "a workspace close must not cancel a capture");

        window_close_requested(CAPTURE_LABEL);
        assert!(cancelled(), "the capture window's close is the cancel");

        clear_cancel();
        assert!(!cancelled(), "a new capture starts uncancelled");
    }

    #[test]
    fn a_cancelled_capture_is_neither_truncated_nor_a_failure() {
        let result = cancelled_result(uuid::Uuid::new_v4().to_string());
        assert!(result.cancelled);
        // Truncation names a run that hit the page limit, and a failure list
        // names pages that could not be captured. A cancel is neither.
        assert!(!result.truncated);
        assert!(result.failures.is_empty());
        assert!(result.pages.is_empty());
        assert_eq!(result.visited, 0);
    }

    #[test]
    fn a_stopped_run_is_never_reported_as_truncated() {
        let page = |url: &str| CapturedPage {
            url: url.to_string(),
            title: url.to_string(),
            path: String::new(),
        };
        // Frontier left over and NOT stopped: that is truncation.
        let hit_limit = finish(
            "capture".to_string(),
            false,
            2,
            9,
            vec![page("a"), page("b")],
            2,
            Vec::new(),
        );
        assert!(hit_limit.truncated);
        assert!(!hit_limit.cancelled);

        // The same leftover frontier, stopped: cancelled, never truncated.
        let stopped = finish(
            "capture".to_string(),
            true,
            2,
            9,
            vec![page("a"), page("b")],
            2,
            Vec::new(),
        );
        assert!(stopped.cancelled);
        assert!(!stopped.truncated);

        // Nothing left over and not stopped: a complete run.
        let complete = finish(
            "capture".to_string(),
            false,
            3,
            3,
            vec![page("a")],
            3,
            Vec::new(),
        );
        assert!(!complete.truncated);
        assert!(!complete.cancelled);
    }

    #[test]
    fn capture_scratch_is_unique_and_removed_unless_retained() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("web-capture");
        let first = CaptureScratch::new_at(&root, 4100).unwrap();
        let first_dir = first.dir.clone();
        std::fs::write(first.dir.join("page-000.pdf"), b"first").unwrap();

        let mut second = CaptureScratch::new_at(&root, 4100).unwrap();
        let second_dir = second.dir.clone();
        let second_id = second.capture_id();
        assert_ne!(first_dir, second_dir);
        assert!(first_dir
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .ends_with(".4100"));

        drop(first);
        assert!(!first_dir.exists(), "an unretained run cleans its partial output");
        std::fs::write(second.dir.join("page-000.pdf"), b"second").unwrap();
        second.retain();
        drop(second);
        assert!(second_dir.exists(), "a completed run stays available to Create PDF");

        assert!(discard_capture_at(&root, "../outside", 4100).is_err());
        assert!(discard_capture_at(&root, &second_id, 4101).is_ok());
        assert!(second_dir.exists(), "one process cannot release another PID's run");
        discard_capture_at(&root, &second_id, 4100).unwrap();
        assert!(!second_dir.exists());
    }
}
