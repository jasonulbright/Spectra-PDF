//! Window geometry, and the documents each window held when the app last quit.
//!
//! Both live on this side rather than in localStorage. A window has a position
//! before its renderer exists and still has one after a renderer that never
//! booted, so the record has to outlive the webview that would otherwise own
//! it. Every input to the file — the window list, each window's rectangle, the
//! paths each window holds — is read from state on this side, so nothing about
//! the capture can be delayed or falsified by a renderer that stopped
//! answering.
//!
//! Rectangles are PHYSICAL screen pixels, taken as `outer_position` plus
//! `inner_size` and restored through `set_position`/`set_size`, which read and
//! write exactly those two. Mixing in the frame would make the round trip
//! inexact by the border and title-bar thickness, and the thickness grows with
//! display scaling.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::app_windows::{self, ClaimState, WindowRegistry, MAIN_LABEL};

const SESSION_FILE: &str = "session.json";

/// How long a move or resize has to stop before the file is rewritten. A drag
/// delivers hundreds of events; the in-memory record follows every one of them
/// and the disk write waits for the gesture to end.
const WRITE_DEBOUNCE: Duration = Duration::from_millis(600);

/// The fraction of a restored window that has to fall on some monitor for the
/// saved position to be used. Below it the display it was saved on is gone or
/// has shrunk, and the window would open where nobody can reach it.
const MIN_VISIBLE_NUMERATOR: i64 = 1;
const MIN_VISIBLE_DENOMINATOR: i64 = 4;

/// How long an app-level quit waits for the windows it asked to close to
/// acknowledge the request before calling the quit off.
///
/// A window whose listener is installed answers in a round trip across the IPC
/// boundary — under a millisecond. The only reason to wait longer is a window
/// whose renderer has not finished mounting, which is the case this gate exists
/// for, and a cold webview boot on a loaded machine stays well inside this.
/// Past it the wait is indistinguishable from a renderer that will never
/// answer, and holding Exit open any longer reads as a hung app.
const QUIT_ACK_TIMEOUT: Duration = Duration::from_secs(3);

// ── Records ───────────────────────────────────────────────────────────────

/// A rectangle in physical screen pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn area(&self) -> i64 {
        self.width.max(0) as i64 * self.height.max(0) as i64
    }

    /// Widened to i64 before any addition: a saved rectangle is arbitrary
    /// persisted data, and `x + width` on two i32 extremes wraps.
    fn intersection_area(&self, other: &Rect) -> i64 {
        let left = (self.x as i64).max(other.x as i64);
        let right = (self.x as i64 + self.width as i64).min(other.x as i64 + other.width as i64);
        let top = (self.y as i64).max(other.y as i64);
        let bottom = (self.y as i64 + self.height as i64).min(other.y as i64 + other.height as i64);
        (right - left).max(0) * (bottom - top).max(0)
    }
}

/// Where a window sits and whether it is maximized. The rectangle is always
/// the RESTORE rectangle: while a window is maximized the OS reports the
/// maximized bounds, so the last un-maximized rectangle is kept instead and a
/// window restored maximized still has somewhere to un-maximize to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub rect: Rect,
    pub maximized: bool,
}

/// Which window a record describes. The main window is created in Rust setup
/// and restored in place; every other record builds a new document window,
/// whose label is minted fresh because labels are per-run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelKind {
    Main,
    Doc,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    pub label_kind: LabelKind,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
    /// The display the window was on when the record was written.
    #[serde(default)]
    pub monitor: String,
    /// Open documents, by path. Paths only: page and document ids are minted
    /// per renderer against a generation counter, so no id survives a run.
    #[serde(default)]
    pub files: Vec<String>,
}

impl WindowRecord {
    pub fn placement(&self) -> Placement {
        Placement {
            rect: Rect {
                x: self.x,
                y: self.y,
                width: self.width,
                height: self.height,
            },
            maximized: self.maximized,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub windows: Vec<WindowRecord>,
}

pub const SESSION_VERSION: u32 = 1;

// ── Pure placement arithmetic ─────────────────────────────────────────────

/// Centre a rectangle in an area, shrinking it to fit rather than hanging off
/// an edge the user cannot drag back from.
fn center_in(rect: Rect, area: Rect) -> Rect {
    let width = rect.width.min(area.width).max(0);
    let height = rect.height.min(area.height).max(0);
    Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y + (area.height - height) / 2,
        width,
        height,
    }
}

/// Where a saved rectangle can actually be shown on the monitors that exist
/// now.
///
/// A saved position is kept whenever enough of it lands on some monitor; the
/// display arrangement changing under a window is ordinary, and nudging every
/// window that straddles an edge would be worse than leaving it. Below the
/// floor the window is centred on the primary work area at its saved size,
/// clamped so a window saved larger than the display it now opens on still
/// fits.
pub fn place_rect(saved: Rect, monitors: &[Rect], primary_work_area: Rect) -> Rect {
    let area = saved.area();
    if area <= 0 {
        return center_in(saved, primary_work_area);
    }
    let visible: i64 = monitors.iter().map(|m| saved.intersection_area(m)).sum();
    if visible * MIN_VISIBLE_DENOMINATOR >= area * MIN_VISIBLE_NUMERATOR {
        return saved;
    }
    center_in(saved, primary_work_area)
}

// ── Pure launch decision ──────────────────────────────────────────────────

/// What a launch does with the saved session.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchPlan {
    /// The main window's geometry, applied on every launch: geometry belongs
    /// to the window and is not what the preference gates.
    pub main: Option<Placement>,
    /// Documents to re-open in the main window.
    pub main_files: Vec<String>,
    /// Windows to rebuild, in recorded order.
    pub extra: Vec<WindowRecord>,
}

/// Split a saved session into the part every launch applies and the part the
/// preference gates.
///
/// With the preference off a launch is indistinguishable from a first run
/// except that the main window comes back where it was left: no document
/// opens and no second window appears.
///
/// A launch always has a main window, so one record always lands on it. When
/// the session was saved with the main window already closed there is no record
/// of that kind, and the first record takes the slot instead — treating every
/// record as an extra would open an empty main window beside the ones that were
/// actually saved. Which record adopts the slot is structural rather than
/// preferential: the preference gates documents and additional windows, so with
/// it off the adopting record still contributes the geometry and nothing else.
pub fn plan_launch(session: &Session, restore_windows: bool) -> LaunchPlan {
    let adopted = session
        .windows
        .iter()
        .position(|w| w.label_kind == LabelKind::Main)
        .or(if session.windows.is_empty() {
            None
        } else {
            Some(0)
        });
    let main = adopted.map(|i| &session.windows[i]);
    LaunchPlan {
        main: main.map(|w| w.placement()),
        main_files: if restore_windows {
            main.map(|w| w.files.clone()).unwrap_or_default()
        } else {
            Vec::new()
        },
        extra: if restore_windows {
            session
                .windows
                .iter()
                .enumerate()
                .filter(|(i, _)| Some(*i) != adopted)
                .map(|(_, w)| w.clone())
                .collect()
        } else {
            Vec::new()
        },
    }
}

// ── Live state ────────────────────────────────────────────────────────────

/// What became of one attempt to put the record on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    /// The snapshot replaced the file.
    Written,
    /// The seal state refused the call: nothing was attempted and nothing on
    /// disk changed.
    Refused,
    /// The write was attempted and did not land. The previous record is still
    /// the file's contents.
    Failed,
}

#[derive(Clone, Debug)]
struct Geometry {
    placement: Placement,
    monitor: String,
}

