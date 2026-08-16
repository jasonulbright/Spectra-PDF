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
//!   * a crawl follows only links whose HOST AND SCHEME match the start, so a
//!     capture of one site cannot walk onto another;
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
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_7,
    COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    COREWEBVIEW2_WEB_ERROR_STATUS,
};
use webview2_com::{
    take_pwstr, ExecuteScriptCompletedHandler, NavigationCompletedEventHandler,
    PrintToPdfCompletedHandler,
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
pub struct CaptureResult {
    pub pages: Vec<CapturedPage>,
    /// How many URLs were reached, including any that failed.
    pub visited: usize,
    /// The frontier still had URLs when the budget ran out.
    pub truncated: bool,
    /// The capture window was closed before the run finished. Structured
    /// rather than an error string: a cancelled run is not a failure, and the
    /// caller decides what to say about it without matching on message text.
    pub cancelled: bool,
    /// Per-URL failures. A capture that lost a page SAYS which one.
    pub failures: Vec<String>,
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
    let (scheme, rest) = candidate
        .split_once(':')
        .ok_or_else(|| format!("{trimmed} is not a web address"))?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "file") {
        return Err(format!(
            "Only http, https and file addresses can be captured, not {scheme}"
        ));
    }
    let after = rest.trim_start_matches('/');
    if after.is_empty() {
        return Err(format!("{trimmed} names no page to capture"));
    }
    // The host is what the dialog SHOWS before the capture runs, and what a
    // crawl is confined to. A file: URL has no host and is its own origin.
    let host = if scheme == "file" {
        String::new()
    } else {
        let authority = after.split(['/', '?', '#']).next().unwrap_or("");
        let authority = authority.rsplit('@').next().unwrap_or(authority);
        if authority.is_empty() {
            return Err(format!("{trimmed} names no host"));
        }
        authority.to_ascii_lowercase()
    };
    Ok((candidate, scheme, host))
}

/// Is `candidate` in the same origin as the capture's start?
///
/// Host AND scheme, both. A crawl that followed http from an https start
/// would silently downgrade the transport for every page after the first.
pub fn same_origin(candidate: &str, scheme: &str, host: &str) -> bool {
    match validate_url(candidate) {
        Ok((_, s, h)) => s == scheme && h == host,
        Err(_) => false,
    }
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

/// Whether a harvested link joins the frontier.
fn admits(link: &str, scheme: &str, host: &str, seen: &[String], budget: u32) -> bool {
    if seen.len() as u32 >= frontier_cap(budget) {
        return false;
    }
    same_origin(link, scheme, host) && !seen.iter().any(|s| s == link)
}

fn scratch_path(index: usize) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("spectrapdf").join("web-capture");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create the capture scratch folder: {e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("capture-{stamp}-{index:03}.pdf")))
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
) -> Result<(), StepError> {
    let target = path.to_path_buf();
    let opts = options.clone();
    run_step(
        window,
        PRINT_TIMEOUT,
        "the page did not finish rendering in time",
        move |browser, tx| {
            let settings = build_settings(&browser.environment, &opts)?;
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
                let _ = tx.send(outcome);
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
    Ok(())
}

/// Same-document links, in document order, de-duplicated by the script so the
/// frontier does not carry a hundred copies of a nav bar.
fn harvest_links(window: &WebviewWindow) -> Vec<String> {
    let outcome = run_step(
        window,
        SCRIPT_TIMEOUT,
        "the page's links did not arrive in time",
        move |browser, tx| {
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_, json| {
                let _ = tx.send(Ok(json.to_string()));
                Ok(())
            }));
            let script: HSTRING = HSTRING::from(
                "(function(){var s=new Set(),o=[];\
                 for (const a of document.querySelectorAll('a[href]')) {\
                   let h; try { h = new URL(a.href, document.baseURI).href; } catch (e) { continue; }\
                   h = h.split('#')[0];\
                   if (!h || s.has(h)) continue; s.add(h); o.push(h);\
                   if (o.length >= 400) break;\
                 } return JSON.stringify(o);})()",
            );
            unsafe { browser.webview.ExecuteScript(PCWSTR(script.as_ptr()), &handler) }
                .map_err(|e| format!("Could not read the page's links: {e}"))?;
            Ok(())
        },
    );
    let Ok(raw) = outcome else {
        return Vec::new();
    };
    // ExecuteScript returns the result as JSON, so a string result arrives
    // JSON-encoded twice.
    let once: String = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<String>>(&once).unwrap_or_default()
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
    let (depth, budget) = clamp(&options);

    if CAPTURING.swap(true, Ordering::SeqCst) {
        return Err("A capture is already running".to_string());
    }
    // A close seen while no capture was running must not cancel this one.
    clear_cancel();
    let result = run_capture(&app, options, start, scheme, host, depth, budget).await;
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
    depth: u32,
    budget: u32,
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

    let worker = window.clone();
    let opts = options.clone();
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
            Err(StepError::Cancelled) => return Ok(cancelled_result()),
            Err(StepError::Failed(err)) => return Err(err),
        }
        Ok(crawl(&worker, &opts, &start, &scheme, &host, depth, budget))
    })
    .await
    .map_err(|e| format!("The capture did not run: {e}"))?;

    let result = outcome?;
    // A cancelled run reports itself rather than refusing: the refusal below
    // names a capture that was tried and produced nothing, which is a
    // different thing from one that was stopped.
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
fn cancelled_result() -> CaptureResult {
    finish(true, 0, 0, Vec::new(), 0, Vec::new())
}

