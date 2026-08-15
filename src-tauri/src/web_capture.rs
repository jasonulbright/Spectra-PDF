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
//!   * a page budget bounds the run absolutely, and a truncated run SAYS so.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
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
const CAPTURE_LABEL: &str = "web-capture";

/// How long one navigation may take before the capture refuses. Generous: a
/// cold DNS lookup plus a heavy page is seconds, and a refusal here costs the
/// user the whole capture.
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(90);
/// How long `PrintToPdf` may take for one page.
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the link harvest may take.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(20);
/// Settling time after `NavigationCompleted` before printing — late webfonts
/// and lazy images land in this window, and printing at the instant of
/// navigation-complete captures a page mid-layout.
const SETTLE: Duration = Duration::from_millis(1200);

/// The absolute ceiling on a crawl, whatever the caller asks for.
pub const MAX_PAGES_CEILING: u32 = 100;
pub const MAX_DEPTH_CEILING: u32 = 3;

static CAPTURING: AtomicBool = AtomicBool::new(false);

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

/// Everything the capture does with the live WebView2, kept in one place so
/// the COM types never leak into the crawl loop.
struct Capture {
    webview: ICoreWebView2_7,
    settings: ICoreWebView2PrintSettings,
}

impl Capture {
    /// Navigate, and wait for the navigation to complete.
    fn navigate(&self, url: &str) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let mut token = Default::default();
        let handler = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
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
            Ok(())
        }));
        unsafe { self.webview.add_NavigationCompleted(&handler, &mut token) }
            .map_err(|e| format!("Could not watch the capture window: {e}"))?;
        let result = (|| {
            let target = HSTRING::from(url);
            unsafe { self.webview.Navigate(PCWSTR(target.as_ptr())) }
                .map_err(|e| format!("Could not open {url}: {e}"))?;
            pump_until(&rx, NAVIGATION_TIMEOUT)
                .unwrap_or_else(|| Err(format!("{url} did not finish loading in time")))
        })();
        let _ = unsafe { self.webview.remove_NavigationCompleted(token) };
        result
    }

    fn title(&self) -> String {
        let mut raw = PWSTR::null();
        if unsafe { self.webview.DocumentTitle(&mut raw) }.is_err() {
            return String::new();
        }
        take_pwstr(raw)
    }

    fn print_to(&self, path: &std::path::Path) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
            let outcome = if hr.is_ok() && ok {
                Ok(())
            } else {
                Err("the page could not be rendered to PDF".to_string())
            };
            let _ = tx.send(outcome);
            Ok(())
        }));
        let target = HSTRING::from(path.to_string_lossy().as_ref());
        unsafe {
            self.webview
                .PrintToPdf(PCWSTR(target.as_ptr()), &self.settings, &handler)
        }
        .map_err(|e| format!("Could not render the page to PDF: {e}"))?;
        pump_until(&rx, PRINT_TIMEOUT)
            .unwrap_or_else(|| Err("the page did not finish rendering in time".to_string()))?;
        if !path.is_file() {
            return Err("the capture produced no PDF".to_string());
        }
        Ok(())
    }

    /// Same-document links, in document order, de-duplicated by the script so
    /// the frontier does not carry a hundred copies of a nav bar.
    fn links(&self) -> Vec<String> {
        let (tx, rx) = mpsc::channel::<String>();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_, json| {
            let _ = tx.send(json.to_string());
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
        if unsafe { self.webview.ExecuteScript(PCWSTR(script.as_ptr()), &handler) }.is_err() {
            return Vec::new();
        }
        let Some(raw) = pump_until(&rx, SCRIPT_TIMEOUT) else {
            return Vec::new();
        };
        // ExecuteScript returns the result as JSON, so a string result
        // arrives JSON-encoded twice.
        let once: String = match serde_json::from_str(&raw) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        serde_json::from_str::<Vec<String>>(&once).unwrap_or_default()
    }
}