/// Every live window's restore geometry, plus the debounce bookkeeping for the
/// file behind it.
pub struct SessionState {
    geometry: Mutex<HashMap<String, Geometry>>,
    /// The tab order each window last published.
    ///
    /// DATA, not a question asked of a renderer: the capture reads whatever
    /// was published last and never waits, so a window that stopped answering
    /// costs a stale arrangement rather than a delayed quit. It arranges only
    /// — which documents a window holds is the claim table's answer, and a
    /// stale order can neither add a path nor lose one.
    ///
    /// A leaf lock like `geometry`: taken under `writer` while a snapshot is
    /// built, and never while `geometry` is held.
    orders: Mutex<HashMap<String, Vec<String>>>,
    /// Bumped on every change. The debounce thread writes only after a sleep
    /// during which this did not move.
    revision: AtomicU64,
    /// Whether a debounce thread is already pending, so a burst of moves
    /// spawns one thread rather than one per event.
    scheduled: AtomicBool,
    /// Set once the quit snapshot is written. Nothing may write while it
    /// stands: the windows are being torn down, and a later write would record
    /// a session that has already half-disappeared. An exit that is cancelled
    /// clears it again — the tear-down it protects against never happened.
    sealed: AtomicBool,
    /// Held across every write to the file, across the seal, and across the
    /// unseal, so that moving the seal and writing the snapshot that goes with
    /// it is one critical section. Taken before the geometry map is read and
    /// never after: `geometry` is never held while this is acquired.
    writer: Mutex<()>,
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            geometry: Mutex::new(HashMap::new()),
            orders: Mutex::new(HashMap::new()),
            revision: AtomicU64::new(0),
            scheduled: AtomicBool::new(false),
            sealed: AtomicBool::new(false),
            writer: Mutex::new(()),
        }
    }

    /// Write unless the file is sealed.
    ///
    /// `build` runs outside the lock: a snapshot reads the window manager and
    /// the claim table, and holding the file against that would queue every
    /// debounced write behind an unrelated one. The seal is then read AGAIN
    /// inside the lock, because a writer that read it unsealed can be
    /// descheduled for arbitrarily long and the last thing on disk after a
    /// quit has to be the quit snapshot.
    fn write_checked<T>(
        &self,
        build: impl FnOnce() -> T,
        sink: impl FnOnce(T) -> std::io::Result<()>,
    ) -> WriteOutcome {
        if self.sealed.load(Ordering::SeqCst) {
            return WriteOutcome::Refused;
        }
        let payload = build();
        let _guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if self.sealed.load(Ordering::SeqCst) {
            return WriteOutcome::Refused;
        }
        match sink(payload) {
            Ok(()) => WriteOutcome::Written,
            // A debounced write that failed is not lost work: the record it
            // describes is still live, and the next change schedules another.
            Err(_) => WriteOutcome::Failed,
        }
    }

    /// Take the seal and write the quit snapshot under it. The first caller
    /// wins and every later quit path finds the file closed.
    ///
    /// The seal stands only over a snapshot that actually reached disk. A write
    /// that failed leaves the previous record as the file's contents and the
    /// windows still standing, so holding the file closed on top of it would
    /// treat a lost snapshot as the durable one and silence every write for the
    /// rest of the run; the seal comes off instead and live tracking continues.
    /// The retry is what makes that rare: the destination cannot be replaced
    /// while another process holds it open, which is transient by nature.
    ///
    /// A poisoned lock is recovered rather than propagated: it guards a unit,
    /// and refusing the quit snapshot because an unrelated thread panicked
    /// would lose the session the user is quitting with.
    fn seal_and_write(&self, sink: impl Fn() -> std::io::Result<()>) -> WriteOutcome {
        let _guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if self.sealed.swap(true, Ordering::SeqCst) {
            return WriteOutcome::Refused;
        }
        if sink().or_else(|_| sink()).is_ok() {
            return WriteOutcome::Written;
        }
        self.sealed.store(false, Ordering::SeqCst);
        WriteOutcome::Failed
    }

    /// Drop the seal and write what replaces the sealed snapshot, under one
    /// hold of the same lock the sealer takes.
    ///
    /// The write is not separable from the clearing. The file still holds the
    /// capture taken when the exit was decided, which describes windows that
    /// have since closed; re-enabling writes without replacing it leaves that
    /// capture on disk as if it were current until something else happens to
    /// write, and nothing has to.
    ///
    /// `sink` builds inside the lock rather than before it, because a payload
    /// built before the seal came off is a reading of the tear-down it
    /// describes the end of.
    ///
    /// Returns whether the file was sealed. A quit prompted several windows
    /// and any number of them can cancel, so every cancel calls this and only
    /// the first one finds a seal to lift.
    fn unseal_and_write(&self, sink: impl FnOnce() -> std::io::Result<()>) -> WriteOutcome {
        let _guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if !self.sealed.swap(false, Ordering::SeqCst) {
            return WriteOutcome::Refused;
        }
        match sink() {
            Ok(()) => WriteOutcome::Written,
            // The seal is off either way — that half is what puts the run back
            // under live tracking, and the stale capture the write meant to
            // replace is now replaceable by the next debounced write.
            Err(_) => WriteOutcome::Failed,
        }
    }

    pub fn is_sealed(&self) -> bool {
        self.sealed.load(Ordering::SeqCst)
    }

    fn remember(&self, label: &str, geometry: Geometry) {
        if let Ok(mut map) = self.geometry.lock() {
            map.insert(label.to_string(), geometry);
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    /// Fold a fresh reading into what is already known.
    ///
    /// A maximized window contributes only its flag: its reported bounds are
    /// the maximized ones, and overwriting the restore rectangle with them
    /// would leave a window that un-maximizes to the whole screen.
    fn observe(&self, label: &str, placement: Placement, monitor: String) {
        if let Ok(mut map) = self.geometry.lock() {
            match map.get_mut(label) {
                Some(known) => {
                    known.placement.maximized = placement.maximized;
                    if !placement.maximized {
                        known.placement.rect = placement.rect;
                        known.monitor = monitor;
                    }
                }
                None => {
                    map.insert(label.to_string(), Geometry { placement, monitor });
                }
            }
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    fn get(&self, label: &str) -> Option<Geometry> {
        self.geometry.lock().ok()?.get(label).cloned()
    }

    /// Last write wins: the newest statement of a window's arrangement is the
    /// only one worth keeping, and the publisher on the other side already
    /// sends them one at a time.
    fn set_order(&self, label: &str, paths: Vec<String>) {
        if let Ok(mut map) = self.orders.lock() {
            map.insert(label.to_string(), paths);
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    fn order(&self, label: &str) -> Vec<String> {
        self.orders
            .lock()
            .ok()
            .and_then(|map| map.get(label).cloned())
            .unwrap_or_default()
    }

    fn forget(&self, label: &str) {
        if let Ok(mut map) = self.geometry.lock() {
            map.remove(label);
        }
        if let Ok(mut map) = self.orders.lock() {
            map.remove(label);
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
    }
}

// ── The quit gate ─────────────────────────────────────────────────────────

/// What a quit is told to do once the windows it asked have answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitGate {
    /// Every prompted window acknowledged; the initiator may close.
    Proceed,
    /// At least one window never answered. The quit is off: nothing closes and
    /// the session goes back to live tracking.
    Abort,
}

/// The payload of `app:beforeClose`.
///
/// A window × carries no quit id, because no quit is waiting on it. A quit
/// carries its own, so a receipt names the quit it belongs to rather than
/// merely the window it came from: a receipt that arrives after its quit was
/// called off must not satisfy the next quit's expectation of that window.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeClose {
    pub quit_id: Option<u64>,
}

struct PendingQuit {
    id: u64,
    /// The windows that have not yet acknowledged.
    outstanding: Vec<String>,
}

/// The receipts an app-level quit is waiting on.
///
/// The quit sequence is fail-closed on delivery: the session is captured and
/// the file sealed before any window is asked to close, so a request that never
/// reaches a renderer would leave that window standing behind a frozen record —
/// the initiator closes, the survivor does not, and nothing the user does for
/// the rest of the run is ever written. A request is therefore not assumed
/// delivered because the emit returned; each window says so, and a window that
/// does not say so calls the quit off.
pub struct QuitAcks {
    pending: Mutex<Option<PendingQuit>>,
    answered: Condvar,
    /// Quit ids are minted from 1, so 0 never names one.
    next_id: AtomicU64,
}

impl QuitAcks {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
            answered: Condvar::new(),
            next_id: AtomicU64::new(0),
        }
    }

    /// Open a quit waiting on `labels`, replacing any quit still in flight —
    /// which can only be one that was already abandoned, since a live quit
    /// either closes the app or is called off before another can start.
    pub fn begin(&self, labels: Vec<String>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        *pending = Some(PendingQuit {
            id,
            outstanding: labels,
        });
        self.answered.notify_all();
        id
    }

    /// Record one window's receipt. Returns whether it was one the quit named:
    /// a receipt for a quit that is over, or from a window that was never
    /// prompted, changes nothing.
    pub fn ack(&self, id: u64, label: &str) -> bool {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let Some(quit) = pending.as_mut() else {
            return false;
        };
        if quit.id != id {
            return false;
        }
        let before = quit.outstanding.len();
        quit.outstanding.retain(|l| l != label);
        if quit.outstanding.len() == before {
            return false;
        }
        self.answered.notify_all();
        true
    }

    /// Call a quit off without waiting it out. Returns whether it was still the
    /// quit in flight.
    pub fn abort(&self, id: u64) -> bool {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.as_ref().is_some_and(|quit| quit.id == id) {
            *pending = None;
            self.answered.notify_all();
            return true;
        }
        false
    }

    /// Block until every prompted window has answered, or `timeout` runs out.
    ///
    /// Either way the quit is closed out before this returns, so a receipt that
    /// arrives afterwards finds nothing to satisfy. A quit that prompted no
    /// window — the only window is the one that asked — is already answered and
    /// never waits.
    pub fn wait(&self, id: u64, timeout: Duration) -> QuitGate {
        let deadline = Instant::now() + timeout;
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match pending.as_ref() {
                Some(quit) if quit.id == id => {
                    if quit.outstanding.is_empty() {
                        *pending = None;
                        return QuitGate::Proceed;
                    }
                }
                // Called off, or replaced by a later quit: either way this one
                // is not the quit that may proceed.
                _ => return QuitGate::Abort,
            }
            let now = Instant::now();
            if now >= deadline {
                *pending = None;
                return QuitGate::Abort;
            }
            let (guard, _) = self
                .answered
                .wait_timeout(pending, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            pending = guard;
        }
    }
}

impl Default for QuitAcks {
    fn default() -> Self {
        Self::new()
    }
}

/// Windows spells one file many ways and both sides hold the canonical
/// spelling, so this compares two spellings of the same path rather than
/// deciding identity — which is the raw string, settled at the boundary.
fn same_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// A window's documents, arranged by the order it last published.
///
/// Membership is the claim table's answer and arrangement is the renderer's,
/// so the two are combined rather than one trusted for both: a path the window
/// holds but never named appends (it opened after the last publish, or the
/// strip was not mounted to publish at all), and a path named but no longer
/// held drops out (it was closed, or handed to another window). A window that
/// never published anything keeps the claim table's own order.
fn arrange(order: &[String], claimed: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(claimed.len());
    for named in order {
        if let Some(path) = claimed.iter().find(|p| same_path(p, named)) {
            if !out.iter().any(|p| same_path(p, path)) {
                out.push(path.clone());
            }
        }
    }
    for path in claimed {
        if !out.iter().any(|p| same_path(p, &path)) {
            out.push(path);
        }
    }
    out
}

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Reading the live windows ──────────────────────────────────────────────

fn read_placement(window: &WebviewWindow) -> Option<Placement> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Placement {
        rect: Rect {
            x: position.x,
            y: position.y,
            width: size.width as i32,
            height: size.height as i32,
        },
        maximized: window.is_maximized().unwrap_or(false),
    })
}

