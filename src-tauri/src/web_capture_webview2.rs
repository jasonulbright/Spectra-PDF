//! Web capture's browser half on Windows: WebView2's
//! `ICoreWebView2_7::PrintToPdf`, which is Chromium's own print pipeline. No
//! new dependency: `webview2-com` is already in the tree at the version tauri
//! resolves, and the live controller comes from Tauri's `PlatformWebview`.

use std::cell::Cell;
use std::ffi::c_void;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use tauri::WebviewWindow;
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

use super::{
    decode_harvested_links, link_in_scope, request_cancel, wait_step, CaptureOptions,
    HarvestedLinks, SharedScope, StepError, CAPTURING, DISPATCH_TIMEOUT, NAVIGATION_TIMEOUT,
    PRINT_TIMEOUT, SCRIPT_TIMEOUT,
};

/// `PrintToPdf` draws the header and footer itself.
pub(super) const DRAWS_HEADERS_FOOTERS: bool = true;

/// Make the capture window's close cancel the capture. The subclass goes on
/// from the window's own thread, and ahead of every step: both are messages
/// to that thread, delivered in the order sent.
pub(super) fn watch_close(window: &WebviewWindow) {
    let hwnd = window.hwnd().map(|h| h.0 as usize).unwrap_or(0);
    let _ = window.with_webview(move |_| watch_close_hwnd(hwnd));
}

/// Reach the browser once before the crawl, so a runtime that cannot render
/// to PDF refuses BY NAME rather than as a page that failed to print.
pub(super) fn ready(window: &WebviewWindow) -> Result<(), StepError> {
    run_step(
        window,
        DISPATCH_TIMEOUT,
        "The capture window did not answer in time",
        |_, tx| {
            let _ = tx.send(Ok(()));
            Ok(())
        },
    )
}

/// Identifies this module's window subclass on the capture window.
const CLOSE_WATCH_ID: usize = 1;

const RUNTIME_TOO_OLD: &str = "This machine's web runtime is too old to render a page to PDF";

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
pub(super) fn watch_close_hwnd(hwnd: usize) {
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

/// The live browser interfaces, for the length of one step.
///
/// COM pointers into the window's single-threaded apartment: not `Send`, so
/// they cannot be carried across dispatches and are taken fresh on the
/// window's own thread each time. Nothing here outlives the dispatch that
/// acquired it, which is what makes destroying the window safe at any moment
/// the window's thread is not inside a step.
pub(super) struct Browser {
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
pub(super) fn run_step<T, F>(
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
pub(super) fn guard_navigation_scope(
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

/// Navigate, and wait for the navigation to complete.
pub(super) fn navigate(window: &WebviewWindow, url: &str) -> Result<(), StepError> {
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
pub(super) fn print_page(
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
pub(super) fn harvest_links(window: &WebviewWindow) -> Result<HarvestedLinks, StepError> {
    let raw = run_step(
        window,
        SCRIPT_TIMEOUT,
        "the page's links did not arrive in time",
        move |browser, tx| {
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_, json| {
                let _ = tx.send(Ok(json.to_string()));
                Ok(())
            }));
            let script: HSTRING = HSTRING::from(super::LINK_HARVEST_SCRIPT);
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

pub(super) fn page_title(window: &WebviewWindow) -> String {
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
pub(super) fn abandon_navigation(window: &WebviewWindow) {
    let _ = window.with_webview(|platform| {
        if let Ok(browser) = Browser::acquire(&platform) {
            let _ = unsafe { browser.webview.Stop() };
        }
    });
}

pub(super) fn build_settings(
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