/// Assemble the run's verdict. Apart from the loop so the relationship between
/// stopping, truncation and failure is stated in one place: a cancelled run
/// did not reach the page limit, and saying it did reports the wrong reason
/// for a short capture.
fn finish(
    stopped: bool,
    cursor: usize,
    frontier: usize,
    pages: Vec<CapturedPage>,
    visited: usize,
    failures: Vec<String>,
) -> CaptureResult {
    CaptureResult {
        truncated: !stopped && cursor < frontier,
        cancelled: stopped,
        pages,
        visited,
        failures,
    }
}

/// Breadth-first over the same origin, one window navigated in turn.
#[allow(clippy::too_many_arguments)]
fn crawl(
    window: &WebviewWindow,
    options: &CaptureOptions,
    start: &str,
    scheme: &str,
    host: &str,
    depth: u32,
    budget: u32,
) -> CaptureResult {
    let mut seen: Vec<String> = vec![start.to_string()];
    let mut frontier: Vec<(String, u32)> = vec![(start.to_string(), 0)];
    let mut pages: Vec<CapturedPage> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    let mut visited = 0usize;
    let mut cursor = 0usize;
    let mut stopped = false;

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

        match navigate(window, &url) {
            Ok(()) => {}
            Err(StepError::Cancelled) => {
                stopped = true;
                break;
            }
            Err(StepError::Failed(err)) => {
                failures.push(format!("{url}: {err}"));
                continue;
            }
        }
        if !settle_pause() {
            stopped = true;
            break;
        }

        let path = match scratch_path(pages.len()) {
            Ok(p) => p,
            Err(err) => {
                failures.push(format!("{url}: {err}"));
                continue;
            }
        };
        match print_page(window, &path, options) {
            Ok(()) => {}
            Err(StepError::Cancelled) => {
                stopped = true;
                break;
            }
            Err(StepError::Failed(err)) => {
                failures.push(format!("{url}: {err}"));
                continue;
            }
        }
        let title = page_title(window);
        pages.push(CapturedPage {
            url: url.clone(),
            title: if title.trim().is_empty() { url.clone() } else { title },
            path: path.to_string_lossy().to_string(),
        });

        if level < depth {
            for link in harvest_links(window) {
                if !admits(&link, scheme, host, &seen, budget) {
                    continue;
                }
                seen.push(link.clone());
                frontier.push((link, level + 1));
            }
        }
    }

    if stopped {
        abandon_navigation(window);
    }

    finish(stopped, cursor, frontier.len(), pages, visited, failures)
}

#[cfg(test)]
mod tests {
    use super::{admits, cancelled, cancelled_result, clamp, clear_cancel, finish, frontier_cap,
                same_origin, validate_url, window_close_requested, CaptureOptions, CapturedPage,
                CAPTURE_LABEL, MAX_DEPTH_CEILING, MAX_PAGES_CEILING};

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
        assert_eq!(host, "example.test");
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
    fn a_crawl_cannot_leave_its_origin() {
        assert!(same_origin("https://example.test/b", "https", "example.test"));
        assert!(!same_origin("https://other.test/b", "https", "example.test"));
        // Scheme too: an https start must not follow http.
        assert!(!same_origin("http://example.test/b", "https", "example.test"));
        assert!(!same_origin("javascript:void(0)", "https", "example.test"));
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
        let seen = vec!["https://example.test/a".to_string()];
        assert!(admits("https://example.test/b", "https", "example.test", &seen, 10));
        // Already queued.
        assert!(!admits("https://example.test/a", "https", "example.test", &seen, 10));
        // Another site, and a downgraded transport.
        assert!(!admits("https://other.test/b", "https", "example.test", &seen, 10));
        assert!(!admits("http://example.test/b", "https", "example.test", &seen, 10));
        // A full frontier admits nothing, however legal the link.
        let full: Vec<String> = (0..frontier_cap(10)).map(|i| format!("u{i}")).collect();
        assert!(!admits("https://example.test/b", "https", "example.test", &full, 10));
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
        let result = cancelled_result();
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
        let hit_limit = finish(false, 2, 9, vec![page("a"), page("b")], 2, Vec::new());
        assert!(hit_limit.truncated);
        assert!(!hit_limit.cancelled);

        // The same leftover frontier, stopped: cancelled, never truncated.
        let stopped = finish(true, 2, 9, vec![page("a"), page("b")], 2, Vec::new());
        assert!(stopped.cancelled);
        assert!(!stopped.truncated);

        // Nothing left over and not stopped: a complete run.
        let complete = finish(false, 3, 3, vec![page("a")], 3, Vec::new());
        assert!(!complete.truncated);
        assert!(!complete.cancelled);
    }
}