fn read_monitor(window: &WebviewWindow) -> String {
    window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned())
        .unwrap_or_default()
}

fn monitor_rects(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width as i32,
            height: m.size().height as i32,
        })
        .collect()
}

/// The area a displaced window is centred in. The work area rather than the
/// whole monitor, so a centred window is never parked under the taskbar.
fn primary_work_area(app: &AppHandle) -> Option<Rect> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let area = monitor.work_area();
    Some(Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width as i32,
        height: area.size.height as i32,
    })
}

// ── Building the snapshot ─────────────────────────────────────────────────

fn label_kind(label: &str) -> LabelKind {
    if label == MAIN_LABEL {
        LabelKind::Main
    } else {
        LabelKind::Doc
    }
}

/// Which windows a snapshot covers: every live workspace window, plus any
/// label the geometry map still holds.
///
/// The second half is what makes the quit snapshot survive its own ordering —
/// the last window may already be out of the manager by the time its
/// destruction is reported here, and dropping it would write a session with no
/// windows in it. `gone` names a window whose destruction is already known.
fn snapshot_labels(app: &AppHandle, gone: Option<&str>) -> Vec<String> {
    let mut labels = app_windows::app_window_labels(app);
    if let Ok(map) = app.state::<SessionState>().geometry.lock() {
        for label in map.keys() {
            if !labels.iter().any(|l| l == label) {
                labels.push(label.clone());
            }
        }
    }
    labels.retain(|l| Some(l.as_str()) != gone);
    labels.sort();
    labels
}

/// Every window the snapshot covers, with the documents it owns.
///
/// The documents come from the claim table, which is this side's own record of
/// who holds what — no window is asked anything, so a window whose renderer has
/// stopped answering still contributes its documents.
fn snapshot_excluding(app: &AppHandle, gone: Option<&str>) -> Session {
    let state = app.state::<SessionState>();
    let claims = app.state::<ClaimState>();
    let mut windows = Vec::new();
    for label in snapshot_labels(app, gone) {
        let known = state.get(&label);
        let live = app.get_webview_window(&label);
        let placement = match (&known, &live) {
            (Some(known), _) => known.placement,
            (None, Some(window)) => match read_placement(window) {
                Some(placement) => placement,
                None => continue,
            },
            (None, None) => continue,
        };
        let monitor = match &known {
            Some(known) => known.monitor.clone(),
            None => live.as_ref().map(read_monitor).unwrap_or_default(),
        };
        windows.push(WindowRecord {
            label_kind: label_kind(&label),
            x: placement.rect.x,
            y: placement.rect.y,
            width: placement.rect.width,
            height: placement.rect.height,
            maximized: placement.maximized,
            monitor,
            files: arrange(&state.order(&label), claims.write_claims(&label)),
        });
    }
    // The main window first, so a reader that wants it does not have to search.
    windows.sort_by_key(|w| w.label_kind != LabelKind::Main);
    Session {
        version: SESSION_VERSION,
        windows,
    }
}

// ── The file ──────────────────────────────────────────────────────────────

fn session_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::portable::data_root(app).ok()?;
    std::fs::create_dir_all(&dir).ok();
    Some(dir.join(SESSION_FILE))
}

pub fn load(app: &AppHandle) -> Session {
    let Some(path) = session_path(app) else {
        return Session::default();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Session::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

/// Where a write stages its bytes: beside the file, so landing them is a
/// directory-entry swap on one volume rather than a copy. Per process, because
/// two processes writing the same record must not share a staging name.
fn staging_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(SESSION_FILE);
    path.with_file_name(format!("{}.{}.tmp", name, std::process::id()))
}

/// Replace the record in one step.
///
/// A write straight over the file has a window in which the file is neither
/// the old session nor the new one, and a death inside it loses both. The bytes
/// go to a staging name, are flushed, and take the file's name by rename — so
/// the file is only ever one whole record or the other. A failure takes the
/// staged bytes with it rather than leaving them beside the record.
fn write_staged(path: &Path, json: &str) -> std::io::Result<()> {
    let staged = staging_path(path);
    let landed = (|| {
        let mut file = std::fs::File::create(&staged)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&staged, path)
    })();
    if landed.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    landed
}

fn write(app: &AppHandle, session: &Session) -> std::io::Result<()> {
    let Some(path) = session_path(app) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no app data directory",
        ));
    };
    let json = serde_json::to_string(session)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_staged(&path, &json)
}

fn write_now(app: &AppHandle, gone: Option<&str>) -> WriteOutcome {
    app.state::<SessionState>()
        .write_checked(|| snapshot_excluding(app, gone), |s| write(app, &s))
}

/// Write after the moving stops.
///
/// One thread per burst rather than one per event, and it re-checks the
/// revision after writing so a move that arrived mid-write is not the one that
/// never reaches disk.
fn schedule_write(app: &AppHandle) {
    {
        let state = app.state::<SessionState>();
        if state.sealed.load(Ordering::SeqCst) {
            return;
        }
        if state.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let seen = app.state::<SessionState>().revision.load(Ordering::SeqCst);
        std::thread::sleep(WRITE_DEBOUNCE);
        let state = app.state::<SessionState>();
        if state.revision.load(Ordering::SeqCst) != seen {
            continue;
        }
        let _ = write_now(&app, None);
        state.scheduled.store(false, Ordering::SeqCst);
        if state.revision.load(Ordering::SeqCst) == seen {
            return;
        }
        if state.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
    });
}

/// Take the quit snapshot and close the file to further writes.
///
/// Called before anything is torn down, from every path that decides the app
/// is exiting. Idempotent: the first caller wins and the destroy events that
/// follow find the file sealed.
///
/// An app-level Exit closes windows one at a time and each destruction writes
/// the closing window out of the record, so this has to run at the point the
/// exit is DECIDED rather than at the point the last window dies — a snapshot
/// taken any later describes whichever window happened to close last and
/// nothing else.
/// A capture that could not be written leaves the file unsealed, and the
/// outcome says so: the record on disk is the previous one, not this quit's.
pub fn capture_and_seal(app: &AppHandle) -> WriteOutcome {
    app.state::<SessionState>()
        .seal_and_write(|| write(app, &snapshot_excluding(app, None)))
}

