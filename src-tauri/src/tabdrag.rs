//! Cross-window tab drag: the source renderer owns the gesture, this side owns
//! the geography.
//!
//! A pointer drag is delivered only to the renderer whose window it started in
//! — with the button held, that window keeps receiving moves even while the
//! cursor is over another window, and the window underneath hears nothing until
//! release. So the source can follow the pointer for the whole drag but cannot
//! answer the two questions that decide the drop: whose tab strip is under the
//! cursor, and who owns the document afterwards. Both are answered here.
//!
//! A strip is published in physical pixels RELATIVE to its window, and this
//! side alone composes it with a screen origin. The origin is the window's
//! `inner_position`: the outer origin includes the frame, whose title bar alone
//! is taller than the gap between the strip and the toolbar below it, so a rect
//! measured against it hit-tests into the wrong band. Holding the window-local
//! rect and the origin separately is also what keeps the two from being sampled
//! at different moments — the origin is re-read here on every move and resize,
//! and a window that moved between two reads can never leave the rect offset.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::app_windows::{self, ClaimState, Handover, WindowRegistry};

/// A tab strip in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StripRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl StripRect {
    /// Half-open on the far edges, so two strips that abut share no point.
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

#[derive(Clone, Copy, Debug)]
struct StripEntry {
    /// The strip's box inside its own window, physical pixels.
    local: StripRect,
    /// The window's inner origin, re-read whenever the window moves.
    origin: (i32, i32),
}

impl StripEntry {
    fn screen(&self) -> StripRect {
        StripRect {
            x: self.origin.0 + self.local.x,
            y: self.origin.1 + self.local.y,
            width: self.local.width,
            height: self.local.height,
        }
    }
}

/// Where the pointer is, in window terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DropTarget {
    /// Another window's strip.
    Window(String),
    /// The dragging window's own strip — its business, not this side's.
    Source,
    /// No strip at all: the drop makes a window.
    TearOff,
}

/// The window currently showing an insertion caret, and where that window says
/// the caret is.
///
/// The index is derived by the hovered window from its OWN tabs and sent back,
/// because only that window knows how many tabs it has or how wide they are.
/// It is held beside the label so it can never outlive the hover it belongs to:
/// a caret that moved to another window, or stopped being drawn, takes its
/// index with it, and a drop can only ever read the index of the window it
/// actually resolves into.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Hover {
    label: String,
    index: Option<u32>,
}

/// A handover that has moved but has not been reported.
///
/// The claim and the queued open move when the reservation is TAKEN, so the
/// destination cannot change afterwards: the source writes its working copy
/// back over the user's own file between the two calls, and a destination
/// re-resolved after that write would leave a document saved and its history
/// discarded for a move that never happened. What can still change is whether
/// the destination survives, and that is what `void` records.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Reservation {
    token: u64,
    path: String,
    /// The window the document is going back to if this comes to nothing.
    from: String,
    target: String,
    /// The target window was built for this handover and is still hidden: the
    /// commit places and shows it, a cancel destroys it.
    tear_off: bool,
    /// Where a torn-off window is placed when the handover is committed.
    position: Option<(i32, i32)>,
    /// The target was destroyed before the commit. Ownership is already back
    /// with `from`; the commit has nothing left to report but the refusal.
    void: bool,
}

/// Every window's strip, which window is currently showing an insertion caret,
/// and the handovers that have moved but not been reported. Managed state
/// beside `WindowRegistry`.
pub struct StripRegistry {
    strips: Mutex<HashMap<String, StripEntry>>,
    hover: Mutex<Option<Hover>>,
    /// Held under `strips` when a reservation is made, and alone otherwise:
    /// the lock order is strips → reservations and never the reverse.
    reservations: Mutex<Vec<Reservation>>,
    next_token: AtomicU64,
}

impl StripRegistry {
    pub fn new() -> Self {
        Self {
            strips: Mutex::new(HashMap::new()),
            hover: Mutex::new(None),
            reservations: Mutex::new(Vec::new()),
            next_token: AtomicU64::new(1),
        }
    }

    fn set(&self, label: &str, local: StripRect, origin: (i32, i32)) {
        if let Ok(mut strips) = self.strips.lock() {
            strips.insert(label.to_string(), StripEntry { local, origin });
        }
    }

    /// Record where a label's window is now.
    ///
    /// The stored origin is replaced rather than accumulated, so a move this
    /// side never heard about corrects itself on the next one. Windows minimize
    /// to an off-screen origin, which takes the strip out of the hit-testable
    /// area by the same arithmetic that follows an ordinary drag and brings it
    /// back when the window is restored.
    fn reanchor(&self, label: &str, origin: (i32, i32)) {
        if let Ok(mut strips) = self.strips.lock() {
            if let Some(entry) = strips.get_mut(label) {
                entry.origin = origin;
            }
        }
    }

    /// Stop answering for a label.
    ///
    /// Called from the window's own destruction, and it must run BEFORE the
    /// claims that label held are released: this is the lock a release resolves
    /// under, so forgetting first is what makes a transfer into a window that
    /// no longer exists impossible rather than merely unlikely.
    fn forget(&self, label: &str) {
        if let Ok(mut strips) = self.strips.lock() {
            strips.remove(label);
        }
        if let Ok(mut hover) = self.hover.lock() {
            if hover.as_ref().map(|h| h.label.as_str()) == Some(label) {
                *hover = None;
            }
        }
    }

    /// Every registered strip, in label order so hit-testing is deterministic.
    fn snapshot(&self) -> Vec<(String, StripRect)> {
        let Ok(strips) = self.strips.lock() else {
            return Vec::new();
        };
        screen_strips(&strips, None)
    }

    fn next_token(&self) -> u64 {
        self.next_token.fetch_add(1, Ordering::SeqCst)
    }

    fn hold(&self, reservation: Reservation) -> bool {
        match self.reservations.lock() {
            Ok(mut held) => {
                held.push(reservation);
                true
            }
            Err(_) => false,
        }
    }

    /// Take a reservation, if it belongs to the window asking for it.
    ///
    /// A token names a document that has already changed hands, so only the
    /// window that gave it up can commit or cancel it — otherwise a stale token
    /// from one gesture could finish or undo another window's handover.
    fn take_reservation(&self, token: u64, from: &str) -> Option<Reservation> {
        let mut held = self.reservations.lock().ok()?;
        let at = held.iter().position(|r| r.token == token && r.from == from)?;
        Some(held.remove(at))
    }

    /// Record that a reservation's destination is gone.
    ///
    /// Voided rather than removed: the window that gave the document up is
    /// waiting on a commit, and the commit is the one place it hears that
    /// nothing moved. False when there is no reservation left to void, which
    /// means the handover was already reported as done.
    fn void_reservation(&self, token: u64) -> bool {
        let Ok(mut held) = self.reservations.lock() else {
            return false;
        };
        match held.iter_mut().find(|r| r.token == token) {
            Some(reservation) => {
                reservation.void = true;
                true
            }
            None => false,
        }
    }

