//! Window identity, per-window backdrop, document ownership and inbound-open
//! routing.
//!
//! Two facts shape everything here. `Emitter::emit` addresses every target in
//! the process, so a payload meant for one renderer reaches all of them unless
//! it goes out through `emit_to`. And a second renderer is a second module
//! scope: every JavaScript-side singleton (id counters, lock maps, generation
//! counters) exists once per window, so a guarantee that has to hold app-wide
//! lives in managed state on this side of the boundary.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const MAIN_LABEL: &str = "main";
const DOC_LABEL_PREFIX: &str = "doc-";

/// A workspace window, as opposed to the transient page-capture window: only
/// these host a renderer that answers close, open and claim messages.
pub fn is_app_window(label: &str) -> bool {
    label == MAIN_LABEL || label.starts_with(DOC_LABEL_PREFIX)
}

/// Every live workspace window's label, sorted so callers get a stable order.
pub fn app_window_labels(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|l| is_app_window(l))
        .collect();
    labels.sort();
    labels
}

pub fn app_window_count(app: &AppHandle) -> usize {
    app.webview_windows()
        .keys()
        .filter(|l| is_app_window(l))
        .count()
}

// ── Backdrop, per label ───────────────────────────────────────────────────

/// Which backdrop each window was created with ("mica" or "none").
///
/// Per label rather than per app: `apply_mica` can succeed for one window and
/// fail for another, and a window told the other one's verdict styles
/// translucent chrome over a material DWM never painted. An unknown label
/// reads "none", which is the opaque presentation the fallback is designed
/// around.
pub struct BackdropState(Mutex<HashMap<String, &'static str>>);

impl BackdropState {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    pub fn record(&self, label: &str, backdrop: &'static str) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(label.to_string(), backdrop);
        }
    }

    pub fn get(&self, label: &str) -> &'static str {
        self.0
            .lock()
            .ok()
            .and_then(|m| m.get(label).copied())
            .unwrap_or("none")
    }

    pub fn forget(&self, label: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(label);
        }
    }
}

impl Default for BackdropState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Document ownership ────────────────────────────────────────────────────

/// How a window holds a path. A write claim is exclusive against everything;
/// two read claims coexist because an import source is never rewritten
/// through the claim that names it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimMode {
    Write,
    Read,
}

#[derive(Clone, Debug)]
struct Claim {
    label: String,
    mode: ClaimMode,
}

/// The outcome of a claim attempt. Structured rather than an error string:
/// the caller needs the blocking window's label to offer to focus it, and
/// control flow never matches on message text.
#[derive(Clone, Debug, Serialize)]
pub struct ClaimOutcome {
    pub granted: bool,
    pub owner: String,
}

impl ClaimOutcome {
    fn granted() -> Self {
        Self {
            granted: true,
            owner: String::new(),
        }
    }

    fn refused(owner: &str) -> Self {
        Self {
            granted: false,
            owner: owner.to_string(),
        }
    }
}

/// Does one output root contain the other, or name it?
///
/// Both sides arrive canonicalized, so equality is identity and the only
/// remaining relation is containment. The separator test is what keeps
/// `C:\out2` from reading as a child of `C:\out`.
fn roots_conflict(a: &str, b: &str) -> bool {
    let trim = |s: &str| s.trim_end_matches(['\\', '/']).to_string();
    let a = trim(a);
    let b = trim(b);
    if a == b {
        return true;
    }
    let contains = |outer: &str, inner: &str| {
        inner.len() > outer.len()
            && inner.starts_with(outer)
            && matches!(inner.as_bytes()[outer.len()], b'\\' | b'/')
    };
    contains(&a, &b) || contains(&b, &a)
}

/// Which paths and output folders each window holds.
///
/// This is the one piece of authoritative state that moves to this side of
/// the boundary. A renderer-side map cannot express it: a second renderer is
/// a fresh module scope with an empty map, and a hung or crashed renderer
/// would wedge a path for the rest of the session — release is driven from
/// the window's own destruction instead.
pub struct ClaimState {
    by_path: Mutex<HashMap<String, Vec<Claim>>>,
    roots: Mutex<Vec<(String, String)>>,
}

impl ClaimState {
    pub fn new() -> Self {
        Self {
            by_path: Mutex::new(HashMap::new()),
            roots: Mutex::new(Vec::new()),
        }
    }

    pub fn claim(&self, path: &str, label: &str, mode: ClaimMode) -> ClaimOutcome {
        let Ok(mut map) = self.by_path.lock() else {
            return ClaimOutcome::granted();
        };
        // Read before `entry`: an `or_default` on the refusal path would leave
        // an empty holder list behind for a path nobody holds.
        if let Some(holders) = map.get(path) {
            let blocker = holders.iter().find(|c| {
                c.label != label && (mode == ClaimMode::Write || c.mode == ClaimMode::Write)
            });
            if let Some(blocker) = blocker {
                return ClaimOutcome::refused(&blocker.label);
            }
        }
        let holders = map.entry(path.to_string()).or_default();
        match holders.iter_mut().find(|c| c.label == label) {
            // Re-claiming is idempotent per window: the open funnel runs for a
            // file this window already holds, and a read claim upgrades to a
            // write claim when the same window opens what it imported from.
            Some(held) => {
                if mode == ClaimMode::Write {
                    held.mode = ClaimMode::Write;
                }
            }
            None => holders.push(Claim {
                label: label.to_string(),
                mode,
            }),
        }
        ClaimOutcome::granted()
    }

