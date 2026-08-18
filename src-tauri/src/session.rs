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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

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
pub fn plan_launch(session: &Session, restore_windows: bool) -> LaunchPlan {
    let main = session
        .windows
        .iter()
        .find(|w| w.label_kind == LabelKind::Main);
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
                .filter(|w| w.label_kind == LabelKind::Doc)
                .cloned()
                .collect()
        } else {
            Vec::new()
        },
    }
}

// ── Live state ────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Geometry {
    placement: Placement,
    monitor: String,
}

/// Every live window's restore geometry, plus the debounce bookkeeping for the
/// file behind it.
pub struct SessionState {
    geometry: Mutex<HashMap<String, Geometry>>,
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
    fn write_checked<T>(&self, build: impl FnOnce() -> T, sink: impl FnOnce(T)) -> bool {
        if self.sealed.load(Ordering::SeqCst) {
            return false;
        }
        let payload = build();
        let _guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if self.sealed.load(Ordering::SeqCst) {
            return false;
        }
        sink(payload);
        true
    }

    /// Take the seal and write the quit snapshot under it. The first caller
    /// wins and every later quit path finds the file closed.
    ///
    /// A poisoned lock is recovered rather than propagated: it guards a unit,
    /// and refusing the quit snapshot because an unrelated thread panicked
    /// would lose the session the user is quitting with.
    fn seal_and_write(&self, sink: impl FnOnce()) -> bool {
        let _guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if self.sealed.swap(true, Ordering::SeqCst) {
            return false;
        }
        sink();
        true
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
    fn unseal_and_write(&self, sink: impl FnOnce()) -> bool {
        let _guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if !self.sealed.swap(false, Ordering::SeqCst) {
            return false;
        }
        sink();
        true
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

    fn forget(&self, label: &str) {
        if let Ok(mut map) = self.geometry.lock() {
            map.remove(label);
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
    }
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
            files: claims.write_claims(&label),
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
    let dir = app.path().app_data_dir().ok()?;
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

fn write(app: &AppHandle, session: &Session) {
    let Some(path) = session_path(app) else {
        return;
    };
    let Ok(json) = serde_json::to_string(session) else {
        return;
    };
    let _ = std::fs::write(&path, json);
}

fn write_now(app: &AppHandle, gone: Option<&str>) {
    app.state::<SessionState>()
        .write_checked(|| snapshot_excluding(app, gone), |s| write(app, &s));
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
        write_now(&app, None);
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
pub fn capture_and_seal(app: &AppHandle) {
    app.state::<SessionState>()
        .seal_and_write(|| write(app, &snapshot_excluding(app, None)));
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
pub fn unseal(app: &AppHandle) {
    app.state::<SessionState>()
        .unseal_and_write(|| write(app, &snapshot_excluding(app, None)));
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
    write_now(app, Some(label));
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
        match app_windows::build_app_window(app, &label, e2e, false) {
            Ok(window) => {
                apply_placement(app, &window, record.placement());
                if show {
                    let _ = window.show();
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

    #[test]
    fn a_session_with_no_main_record_restores_the_doc_windows_regardless() {
        let session = Session {
            version: SESSION_VERSION,
            windows: vec![WindowRecord {
                label_kind: LabelKind::Doc,
                x: 10,
                y: 10,
                width: 800,
                height: 600,
                maximized: false,
                monitor: String::new(),
                files: vec!["C:\\c.pdf".into()],
            }],
        };
        let plan = plan_launch(&session, true);
        assert_eq!(plan.main, None);
        assert!(plan.main_files.is_empty());
        assert_eq!(plan.extra.len(), 1);

        // And an empty session asks a launch to do nothing at all.
        assert_eq!(plan_launch(&Session::default(), true), LaunchPlan::default());
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
        state.forget("doc-1");
        assert!(state.get("doc-1").is_none());
    }

    #[test]
    fn the_seal_is_taken_once() {
        let state = SessionState::new();
        let mut writes = 0;
        assert!(state.seal_and_write(|| writes += 1));
        // Every later quit path finds it already closed and writes nothing.
        assert!(!state.seal_and_write(|| writes += 1));
        assert_eq!(writes, 1);
    }

    #[test]
    fn a_cancelled_exit_replaces_the_capture_and_lets_writes_land_again() {
        let state = SessionState::new();
        let windows = FakeWindows::with(&["main", "doc-1", "doc-2"]);

        // File ▸ Exit records every window and closes the file.
        assert!(state.seal_and_write(|| windows.record(windows.snapshot(None))));
        assert_eq!(windows.written(), vec!["main", "doc-1", "doc-2"]);

        // doc-1 goes through with its close before doc-2's prompt is answered.
        windows.destroy("doc-1");
        assert!(!state.write_checked(
            || windows.snapshot(Some("doc-1")),
            |session| windows.record(session),
        ));

        // doc-2 cancels. The file describes an exit that did not happen and a
        // window that is already gone, so lifting the seal replaces it.
        assert!(state.unseal_and_write(|| windows.record(windows.snapshot(None))));
        assert_eq!(windows.written(), vec!["main", "doc-2"]);

        // And the run carries on being recorded: an ordinary close after the
        // cancelled exit reaches disk, which is what the seal was preventing.
        windows.destroy("doc-2");
        assert!(state.write_checked(
            || windows.snapshot(Some("doc-2")),
            |session| windows.record(session),
        ));
        assert_eq!(windows.written(), vec!["main"]);
    }

    #[test]
    fn only_the_first_cancel_lifts_the_seal() {
        let state = SessionState::new();
        let mut unseals = 0;
        assert!(state.seal_and_write(|| {}));

        // Two windows were prompted and both cancel.
        assert!(state.unseal_and_write(|| unseals += 1));
        assert!(!state.unseal_and_write(|| unseals += 1));
        assert_eq!(unseals, 1);

        // A cancelled window × never belonged to a quit, so there is no seal
        // to lift and no snapshot to replace.
        let fresh = SessionState::new();
        let mut spurious = 0;
        assert!(!fresh.unseal_and_write(|| spurious += 1));
        assert_eq!(spurious, 0);
    }

    #[test]
    fn a_quit_after_a_cancelled_exit_seals_the_file_again() {
        let state = SessionState::new();
        let windows = FakeWindows::with(&["main", "doc-1"]);

        assert!(state.seal_and_write(|| windows.record(windows.snapshot(None))));
        assert!(state.unseal_and_write(|| windows.record(windows.snapshot(None))));

        // The second Exit is an ordinary one: it takes the seal, records what
        // is standing now, and every destruction that follows finds the file
        // closed again.
        windows.destroy("doc-1");
        assert!(state.seal_and_write(|| windows.record(windows.snapshot(None))));
        assert_eq!(windows.written(), vec!["main"]);
        windows.destroy("main");
        assert!(!state.write_checked(
            || windows.snapshot(Some("main")),
            |session| windows.record(session),
        ));
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

        fn record(&self, session: Vec<String>) {
            *self.file.lock().unwrap() = session;
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
        assert!(state.seal_and_write(|| windows.record(windows.snapshot(None))));

        // Each window then runs its own close flow, and its destruction writes
        // that window out of the record. Every one of those finds the file
        // sealed and leaves the exit capture standing.
        for label in ["doc-1", "doc-2", "main"] {
            windows.destroy(label);
            assert!(!state.write_checked(
                || windows.snapshot(Some(label)),
                |session| windows.record(session),
            ));
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
            assert!(state.write_checked(
                || windows.snapshot(Some(label)),
                |session| windows.record(session),
            ));
            assert_eq!(windows.written(), left);
        }
        // The last window seals while it is still standing.
        assert!(state.seal_and_write(|| windows.record(windows.snapshot(None))));
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
                    |payload| file.lock().unwrap().push(payload),
                )
            })
        };

        // The quit runs to completion inside that window.
        built_rx.recv().unwrap();
        assert!(state.seal_and_write(|| file.lock().unwrap().push("quit")));
        go_tx.send(()).unwrap();

        // The stale writer wakes into a sealed file and writes nothing, so the
        // quit snapshot is what a relaunch reads.
        assert!(!writer.join().unwrap());
        assert_eq!(*file.lock().unwrap(), vec!["quit"]);
    }
}