    /// Take every reservation a window made, because it will never commit one.
    fn take_reservations_from(&self, label: &str) -> Vec<Reservation> {
        let Ok(mut held) = self.reservations.lock() else {
            return Vec::new();
        };
        let (mine, rest) = held.iter().cloned().partition(|r| r.from == label);
        *held = rest;
        mine
    }

    /// Resolve a release AND move the document, both under this lock.
    ///
    /// A window destroyed between the hit-test and the transfer would otherwise
    /// take the claim with it: the source is told the document changed hands and
    /// closes its tab, and the path belongs to a label nothing can ever deliver
    /// to. Destruction forgets the strip under this same lock, so the two are
    /// strictly ordered — either the label is still here and the whole handover
    /// completes, or it is gone and the point falls through to a tear-off.
    ///
    /// The queued open is part of the same unit. A transfer whose delivery was
    /// refused is undone rather than reported: ownership that moved with nothing
    /// to open it is the same lost document by a different route.
    ///
    /// What this does NOT do is report the move. Ownership is held under a
    /// token until the source commits it, so the destination this point
    /// resolved to is the destination the handover ends in — the source writes
    /// its file between the two calls, and a second resolution could answer
    /// differently by then.
    ///
    /// `at` is the gap the caret was last reported in, paired with the window
    /// that reported it: a drop honours a position only in the window that
    /// measured it, so a transfer into any other label appends.
    fn reserve_release(
        &self,
        claims: &ClaimState,
        registry: &WindowRegistry,
        live: &[String],
        source: &str,
        path: &str,
        at: Option<(String, Option<u32>)>,
        x: i32,
        y: i32,
    ) -> Reserved {
        // Failing closed: a drop that cannot be resolved leaves the document
        // where it is, which is the outcome the source already knows how to
        // undo.
        let Ok(strips) = self.strips.lock() else {
            return Reserved::Refused(source.to_string());
        };
        match resolve_drop(&screen_strips(&strips, Some(live)), source, x, y) {
            DropTarget::Source => Reserved::Source,
            DropTarget::TearOff => Reserved::TearOff,
            DropTarget::Window(target) => {
                let moved = claims.transfer(path, source, &target);
                if !moved.granted {
                    return Reserved::Refused(moved.owner);
                }
                let index = match &at {
                    Some((label, index)) if *label == target => *index,
                    _ => None,
                };
                let token = self.next_token();
                let queued = app_windows::queue_handover(
                    registry,
                    &target,
                    vec![path.to_string()],
                    index,
                    Handover {
                        token,
                        from: source.to_string(),
                    },
                );
                if !queued
                    || !self.hold(Reservation {
                        token,
                        path: path.to_string(),
                        from: source.to_string(),
                        target: target.clone(),
                        tear_off: false,
                        position: None,
                        void: false,
                    })
                {
                    registry.revoke_pending(&target, token);
                    let _ = claims.transfer(path, &target, source);
                    return Reserved::Refused(source.to_string());
                }
                Reserved::Held { token, target }
            }
        }
    }

    /// Give back what a destroyed window was holding but never opened.
    ///
    /// A handover moves ownership before the receiving window has drawn
    /// anything: between the queue and the drain the document exists in no
    /// window at all, and destruction in that gap releases the claim into the
    /// pool while the source has already been told to close its tab. So the
    /// queue is read here, before those claims are released, and every
    /// undelivered handover goes back to the window it came from.
    ///
    /// Which way it goes back depends on what the source has been told. A
    /// reservation still open means the source is waiting on a commit and will
    /// hear the refusal there, so the claim moves and nothing else is needed. A
    /// reservation already committed means the source believes the document
    /// left, so it has to be told to open it again.
    fn sweep_destroyed(
        &self,
        claims: &ClaimState,
        registry: &WindowRegistry,
        label: &str,
        live: &[String],
    ) -> DestroySweep {
        let mut sweep = DestroySweep::default();
        for open in registry.take_pending(label) {
            let Some(handover) = open.handover else {
                continue;
            };
            let waiting = self.void_reservation(handover.token);
            let home_is_source =
                handover.from != label && live.iter().any(|l| *l == handover.from);
            // A source that is gone too leaves the document with no home of its
            // own; any window that can open it beats losing it.
            let home = if home_is_source {
                Some(handover.from.clone())
            } else {
                live.iter().find(|l| *l != label).cloned()
            };
            let Some(home) = home else {
                continue;
            };
            for path in open.files {
                if !claims.transfer(&path, label, &home).granted {
                    continue;
                }
                if !(waiting && home_is_source) {
                    sweep.returned.push((home.clone(), path));
                }
            }
        }
        // A window destroyed while it was the SOURCE of a handover will never
        // commit it. The document is already the target's, so the delivery it
        // was holding open is completed on its behalf rather than left queued —
        // including the release the commit would have done, without which the
        // queued open stays invisible to the window it belongs to.
        for reservation in self.take_reservations_from(label) {
            if reservation.void {
                continue;
            }
            registry.release_pending(&reservation.target, reservation.token);
            sweep.deliver.push(reservation);
        }
        sweep
    }

    /// Which window is drawing a caret, without stopping it.
    fn hover_label(&self) -> Option<String> {
        self.hover
            .lock()
            .ok()
            .and_then(|h| h.as_ref().map(|h| h.label.clone()))
    }

    /// Stop drawing, and say who was.
    fn take_hover(&self) -> Option<String> {
        self.hover
            .lock()
            .ok()
            .and_then(|mut h| h.take())
            .map(|h| h.label)
    }

    /// Stop drawing, and say who was and where they said the caret was.
    fn take_hover_state(&self) -> Option<(String, Option<u32>)> {
        self.hover
            .lock()
            .ok()
            .and_then(|mut h| h.take())
            .map(|h| (h.label, h.index))
    }

    /// Move the caret to a window. A caret arriving somewhere new has no index
    /// yet — the window that has it will report one — and re-entering the same
    /// window is not an arrival, so an index already reported survives the
    /// moves that follow it.
    fn set_hover(&self, label: &str) {
        if let Ok(mut hover) = self.hover.lock() {
            if hover.as_ref().map(|h| h.label.as_str()) != Some(label) {
                *hover = Some(Hover {
                    label: label.to_string(),
                    index: None,
                });
            }
        }
    }

    /// Record where a window says its caret is.
    ///
    /// Ignored unless that window is the one currently hovered: a report that
    /// crossed with the caret leaving would otherwise place a drop at a gap in
    /// a strip the pointer is no longer over.
    fn set_hover_index(&self, label: &str, index: u32) {
        if let Ok(mut hover) = self.hover.lock() {
            if let Some(current) = hover.as_mut() {
                if current.label == label {
                    current.index = Some(index);
                }
            }
        }
    }
}

impl Default for StripRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// What a release reserved, decided under the registry lock.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Reserved {
    /// The document belongs to this label now and its open is queued, held
    /// under a token until the source commits or cancels it.
    Held { token: u64, target: String },
    /// The pointer never left the dragging window's own strip.
    Source,
    /// No strip took it; the caller builds a window for it.
    TearOff,
    /// Nothing moved. This label holds the path.
    Refused(String),
}