    /// Hand a path from one window to another without it ever being unowned.
    ///
    /// Release-then-claim has a window in which the path belongs to nobody and
    /// a third window can take it; the tab would then arrive at a window that
    /// cannot open it, having already left the one that could. The swap
    /// happens under the same mutex `claim` and `release` take, and the entry
    /// is edited in place rather than removed and re-inserted.
    ///
    /// Refused unless `from` holds the path exclusively for writing: a second
    /// holder of any kind means someone else's pending pages address positions
    /// in this file, and a sole read holder never owned it exclusively in the
    /// first place. A refusal names the holder the caller lost to.
    pub fn transfer(&self, path: &str, from: &str, to: &str) -> ClaimOutcome {
        // Failing closed, unlike `claim`: a granted transfer that did not
        // happen closes the tab in a window that still owns the path.
        let Ok(mut map) = self.by_path.lock() else {
            return ClaimOutcome::refused("");
        };
        let Some(holders) = map.get_mut(path) else {
            return ClaimOutcome::refused("");
        };
        let exclusive = holders.len() == 1
            && holders[0].label == from
            && holders[0].mode == ClaimMode::Write;
        if !exclusive {
            let blocker = holders
                .iter()
                .find(|c| c.label != from)
                .or_else(|| holders.first())
                .map(|c| c.label.as_str())
                .unwrap_or("");
            return ClaimOutcome::refused(blocker);
        }
        holders[0].label = to.to_string();
        ClaimOutcome::granted()
    }

    pub fn release(&self, path: &str, label: &str) {
        if let Ok(mut map) = self.by_path.lock() {
            if let Some(holders) = map.get_mut(path) {
                holders.retain(|c| c.label != label);
                if holders.is_empty() {
                    map.remove(path);
                }
            }
        }
    }

    /// Which window a path belongs to. A write holder answers first — it is
    /// the window an inbound open must be routed to.
    pub fn owner(&self, path: &str) -> Option<String> {
        let map = self.by_path.lock().ok()?;
        let holders = map.get(path)?;
        holders
            .iter()
            .find(|c| c.mode == ClaimMode::Write)
            .or_else(|| holders.first())
            .map(|c| c.label.clone())
    }

    /// The documents a window has open, in path order.
    ///
    /// Write claims only: a read claim is an import SOURCE, a file whose bytes
    /// were pulled into another document and which was never open in its own
    /// right. Reopening one would put a document on screen the user never
    /// opened.
    pub fn write_claims(&self, label: &str) -> Vec<String> {
        let Ok(map) = self.by_path.lock() else {
            return Vec::new();
        };
        let mut paths: Vec<String> = map
            .iter()
            .filter(|(_, holders)| {
                holders
                    .iter()
                    .any(|c| c.label == label && c.mode == ClaimMode::Write)
            })
            .map(|(path, _)| path.clone())
            .collect();
        paths.sort();
        paths
    }

    pub fn claim_root(&self, root: &str, label: &str) -> ClaimOutcome {
        let Ok(mut roots) = self.roots.lock() else {
            return ClaimOutcome::granted();
        };
        if let Some((_, owner)) = roots
            .iter()
            .find(|(r, l)| l != label && roots_conflict(r, root))
        {
            return ClaimOutcome::refused(owner);
        }
        if !roots.iter().any(|(r, l)| r == root && l == label) {
            roots.push((root.to_string(), label.to_string()));
        }
        ClaimOutcome::granted()
    }

    pub fn release_root(&self, root: &str, label: &str) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.retain(|(r, l)| !(r == root && l == label));
        }
    }

    /// Drop everything a window held. Driven by the window's destruction so a
    /// renderer that never got to release cannot wedge a path.
    pub fn release_label(&self, label: &str) {
        if let Ok(mut map) = self.by_path.lock() {
            map.retain(|_, holders| {
                holders.retain(|c| c.label != label);
                !holders.is_empty()
            });
        }
        if let Ok(mut roots) = self.roots.lock() {
            roots.retain(|(_, l)| l != label);
        }
    }
}

impl Default for ClaimState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Registry: labels, focus, queued opens ─────────────────────────────────

/// A queued open that carries a document's OWNERSHIP with it.
///
/// The claim moved when the open was queued, so until the receiving window
/// drains it the document exists in no window at all: the source has been told
/// to close its tab and the target has not opened one. The token names the
/// handover, so the commit that reports it, the cancel that undoes it and the
/// destruction of the receiving window all address the same queue entry; `from`
/// is where the document goes back to when that window dies still holding it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Handover {
    pub token: u64,
    pub from: String,
}