/// Return the session to live tracking after an exit that did not happen.
///
/// A quit seals the file before any window is asked anything, so a window that
/// then cancels leaves the app running behind a snapshot of the moment the
/// exit was decided: the windows that did close during the aborted exit are
/// still in it, and every later open, close and move goes unrecorded for the
/// rest of the run.
///
/// Both halves matter. The fresh snapshot replaces a record that has already
/// stopped being true, and clearing the seal puts the ordinary debounced
/// writes back.
pub fn unseal(app: &AppHandle) -> WriteOutcome {
    app.state::<SessionState>()
        .unseal_and_write(|| write(app, &snapshot_excluding(app, None)))
}

/// Wait out a quit's receipts, putting the session back under live tracking
/// when the quit is called off.
///
/// The unseal is the same one a cancelled prompt runs: an exit that does not
/// happen has to leave the record following the windows that are still there,
/// and an unanswered request is an exit that does not happen.
pub fn await_quit_acks(app: &AppHandle, id: u64) -> QuitGate {
    let gate = app.state::<QuitAcks>().wait(id, QUIT_ACK_TIMEOUT);
    if gate == QuitGate::Abort {
        unseal(app);
    }
    gate
}

/// Call a quit off before it was ever waited on — a request that could not be
/// delivered is one that will never be answered.
pub fn abandon_quit(app: &AppHandle, id: u64) {
    app.state::<QuitAcks>().abort(id);
    unseal(app);
}

/// Wait out the PREPARE round's receipts.
///
/// The same wait as the close round's, minus the unseal: nothing is sealed yet
/// when this runs, and calling the unseal here would write a fresh snapshot for
/// a quit that has not captured anything.
pub fn await_prepare_acks(app: &AppHandle, id: u64) -> QuitGate {
    app.state::<QuitAcks>().wait(id, QUIT_ACK_TIMEOUT)
}

/// Call off a PREPARE round that could not be delivered. Nothing is sealed, so
/// there is nothing to put back.
pub fn abandon_prepare(app: &AppHandle, id: u64) {
    app.state::<QuitAcks>().abort(id);
}

/// Order the three steps of an app-level quit.
///
/// The capture sits strictly BETWEEN the two rounds, and that is the whole
/// point of there being two. Each window publishes its tab order through a
/// channel nothing waits on, so an order changed seconds before Exit can still
/// be in flight when the quit is decided. Capturing first sealed over it: the
/// initiating window flushed its own, and every peer flushed only when it heard
/// the close request — which the seal already preceded, so a reorder made in
/// window B was lost whenever window A exited.
///
/// So the peers are asked to flush and say so BEFORE anything is captured. Only
/// once every one of them has answered does the record get taken and sealed,
/// and only then are they asked to close. A round nobody answers aborts with
/// nothing captured and nothing sealed.
///
/// A capture that FAILED aborts too. `seal_and_write` has already lifted the
/// seal on that outcome, so the file still holds the previous run's record;
/// closing the windows now would exit having silently thrown this session away,
/// with the windows that could still be captured already gone.
pub fn sequence_quit(
    prepare: impl FnOnce() -> QuitGate,
    capture: impl FnOnce() -> WriteOutcome,
    close: impl FnOnce() -> QuitGate,
) -> bool {
    if prepare() == QuitGate::Abort {
        return false;
    }
    if capture() == WriteOutcome::Failed {
        return false;
    }
    close() == QuitGate::Proceed
}

/// Whether a teardown may go ahead on the outcome of its own quit snapshot.
///
/// A snapshot that did not land leaves the previous record as the file's
/// contents, and `seal_and_write` lifts the seal rather than holding the file
/// closed over a snapshot that never reached disk. Destroying the windows on
/// that outcome exits with some earlier run's session on disk and nothing left
/// alive to write this one from. `Refused` is a different answer: another path
/// sealed first, so this session is already recorded.
pub fn teardown_permitted(capture: WriteOutcome) -> bool {
    capture != WriteOutcome::Failed
}

// ── Applying geometry ─────────────────────────────────────────────────────

/// Put a window where the record says, adjusted for the monitors that exist
/// now, and record what was actually applied so the next capture agrees with
/// the screen.
pub fn apply_placement(app: &AppHandle, window: &WebviewWindow, placement: Placement) {
    let primary = primary_work_area(app).unwrap_or(placement.rect);
    let rect = place_rect(placement.rect, &monitor_rects(app), primary);
    if rect.width <= 0 || rect.height <= 0 {
        return;
    }
    let _ = window.set_size(PhysicalSize::new(rect.width as u32, rect.height as u32));
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
    app.state::<SessionState>().remember(
        window.label(),
        Geometry {
            placement: Placement {
                rect,
                maximized: placement.maximized,
            },
            monitor: read_monitor(window),
        },
    );
    if placement.maximized {
        let _ = window.maximize();
    }
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────

/// Record a window's new geometry after the OS moved or resized it.
///
/// A minimized window is ignored outright: Windows parks it at an off-screen
/// origin, and recording that would restore every window to the far corner of
/// nowhere.
pub fn on_window_geometry_changed(app: &AppHandle, label: &str) {
    if !app_windows::is_app_window(label) {
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let Some(placement) = read_placement(&window) else {
        return;
    };
    app.state::<SessionState>()
        .observe(label, placement, read_monitor(&window));
    schedule_write(app);
}

/// Record a window's tab order and let the file catch up.
///
/// The write is scheduled rather than immediate for the same reason a move's
/// is: an open changes the order once per document, and the record only has to
/// be right when it is read. A sealed file refuses it like any other write, so
/// a publish arriving during a quit cannot reopen the record.
pub fn publish_tab_order(app: &AppHandle, label: &str, paths: Vec<String>) {
    if !app_windows::is_app_window(label) {
        return;
    }
    app.state::<SessionState>().set_order(label, paths);
    schedule_write(app);
}

/// Seed a freshly built window's geometry, so a window maximized before it was
/// ever seen in its normal state still has a restore rectangle.
pub fn on_window_created(app: &AppHandle, window: &WebviewWindow) {
    if !app_windows::is_app_window(window.label()) {
        return;
    }
    if let Some(placement) = read_placement(window) {
        app.state::<SessionState>().remember(
            window.label(),
            Geometry {
                placement,
                monitor: read_monitor(window),
            },
        );
    }
}

/// The last workspace window's destruction is a quit, whichever path led to
/// it: the snapshot is taken while this window's geometry and claims are still
/// standing, because releasing them is what happens next.
///
/// Runs before `app_windows::on_window_destroyed`, which drops the claims the
/// snapshot reads.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if !app_windows::is_app_window(label) {
        return;
    }
    let others = app_windows::app_window_labels(app)
        .into_iter()
        .filter(|l| l != label)
        .count();
    if others == 0 {
        capture_and_seal(app);
        return;
    }
    let _ = write_now(app, Some(label));
    app.state::<SessionState>().forget(label);
}

// ── Launch ────────────────────────────────────────────────────────────────