/// What a destroyed window leaves for somebody else to finish.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DestroySweep {
    /// `(window, path)`: a document the destroyed window owned and never
    /// opened, handed back to a window that has to open it.
    returned: Vec<(String, String)>,
    /// Handovers the destroyed window reserved and will never commit.
    deliver: Vec<Reservation>,
}

/// Registered strips in screen coordinates, in label order so hit-testing is
/// deterministic. `live` restricts the answer to labels that can still take a
/// drop; `None` asks every registered strip.
fn screen_strips(
    strips: &HashMap<String, StripEntry>,
    live: Option<&[String]>,
) -> Vec<(String, StripRect)> {
    let mut out: Vec<(String, StripRect)> = strips
        .iter()
        .filter(|(label, _)| match live {
            Some(live) => live.iter().any(|l| l == *label),
            None => true,
        })
        .map(|(label, entry)| (label.clone(), entry.screen()))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// ── Pure resolution ───────────────────────────────────────────────────────

/// Which window a point belongs to, the source window first.
///
/// The source holds the pointer, so it is the focused and topmost window: a
/// point inside its own strip is its own business whatever else overlaps
/// there. Any remaining overlap resolves by label order — z-order is not
/// observable from this side, and a deterministic answer is what keeps hover
/// and drop from disagreeing about the same point.
pub fn resolve_drop(strips: &[(String, StripRect)], source: &str, x: i32, y: i32) -> DropTarget {
    if strips
        .iter()
        .any(|(label, rect)| label == source && rect.contains(x, y))
    {
        return DropTarget::Source;
    }
    match strips
        .iter()
        .find(|(label, rect)| label != source && rect.contains(x, y))
    {
        Some((label, _)) => DropTarget::Window(label.clone()),
        None => DropTarget::TearOff,
    }
}

/// The window to show an insertion caret, and how far into its strip the
/// pointer is.
///
/// The offset is physical pixels from the strip's left edge: the target divides
/// by its OWN device pixel ratio, so nothing about the source's scale factor
/// has to travel with the drag.
pub fn resolve_hover(
    strips: &[(String, StripRect)],
    source: &str,
    x: i32,
    y: i32,
) -> Option<(String, i32)> {
    match resolve_drop(strips, source, x, y) {
        DropTarget::Window(label) => strips
            .iter()
            .find(|(l, _)| *l == label)
            .map(|(l, rect)| (l.clone(), x - rect.x)),
        _ => None,
    }
}

// ── Event payloads ────────────────────────────────────────────────────────

const HOVER_EVENT: &str = "tabdrag://hover";
const LEAVE_EVENT: &str = "tabdrag://leave";
const RETURNED_EVENT: &str = "tabdrag://returned";

#[derive(Clone, Serialize)]
struct HoverPayload {
    /// Physical pixels from the left edge of this window's own strip.
    x: i32,
}

/// A document coming back from a handover that was reported as done and then
/// undone by the receiving window's destruction. The path is all that crosses:
/// the receiver re-opens it through its own funnel.
#[derive(Clone, Serialize)]
struct ReturnedPayload {
    path: String,
}

/// What a drop did. Structured rather than a message: the caller decides
/// whether to close its tab from `outcome`, and control flow never reads text.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabDragResult {
    /// `transferred` · `tornOff` · `sameWindow` · `refused`.
    pub outcome: &'static str,
    /// The window that owns the path now; empty unless it moved.
    pub label: String,
    /// On a refusal, the window that holds the path; empty otherwise.
    pub owner: String,
}

impl TabDragResult {
    pub const TRANSFERRED: &'static str = "transferred";
    pub const TORN_OFF: &'static str = "tornOff";
    pub const SAME_WINDOW: &'static str = "sameWindow";
    pub const REFUSED: &'static str = "refused";

    fn moved(outcome: &'static str, label: String) -> Self {
        Self {
            outcome,
            label,
            owner: String::new(),
        }
    }

    fn refused(owner: String) -> Self {
        Self {
            outcome: Self::REFUSED,
            label: String::new(),
            owner,
        }
    }
}

/// A handover that has happened but has not been reported.
///
/// `outcome` is what the commit will say, decided now: the destination is held
/// against re-resolution for as long as the token lives, so the source can
/// write the user's file knowing where the document is going. A `token` of zero
/// means nothing is held and there is nothing to commit or cancel.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabDragReservation {
    /// `transferred` · `tornOff` · `sameWindow` · `refused`.
    pub outcome: &'static str,
    /// The window that owns the path now; empty unless it moved.
    pub label: String,
    /// On a refusal, the window that holds the path; empty otherwise.
    pub owner: String,
    pub token: u64,
}

impl TabDragReservation {
    fn held(outcome: &'static str, label: String, token: u64) -> Self {
        Self {
            outcome,
            label,
            owner: String::new(),
            token,
        }
    }

    fn refused(owner: String) -> Self {
        Self {
            outcome: TabDragResult::REFUSED,
            label: String::new(),
            owner,
            token: 0,
        }
    }

    fn same_window() -> Self {
        Self {
            outcome: TabDragResult::SAME_WINDOW,
            label: String::new(),
            owner: String::new(),
            token: 0,
        }
    }
}

// ── Hooks ─────────────────────────────────────────────────────────────────

/// Re-anchor a window's strip after the OS moved or resized it.
///
/// Driven from the window event rather than the renderer: this side hears the
/// move first, and a rect that lags a frame behind a human-speed drag still
/// names the right window.
pub fn on_window_geometry_changed(app: &AppHandle, window: &tauri::Window) {
    if !app_windows::is_app_window(window.label()) {
        return;
    }
    if let Ok(origin) = window.inner_position() {
        app.state::<StripRegistry>()
            .reanchor(window.label(), (origin.x, origin.y));
    }
}

/// Forget a window's strip, and finish the handovers its destruction interrupted.
///
/// Runs BEFORE `app_windows::on_window_destroyed` (`lib.rs`), which is what
/// makes the recovery possible at all: a document handed to this window and
/// never opened is still owned by it here, and one line later the claim is back
/// in the pool with nothing left to say where it came from.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let registry = app.state::<StripRegistry>();
    registry.forget(label);
    if !app_windows::is_app_window(label) {
        return;
    }
    let live: Vec<String> = app_windows::app_window_labels(app)
        .into_iter()
        .filter(|l| l != label)
        .collect();
    let sweep = registry.sweep_destroyed(
        &app.state::<ClaimState>(),
        &app.state::<WindowRegistry>(),
        label,
        &live,
    );
    for (home, path) in sweep.returned {
        // Not a queued open: the window this goes to may be mid-handover for
        // this very path, and only it knows whether the tab it was about to
        // close is still there. It re-opens through its own funnel or keeps
        // what it has.
        let _ = app.emit_to(home.as_str(), RETURNED_EVENT, ReturnedPayload { path });
    }
    for reservation in sweep.deliver {
        if reservation.tear_off {
            show_torn_off(app, &reservation);
        }
        app_windows::signal_open(app, &reservation.target);
    }
}