/// One inbound open, held until the window it was routed to asks for it.
///
/// Queued rather than carried on the event, because a window created for this
/// open has no listener yet when the event fires. The event is a signal; the
/// payload is drained here, so an open can be neither lost nor applied twice.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingOpen {
    pub files: Vec<String>,
    pub merge: bool,
    /// Where the first file lands in the receiving window's tab order, when the
    /// open came from a gesture that named a position — a dropped tab lands at
    /// the gap its caret marked rather than at the end of the lane.
    ///
    /// An index is DATA, not an identity: page and document ids are minted
    /// against a per-renderer generation counter and can never cross, but a
    /// position in a list the receiver owns means the same thing in both
    /// windows. A stale one clamps on arrival, so nothing has to be agreed.
    #[serde(default)]
    pub index: Option<u32>,
    /// Set only on an open that came with the document's ownership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handover: Option<Handover>,
    /// A handover whose source has not committed it yet.
    ///
    /// Invisible to the drain while it stands. The source writes its working
    /// copy back over the user's own file BETWEEN taking the reservation and
    /// committing it, so a target that drained the entry before that write
    /// opens the bytes the write was about to replace — and the drain removes
    /// the entry, leaving the destruction rollback nothing to hand back. The
    /// commit clears this and signals; nothing else may.
    #[serde(default, skip_serializing)]
    pub reserved: bool,
}

pub struct WindowRegistry {
    next_doc: AtomicU32,
    last_focused: Mutex<String>,
    pending: Mutex<HashMap<String, Vec<PendingOpen>>>,
}

/// Web-download provenance, keyed by canonical path, shared app-wide.
///
/// A document fetched from a web address lands on a temp working path; its
/// origin is what routes File ▸ Save to Save As instead of silently
/// overwriting that scratch copy. The decision has to survive a cross-window
/// hand-off — Move to New Window, a torn-off tab — where the handover carries
/// PATHS ONLY: page and document ids are minted against a per-renderer
/// generation counter and can never cross, but a path names the same file in
/// every window. So the origin lives here, keyed by path, and the receiving
/// window recovers it by looking the path up rather than by carrying an id.
///
/// A JS module map cannot serve this: a second renderer is a fresh module
/// scope that starts empty, so anything that must hold app-wide lives in
/// managed state on this side of the boundary.
#[derive(Default)]
pub struct WebOrigins(Mutex<HashMap<String, String>>);

impl WebOrigins {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record where the downloaded copy at `path` came from.
    pub fn set(&self, path: &str, url: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(path.to_string(), url.to_string());
        }
    }

    /// The origins known for `paths` — canonical path → url, omitting any path
    /// with no recorded origin.
    pub fn lookup(&self, paths: &[String]) -> HashMap<String, String> {
        let Ok(map) = self.0.lock() else {
            return HashMap::new();
        };
        paths
            .iter()
            .filter_map(|p| map.get(p).map(|u| (p.clone(), u.clone())))
            .collect()
    }
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self {
            next_doc: AtomicU32::new(1),
            last_focused: Mutex::new(MAIN_LABEL.to_string()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn next_doc_label(&self) -> String {
        format!("{}{}", DOC_LABEL_PREFIX, self.next_doc.fetch_add(1, Ordering::SeqCst))
    }

    pub fn set_focused(&self, label: &str) {
        if let Ok(mut current) = self.last_focused.lock() {
            *current = label.to_string();
        }
    }

    fn focused(&self) -> String {
        self.last_focused
            .lock()
            .map(|l| l.clone())
            .unwrap_or_else(|_| MAIN_LABEL.to_string())
    }

    /// Queue an open. False when the queue could not take it, which a caller
    /// that has already moved ownership has to act on rather than report a
    /// delivery that never happened.
    pub fn push_pending(&self, label: &str, open: PendingOpen) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        pending.entry(label.to_string()).or_default().push(open);
        true
    }

    /// Drop a queued handover by token.
    ///
    /// False when it is no longer there to drop — drained by the window it was
    /// routed to, or reclaimed by that window's destruction. Either way the
    /// caller is undoing something that already happened to somebody else, and
    /// the answer says so rather than reporting a removal that did not occur.
    pub fn revoke_pending(&self, label: &str, token: u64) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        let Some(queue) = pending.get_mut(label) else {
            return false;
        };
        let held = |open: &PendingOpen| open.handover.as_ref().map(|h| h.token) == Some(token);
        let found = queue.iter().any(held);
        queue.retain(|open| !held(open));
        if queue.is_empty() {
            pending.remove(label);
        }
        found
    }

    /// Every open queued for a label, reserved or not.
    ///
    /// The recovery read: a window's destruction has to see the handovers that
    /// moved to it and were never committed, which are exactly the ones the
    /// drain cannot take.
    pub fn take_pending(&self, label: &str) -> Vec<PendingOpen> {
        self.pending
            .lock()
            .ok()
            .and_then(|mut p| p.remove(label))
            .unwrap_or_default()
    }

    /// The opens a window may act on now, leaving uncommitted handovers queued.
    ///
    /// The renderer drains on mount and on every open signal, both of which can
    /// fall between a reservation and its commit; a reserved entry taken there
    /// would open a file its source is still writing.
    pub fn take_deliverable(&self, label: &str) -> Vec<PendingOpen> {
        let Ok(mut pending) = self.pending.lock() else {
            return Vec::new();
        };
        let (held, ready): (Vec<PendingOpen>, Vec<PendingOpen>) = match pending.get_mut(label) {
            Some(queue) => queue.drain(..).partition(|open| open.reserved),
            None => return Vec::new(),
        };
        if held.is_empty() {
            pending.remove(label);
        } else {
            pending.insert(label.to_string(), held);
        }
        ready
    }

    /// Make a committed handover drainable. False when the token names no
    /// queued entry — drained, revoked, or reclaimed by a destruction.
    pub fn release_pending(&self, label: &str, token: u64) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        let Some(queue) = pending.get_mut(label) else {
            return false;
        };
        let mut found = false;
        for open in queue.iter_mut() {
            if open.handover.as_ref().map(|h| h.token) == Some(token) {
                open.reserved = false;
                found = true;
            }
        }
        found
    }

    pub fn forget(&self, label: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(label);
        }
    }

    /// Leave the queue in the state a panic inside a holder leaves it, so the
    /// paths that have to survive a refused delivery can be driven.
    #[cfg(test)]
    pub fn poison_queue(&self) {
        let _ = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _held = self.pending.lock().expect("queue was already poisoned");
                    panic!("poisoning the queue");
                })
                .join()
        });
    }
}