/// Run the Windows message loop until `rx` produces or the deadline passes.
///
/// A blocking `recv` would deadlock: every WebView2 callback is delivered on
/// this same thread's message queue, so the thread that waits must also pump.
fn pump_until<T>(rx: &mpsc::Receiver<T>, timeout: Duration) -> Option<T> {
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Ok(value) = rx.try_recv() {
            return Some(value);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        let mut msg = MSG::default();
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
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
    let result = run_capture(&app, options, start, scheme, host, depth, budget).await;
    CAPTURING.store(false, Ordering::SeqCst);
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

    let (tx, rx) = std::sync::mpsc::channel::<Result<CaptureResult, String>>();
    let sender = tx.clone();
    let opts = options.clone();
    window
        .with_webview(move |platform| {
            let outcome = (|| -> Result<CaptureResult, String> {
                let controller = platform.controller();
                let environment = platform.environment();
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|e| format!("The capture window has no browser: {e}"))?;
                // The interface PrintToPdf lives on. No version is pinned
                // (the standing rule); the cast is attempted and its failure
                // is a NAMED refusal, never a silent blank capture.
                let webview: ICoreWebView2_7 = core.cast().map_err(|_| {
                    "This machine's web runtime is too old to render a page to PDF".to_string()
                })?;
                let environment6: ICoreWebView2Environment6 = environment.cast().map_err(|_| {
                    "This machine's web runtime is too old to render a page to PDF".to_string()
                })?;
                let settings = build_settings(&environment6, &opts)?;
                let capture = Capture { webview, settings };
                Ok(crawl(&capture, &start, &scheme, &host, depth, budget))
            })();
            let _ = sender.send(outcome);
        })
        .map_err(|e| format!("Could not reach the capture window: {e}"))?;

    // `with_webview` runs the closure on the main thread; this command is
    // async and runs off it, so a blocking receive here is correct and does
    // not starve the callbacks the closure pumps for itself.
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(NAVIGATION_TIMEOUT + PRINT_TIMEOUT + Duration::from_secs(30))
    })
    .await
    .map_err(|e| format!("The capture did not run: {e}"))?
    .map_err(|_| "The capture did not start in time".to_string())??;

    if result.pages.is_empty() {
        let detail = result
            .failures
            .first()
            .cloned()
            .unwrap_or_else(|| "nothing could be captured".to_string());
        return Err(detail);
    }
    Ok(result)
}

/// Breadth-first over the same origin, one window navigated in turn.
fn crawl(
    capture: &Capture,
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

    while cursor < frontier.len() {
        if pages.len() as u32 >= budget {
            break;
        }
        let (url, level) = frontier[cursor].clone();
        cursor += 1;
        visited += 1;

        if let Err(err) = capture.navigate(&url) {
            failures.push(format!("{url}: {err}"));
            continue;
        }
        // Late webfonts and lazy images land here; printing at the instant of
        // navigation-complete captures a page mid-layout.
        std::thread::sleep(SETTLE);

        let path = match scratch_path(pages.len()) {
            Ok(p) => p,
            Err(err) => {
                failures.push(format!("{url}: {err}"));
                continue;
            }
        };
        if let Err(err) = capture.print_to(&path) {
            failures.push(format!("{url}: {err}"));
            continue;
        }
        let title = capture.title();
        pages.push(CapturedPage {
            url: url.clone(),
            title: if title.trim().is_empty() { url.clone() } else { title },
            path: path.to_string_lossy().to_string(),
        });

        if level < depth {
            for link in capture.links() {
                if seen.len() as u32 >= budget * 4 + 16 {
                    break;
                }
                if !same_origin(&link, scheme, host) || seen.iter().any(|s| s == &link) {
                    continue;
                }
                seen.push(link.clone());
                frontier.push((link, level + 1));
            }
        }
    }

    CaptureResult {
        truncated: cursor < frontier.len(),
        pages,
        visited,
        failures,
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp, same_origin, validate_url, CaptureOptions, MAX_DEPTH_CEILING,
                MAX_PAGES_CEILING};

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
}
