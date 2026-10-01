//! Web capture's browser half on Linux: WebKitGTK's print operation, sent to
//! the toolkit's print-to-file backend as PDF. No new dependency: `gtk` and
//! `webkit2gtk` are the versions wry links, and the live view comes from
//! Tauri's `PlatformWebview`.
//!
//! Scope differs from WebView2 in one way that matters: WebKit asks the
//! navigation policy BEFORE it sends a top-level request, redirects
//! included, so an ignored decision issues no request and no separate
//! request filter is needed. A navigation the policy refuses produces no
//! load event, so the refusal itself answers a waiting navigation.
//!
//! Every GTK and WebKit object here lives on the main thread. The worker
//! thread only waits: each step is dispatched through `with_webview` and its
//! completion arrives on a channel, as on Windows.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;
use java_script_core::ValueExt;
use tauri::{WebviewWindow, WindowEvent};
use webkit2gtk::{
    LoadEvent, NavigationPolicyDecision, NavigationPolicyDecisionExt, PolicyDecisionExt,
    PolicyDecisionType, PrintOperation, PrintOperationExt, SettingsExt, URIRequestExt, WebView,
    WebViewExt,
};

use super::{
    decode_link_list, link_in_scope, request_cancel, wait_step, CaptureOptions, HarvestedLinks,
    SharedScope, StepError, CAPTURING, DISPATCH_TIMEOUT, NAVIGATION_TIMEOUT, PRINT_TIMEOUT,
    SCRIPT_TIMEOUT,
};

/// The GTK print backend that writes a file instead of spooling to a printer.
const PRINT_TO_FILE: &str = "Print to File";

/// GTK's print operation has no header or footer of its own, so a capture that
/// asks for them is stamped after printing (see `CaptureResult`).
pub(super) const DRAWS_HEADERS_FOOTERS: bool = false;

thread_local! {
    /// The navigation a `navigate` step is waiting for. One capture runs at a
    /// time, so one slot is enough; a load event with no waiter is a script
    /// navigation during settle and answers nobody.
    static PENDING_LOAD: RefCell<Option<mpsc::Sender<Result<(), String>>>> =
        const { RefCell::new(None) };
    /// The print operation in flight. WebKit holds no reference of its own
    /// across the asynchronous print, so the operation lives here until its
    /// `finished` signal.
    static PRINTING: RefCell<Option<PrintOperation>> = const { RefCell::new(None) };
}

fn answer_load(outcome: Result<(), String>) {
    if let Some(tx) = PENDING_LOAD.with(|slot| slot.borrow_mut().take()) {
        let _ = tx.send(outcome);
    }
}

/// Start one browser call on the main thread, and wait for it HERE.
fn run_step<T, F>(
    window: &WebviewWindow,
    timeout: Duration,
    timed_out: &str,
    start: F,
) -> Result<T, StepError>
where
    T: Send + 'static,
    F: FnOnce(&WebView, mpsc::Sender<Result<T, String>>) -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Result<T, String>>();
    let refused = tx.clone();
    window
        .with_webview(move |platform| {
            let webview = platform.inner();
            if let Err(err) = start(&webview, tx) {
                let _ = refused.send(Err(err));
            }
        })
        .map_err(|e| StepError::Failed(format!("Could not reach the capture window: {e}")))?;
    wait_step(&rx, timeout, timed_out)
}

/// Make the capture window's close cancel the capture. Held open while a
/// capture is in flight: the capture destroys the window on the way out, so
/// the default close must not race that with a teardown of its own.
pub(super) fn watch_close(window: &WebviewWindow) {
    window.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if CAPTURING.load(Ordering::SeqCst) {
                request_cancel();
                api.prevent_close();
            }
        }
    });
}

/// Reach the browser once before the crawl.
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