impl Default for WindowRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// The window an unowned inbound open lands in: the last one focused while it
/// still exists, otherwise any live workspace window.
pub fn route_target(app: &AppHandle) -> String {
    let live = app_window_labels(app);
    let focused = app.state::<WindowRegistry>().focused();
    if live.iter().any(|l| *l == focused) {
        return focused;
    }
    live.into_iter().next().unwrap_or_else(|| MAIN_LABEL.to_string())
}

/// Bring every workspace window back from the tray, raising the routing
/// target last so it ends up in front.
pub fn show_all_app_windows(app: &AppHandle) {
    let target = route_target(app);
    for label in app_window_labels(app) {
        if label == target {
            continue;
        }
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
        }
    }
    focus_label(app, &target);
}

pub fn focus_label(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hand `files` to the window that owns them, or to the routing target, and
/// raise it.
///
/// One open must produce one working copy: `create_working_copy` mints a fresh
/// temp directory per call, so a broadcast turns a single double-click into as
/// many independent edit sessions as there are windows, reconciled by whichever
/// save lands last.
pub fn route_open(app: &AppHandle, files: Vec<String>, merge: bool) {
    let target = route_target(app);
    if files.is_empty() {
        focus_label(app, &target);
        return;
    }
    let live = app_window_labels(app);
    let claims = app.state::<ClaimState>();
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for path in files {
        let owner = claims
            .owner(&path)
            .filter(|l| live.iter().any(|live| live == l))
            .unwrap_or_else(|| target.clone());
        match groups.iter_mut().find(|(label, _)| *label == owner) {
            Some((_, group)) => group.push(path),
            None => groups.push((owner, vec![path])),
        }
    }
    for (label, group) in &groups {
        deliver_open(app, label, group.clone(), merge);
    }
    focus_label(app, &groups[0].0);
}

/// Queue an open for a label, without signalling.
///
/// Split from the signal so a handover can queue under the lock that guards it
/// and signal after: the queue is the delivery, and the event only says a queue
/// is worth draining.
pub fn queue_open(
    registry: &WindowRegistry,
    label: &str,
    files: Vec<String>,
    merge: bool,
) -> bool {
    registry.push_pending(
        label,
        PendingOpen {
            files,
            merge,
            index: None,
            handover: None,
            reserved: false,
        },
    )
}

/// Queue an open that carries ownership, and may name where it lands in the
/// receiving window's strip.
///
/// Only a released tab has a position to name: it was dropped at a gap the
/// target window itself measured and painted a caret in. Every other open —
/// a shell association, a second instance, a restored session, a tear-off into
/// a window with no tabs at all — appends. Nothing handed over ever merges:
/// the document arrives as itself, in a window that may have none.
///
/// Queued RESERVED: ownership has moved but the source has not written the
/// file yet, so the entry is held out of the drain until the commit releases
/// it.
pub fn queue_handover(
    registry: &WindowRegistry,
    label: &str,
    files: Vec<String>,
    index: Option<u32>,
    handover: Handover,
) -> bool {
    registry.push_pending(
        label,
        PendingOpen {
            files,
            merge: false,
            index,
            handover: Some(handover),
            reserved: true,
        },
    )
}

/// Tell a window it has queued opens waiting.
pub fn signal_open(app: &AppHandle, label: &str) {
    let _ = app.emit_to(label, "app:openFile", ());
}

/// Queue an open for a label and signal the renderer to drain it. False when
/// the queue refused it and nothing was delivered.
pub fn deliver_open(app: &AppHandle, label: &str, files: Vec<String>, merge: bool) -> bool {
    if !queue_open(&app.state::<WindowRegistry>(), label, files, merge) {
        return false;
    }
    signal_open(app, label);
    true
}

// ── Creation ──────────────────────────────────────────────────────────────

/// Build a workspace window and record which backdrop it actually got.
///
/// Windows are built here rather than declared in `tauri.conf.json` because
/// `transparent` is a creation-time property (tao's DWM blur-behind region
/// plus wry's WebView2 background colour) and is only wanted where a backdrop
/// can compose. Tauri's own windowEffects path discards the vibrancy Result,
/// so Mica is applied directly and the outcome recorded for the renderer to
/// key translucent styling on.
///
/// Both halves of the gate are required: the OS must have Mica, and DWM must
/// be going to draw it. Checking only the first is what lets a
/// transparency-effects-off machine get chrome styled for a backdrop that was
/// never composed.
///
/// `SPECTRAPDF_E2E_FORCE_OPAQUE` is read only under end-to-end control, so it
/// is not a shipped configuration channel: it makes the opaque presentation
/// reachable on a machine where Mica would compose.
pub fn build_app_window(
    app: &AppHandle,
    label: &str,
    e2e: bool,
    visible: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    let force_opaque = e2e && std::env::var("SPECTRAPDF_E2E_FORCE_OPAQUE").is_ok();
    let wants_backdrop = crate::wants_backdrop(
        windows_version::OsVersion::current().build,
        crate::is_remote_session(),
        crate::transparency_effects_enabled(),
    ) && !force_opaque;
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title("Spectra PDF")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .visible(visible)
        .transparent(wants_backdrop)
        .build()?;
    let backdrop = if wants_backdrop && window_vibrancy::apply_mica(&window, None).is_ok() {
        "mica"
    } else {
        // A transparent window whose HTML paints opaque renders identically to
        // an opaque one, so a failed apply on a supported build still degrades
        // cleanly.
        "none"
    };
    app.state::<BackdropState>().record(label, backdrop);
    crate::session::on_window_created(app, &window);
    Ok(window)
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────

pub fn on_window_focused(app: &AppHandle, label: &str) {
    if is_app_window(label) {
        app.state::<WindowRegistry>().set_focused(label);
    }
}

/// Drop everything a destroyed window held.
///
/// `tabdrag::on_window_destroyed` runs BEFORE this (`lib.rs`): a document handed
/// to this window and never opened is still owned by it here, and releasing the
/// claim into the pool is what makes it unrecoverable. The sweep there hands
/// those back first, so what this releases is only what the window actually had.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if !is_app_window(label) {
        return;
    }
    app.state::<ClaimState>().release_label(label);
    app.state::<BackdropState>().forget(label);
    app.state::<WindowRegistry>().forget(label);
    app.state::<crate::engine::EngineRouter>().drop_label(label);
    crate::engine::publish_activity(app);
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Open an empty second workspace. Async because building a webview window
/// from a synchronous command deadlocks the WebView2 message loop.
#[tauri::command]
pub async fn open_new_window(app: AppHandle) -> Result<String, String> {
    let label = app.state::<WindowRegistry>().next_doc_label();
    let window = build_app_window(&app, &label, crate::is_e2e_mode(), true)
        .map_err(|e| format!("Failed to open a window: {}", e))?;
    let _ = window.set_focus();
    crate::engine::publish_activity(&app);
    Ok(label)
}

#[tauri::command]
pub async fn claim_document(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    mode: ClaimMode,
) -> Result<ClaimOutcome, String> {
    let path = crate::commands::canonical_path(&path);
    Ok(app.state::<ClaimState>().claim(&path, window.label(), mode))
}

#[tauri::command]
pub async fn release_document(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let path = crate::commands::canonical_path(&path);
    app.state::<ClaimState>().release(&path, window.label());
    Ok(())
}

#[tauri::command]
pub async fn claim_output_root(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<ClaimOutcome, String> {
    let path = crate::commands::canonical_path(&path);
    Ok(app.state::<ClaimState>().claim_root(&path, window.label()))
}

#[tauri::command]
pub async fn release_output_root(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let path = crate::commands::canonical_path(&path);
    app.state::<ClaimState>().release_root(&path, window.label());
    Ok(())
}

#[tauri::command]
pub async fn focus_app_window(app: AppHandle, label: String) -> Result<(), String> {
    focus_label(&app, &label);
    Ok(())
}

/// Drain this window's queued opens.
///
/// Uncommitted handovers stay behind: the document has changed hands but its
/// source is still writing the file the open would read.
/// Record the web address a downloaded copy at `path` came from, so any window
/// that later opens that temp path — including one it was handed to across a
/// window boundary — routes File ▸ Save to Save As.
#[tauri::command]
pub async fn register_web_origin(app: AppHandle, path: String, url: String) -> Result<(), String> {
    let path = crate::commands::canonical_path(&path);
    app.state::<WebOrigins>().set(&path, &url);
    Ok(())
}

/// The web origins known for `paths` — the receiving window's recovery read
/// after a cross-window hand-off carried the path but not the provenance.
#[tauri::command]
pub async fn web_origins_for(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let canonical: Vec<String> = paths
        .iter()
        .map(|p| crate::commands::canonical_path(p))
        .collect();
    Ok(app.state::<WebOrigins>().lookup(&canonical))
}

#[tauri::command]
pub async fn take_pending_opens(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<PendingOpen>, String> {
    Ok(app
        .state::<WindowRegistry>()
        .take_deliverable(window.label()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_web_origin_round_trips_by_path_and_is_absent_otherwise() {
        // The provenance a cross-window hand-off recovers: registered against
        // the temp path on the download, read back by the window it moves to.
        let origins = WebOrigins::new();
        origins.set("C:\\Temp\\net\\a.pdf", "https://example.com/a.pdf");
        let found = origins.lookup(&[
            "C:\\Temp\\net\\a.pdf".to_string(),
            "C:\\Temp\\net\\b.pdf".to_string(),
        ]);
        assert_eq!(
            found.get("C:\\Temp\\net\\a.pdf").map(String::as_str),
            Some("https://example.com/a.pdf"),
        );
        // A path with no recorded origin is simply absent — never a temp path
        // masquerading as web-origined.
        assert!(!found.contains_key("C:\\Temp\\net\\b.pdf"));
    }

    #[test]
    fn only_workspace_labels_answer_window_messages() {
        assert!(is_app_window("main"));
        assert!(is_app_window("doc-1"));
        assert!(is_app_window("doc-17"));
        assert!(!is_app_window("web-capture"));
        assert!(!is_app_window("document"));
    }

    #[test]
    fn a_write_claim_is_exclusive_and_names_its_holder() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);

        let refused = state.claim("C:\\a.pdf", "doc-1", ClaimMode::Write);
        assert!(!refused.granted);
        assert_eq!(refused.owner, "main");

        // A read of a path held for writing is refused too: the reader's
        // pending pages address positions the writer is about to change.
        let refused_read = state.claim("C:\\a.pdf", "doc-1", ClaimMode::Read);
        assert!(!refused_read.granted);
        assert_eq!(refused_read.owner, "main");

        // Re-claiming from the holder is the same claim, not a conflict.
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);
        assert_eq!(state.owner("C:\\a.pdf").as_deref(), Some("main"));
    }

    #[test]
    fn the_exclusive_owner_reclaiming_is_granted_and_stacks_no_second_holder() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "doc-1", ClaimMode::Write).granted);

        let again = state.claim("C:\\a.pdf", "doc-1", ClaimMode::Write);
        assert!(again.granted);
        assert!(again.owner.is_empty());
        assert_eq!(state.owner("C:\\a.pdf").as_deref(), Some("doc-1"));

        // A re-claim updates the holder in place rather than pushing a second
        // one: a stacked holder would survive its window's single release and
        // wedge the path for the rest of the session.
        state.release("C:\\a.pdf", "doc-1");
        assert_eq!(state.owner("C:\\a.pdf"), None);
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);
    }

    #[test]
    fn a_transfer_swaps_the_owner_without_the_path_ever_being_free() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);

        let moved = state.transfer("C:\\a.pdf", "main", "doc-1");
        assert!(moved.granted);
        assert!(moved.owner.is_empty());
        assert_eq!(state.owner("C:\\a.pdf").as_deref(), Some("doc-1"));

        // Exclusivity moved with it: neither a third window nor the window that
        // just gave it up can take the path back.
        let third = state.claim("C:\\a.pdf", "doc-2", ClaimMode::Write);
        assert!(!third.granted);
        assert_eq!(third.owner, "doc-1");
        let back = state.claim("C:\\a.pdf", "main", ClaimMode::Write);
        assert!(!back.granted);
        assert_eq!(back.owner, "doc-1");
    }

    #[test]
    fn a_transfer_from_a_window_that_does_not_own_the_path_is_refused() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);

        let refused = state.transfer("C:\\a.pdf", "doc-1", "doc-2");
        assert!(!refused.granted);
        assert_eq!(refused.owner, "main");
        assert_eq!(state.owner("C:\\a.pdf").as_deref(), Some("main"));

        // A path nobody holds has nothing to hand over, and a refusal must not
        // leave a holder behind for a path that was never claimed.
        let unowned = state.transfer("C:\\ghost.pdf", "main", "doc-1");
        assert!(!unowned.granted);
        assert!(unowned.owner.is_empty());
        assert_eq!(state.owner("C:\\ghost.pdf"), None);
        assert!(state.claim("C:\\ghost.pdf", "doc-2", ClaimMode::Write).granted);
    }

    #[test]
    fn a_transfer_is_refused_while_a_second_window_holds_the_path() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\src.pdf", "main", ClaimMode::Read).granted);
        assert!(state.claim("C:\\src.pdf", "doc-1", ClaimMode::Read).granted);

        // Two readers means neither is the exclusive owner: the other window's
        // pending pages address positions in this file.
        let refused = state.transfer("C:\\src.pdf", "main", "doc-2");
        assert!(!refused.granted);
        assert_eq!(refused.owner, "doc-1");
        assert_eq!(state.owner("C:\\src.pdf").as_deref(), Some("main"));

        // A sole reader is still not an exclusive owner — a read claim never
        // conferred the right to hand the file to somebody else.
        state.release("C:\\src.pdf", "doc-1");
        let sole_reader = state.transfer("C:\\src.pdf", "main", "doc-2");
        assert!(!sole_reader.granted);
        assert_eq!(sole_reader.owner, "main");
    }

    #[test]
    fn releasing_after_a_transfer_leaves_no_residue_in_either_window() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "doc-3", ClaimMode::Write).granted);
        assert!(state.transfer("C:\\a.pdf", "doc-3", "doc-4").granted);

        // The new owner's SINGLE release frees the path completely: a swap that
        // left the source stacked behind the new holder would keep the path
        // owned here, and wedge it for the rest of the session.
        state.release("C:\\a.pdf", "doc-4");
        assert_eq!(state.owner("C:\\a.pdf"), None);
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);

        // The source closes its tab without releasing; a stray release from it
        // must not strip the claim off the window that now holds the path.
        assert!(state.claim("C:\\b.pdf", "doc-3", ClaimMode::Write).granted);
        assert!(state.transfer("C:\\b.pdf", "doc-3", "doc-4").granted);
        state.release("C:\\b.pdf", "doc-3");
        assert_eq!(state.owner("C:\\b.pdf").as_deref(), Some("doc-4"));
    }

    #[test]
    fn destroying_the_window_a_path_was_transferred_to_frees_it() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);
        assert!(state.transfer("C:\\a.pdf", "main", "doc-1").granted);

        // Release is driven by the window's own destruction, so the transferred
        // path follows the label it moved to, not the one it came from.
        state.release_label("main");
        assert_eq!(state.owner("C:\\a.pdf").as_deref(), Some("doc-1"));
        state.release_label("doc-1");
        assert_eq!(state.owner("C:\\a.pdf"), None);
    }

    #[test]
    fn the_documents_a_window_has_open_are_its_write_claims_only() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\b.pdf", "main", ClaimMode::Write).granted);
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);
        assert!(state.claim("C:\\z.pdf", "doc-1", ClaimMode::Write).granted);
        // An import source: read by main, never open in it.
        assert!(state.claim("C:\\src.pdf", "main", ClaimMode::Read).granted);

        assert_eq!(
            state.write_claims("main"),
            vec!["C:\\a.pdf".to_string(), "C:\\b.pdf".to_string()]
        );
        assert_eq!(state.write_claims("doc-1"), vec!["C:\\z.pdf".to_string()]);
        assert!(state.write_claims("doc-9").is_empty());

        // A transferred document is listed by whoever holds it now, and by
        // nobody else — a session that recorded it twice would open two copies.
        assert!(state.transfer("C:\\a.pdf", "main", "doc-1").granted);
        assert_eq!(state.write_claims("main"), vec!["C:\\b.pdf".to_string()]);
        assert_eq!(
            state.write_claims("doc-1"),
            vec!["C:\\a.pdf".to_string(), "C:\\z.pdf".to_string()]
        );
    }

    #[test]
    fn read_claims_coexist_and_still_block_a_write() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\src.pdf", "main", ClaimMode::Read).granted);
        assert!(state.claim("C:\\src.pdf", "doc-1", ClaimMode::Read).granted);

        let refused = state.claim("C:\\src.pdf", "doc-2", ClaimMode::Write);
        assert!(!refused.granted);

        // A reader upgrading to a write is refused while another reader holds
        // the path — the upgrade is not privileged by already being a holder.
        let upgrade = state.claim("C:\\src.pdf", "main", ClaimMode::Write);
        assert!(!upgrade.granted);
        assert_eq!(upgrade.owner, "doc-1");

        state.release("C:\\src.pdf", "doc-1");
        assert!(state.claim("C:\\src.pdf", "main", ClaimMode::Write).granted);
    }

    #[test]
    fn destroying_a_window_drops_everything_it_held() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "doc-1", ClaimMode::Write).granted);
        assert!(state.claim_root("C:\\out", "doc-1").granted);

        state.release_label("doc-1");

        assert_eq!(state.owner("C:\\a.pdf"), None);
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);
        assert!(state.claim_root("C:\\out", "main").granted);
    }

    #[test]
    fn releasing_a_path_this_window_never_held_is_a_no_op() {
        let state = ClaimState::new();
        assert!(state.claim("C:\\a.pdf", "main", ClaimMode::Write).granted);
        state.release("C:\\a.pdf", "doc-1");
        assert_eq!(state.owner("C:\\a.pdf").as_deref(), Some("main"));
        state.release("C:\\never-claimed.pdf", "doc-1");
        assert_eq!(state.owner("C:\\never-claimed.pdf"), None);
    }

    #[test]
    fn output_roots_conflict_by_containment_not_by_prefix() {
        assert!(roots_conflict("C:\\out", "C:\\out"));
        assert!(roots_conflict("C:\\out", "C:\\out\\sub"));
        assert!(roots_conflict("C:\\out\\sub", "C:\\out"));
        assert!(roots_conflict("C:\\out\\", "C:\\out"));
        assert!(!roots_conflict("C:\\out", "C:\\out2"));
        assert!(!roots_conflict("C:\\out", "C:\\other"));

        let state = ClaimState::new();
        assert!(state.claim_root("C:\\out", "main").granted);
        let refused = state.claim_root("C:\\out\\sub", "doc-1");
        assert!(!refused.granted);
        assert_eq!(refused.owner, "main");
        assert!(state.claim_root("C:\\out2", "doc-1").granted);
    }

    #[test]
    fn doc_labels_are_minted_once_each() {
        let registry = WindowRegistry::new();
        assert_eq!(registry.next_doc_label(), "doc-1");
        assert_eq!(registry.next_doc_label(), "doc-2");
        assert!(is_app_window(&registry.next_doc_label()));
    }

    #[test]
    fn queued_opens_drain_once() {
        let registry = WindowRegistry::new();
        assert!(queue_open(&registry, "doc-1", vec!["C:\\a.pdf".into()], false));
        assert!(queue_open(&registry, "doc-1", vec!["C:\\b.pdf".into()], true));
        let drained = registry.take_pending("doc-1");
        assert_eq!(drained.len(), 2);
        assert!(drained[1].merge);
        assert!(registry.take_pending("doc-1").is_empty());
    }

    fn handover(token: u64) -> Handover {
        Handover {
            token,
            from: "main".to_string(),
        }
    }

    #[test]
    fn only_an_open_that_named_a_position_carries_one() {
        let registry = WindowRegistry::new();
        // A released tab: it was dropped at a gap the receiving window itself
        // measured, and the index is what makes the drop land where the caret
        // promised instead of at the end of the lane.
        assert!(queue_handover(
            &registry,
            "doc-1",
            vec!["C:\\a.pdf".into()],
            Some(2),
            handover(1),
        ));
        // Everything else appends, and says so rather than guessing a position.
        assert!(queue_open(&registry, "doc-1", vec!["C:\\b.pdf".into()], false));
        let drained = registry.take_pending("doc-1");
        assert_eq!(drained[0].index, Some(2));
        assert_eq!(drained[1].index, None);
    }

    #[test]
    fn a_revoked_handover_leaves_the_queue_it_was_the_only_entry_of_empty() {
        let registry = WindowRegistry::new();
        assert!(queue_handover(&registry, "doc-1", vec!["C:\\a.pdf".into()], None, handover(7)));
        assert!(queue_open(&registry, "doc-1", vec!["C:\\b.pdf".into()], false));

        // Only the named handover goes: an ordinary open queued to the same
        // window is nobody's to cancel.
        assert!(registry.revoke_pending("doc-1", 7));
        let left = registry.take_pending("doc-1");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].files, vec!["C:\\b.pdf".to_string()]);

        // A token that is no longer queued reports the removal it did not make,
        // so a cancel racing a drain cannot undo a delivery that happened.
        assert!(!registry.revoke_pending("doc-1", 7));
        assert!(!registry.revoke_pending("doc-9", 7));
    }

    #[test]
    fn a_handover_carries_its_token_over_the_wire_and_an_ordinary_open_carries_none() {
        let registry = WindowRegistry::new();
        assert!(queue_handover(&registry, "doc-1", vec!["C:\\a.pdf".into()], None, handover(3)));
        let drained = registry.take_pending("doc-1");
        assert_eq!(drained[0].handover, Some(handover(3)));

        let plain = PendingOpen {
            files: vec!["C:\\a.pdf".into()],
            merge: false,
            index: None,
            handover: None,
            reserved: false,
        };
        let json = serde_json::to_string(&plain).unwrap();
        assert!(!json.contains("handover"), "{json}");
        // The gate is this side's bookkeeping: a renderer that could read it
        // would be reading a decision it does not make.
        assert!(!json.contains("reserved"), "{json}");
    }

    #[test]
    fn an_uncommitted_handover_is_invisible_to_the_drain_and_stays_queued() {
        let registry = WindowRegistry::new();
        assert!(queue_open(&registry, "doc-1", vec!["C:\\b.pdf".into()], false));
        assert!(queue_handover(&registry, "doc-1", vec!["C:\\a.pdf".into()], None, handover(4)));

        // The source is still writing the file this open would read, and the
        // entry is the destruction rollback's only record of the move.
        let drained = registry.take_deliverable("doc-1");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].files, vec!["C:\\b.pdf".to_string()]);
        // Draining again takes nothing and still leaves it.
        assert!(registry.take_deliverable("doc-1").is_empty());

        assert!(registry.release_pending("doc-1", 4));
        let committed = registry.take_deliverable("doc-1");
        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].files, vec!["C:\\a.pdf".to_string()]);
        assert!(registry.take_pending("doc-1").is_empty());
    }

    #[test]
    fn a_release_names_one_token_and_a_destruction_still_sees_what_was_never_committed() {
        let registry = WindowRegistry::new();
        assert!(queue_handover(&registry, "doc-1", vec!["C:\\a.pdf".into()], None, handover(4)));
        assert!(queue_handover(&registry, "doc-1", vec!["C:\\b.pdf".into()], None, handover(5)));
        // A commit releases its own handover and no other window's.
        assert!(!registry.release_pending("doc-9", 4));
        assert!(!registry.release_pending("doc-1", 6));
        assert!(registry.release_pending("doc-1", 4));
        assert_eq!(registry.take_deliverable("doc-1").len(), 1);
        // The recovery read sees the one still held, which is the point of
        // holding it: the drain could not have taken it away.
        let left = registry.take_pending("doc-1");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].files, vec!["C:\\b.pdf".to_string()]);
    }

    #[test]
    fn a_queued_position_survives_the_wire_and_an_older_record_has_none() {
        let queued = PendingOpen {
            files: vec!["C:\\a.pdf".into()],
            merge: false,
            index: Some(0),
            handover: None,
            reserved: false,
        };
        let json = serde_json::to_string(&queued).unwrap();
        assert_eq!(
            serde_json::from_str::<PendingOpen>(&json).unwrap().index,
            Some(0),
            "{json}"
        );
        // Zero is a real gap — before every tab — so it must not be confused
        // with the absent index that means "append".
        assert!(json.contains("\"index\":0"));
        let lean: PendingOpen =
            serde_json::from_str(r#"{"files":["C:\\a.pdf"],"merge":false}"#).unwrap();
        assert_eq!(lean.index, None);
    }

    #[test]
    fn an_unknown_label_reads_the_opaque_backdrop() {
        let state = BackdropState::new();
        assert_eq!(state.get("doc-9"), "none");
        state.record("doc-9", "mica");
        assert_eq!(state.get("doc-9"), "mica");
        assert_eq!(state.get("main"), "none");
        state.forget("doc-9");
        assert_eq!(state.get("doc-9"), "none");
    }
}