/// Labels that can actually receive a drop: alive and on screen. A window
/// hidden to the tray keeps its rect (nothing tells this side it moved), and a
/// document dropped into an invisible window is gone as far as the user can
/// tell — a tear-off is the recoverable answer.
///
/// Read outside the registry lock, because asking a window whether it is
/// visible crosses to the event loop, and the event loop is where a window's
/// destruction runs. What this list can miss — a window destroyed a moment
/// later — the registry's own `forget` catches under the lock.
fn droppable_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, window)| {
            app_windows::is_app_window(label) && window.is_visible().unwrap_or(false)
        })
        .map(|(label, _)| label)
        .collect()
}

/// Clear whichever window is drawing an insertion caret, and tell it to stop.
fn clear_hover(app: &AppHandle) {
    if let Some(previous) = app.state::<StripRegistry>().take_hover() {
        let _ = app.emit_to(previous.as_str(), LEAVE_EVENT, ());
    }
}

/// Reserve a move into a brand-new window.
///
/// The label is minted and the claim transferred BEFORE the window is built, so
/// a refusal leaves no empty window behind and the path is never unowned. The
/// open is queued rather than carried on an event: the window has no renderer
/// when the claim lands, which is the case the pending-open queue already
/// exists for.
///
/// The window is built HIDDEN and stays hidden until the commit, so a handover
/// the source abandons — or one whose file could not be written — leaves no
/// window on screen that the user never asked for. It is built here rather than
/// at the commit because a build that fails is the one failure that can still
/// be reported before the source writes anything.
fn reserve_tear_off(
    app: &AppHandle,
    path: &str,
    from: &str,
    position: Option<(i32, i32)>,
) -> TabDragReservation {
    let label = app.state::<WindowRegistry>().next_doc_label();
    let moved = app.state::<ClaimState>().transfer(path, from, &label);
    if !moved.granted {
        return TabDragReservation::refused(moved.owner);
    }
    let strips = app.state::<StripRegistry>();
    let token = strips.next_token();
    let queued = app_windows::queue_handover(
        &app.state::<WindowRegistry>(),
        &label,
        vec![path.to_string()],
        None,
        Handover {
            token,
            from: from.to_string(),
        },
    );
    let undo = || {
        // Nothing will drain that queue or release that claim — hand both back
        // to the window that still has the document open.
        app.state::<WindowRegistry>().revoke_pending(&label, token);
        app.state::<WindowRegistry>().forget(&label);
        let _ = app.state::<ClaimState>().transfer(path, &label, from);
    };
    if !queued
        || !strips.hold(Reservation {
            token,
            path: path.to_string(),
            from: from.to_string(),
            target: label.clone(),
            tear_off: true,
            position,
            void: false,
        })
    {
        undo();
        return TabDragReservation::refused(from.to_string());
    }
    match app_windows::build_app_window(app, &label, crate::is_e2e_mode(), false) {
        Ok(_) => TabDragReservation::held(TabDragResult::TORN_OFF, label, token),
        Err(_) => {
            let _ = strips.take_reservation(token, from);
            undo();
            TabDragReservation::refused(from.to_string())
        }
    }
}

/// Put a torn-off window where the release left the cursor, and show it.
///
/// A window that appears centred and then jumps to the cursor reads as two
/// windows opening, so it is placed before it is ever visible.
fn show_torn_off(app: &AppHandle, reservation: &Reservation) {
    let Some(window) = app.get_webview_window(&reservation.target) else {
        return;
    };
    if let Some((x, y)) = reservation.position {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
    crate::engine::publish_activity(app);
}

// ── Commands ──────────────────────────────────────────────────────────────

/// Publish this window's tab-strip rectangle, in physical pixels relative to
/// the window.
///
/// The renderer measures the box (`getBoundingClientRect` scaled by its own
/// device pixel ratio) because only the renderer knows where the strip sits
/// inside the page; the screen origin is read HERE, and only here, so a window
/// that moves between the two never leaves the stored rect offset. A strip with
/// no area — collapsed, or a window with no tabs — is forgotten rather than
/// stored, so it can never take a drop.
#[tauri::command]
pub async fn register_strip_rect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let registry = app.state::<StripRegistry>();
    if width <= 0 || height <= 0 {
        registry.forget(window.label());
        return Ok(());
    }
    let origin = window
        .inner_position()
        .map(|p| (p.x, p.y))
        .map_err(|e| format!("Window position unavailable: {}", e))?;
    registry.set(
        window.label(),
        StripRect {
            x,
            y,
            width,
            height,
        },
        origin,
    );
    Ok(())
}

/// Follow a drag. Returns the window now showing an insertion caret, if any.
#[tauri::command]
pub async fn tabdrag_track(
    app: AppHandle,
    window: tauri::WebviewWindow,
    screen_x: i32,
    screen_y: i32,
) -> Result<Option<String>, String> {
    let registry = app.state::<StripRegistry>();
    let hovered = resolve_hover(&registry.snapshot(), window.label(), screen_x, screen_y);
    // Peeked rather than taken: the hovered window's reported caret position
    // lives beside this label, and clearing it on every move would throw away
    // the gap a drop is supposed to honour.
    let previous = registry.hover_label();
    match &hovered {
        Some((label, offset)) => {
            if previous.as_deref() != Some(label.as_str()) {
                if let Some(previous) = previous {
                    let _ = app.emit_to(previous.as_str(), LEAVE_EVENT, ());
                }
            }
            registry.set_hover(label);
            // Emitted every move, not only on entry: the caret's position
            // inside the strip is the payload, and it changes with the pointer.
            let _ = app.emit_to(label.as_str(), HOVER_EVENT, HoverPayload { x: *offset });
        }
        None => {
            // Taken, not peeked: the caret is stopping, and the gap it reported
            // stops with it.
            if let Some(previous) = registry.take_hover() {
                let _ = app.emit_to(previous.as_str(), LEAVE_EVENT, ());
            }
        }
    }
    Ok(hovered.map(|(label, _)| label))
}

/// The gap the calling window is painting its caret in, for the drag it is
/// hovering but not running.
///
/// The offset this side sends says where the pointer is; only the hovered
/// window knows what is under it, so the index comes back rather than being
/// guessed here. Reported on every crossing of a tab's midpoint and dropped
/// with the caret, so a release lands where the caret promised or, having never
/// been told, at the end of the lane.
#[tauri::command]
pub async fn tabdrag_hover_index(
    app: AppHandle,
    window: tauri::WebviewWindow,
    index: u32,
) -> Result<(), String> {
    app.state::<StripRegistry>()
        .set_hover_index(window.label(), index);
    Ok(())
}

/// Abandon a drag (Escape, or a gesture cancelled before release). Nothing
/// crosses; the caret stops being drawn.
#[tauri::command]
pub async fn tabdrag_cancel(app: AppHandle) -> Result<(), String> {
    clear_hover(&app);
    Ok(())
}