/// Restore the main window's geometry, and — when the preference allows it —
/// the rest of the session.
///
/// Documents are queued through the pending-open queue rather than opened here:
/// a window built for an open has no renderer yet, which is the case that queue
/// exists for, and draining it runs the one open funnel. A path that has since
/// been deleted is reported by that funnel's own missing-file handling.
pub fn apply_launch(app: &AppHandle, restore_windows: bool, e2e: bool, show: bool) {
    let plan = plan_launch(&load(app), restore_windows);
    if let Some(placement) = plan.main {
        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
            apply_placement(app, &window, placement);
        }
    }
    if !plan.main_files.is_empty() {
        app_windows::deliver_open(app, MAIN_LABEL, plan.main_files, false);
    }
    for record in plan.extra {
        let label = app.state::<WindowRegistry>().next_doc_label();
        if !record.files.is_empty() {
            app_windows::deliver_open(app, &label, record.files.clone(), false);
        }
        // Built hidden and placed before it is shown: a window that appears
        // centred and then jumps to its saved corner reads as two windows.
        match app_windows::build_app_window(app, &label, e2e) {
            Ok(window) => {
                apply_placement(app, &window, record.placement());
                if show {
                    app_windows::show_when_ready(app, &label, false);
                }
            }
            Err(_) => {
                // Nothing will drain a queue for a window that was never built.
                app.state::<WindowRegistry>().forget(&label);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::{mpsc, Arc};

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// 1920×1080 primary at the origin, 1920×1080 secondary to its left.
    fn two_monitors() -> Vec<Rect> {
        vec![rect(0, 0, 1920, 1080), rect(-1920, 0, 1920, 1080)]
    }

    fn primary() -> Rect {
        // The work area: 1920×1040, the taskbar taking the bottom 40.
        rect(0, 0, 1920, 1040)
    }

    #[test]
    fn a_window_still_on_a_monitor_keeps_its_saved_position() {
        let saved = rect(100, 80, 1200, 800);
        assert_eq!(place_rect(saved, &two_monitors(), primary()), saved);

        // On the secondary, at a negative origin.
        let left = rect(-1800, 100, 1200, 800);
        assert_eq!(place_rect(left, &two_monitors(), primary()), left);
    }

    #[test]
    fn a_window_straddling_an_edge_keeps_its_position_while_a_quarter_shows() {
        // 1000 wide at x=1670: 250 px on the primary, exactly a quarter.
        let quarter = rect(1670, 100, 1000, 800);
        assert_eq!(quarter.intersection_area(&rect(0, 0, 1920, 1080)), 250 * 800);
        assert_eq!(place_rect(quarter, &two_monitors(), primary()), quarter);

        // One pixel further out is under the floor and gets centred.
        let under = rect(1671, 100, 1000, 800);
        assert_eq!(
            place_rect(under, &two_monitors(), primary()),
            rect(460, 120, 1000, 800)
        );
    }

    #[test]
    fn a_window_on_a_monitor_that_is_gone_is_centred_at_its_saved_size() {
        // Saved on the left-hand monitor, relaunched with only the primary.
        let saved = rect(-1800, 100, 1200, 800);
        let centred = place_rect(saved, &[rect(0, 0, 1920, 1080)], primary());
        assert_eq!(centred, rect(360, 120, 1200, 800));
        // The size survives the move: the position was unreachable, the size
        // was the user's choice.
        assert_eq!((centred.width, centred.height), (saved.width, saved.height));
    }

    #[test]
    fn no_monitors_at_all_still_produces_a_placeable_rectangle() {
        let saved = rect(100, 80, 1200, 800);
        assert_eq!(place_rect(saved, &[], primary()), rect(360, 120, 1200, 800));
    }

    #[test]
    fn a_window_larger_than_the_display_is_clamped_to_the_work_area() {
        // Saved from a 3840×2160 display, relaunched on a 1920×1080 one.
        let saved = rect(2600, 1400, 3000, 1600);
        let placed = place_rect(saved, &[rect(0, 0, 1920, 1080)], primary());
        assert_eq!(placed, rect(0, 0, 1920, 1040));
        // Clamped to the WORK area, not the monitor: the taskbar's 40 px are
        // not the window's to occupy.
        assert!(placed.height < 1080);
    }

    #[test]
    fn a_degenerate_saved_rectangle_is_centred_rather_than_trusted() {
        let placed = place_rect(rect(10, 10, 0, 0), &two_monitors(), primary());
        assert_eq!(placed, rect(960, 520, 0, 0));
    }

    #[test]
    fn intersection_over_the_i32_extremes_does_not_wrap() {
        let huge = rect(i32::MAX - 10, 0, 1000, 1000);
        assert_eq!(huge.intersection_area(&rect(0, 0, 1920, 1080)), 0);
        assert_eq!(
            place_rect(huge, &[rect(0, 0, 1920, 1080)], primary()),
            rect(460, 20, 1000, 1000)
        );
    }

    #[test]
    fn a_record_survives_the_round_trip_through_the_file_format() {
        let session = Session {
            version: SESSION_VERSION,
            windows: vec![
                WindowRecord {
                    label_kind: LabelKind::Main,
                    x: -1800,
                    y: 120,
                    width: 1200,
                    height: 800,
                    maximized: true,
                    monitor: "\\\\.\\DISPLAY2".into(),
                    files: vec!["C:\\a.pdf".into(), "C:\\b.pdf".into()],
                },
                WindowRecord {
                    label_kind: LabelKind::Doc,
                    x: 40,
                    y: 40,
                    width: 900,
                    height: 700,
                    maximized: false,
                    monitor: String::new(),
                    files: Vec::new(),
                },
            ],
        };
        let json = serde_json::to_string(&session).unwrap();
        assert_eq!(
            serde_json::from_str::<Session>(&json).unwrap(),
            session,
            "{json}"
        );
        // The two kinds are distinguishable in the file, and the negative
        // origin of a left-hand monitor survives it.
        assert!(json.contains("\"labelKind\":\"main\""));
        assert!(json.contains("\"labelKind\":\"doc\""));
        assert!(json.contains("\"x\":-1800"));
    }

    #[test]
    fn a_missing_or_unreadable_file_reads_as_an_empty_session() {
        assert_eq!(
            serde_json::from_str::<Session>("{}").unwrap(),
            Session::default()
        );
        assert!(serde_json::from_str::<Session>("not json").is_err());
        // A record written by an older build without the later fields still
        // loads; the absent ones take their defaults rather than voiding it.
        let lean = r#"{"windows":[{"labelKind":"doc","x":1,"y":2,"width":3,"height":4,"maximized":false}]}"#;
        let session: Session = serde_json::from_str(lean).unwrap();
        assert_eq!(session.windows[0].files, Vec::<String>::new());
        assert_eq!(session.windows[0].monitor, "");
    }

    fn saved_session() -> Session {
        Session {
            version: SESSION_VERSION,
            windows: vec![
                WindowRecord {
                    label_kind: LabelKind::Main,
                    x: 100,
                    y: 80,
                    width: 1200,
                    height: 800,
                    maximized: false,
                    monitor: String::new(),
                    files: vec!["C:\\a.pdf".into()],
                },
                WindowRecord {
                    label_kind: LabelKind::Doc,
                    x: 300,
                    y: 200,
                    width: 900,
                    height: 700,
                    maximized: true,
                    monitor: String::new(),
                    files: vec!["C:\\b.pdf".into()],
                },
            ],
        }
    }

    #[test]
    fn the_preference_off_restores_geometry_and_nothing_else() {
        let plan = plan_launch(&saved_session(), false);
        assert_eq!(
            plan.main,
            Some(Placement {
                rect: rect(100, 80, 1200, 800),
                maximized: false,
            })
        );
        // No document opens and no second window appears: with the preference
        // off a launch looks like a first run apart from where the window is.
        assert!(plan.main_files.is_empty());
        assert!(plan.extra.is_empty());
    }

    #[test]
    fn the_preference_on_restores_every_window_and_its_paths() {
        let plan = plan_launch(&saved_session(), true);
        assert_eq!(plan.main_files, vec!["C:\\a.pdf".to_string()]);
        assert_eq!(plan.extra.len(), 1);
        assert_eq!(plan.extra[0].files, vec!["C:\\b.pdf".to_string()]);
        assert_eq!(
            plan.extra[0].placement(),
            Placement {
                rect: rect(300, 200, 900, 700),
                maximized: true,
            }
        );
    }

    fn doc_record(x: i32, file: &str) -> WindowRecord {
        WindowRecord {
            label_kind: LabelKind::Doc,
            x,
            y: 10,
            width: 800,
            height: 600,
            maximized: false,
            monitor: String::new(),
            files: vec![file.to_string()],
        }
    }

    #[test]
    fn a_session_saved_with_no_main_window_restores_onto_the_main_window() {
        // Last quit with the main window already closed and one document
        // window open. The launch builds a main window regardless, so that
        // record has to land ON it — restoring it as an extra would leave an
        // empty main window open beside it.
        let session = Session {
            version: SESSION_VERSION,
            windows: vec![doc_record(10, "C:\\c.pdf")],
        };
        let plan = plan_launch(&session, true);
        assert_eq!(
            plan.main,
            Some(Placement {
                rect: rect(10, 10, 800, 600),
                maximized: false,
            })
        );
        assert_eq!(plan.main_files, vec!["C:\\c.pdf".to_string()]);
        assert!(plan.extra.is_empty(), "{:?}", plan.extra);

        // And an empty session asks a launch to do nothing at all.
        assert_eq!(plan_launch(&Session::default(), true), LaunchPlan::default());
    }

    #[test]
    fn only_the_first_record_adopts_the_main_window() {
        let session = Session {
            version: SESSION_VERSION,
            windows: vec![doc_record(10, "C:\\c.pdf"), doc_record(500, "C:\\d.pdf")],
        };
        let plan = plan_launch(&session, true);
        assert_eq!(plan.main_files, vec!["C:\\c.pdf".to_string()]);
        assert_eq!(plan.extra.len(), 1);
        assert_eq!(plan.extra[0].files, vec!["C:\\d.pdf".to_string()]);
        assert_eq!(plan.extra[0].x, 500);
    }

    #[test]
    fn the_adopting_record_still_only_contributes_geometry_with_the_preference_off() {
        let session = Session {
            version: SESSION_VERSION,
            windows: vec![doc_record(10, "C:\\c.pdf"), doc_record(500, "C:\\d.pdf")],
        };
        let plan = plan_launch(&session, false);
        // Where the last window was is still where the app opens; which
        // documents it held is what the preference gates.
        assert_eq!(
            plan.main,
            Some(Placement {
                rect: rect(10, 10, 800, 600),
                maximized: false,
            })
        );
        assert!(plan.main_files.is_empty());
        assert!(plan.extra.is_empty());
    }

    #[test]
    fn a_saved_main_record_takes_the_slot_wherever_it_sits() {
        // The control: a session that HAS a main record is unaffected by the
        // adoption, including when it is not the first record in the file.
        let session = Session {
            version: SESSION_VERSION,
            windows: vec![
                doc_record(500, "C:\\d.pdf"),
                WindowRecord {
                    label_kind: LabelKind::Main,
                    x: 100,
                    y: 80,
                    width: 1200,
                    height: 800,
                    maximized: false,
                    monitor: String::new(),
                    files: vec!["C:\\a.pdf".into()],
                },
            ],
        };
        let plan = plan_launch(&session, true);
        assert_eq!(plan.main_files, vec!["C:\\a.pdf".to_string()]);
        assert_eq!(plan.extra.len(), 1);
        assert_eq!(plan.extra[0].files, vec!["C:\\d.pdf".to_string()]);
    }

    #[test]
    fn a_maximized_window_keeps_the_rectangle_it_un_maximizes_to() {
        let state = SessionState::new();
        state.observe(
            "main",
            Placement {
                rect: rect(100, 80, 1200, 800),
                maximized: false,
            },
            "\\\\.\\DISPLAY1".into(),
        );
        // Maximizing reports the whole screen; the restore rectangle must not
        // become it, or the window un-maximizes to full screen forever.
        state.observe(
            "main",
            Placement {
                rect: rect(-8, -8, 1936, 1096),
                maximized: true,
            },
            "\\\\.\\DISPLAY1".into(),
        );
        let known = state.get("main").unwrap();
        assert_eq!(known.placement.rect, rect(100, 80, 1200, 800));
        assert!(known.placement.maximized);

        // Un-maximizing takes the new rectangle and clears the flag.
        state.observe(
            "main",
            Placement {
                rect: rect(120, 90, 1200, 800),
                maximized: false,
            },
            "\\\\.\\DISPLAY1".into(),
        );
        let known = state.get("main").unwrap();
        assert_eq!(known.placement.rect, rect(120, 90, 1200, 800));
        assert!(!known.placement.maximized);
    }

    fn paths(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_windows_documents_are_recorded_in_the_order_it_published() {
        // The claim table answers alphabetically; the strip is whatever the
        // user arranged, and that is what a restore has to reproduce.
        assert_eq!(
            arrange(&paths(&["C:\\c.pdf", "C:\\a.pdf", "C:\\b.pdf"]), paths(&["C:\\a.pdf", "C:\\b.pdf", "C:\\c.pdf"])),
            paths(&["C:\\c.pdf", "C:\\a.pdf", "C:\\b.pdf"])
        );
    }

    #[test]
    fn ownership_decides_membership_and_the_published_order_only_arranges() {
        // Opened after the last publish, or opened while no strip was mounted
        // to publish at all: held, so recorded — at the end, where an append
        // puts it.
        assert_eq!(
            arrange(&paths(&["C:\\b.pdf"]), paths(&["C:\\a.pdf", "C:\\b.pdf"])),
            paths(&["C:\\b.pdf", "C:\\a.pdf"])
        );
        // Closed, or handed to another window, after the last publish: not
        // held, so not recorded — restoring it would open a document the
        // window does not have and, being a claim, could not open anyway.
        assert_eq!(
            arrange(&paths(&["C:\\a.pdf", "C:\\gone.pdf", "C:\\b.pdf"]), paths(&["C:\\a.pdf", "C:\\b.pdf"])),
            paths(&["C:\\a.pdf", "C:\\b.pdf"])
        );
        // A window that never published keeps the claim table's own order.
        assert_eq!(arrange(&[], paths(&["C:\\a.pdf"])), paths(&["C:\\a.pdf"]));
        assert!(arrange(&paths(&["C:\\a.pdf"]), Vec::new()).is_empty());
    }

    #[test]
    fn a_repeated_path_is_recorded_once_and_in_its_own_spelling() {
        // The record is read back into the open funnel, where one path twice
        // is one open — but a duplicate would still make the file lie about
        // what a window holds.
        assert_eq!(
            arrange(&paths(&["C:\\a.pdf", "C:\\a.pdf"]), paths(&["C:\\a.pdf"])),
            paths(&["C:\\a.pdf"])
        );
        // Both sides hold the canonical spelling; a case-differing pair is the
        // same file, and treating it as a different one would append the
        // document a second time.
        assert_eq!(
            arrange(&paths(&["c:\\A.PDF"]), paths(&["C:\\a.pdf"])),
            paths(&["C:\\a.pdf"])
        );
    }

    #[test]
    fn the_last_published_order_is_the_one_that_is_kept() {
        let state = SessionState::new();
        state.set_order("main", paths(&["C:\\a.pdf", "C:\\b.pdf"]));
        state.set_order("main", paths(&["C:\\b.pdf", "C:\\a.pdf"]));
        assert_eq!(state.order("main"), paths(&["C:\\b.pdf", "C:\\a.pdf"]));
        // A window nobody published for arranges nothing.
        assert!(state.order("doc-9").is_empty());
    }

    #[test]
    fn a_forgotten_label_stops_contributing_geometry() {
        let state = SessionState::new();
        state.observe(
            "doc-1",
            Placement {
                rect: rect(0, 0, 100, 100),
                maximized: false,
            },
            String::new(),
        );
        assert!(state.get("doc-1").is_some());
        state.set_order("doc-1", paths(&["C:\\a.pdf"]));
        state.forget("doc-1");
        assert!(state.get("doc-1").is_none());
        // A label is minted fresh every run, so an order left behind by a
        // destroyed window would be inherited by an unrelated one.
        assert!(state.order("doc-1").is_empty());
    }

    #[test]
    fn the_seal_is_taken_once() {
        let state = SessionState::new();
        let writes = Cell::new(0);
        let count = || {
            writes.set(writes.get() + 1);
            Ok(())
        };
        assert_eq!(state.seal_and_write(count), WriteOutcome::Written);
        // Every later quit path finds it already closed and writes nothing.
        assert_eq!(state.seal_and_write(count), WriteOutcome::Refused);
        assert_eq!(writes.get(), 1);
        assert!(state.is_sealed());
    }

    #[test]
    fn a_quit_snapshot_that_did_not_land_leaves_the_file_open() {
        let state = SessionState::new();
        let attempts = Cell::new(0);
        let fail = || {
            attempts.set(attempts.get() + 1);
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "x"))
        };
        assert_eq!(state.seal_and_write(fail), WriteOutcome::Failed);
        // Retried once — the destination being held open by another process is
        // the failure this path actually meets, and it does not last.
        assert_eq!(attempts.get(), 2);
        // Sealing over a snapshot that never reached disk would silence every
        // write for the rest of the run in exchange for nothing.
        assert!(!state.is_sealed());
        assert_eq!(
            state.write_checked(|| (), |()| Ok(())),
            WriteOutcome::Written
        );
    }

    #[test]
    fn a_snapshot_that_lands_on_the_retry_still_seals() {
        let state = SessionState::new();
        let attempts = Cell::new(0);
        let flaky = || {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "x"));
            }
            Ok(())
        };
        assert_eq!(state.seal_and_write(flaky), WriteOutcome::Written);
        assert!(state.is_sealed());
        assert_eq!(
            state.write_checked(|| (), |()| Ok(())),
            WriteOutcome::Refused
        );
    }

    // ── The two-phase quit ────────────────────────────────────────────────

    /// A quit snapshot that cannot be written, however many times it is tried.
    fn held_open() -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "the record is held open",
        ))
    }

    #[test]
    fn an_order_published_during_the_prepare_round_is_in_the_sealed_capture() {
        let state = SessionState::new();
        // The arrangement the record holds when Exit is chosen: window B has
        // reordered its tabs, and its publish is still in flight.
        state.set_order("doc-1", paths(&["a.pdf", "b.pdf"]));
        let captured = Cell::new(Vec::new());

        let proceeded = sequence_quit(
            || {
                // The peer flushes what it measured and only then answers, so
                // the reorder is on this side before the round completes.
                state.set_order("doc-1", paths(&["b.pdf", "a.pdf"]));
                QuitGate::Proceed
            },
            || {
                captured.set(state.order("doc-1"));
                state.seal_and_write(|| Ok(()))
            },
            || QuitGate::Proceed,
        );

        assert!(proceeded);
        // Capturing ahead of the round is what sealed this over: the restored
        // session arranged the tabs the way they were before the user moved
        // them, and only the initiating window's own flush was ever waited on.
        assert_eq!(captured.take(), paths(&["b.pdf", "a.pdf"]));
        assert!(state.is_sealed());
    }

    #[test]
    fn the_sealed_capture_is_what_the_last_peer_published() {
        let state = SessionState::new();
        let captured = Cell::new(Vec::new());
        let proceeded = sequence_quit(
            || {
                // Two peers answer the same round; the record has to hold both
                // windows' newest orders, not whichever one lost a race with
                // the capture.
                state.set_order("doc-1", paths(&["b.pdf"]));
                state.set_order("doc-2", paths(&["c.pdf", "d.pdf"]));
                QuitGate::Proceed
            },
            || {
                let mut both = state.order("doc-1");
                both.extend(state.order("doc-2"));
                captured.set(both);
                state.seal_and_write(|| Ok(()))
            },
            || QuitGate::Proceed,
        );
        assert!(proceeded);
        assert_eq!(captured.take(), paths(&["b.pdf", "c.pdf", "d.pdf"]));
    }

    #[test]
    fn a_prepare_round_that_goes_unanswered_captures_nothing_and_seals_nothing() {
        let state = SessionState::new();
        let captured = Cell::new(false);
        let closed = Cell::new(false);

        let proceeded = sequence_quit(
            || QuitGate::Abort,
            || {
                captured.set(true);
                state.seal_and_write(|| Ok(()))
            },
            || {
                closed.set(true);
                QuitGate::Proceed
            },
        );

        // A window that never heard the prepare request has an order this side
        // may not have; recording one over it is the loss the round exists to
        // prevent, so nothing is recorded and nothing closes.
        assert!(!proceeded);
        assert!(!captured.get());
        assert!(!closed.get());
        assert!(!state.is_sealed());
    }

    #[test]
    fn a_quit_snapshot_that_did_not_land_stops_the_quit_before_anything_closes() {
        let state = SessionState::new();
        let closed = Cell::new(false);

        let proceeded = sequence_quit(
            || QuitGate::Proceed,
            || state.seal_and_write(held_open),
            || {
                closed.set(true);
                QuitGate::Proceed
            },
        );

        // The file still holds the previous run's record and the seal is back
        // off. Closing the windows now would exit having thrown this session
        // away, with nothing left standing to capture it from.
        assert!(!proceeded);
        assert!(!closed.get());
        assert!(!state.is_sealed());
    }

    #[test]
    fn a_prompted_window_that_never_answers_the_close_round_still_stops_the_quit() {
        let state = SessionState::new();
        let proceeded = sequence_quit(
            || QuitGate::Proceed,
            || state.seal_and_write(|| Ok(())),
            || QuitGate::Abort,
        );
        assert!(!proceeded);
    }

    #[test]
    fn the_last_window_is_destroyed_only_when_its_snapshot_reached_disk() {
        let state = SessionState::new();
        // The window × path and the tray Quit both capture here. A destination
        // held open by another process fails the write, `seal_and_write` puts
        // the seal back, and destroying the window on that outcome exits with
        // an older run's session on disk.
        assert!(!teardown_permitted(state.seal_and_write(held_open)));
        assert!(!state.is_sealed());

        // The same close, once the write lands.
        assert!(teardown_permitted(state.seal_and_write(|| Ok(()))));
        assert!(state.is_sealed());

        // A path that finds the file already sealed is not a failure: this
        // session is recorded, by whichever quit path got there first.
        assert!(teardown_permitted(state.seal_and_write(|| Ok(()))));
    }

    #[test]
    fn a_debounced_write_that_fails_is_reported_rather_than_counted_as_written() {
        let state = SessionState::new();
        assert_eq!(
            state.write_checked(
                || (),
                |()| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "x")),
            ),
            WriteOutcome::Failed
        );
    }

    #[test]
    fn a_cancelled_exit_replaces_the_capture_and_lets_writes_land_again() {
        let state = SessionState::new();
        let windows = FakeWindows::with(&["main", "doc-1", "doc-2"]);

        // File ▸ Exit records every window and closes the file.
        assert_eq!(
            state.seal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );
        assert_eq!(windows.written(), vec!["main", "doc-1", "doc-2"]);

        // doc-1 goes through with its close before doc-2's prompt is answered.
        windows.destroy("doc-1");
        assert_eq!(
            state.write_checked(
                || windows.snapshot(Some("doc-1")),
                |session| windows.record(session),
            ),
            WriteOutcome::Refused
        );

        // doc-2 cancels. The file describes an exit that did not happen and a
        // window that is already gone, so lifting the seal replaces it.
        assert_eq!(
            state.unseal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );
        assert_eq!(windows.written(), vec!["main", "doc-2"]);

        // And the run carries on being recorded: an ordinary close after the
        // cancelled exit reaches disk, which is what the seal was preventing.
        windows.destroy("doc-2");
        assert_eq!(
            state.write_checked(
                || windows.snapshot(Some("doc-2")),
                |session| windows.record(session),
            ),
            WriteOutcome::Written
        );
        assert_eq!(windows.written(), vec!["main"]);
    }

    #[test]
    fn only_the_first_cancel_lifts_the_seal() {
        let state = SessionState::new();
        let unseals = Cell::new(0);
        let count = || {
            unseals.set(unseals.get() + 1);
            Ok(())
        };
        assert_eq!(state.seal_and_write(|| Ok(())), WriteOutcome::Written);

        // Two windows were prompted and both cancel.
        assert_eq!(state.unseal_and_write(count), WriteOutcome::Written);
        assert_eq!(state.unseal_and_write(count), WriteOutcome::Refused);
        assert_eq!(unseals.get(), 1);

        // A cancelled window × never belonged to a quit, so there is no seal
        // to lift and no snapshot to replace.
        let fresh = SessionState::new();
        let spurious = Cell::new(0);
        assert_eq!(
            fresh.unseal_and_write(|| {
                spurious.set(spurious.get() + 1);
                Ok(())
            }),
            WriteOutcome::Refused
        );
        assert_eq!(spurious.get(), 0);
    }

    #[test]
    fn a_quit_after_a_cancelled_exit_seals_the_file_again() {
        let state = SessionState::new();
        let windows = FakeWindows::with(&["main", "doc-1"]);

        assert_eq!(
            state.seal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );
        assert_eq!(
            state.unseal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );

        // The second Exit is an ordinary one: it takes the seal, records what
        // is standing now, and every destruction that follows finds the file
        // closed again.
        windows.destroy("doc-1");
        assert_eq!(
            state.seal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );
        assert_eq!(windows.written(), vec!["main"]);
        windows.destroy("main");
        assert_eq!(
            state.write_checked(
                || windows.snapshot(Some("main")),
                |session| windows.record(session),
            ),
            WriteOutcome::Refused
        );
        assert_eq!(windows.written(), vec!["main"]);
    }

    /// The live windows a quit tears down, and the file the writes land in.
    /// The real snapshot reads the window manager and the claim table; this
    /// stands in for both so the write ORDER can be driven without them.
    struct FakeWindows {
        live: Mutex<Vec<String>>,
        file: Mutex<Vec<String>>,
    }

    impl FakeWindows {
        fn with(labels: &[&str]) -> Self {
            Self {
                live: Mutex::new(labels.iter().map(|l| l.to_string()).collect()),
                file: Mutex::new(Vec::new()),
            }
        }

        fn snapshot(&self, gone: Option<&str>) -> Vec<String> {
            self.live
                .lock()
                .unwrap()
                .iter()
                .filter(|l| Some(l.as_str()) != gone)
                .cloned()
                .collect()
        }

        fn destroy(&self, label: &str) {
            self.live.lock().unwrap().retain(|l| l != label);
        }

        fn record(&self, session: Vec<String>) -> std::io::Result<()> {
            *self.file.lock().unwrap() = session;
            Ok(())
        }

        fn written(&self) -> Vec<String> {
            self.file.lock().unwrap().clone()
        }
    }

    #[test]
    fn an_exit_capture_outlives_every_window_that_closes_after_it() {
        let state = SessionState::new();
        let windows = FakeWindows::with(&["main", "doc-1", "doc-2"]);

        // File ▸ Exit records the whole window list before any window is told
        // to close.
        assert_eq!(
            state.seal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );

        // Each window then runs its own close flow, and its destruction writes
        // that window out of the record. Every one of those finds the file
        // sealed and leaves the exit capture standing.
        for label in ["doc-1", "doc-2", "main"] {
            windows.destroy(label);
            assert_eq!(
                state.write_checked(
                    || windows.snapshot(Some(label)),
                    |session| windows.record(session),
                ),
                WriteOutcome::Refused
            );
        }

        assert_eq!(windows.written(), vec!["main", "doc-1", "doc-2"]);
    }

    #[test]
    fn a_capture_taken_after_the_first_close_names_only_the_last_window() {
        // The sequence the exit capture exists to prevent, and the ordinary
        // one-window-at-a-time close it must not disturb: each destruction
        // rewrites the file without the window that died, so a snapshot taken
        // at the end describes the last window and nothing else.
        let state = SessionState::new();
        let windows = FakeWindows::with(&["main", "doc-1", "doc-2"]);
        for (label, left) in [("doc-1", vec!["main", "doc-2"]), ("doc-2", vec!["main"])] {
            windows.destroy(label);
            assert_eq!(
                state.write_checked(
                    || windows.snapshot(Some(label)),
                    |session| windows.record(session),
                ),
                WriteOutcome::Written
            );
            assert_eq!(windows.written(), left);
        }
        // The last window seals while it is still standing.
        assert_eq!(
            state.seal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );
        assert_eq!(windows.written(), vec!["main"]);
    }

    #[test]
    fn a_writer_that_started_before_the_seal_cannot_land_after_it() {
        let state = Arc::new(SessionState::new());
        let file = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let (built_tx, built_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel();

        // A debounced writer passes the open-file check and builds its
        // snapshot, and is held there — the exact window in which the file
        // can be sealed under it.
        let writer = {
            let state = Arc::clone(&state);
            let file = Arc::clone(&file);
            std::thread::spawn(move || {
                state.write_checked(
                    || {
                        built_tx.send(()).unwrap();
                        go_rx.recv().unwrap();
                        "debounced"
                    },
                    |payload| {
                        file.lock().unwrap().push(payload);
                        Ok(())
                    },
                )
            })
        };

        // The quit runs to completion inside that window.
        built_rx.recv().unwrap();
        assert_eq!(
            state.seal_and_write(|| {
                file.lock().unwrap().push("quit");
                Ok(())
            }),
            WriteOutcome::Written
        );
        go_tx.send(()).unwrap();

        // The stale writer wakes into a sealed file and writes nothing, so the
        // quit snapshot is what a relaunch reads.
        assert_eq!(writer.join().unwrap(), WriteOutcome::Refused);
        assert_eq!(*file.lock().unwrap(), vec!["quit"]);
    }

    // ── The file itself ───────────────────────────────────────────────────

    #[test]
    fn a_record_replaces_the_one_before_it_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SESSION_FILE);

        write_staged(&path, "{\"version\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"version\":1}");
        // A second write lands over the first: the swap replaces an existing
        // destination rather than refusing it.
        write_staged(&path, "{\"version\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"version\":2}");
        // And nothing is left beside the record.
        assert!(!staging_path(&path).exists());
    }

    #[test]
    fn a_write_that_fails_leaves_the_previous_record_readable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SESSION_FILE);
        write_staged(&path, "{\"version\":1}").unwrap();

        // Staging cannot be created. A write straight over the record would
        // have truncated it first and left neither session on disk.
        std::fs::create_dir(staging_path(&path)).unwrap();
        assert!(write_staged(&path, "{\"version\":2}").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"version\":1}");
    }

    // ── The quit gate ─────────────────────────────────────────────────────

    #[test]
    fn a_quit_proceeds_once_every_prompted_window_answers() {
        let acks = QuitAcks::new();
        let id = acks.begin(paths(&["doc-1", "doc-2"]));
        assert!(acks.ack(id, "doc-1"));
        assert!(acks.ack(id, "doc-2"));
        assert_eq!(acks.wait(id, Duration::from_millis(50)), QuitGate::Proceed);
    }

    #[test]
    fn a_receipt_that_arrives_during_the_wait_releases_it() {
        let acks = Arc::new(QuitAcks::new());
        let id = acks.begin(paths(&["doc-1"]));
        let waiter = {
            let acks = Arc::clone(&acks);
            std::thread::spawn(move || acks.wait(id, Duration::from_secs(10)))
        };
        assert!(acks.ack(id, "doc-1"));
        assert_eq!(waiter.join().unwrap(), QuitGate::Proceed);
    }

    #[test]
    fn a_window_that_never_answers_calls_the_quit_off() {
        let acks = QuitAcks::new();
        let id = acks.begin(paths(&["doc-1"]));
        let started = Instant::now();
        assert_eq!(acks.wait(id, Duration::from_millis(50)), QuitGate::Abort);
        // Waited it out rather than giving up on the first look.
        assert!(started.elapsed() >= Duration::from_millis(50));
        // And the quit is closed out, so the window that finally answers finds
        // nothing left to satisfy.
        assert!(!acks.ack(id, "doc-1"));
    }

    #[test]
    fn a_quit_with_no_other_window_to_ask_never_waits() {
        let acks = QuitAcks::new();
        let id = acks.begin(Vec::new());
        let started = Instant::now();
        assert_eq!(acks.wait(id, Duration::from_secs(10)), QuitGate::Proceed);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_receipt_for_an_abandoned_quit_cannot_answer_the_next_one() {
        let acks = QuitAcks::new();
        let first = acks.begin(paths(&["doc-1"]));
        assert!(acks.abort(first));
        // Only the call that found it in flight calls it off.
        assert!(!acks.abort(first));

        let second = acks.begin(paths(&["doc-1"]));
        assert_ne!(first, second);
        // doc-1 finally answers the FIRST request. A receipt names the quit it
        // belongs to, so it cannot stand in for the one the live quit is
        // waiting on — otherwise the window that proved nothing would let a
        // second quit through.
        assert!(!acks.ack(first, "doc-1"));
        assert_eq!(acks.wait(second, Duration::from_millis(50)), QuitGate::Abort);
    }

    #[test]
    fn a_receipt_from_a_window_the_quit_did_not_prompt_changes_nothing() {
        let acks = QuitAcks::new();
        let id = acks.begin(paths(&["doc-1"]));
        assert!(!acks.ack(id, "doc-9"));
        assert!(!acks.ack(id + 1, "doc-1"));
        assert_eq!(acks.wait(id, Duration::from_millis(50)), QuitGate::Abort);
    }

    #[test]
    fn an_unanswered_quit_puts_the_session_back_under_live_tracking() {
        let state = SessionState::new();
        let acks = QuitAcks::new();
        let windows = FakeWindows::with(&["main", "doc-1"]);

        // File ▸ Exit records every window and closes the file before doc-1 is
        // asked anything.
        assert_eq!(
            state.seal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );
        let id = acks.begin(paths(&["doc-1"]));

        // doc-1 has no listener installed — a window built moments ago, or one
        // whose renderer stopped answering — so no receipt comes back.
        assert_eq!(acks.wait(id, Duration::from_millis(50)), QuitGate::Abort);

        // Which makes it an exit that did not happen: both windows are still
        // standing, and the record has to follow them again or everything the
        // user does for the rest of the run goes unwritten.
        assert_eq!(
            state.unseal_and_write(|| windows.record(windows.snapshot(None))),
            WriteOutcome::Written
        );
        assert!(!state.is_sealed());
        windows.destroy("doc-1");
        assert_eq!(
            state.write_checked(
                || windows.snapshot(Some("doc-1")),
                |session| windows.record(session),
            ),
            WriteOutcome::Written
        );
        assert_eq!(windows.written(), vec!["main"]);
    }
}