/// Block every `decide-policy` handler already on the capture view.
///
/// The webview layer connects its own handler when it builds the view. That
/// handler answers every navigation it allows and stops the emission, so a
/// handler connected later never runs and an out-of-scope request goes out.
/// The capture window hosts no app content, so the webview layer's policy has
/// nothing to protect there; this module's handler is the only policy.
fn silence_other_policy_handlers(webview: &WebView) {
    use glib::gobject_ffi;
    use glib::translate::IntoGlib;
    let object: &glib::Object = webview.upcast_ref();
    unsafe {
        let signal = gobject_ffi::g_signal_lookup(
            c"decide-policy".as_ptr(),
            WebView::static_type().into_glib(),
        );
        if signal == 0 {
            return;
        }
        gobject_ffi::g_signal_handlers_block_matched(
            object.as_ptr(),
            gobject_ffi::G_SIGNAL_MATCH_ID,
            signal,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
    }
}

/// Enforce the start page's scope for every top-level navigation, and route
/// the view's load events to the waiting `navigate` step. New windows are
/// refused outright: a capture is one window navigated in turn.
pub(super) fn guard_navigation_scope(
    window: &WebviewWindow,
    scope: SharedScope,
    local_root: Option<PathBuf>,
) -> Result<(), StepError> {
    run_step(
        window,
        DISPATCH_TIMEOUT,
        "the capture scope could not be enforced",
        move |webview, tx| {
            silence_other_policy_handlers(webview);
            webview.connect_decide_policy(move |_, decision, kind| match kind {
                PolicyDecisionType::NavigationAction => {
                    let Some(navigation) = decision.downcast_ref::<NavigationPolicyDecision>()
                    else {
                        return false;
                    };
                    let mut action = navigation.navigation_action();
                    let target = action
                        .as_ref()
                        .and_then(|action| action.request())
                        .and_then(|request| request.uri())
                        .map(|uri| uri.to_string());
                    let redirected = action.as_mut().is_some_and(|action| action.is_redirect());
                    let mut guard = scope.lock().unwrap_or_else(|poison| poison.into_inner());
                    let allowed = match target.as_deref() {
                        Some(target) => guard.admit(target, redirected, local_root.as_deref()),
                        None => {
                            guard.refuse_unknown();
                            false
                        }
                    };
                    drop(guard);
                    if allowed {
                        return false;
                    }
                    decision.ignore();
                    answer_load(Err("the navigation left the capture's permitted scope".to_string()));
                    true
                }
                PolicyDecisionType::NewWindowAction => {
                    decision.ignore();
                    true
                }
                _ => false,
            });
            webview.connect_load_changed(|_, event| {
                if event == LoadEvent::Finished {
                    answer_load(Ok(()));
                }
            });
            webview.connect_load_failed(|_, _, _, error| {
                answer_load(Err(format!("the page could not be loaded ({error})")));
                false
            });
            let _ = tx.send(Ok(()));
            Ok(())
        },
    )
}

/// Navigate, and wait for the navigation to complete.
pub(super) fn navigate(window: &WebviewWindow, url: &str) -> Result<(), StepError> {
    let target = url.to_string();
    let timed_out = format!("{url} did not finish loading in time");
    run_step(window, NAVIGATION_TIMEOUT, &timed_out, move |webview, tx| {
        PENDING_LOAD.with(|slot| *slot.borrow_mut() = Some(tx));
        webview.load_uri(&target);
        Ok(())
    })
}

fn page_setup(options: &CaptureOptions) -> (gtk::PageSetup, gtk::PrintSettings) {
    let width = if options.page_width_in > 0.0 { options.page_width_in } else { 8.5 };
    let height = if options.page_height_in > 0.0 { options.page_height_in } else { 11.0 };
    let margin = if options.margin_in.is_finite() && options.margin_in >= 0.0 {
        options.margin_in
    } else {
        0.0
    };
    let scale = if (0.1..=2.0).contains(&options.scale) { options.scale } else { 1.0 };
    let orientation = if options.orientation.eq_ignore_ascii_case("landscape") {
        gtk::PageOrientation::Landscape
    } else {
        gtk::PageOrientation::Portrait
    };

    let paper = gtk::PaperSize::new_custom("spectra-capture", "Capture", width, height, gtk::Unit::Inch);
    let setup = gtk::PageSetup::new();
    setup.set_paper_size(&paper);
    setup.set_orientation(orientation);
    setup.set_top_margin(margin, gtk::Unit::Inch);
    setup.set_bottom_margin(margin, gtk::Unit::Inch);
    setup.set_left_margin(margin, gtk::Unit::Inch);
    setup.set_right_margin(margin, gtk::Unit::Inch);

    let settings = gtk::PrintSettings::new();
    settings.set_printer(PRINT_TO_FILE);
    settings.set("output-file-format", Some("pdf"));
    settings.set_paper_size(&paper);
    settings.set_orientation(orientation);
    settings.set_scale(scale * 100.0);
    (setup, settings)
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
    let output = glib::filename_to_uri(path, None)
        .map_err(|e| StepError::Failed(format!("The capture file name is not usable: {e}")))?
        .to_string();
    let opts = options.clone();
    let final_url = run_step(
        window,
        PRINT_TIMEOUT,
        "the page did not finish rendering in time",
        move |webview, tx| {
            let final_url = webview.uri().map(|uri| uri.to_string()).unwrap_or_default();
            if !link_in_scope(&final_url, &scheme, &host, local_root.as_deref()) {
                return Err("the page navigated outside the capture's permitted scope".to_string());
            }
            if let Some(settings) = WebViewExt::settings(webview) {
                settings.set_print_backgrounds(opts.backgrounds);
            }
            let (setup, settings) = page_setup(&opts);
            settings.set("output-uri", Some(&output));

            let operation = PrintOperation::new(webview);
            operation.set_page_setup(&setup);
            operation.set_print_settings(&settings);
            let answer = std::rc::Rc::new(RefCell::new(Some(tx)));
            let failed = answer.clone();
            operation.connect_failed(move |_, error| {
                if let Some(tx) = failed.borrow_mut().take() {
                    let _ = tx.send(Err(format!("the page could not be rendered to PDF ({error})")));
                }
            });
            operation.connect_finished(move |_| {
                if let Some(tx) = answer.borrow_mut().take() {
                    let _ = tx.send(Ok(final_url.clone()));
                }
                PRINTING.with(|slot| slot.borrow_mut().take());
            });
            operation.print();
            PRINTING.with(|slot| *slot.borrow_mut() = Some(operation));
            Ok(())
        },
    )?;
    if !path.is_file() {
        return Err(StepError::Failed("the capture produced no PDF".to_string()));
    }
    Ok(final_url)
}

/// Same-document links, in document order, de-duplicated by the script.
pub(super) fn harvest_links(window: &WebviewWindow) -> Result<HarvestedLinks, StepError> {
    let raw = run_step(
        window,
        SCRIPT_TIMEOUT,
        "the page's links did not arrive in time",
        move |webview, tx| {
            webview.evaluate_javascript(
                super::LINK_HARVEST_SCRIPT,
                None,
                None,
                None::<&gtk::gio::Cancellable>,
                move |result| {
                    let _ = tx.send(
                        result
                            .map(|value| value.to_str().to_string())
                            .map_err(|e| format!("Could not read the page's links: {e}")),
                    );
                },
            );
            Ok(())
        },
    )?;
    decode_link_list(&raw).map_err(StepError::Failed)
}

pub(super) fn page_title(window: &WebviewWindow) -> String {
    run_step(
        window,
        DISPATCH_TIMEOUT,
        "the page title did not arrive in time",
        |webview, tx| {
            let title = webview.title().map(|t| t.to_string()).unwrap_or_default();
            let _ = tx.send(Ok(title));
            Ok(())
        },
    )
    .unwrap_or_default()
}

/// Abandon whatever the window is still loading. Issued without waiting; the
/// destroy that follows is dispatched to the same thread after it.
pub(super) fn abandon_navigation(window: &WebviewWindow) {
    let _ = window.with_webview(|platform| {
        platform.inner().stop_loading();
        PENDING_LOAD.with(|slot| slot.borrow_mut().take());
    });
}