/// Reserve a release: transfer to the window under the cursor, mint a window
/// where there is no strip, or report that the pointer never left home.
///
/// Only the path crosses. Page and document ids are minted against a
/// per-renderer generation counter, so the same id string names a different
/// physical page in every window.
///
/// This is where the destination is DECIDED, and it stays decided: the source
/// writes its working copy back over the user's own file before it commits,
/// and a document saved and marked clean for a move that then resolved
/// somewhere else — or nowhere — has lost its undo history for nothing. Asking
/// twice is what made that possible, so the answer is held instead of repeated.
#[tauri::command]
pub async fn tabdrag_reserve(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    screen_x: i32,
    screen_y: i32,
) -> Result<TabDragReservation, String> {
    // The caret stops being drawn and its gap is read in the same step: the
    // position a release honours is the last one the receiving window reported,
    // and it must not be readable by the drop after it.
    let at = app.state::<StripRegistry>().take_hover_state();
    if let Some((label, _)) = &at {
        let _ = app.emit_to(label.as_str(), LEAVE_EVENT, ());
    }
    let path = crate::commands::canonical_path(&path);
    let source = window.label().to_string();
    // Everything that decides ownership happens inside `reserve_release`, which
    // holds the registry lock throughout. Only what cannot run under a lock the
    // event loop also takes is left out here: the visibility probe above it, and
    // building a window below it.
    let live = droppable_labels(&app);
    let reserved = app.state::<StripRegistry>().reserve_release(
        &app.state::<ClaimState>(),
        &app.state::<WindowRegistry>(),
        &live,
        &source,
        &path,
        at,
        screen_x,
        screen_y,
    );
    Ok(match reserved {
        Reserved::Source => TabDragReservation::same_window(),
        Reserved::Refused(owner) => TabDragReservation::refused(owner),
        Reserved::Held { token, target } => {
            TabDragReservation::held(TabDragResult::TRANSFERRED, target, token)
        }
        Reserved::TearOff => reserve_tear_off(
            &app,
            &path,
            &source,
            Some((
                // Offset so the cursor lands inside the new window rather than
                // on the corner it would resize from.
                screen_x - TEAR_OFF_INSET,
                screen_y - TEAR_OFF_INSET,
            )),
        ),
    })
}

const TEAR_OFF_INSET: i32 = 24;

/// Window ▸ Move to New Window. The same handover as a tear-off, minus the
/// drop point — releasing and re-claiming instead would leave the path unowned
/// for as long as it takes to build a window.
#[tauri::command]
pub async fn tabdrag_reserve_new_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<TabDragReservation, String> {
    let path = crate::commands::canonical_path(&path);
    Ok(reserve_tear_off(&app, &path, window.label(), None))
}

/// Report a reserved handover, and deliver it.
///
/// The outcome is the source's whole answer: on a move it closes its tab
/// WITHOUT releasing, because ownership already belongs to the receiving window
/// and a release would strip the claim off it.
///
/// A destination destroyed since the reservation was taken has already handed
/// the document back, and this is where the source hears it — as a refusal,
/// with its tab still open and still the only copy.
///
/// This is also the moment the queued open becomes drainable. Until it, the
/// entry is held out of the target's drain: the source writes its working copy
/// back over the user's own file between the reservation and this call, and a
/// target that opened the path before that write would read the bytes the write
/// replaces — and take the entry the rollback needs with it.
#[tauri::command]
pub async fn tabdrag_commit(
    app: AppHandle,
    window: tauri::WebviewWindow,
    token: u64,
) -> Result<TabDragResult, String> {
    let source = window.label().to_string();
    let Some(reservation) = app
        .state::<StripRegistry>()
        .take_reservation(token, &source)
    else {
        return Ok(TabDragResult::refused(source));
    };
    if reservation.void {
        return Ok(TabDragResult::refused(reservation.from));
    }
    app.state::<WindowRegistry>()
        .release_pending(&reservation.target, token);
    if reservation.tear_off {
        show_torn_off(&app, &reservation);
        app_windows::signal_open(&app, &reservation.target);
        return Ok(TabDragResult::moved(
            TabDragResult::TORN_OFF,
            reservation.target,
        ));
    }
    app_windows::signal_open(&app, &reservation.target);
    app_windows::focus_label(&app, &reservation.target);
    Ok(TabDragResult::moved(
        TabDragResult::TRANSFERRED,
        reservation.target,
    ))
}

/// Undo a reserved handover the source is not going to commit.
///
/// The write that a move costs can fail, and a document whose file was never
/// written must not arrive anywhere: the claim goes back, the queued open is
/// revoked, and a window built for a tear-off is destroyed before it is ever
/// seen.
#[tauri::command]
pub async fn tabdrag_release(
    app: AppHandle,
    window: tauri::WebviewWindow,
    token: u64,
) -> Result<TabDragResult, String> {
    let source = window.label().to_string();
    let Some(reservation) = app
        .state::<StripRegistry>()
        .take_reservation(token, &source)
    else {
        return Ok(TabDragResult::refused(source));
    };
    // A voided reservation was undone by the destruction that voided it; doing
    // it again would take the path off whoever owns it now.
    if !reservation.void {
        app.state::<WindowRegistry>()
            .revoke_pending(&reservation.target, token);
        let _ = app.state::<ClaimState>().transfer(
            &reservation.path,
            &reservation.target,
            &reservation.from,
        );
        if reservation.tear_off {
            app.state::<WindowRegistry>().forget(&reservation.target);
            if let Some(built) = app.get_webview_window(&reservation.target) {
                let _ = built.destroy();
            }
        }
    }
    Ok(TabDragResult::refused(reservation.from))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_windows::ClaimMode;

    fn strip(label: &str, x: i32, y: i32, width: i32, height: i32) -> (String, StripRect) {
        (
            label.to_string(),
            StripRect {
                x,
                y,
                width,
                height,
            },
        )
    }

    #[test]
    fn a_point_in_another_windows_strip_names_that_window() {
        let strips = vec![strip("main", 0, 0, 400, 40), strip("doc-1", 900, 100, 400, 40)];
        assert_eq!(
            resolve_drop(&strips, "main", 950, 110),
            DropTarget::Window("doc-1".into())
        );
        assert_eq!(
            resolve_hover(&strips, "main", 950, 110),
            Some(("doc-1".to_string(), 50))
        );
    }

    #[test]
    fn a_point_in_no_strip_tears_off() {
        let strips = vec![strip("main", 0, 0, 400, 40), strip("doc-1", 900, 100, 400, 40)];
        assert_eq!(resolve_drop(&strips, "main", 600, 600), DropTarget::TearOff);
        assert_eq!(resolve_hover(&strips, "main", 600, 600), None);
        // Just below a strip is outside it: the band under the strip is the
        // toolbar, and a drop there is a tear-off, not a transfer.
        assert_eq!(resolve_drop(&strips, "main", 950, 140), DropTarget::TearOff);
    }

    #[test]
    fn the_dragging_windows_own_strip_is_never_a_foreign_hover() {
        let strips = vec![strip("main", 0, 0, 400, 40), strip("doc-1", 900, 100, 400, 40)];
        assert_eq!(resolve_drop(&strips, "main", 100, 20), DropTarget::Source);
        assert_eq!(resolve_hover(&strips, "main", 100, 20), None);
        // The same point, dragged from the other window, IS a transfer.
        assert_eq!(
            resolve_drop(&strips, "doc-1", 100, 20),
            DropTarget::Window("main".into())
        );
    }

    #[test]
    fn overlapping_strips_resolve_to_the_source_first_then_deterministically() {
        // Three strips over one point. The source wins because it holds the
        // pointer and is therefore on top.
        let strips = vec![
            strip("doc-1", 0, 0, 400, 40),
            strip("doc-2", 0, 0, 400, 40),
            strip("main", 0, 0, 400, 40),
        ];
        assert_eq!(resolve_drop(&strips, "doc-2", 10, 10), DropTarget::Source);
        assert_eq!(resolve_drop(&strips, "main", 10, 10), DropTarget::Source);
        // With the source elsewhere, label order decides — and hover and drop
        // must never disagree about the same point.
        assert_eq!(
            resolve_drop(&strips, "doc-9", 10, 10),
            DropTarget::Window("doc-1".into())
        );
        assert_eq!(
            resolve_hover(&strips, "doc-9", 10, 10).map(|(l, _)| l),
            Some("doc-1".to_string())
        );
    }

    #[test]
    fn strip_rects_are_half_open_so_abutting_strips_share_no_point() {
        let strips = vec![strip("main", 100, 100, 50, 20), strip("doc-1", 150, 100, 50, 20)];
        assert_eq!(
            resolve_drop(&strips, "doc-9", 100, 100),
            DropTarget::Window("main".into())
        );
        assert_eq!(
            resolve_drop(&strips, "doc-9", 149, 119),
            DropTarget::Window("main".into())
        );
        // The far edges belong to the next rect, not to both.
        assert_eq!(
            resolve_drop(&strips, "doc-9", 150, 100),
            DropTarget::Window("doc-1".into())
        );
        assert_eq!(resolve_drop(&strips, "doc-9", 100, 120), DropTarget::TearOff);
        assert_eq!(resolve_drop(&strips, "doc-9", 99, 100), DropTarget::TearOff);
    }

    #[test]
    fn a_caret_offset_is_measured_from_the_strips_own_left_edge() {
        let strips = vec![strip("doc-1", 900, 100, 400, 40)];
        assert_eq!(resolve_hover(&strips, "main", 900, 110), Some(("doc-1".into(), 0)));
        assert_eq!(resolve_hover(&strips, "main", 1120, 110), Some(("doc-1".into(), 220)));
    }

    #[test]
    fn a_moved_window_carries_its_strip_with_it() {
        let registry = StripRegistry::new();
        // 40 across and 31 down inside a window at (900, 100).
        registry.set(
            "doc-1",
            StripRect {
                x: 40,
                y: 31,
                width: 400,
                height: 40,
            },
            (900, 100),
        );
        assert_eq!(registry.snapshot(), vec![strip("doc-1", 940, 131, 400, 40)]);
        // Dragged 200 right and 50 up: the strip keeps its offset inside the
        // window, which is the whole reason the origin is stored beside it.
        registry.reanchor("doc-1", (1100, 50));
        assert_eq!(registry.snapshot(), vec![strip("doc-1", 1140, 81, 400, 40)]);
        // Re-anchoring twice must not double-count the first move.
        registry.reanchor("doc-1", (1100, 50));
        assert_eq!(registry.snapshot(), vec![strip("doc-1", 1140, 81, 400, 40)]);
        // A move this side never heard about corrects itself on the next one:
        // the origin is replaced, never accumulated.
        registry.reanchor("doc-1", (900, 100));
        assert_eq!(registry.snapshot(), vec![strip("doc-1", 940, 131, 400, 40)]);
    }

    #[test]
    fn a_strip_republished_while_the_window_moves_is_anchored_to_one_origin_only() {
        let registry = StripRegistry::new();
        // The renderer measures its box; this side reads the origin. The two
        // are never composed by different observers, so a window that moved
        // between a measure and a publish still lands on its own strip.
        registry.set(
            "doc-1",
            StripRect {
                x: 40,
                y: 31,
                width: 400,
                height: 40,
            },
            (900, 100),
        );
        registry.set(
            "doc-1",
            StripRect {
                x: 40,
                y: 31,
                width: 400,
                height: 40,
            },
            (1200, 300),
        );
        assert_eq!(registry.snapshot(), vec![strip("doc-1", 1240, 331, 400, 40)]);
        assert_eq!(
            resolve_drop(&registry.snapshot(), "main", 1300, 340),
            DropTarget::Window("doc-1".into())
        );
    }

    #[test]
    fn a_minimized_windows_strip_leaves_the_hit_testable_area() {
        let registry = StripRegistry::new();
        registry.set(
            "doc-1",
            StripRect {
                x: 40,
                y: 31,
                width: 400,
                height: 40,
            },
            (0, 0),
        );
        // Windows parks a minimized window off-screen; the same arithmetic that
        // follows a drag takes its strip out of reach.
        registry.reanchor("doc-1", (-32000, -32000));
        assert_eq!(
            resolve_drop(&registry.snapshot(), "main", 100, 40),
            DropTarget::TearOff
        );
        registry.reanchor("doc-1", (0, 0));
        assert_eq!(
            resolve_drop(&registry.snapshot(), "main", 100, 40),
            DropTarget::Window("doc-1".into())
        );
    }

    #[test]
    fn a_forgotten_label_stops_answering_and_stops_hovering() {
        let registry = StripRegistry::new();
        registry.set(
            "doc-1",
            StripRect {
                x: 0,
                y: 0,
                width: 400,
                height: 40,
            },
            (0, 0),
        );
        registry.set_hover("doc-1");
        registry.forget("doc-1");
        assert!(registry.snapshot().is_empty());
        // A destroyed window must not be told to stop drawing a caret it can no
        // longer be told anything about.
        assert_eq!(registry.take_hover(), None);
        // Re-anchoring a label nobody registered is a no-op, not a resurrection.
        registry.reanchor("doc-1", (10, 10));
        assert!(registry.snapshot().is_empty());
    }

    #[test]
    fn the_hover_target_is_handed_over_once() {
        let registry = StripRegistry::new();
        registry.set_hover("doc-1");
        assert_eq!(registry.take_hover().as_deref(), Some("doc-1"));
        assert_eq!(registry.take_hover(), None);
    }

    #[test]
    fn a_reported_gap_survives_the_moves_inside_one_strip_and_dies_leaving_it() {
        let registry = StripRegistry::new();
        registry.set_hover("doc-1");
        registry.set_hover_index("doc-1", 2);
        // Every pointer move re-hovers the same window; the gap it reported
        // must not be thrown away on each one, or a drop has nothing to honour.
        registry.set_hover("doc-1");
        assert_eq!(registry.take_hover_state(), Some(("doc-1".into(), Some(2))));

        // A caret that moved to another window starts with no gap: the index
        // it had was a position in a strip the pointer has left.
        registry.set_hover("doc-1");
        registry.set_hover_index("doc-1", 2);
        registry.set_hover("doc-2");
        assert_eq!(registry.take_hover_state(), Some(("doc-2".into(), None)));
    }

    #[test]
    fn only_the_window_actually_hovered_can_report_a_gap() {
        let registry = StripRegistry::new();
        registry.set_hover("doc-1");
        // A report that crossed with the caret leaving would otherwise place a
        // drop at a gap in a strip the pointer is not over.
        registry.set_hover_index("doc-2", 5);
        assert_eq!(registry.take_hover_state(), Some(("doc-1".into(), None)));

        // And with no caret drawn at all there is nothing to report against.
        registry.set_hover_index("doc-1", 5);
        assert_eq!(registry.take_hover_state(), None);
    }

    #[test]
    fn a_cancelled_drag_leaves_no_gap_behind() {
        let registry = StripRegistry::new();
        registry.set_hover("doc-1");
        registry.set_hover_index("doc-1", 3);
        // Escape, and a strip that stopped being rendered, both clear the
        // caret through this — the gap goes with it, so the next drag cannot
        // inherit a position from the one that was abandoned.
        assert_eq!(registry.take_hover().as_deref(), Some("doc-1"));
        assert_eq!(registry.take_hover_state(), None);
    }

    // ── Handover, and the destroyed-target interleavings ──────────────────

    const DOC: &str = "C:\\docs\\a.pdf";

    /// Two windows side by side, `main` holding the document.
    fn two_windows() -> (StripRegistry, ClaimState, WindowRegistry) {
        let strips = StripRegistry::new();
        let square = |width, height| StripRect {
            x: 0,
            y: 0,
            width,
            height,
        };
        strips.set("main", square(400, 40), (0, 0));
        strips.set("doc-1", square(400, 40), (900, 100));
        let claims = ClaimState::new();
        assert!(claims.claim(DOC, "main", ClaimMode::Write).granted);
        (strips, claims, WindowRegistry::new())
    }

    fn live(labels: &[&str]) -> Vec<String> {
        labels.iter().map(|l| l.to_string()).collect()
    }

    /// The reservation a release over `doc-1` takes, with everything else at
    /// rest. Panics rather than returning, so a test that means to reserve
    /// cannot quietly assert against a refusal.
    fn reserve_onto_doc1(
        strips: &StripRegistry,
        claims: &ClaimState,
        registry: &WindowRegistry,
    ) -> u64 {
        match strips.reserve_release(
            claims,
            registry,
            &live(&["main", "doc-1"]),
            "main",
            DOC,
            None,
            950,
            110,
        ) {
            Reserved::Held { token, target } => {
                assert_eq!(target, "doc-1");
                token
            }
            other => panic!("expected a held handover, got {other:?}"),
        }
    }

    #[test]
    fn a_release_over_another_window_moves_the_claim_and_queues_the_open_together() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-1"));
        let queued = registry.take_pending("doc-1");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].files, vec![DOC.to_string()]);
        assert!(!queued[0].merge);
        // No caret was ever reported, so the document appends rather than
        // landing at a position nobody named.
        assert_eq!(queued[0].index, None);
        // The queued open carries the handover it belongs to, which is what
        // lets the receiving window's destruction give the document back.
        assert_eq!(
            queued[0].handover,
            Some(Handover {
                token,
                from: "main".to_string()
            })
        );
    }

    #[test]
    fn a_release_lands_at_the_gap_the_receiving_window_reported() {
        let (strips, claims, registry) = two_windows();
        strips.set_hover("doc-1");
        strips.set_hover_index("doc-1", 2);
        assert!(matches!(
            strips.reserve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                strips.take_hover_state(),
                950,
                110,
            ),
            Reserved::Held { .. }
        ));
        assert_eq!(registry.take_pending("doc-1")[0].index, Some(2));
    }

    #[test]
    fn a_gap_measured_in_one_window_is_never_honoured_in_another() {
        let (strips, claims, registry) = two_windows();
        // The caret was in a third window when the pointer moved on. An index
        // is a position in the reporting window's OWN strip, so carrying it
        // into the window the drop resolves into would place the tab at a gap
        // measured somewhere else.
        strips.set_hover("doc-9");
        strips.set_hover_index("doc-9", 3);
        assert!(matches!(
            strips.reserve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                strips.take_hover_state(),
                950,
                110,
            ),
            Reserved::Held { .. }
        ));
        assert_eq!(registry.take_pending("doc-1")[0].index, None);
    }

    #[test]
    fn a_target_destroyed_before_the_release_never_takes_the_claim_with_it() {
        let (strips, claims, registry) = two_windows();
        // Destruction forgets the strip under the lock the release resolves
        // under. Had the claim moved anyway, the source would have been told
        // the document changed hands and closed the only tab that had it,
        // leaving the path owned by a label nothing can deliver to.
        strips.forget("doc-1");
        assert_eq!(
            strips.reserve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                None,
                950,
                110,
            ),
            Reserved::TearOff
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("doc-1").is_empty());
    }

    #[test]
    fn a_target_the_visibility_probe_no_longer_lists_takes_no_drop() {
        let (strips, claims, registry) = two_windows();
        // The strip is still registered — the destroyed window's event has not
        // been processed — but it is not among the windows that can take a
        // drop, so the point falls through to a tear-off rather than into it.
        assert_eq!(
            strips.reserve_release(
                &claims,
                &registry,
                &live(&["main"]),
                "main",
                DOC,
                None,
                950,
                110,
            ),
            Reserved::TearOff
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("doc-1").is_empty());
    }

    #[test]
    fn a_delivery_the_queue_refuses_hands_the_claim_straight_back() {
        let (strips, claims, registry) = two_windows();
        registry.poison_queue();
        // Ownership that moved with nothing to open it is the same lost
        // document as a transfer into a window that no longer exists.
        assert_eq!(
            strips.reserve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                None,
                950,
                110,
            ),
            Reserved::Refused("main".to_string())
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        // And nothing is left held: a token whose delivery never happened must
        // not be committable.
        assert_eq!(strips.take_reservation(1, "main"), None);
    }

    #[test]
    fn a_release_the_claim_state_refuses_queues_no_open() {
        let (strips, claims, registry) = two_windows();
        // A second holder means someone else's pending pages address positions
        // in this file: nothing moves, and nothing is promised to the target.
        assert_eq!(
            strips.reserve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "doc-1",
                DOC,
                None,
                10,
                10,
            ),
            Reserved::Refused("main".to_string())
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("main").is_empty());
    }

    #[test]
    fn a_release_in_the_sources_own_strip_moves_nothing_and_promises_nothing() {
        let (strips, claims, registry) = two_windows();
        assert_eq!(
            strips.reserve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                None,
                10,
                10,
            ),
            Reserved::Source
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("main").is_empty());
        assert!(registry.take_pending("doc-1").is_empty());
    }

    // ── The reservation: one resolution, held until it is reported ─────────

    #[test]
    fn a_reserved_destination_cannot_be_re_resolved_out_from_under_the_write() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        // Everything the first resolution read can change while the source
        // writes the user's file: the pointer is released, the target window
        // moves, the source's own strip grows over the point. Asking again is
        // what produced a document saved and marked clean for a move that
        // resolved somewhere else — so nothing asks again.
        strips.reanchor("doc-1", (4000, 4000));
        strips.set(
            "main",
            StripRect {
                x: 0,
                y: 0,
                width: 4000,
                height: 4000,
            },
            (0, 0),
        );
        let committed = strips.take_reservation(token, "main").expect("held");
        assert_eq!(committed.target, "doc-1");
        assert!(!committed.void);
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-1"));
        assert_eq!(registry.take_pending("doc-1").len(), 1);
    }

    #[test]
    fn a_reservation_can_only_be_taken_by_the_window_that_made_it() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        // A token names a document that has already changed hands. Another
        // window finishing or undoing this handover would be deciding the fate
        // of a tab it does not have.
        assert_eq!(strips.take_reservation(token, "doc-1"), None);
        assert_eq!(strips.take_reservation(token + 1, "main"), None);
        assert!(strips.take_reservation(token, "main").is_some());
        // Taken once and once only: a second commit has nothing to report.
        assert_eq!(strips.take_reservation(token, "main"), None);
        let _ = registry.take_pending("doc-1");
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-1"));
    }

    #[test]
    fn a_cancelled_reservation_hands_the_claim_and_the_queue_straight_back() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        // The write a move costs can fail. A document whose file was never
        // written must not arrive anywhere.
        let cancelled = strips.take_reservation(token, "main").expect("held");
        assert!(registry.revoke_pending(&cancelled.target, token));
        assert!(claims
            .transfer(&cancelled.path, &cancelled.target, &cancelled.from)
            .granted);
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("doc-1").is_empty());
    }

    // ── Destruction, on both sides of the report ──────────────────────────

    // ── The reservation gate on the queue ─────────────────────────────────

    #[test]
    fn a_target_draining_before_the_commit_takes_nothing_and_leaves_the_rollback_its_entry() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        // The receiving window drains on mount and on every open signal, and
        // both can land here — between the reservation and the commit, while
        // the source is still writing its working copy over the user's file.
        // An open taken now reads the bytes that write replaces.
        assert!(registry.take_deliverable("doc-1").is_empty());

        // And the entry is still there, which is the other half: a drain that
        // removed it would leave the destruction rollback nothing to give back.
        let sweep = strips.sweep_destroyed(&claims, &registry, "doc-1", &live(&["main"]));
        assert_eq!(sweep, DestroySweep::default());
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        let voided = strips.take_reservation(token, "main").expect("held");
        assert!(voided.void);
    }

    #[test]
    fn a_commit_makes_the_handover_drainable_by_a_window_that_already_drained() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        assert!(registry.take_deliverable("doc-1").is_empty());

        // What `tabdrag_commit` does before it signals: the file has been
        // written, so the entry becomes visible and the target is nudged to
        // drain again — a window that already looked and found nothing.
        assert!(strips.take_reservation(token, "main").is_some());
        assert!(registry.release_pending("doc-1", token));
        let drained = registry.take_deliverable("doc-1");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].files, vec![DOC.to_string()]);
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-1"));
    }

    #[test]
    fn a_target_destroyed_before_the_commit_voids_the_reservation_and_returns_nothing() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        // The window died in the gap the atomic unit does not cover: after the
        // claim and the queue moved, before the source was told anything. The
        // source is still waiting on the commit, so the document goes back
        // silently and the commit is where it hears that nothing moved.
        let sweep = strips.sweep_destroyed(&claims, &registry, "doc-1", &live(&["main"]));
        assert_eq!(sweep, DestroySweep::default());
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("doc-1").is_empty());

        let voided = strips.take_reservation(token, "main").expect("held");
        assert!(voided.void);
        // And the cancel path must not move the claim a second time: it is
        // already back with the window that never let go of the tab.
        assert!(!registry.revoke_pending("doc-1", token));
    }

    #[test]
    fn a_target_destroyed_after_the_commit_gives_the_document_back_to_its_source() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        // Committed: the source has been told the document changed hands and
        // has closed the only tab that had it. The queue entry is still there,
        // so the receiving window never opened it — and its destruction would
        // otherwise release the claim into the pool with the tab already gone.
        let reported = strips.take_reservation(token, "main").expect("held");
        assert!(!reported.void);

        let sweep = strips.sweep_destroyed(&claims, &registry, "doc-1", &live(&["main"]));
        assert_eq!(sweep.returned, vec![("main".to_string(), DOC.to_string())]);
        assert!(sweep.deliver.is_empty());
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
    }

    #[test]
    fn a_document_whose_source_is_gone_too_goes_to_a_window_that_can_open_it() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        assert!(strips.take_reservation(token, "main").is_some());
        // Both ends of the handover are gone. A path released into the pool
        // here is a document the user cannot get back without knowing where it
        // was, so any window that is still standing beats none.
        let sweep = strips.sweep_destroyed(&claims, &registry, "doc-1", &live(&["doc-2"]));
        assert_eq!(sweep.returned, vec![("doc-2".to_string(), DOC.to_string())]);
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-2"));
    }

    #[test]
    fn a_document_with_nowhere_left_to_go_is_not_pushed_into_the_window_that_died() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        assert!(strips.take_reservation(token, "main").is_some());
        // The last window closing is the app closing: there is no recovery to
        // make, and naming the destroyed label would be one.
        let sweep = strips.sweep_destroyed(&claims, &registry, "doc-1", &live(&["doc-1"]));
        assert_eq!(sweep, DestroySweep::default());
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-1"));
    }

    #[test]
    fn a_source_destroyed_holding_a_reservation_has_its_delivery_finished_for_it() {
        let (strips, claims, registry) = two_windows();
        let token = reserve_onto_doc1(&strips, &claims, &registry);
        // The document is already the target's and the open is already queued;
        // only the signal was waiting on a window that will never send it.
        let sweep = strips.sweep_destroyed(&claims, &registry, "main", &live(&["doc-1"]));
        assert_eq!(sweep.deliver.len(), 1);
        assert_eq!(sweep.deliver[0].target, "doc-1");
        assert!(sweep.returned.is_empty());
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-1"));
        // Finished for it INCLUDES the release the commit would have done:
        // an entry left reserved is one no drain can ever take, and the
        // window that owns the document would never open it.
        assert_eq!(registry.take_deliverable("doc-1").len(), 1);
        // The reservation goes with the window that made it, so no later
        // destruction can void a handover nobody is waiting on.
        assert_eq!(strips.take_reservation(token, "main"), None);
    }

    #[test]
    fn an_ordinary_queued_open_is_not_a_handover_and_is_not_handed_back() {
        let (strips, claims, registry) = two_windows();
        // A shell association routed to a window that then closed. Nothing was
        // claimed for it, so there is nothing to give back — and inventing a
        // return would open a document in a window that never asked for it.
        assert!(app_windows::queue_open(
            &registry,
            "doc-1",
            vec!["C:\\docs\\b.pdf".to_string()],
            false
        ));
        let sweep = strips.sweep_destroyed(&claims, &registry, "doc-1", &live(&["main"]));
        assert_eq!(sweep, DestroySweep::default());
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
    }
}
