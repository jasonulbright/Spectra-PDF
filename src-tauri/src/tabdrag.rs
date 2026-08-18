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
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::app_windows::{self, ClaimState, WindowRegistry};

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

/// Every window's strip, plus which window is currently showing an insertion
/// caret. Managed state beside `WindowRegistry`.
pub struct StripRegistry {
    strips: Mutex<HashMap<String, StripEntry>>,
    hover: Mutex<Option<String>>,
}

impl StripRegistry {
    pub fn new() -> Self {
        Self {
            strips: Mutex::new(HashMap::new()),
            hover: Mutex::new(None),
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
            if hover.as_deref() == Some(label) {
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

    /// Where a release at this point would go, deciding nothing else.
    fn resolve_at(&self, live: &[String], source: &str, x: i32, y: i32) -> DropTarget {
        let Ok(strips) = self.strips.lock() else {
            return DropTarget::TearOff;
        };
        resolve_drop(&screen_strips(&strips, Some(live)), source, x, y)
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
    fn resolve_release(
        &self,
        claims: &ClaimState,
        registry: &WindowRegistry,
        live: &[String],
        source: &str,
        path: &str,
        x: i32,
        y: i32,
    ) -> HandOver {
        // Failing closed: a drop that cannot be resolved leaves the document
        // where it is, which is the outcome the source already knows how to
        // undo.
        let Ok(strips) = self.strips.lock() else {
            return HandOver::Refused(source.to_string());
        };
        match resolve_drop(&screen_strips(&strips, Some(live)), source, x, y) {
            DropTarget::Source => HandOver::Source,
            DropTarget::TearOff => HandOver::TearOff,
            DropTarget::Window(target) => {
                let moved = claims.transfer(path, source, &target);
                if !moved.granted {
                    return HandOver::Refused(moved.owner);
                }
                if !app_windows::queue_open(registry, &target, vec![path.to_string()], false) {
                    let _ = claims.transfer(path, &target, source);
                    return HandOver::Refused(source.to_string());
                }
                HandOver::Moved(target)
            }
        }
    }

    fn take_hover(&self) -> Option<String> {
        self.hover.lock().ok().and_then(|mut h| h.take())
    }

    fn set_hover(&self, label: Option<&str>) {
        if let Ok(mut hover) = self.hover.lock() {
            *hover = label.map(|l| l.to_string());
        }
    }
}

impl Default for StripRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// What a release did, decided under the registry lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandOver {
    /// The document belongs to this label now, and its open is queued.
    Moved(String),
    /// The pointer never left the dragging window's own strip.
    Source,
    /// No strip took it; the caller builds a window for it.
    TearOff,
    /// Nothing moved. This label holds the path.
    Refused(String),
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

#[derive(Clone, Serialize)]
struct HoverPayload {
    /// Physical pixels from the left edge of this window's own strip.
    x: i32,
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

    fn same_window() -> Self {
        Self {
            outcome: Self::SAME_WINDOW,
            label: String::new(),
            owner: String::new(),
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

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    app.state::<StripRegistry>().forget(label);
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

/// Move a document into a brand-new window.
///
/// The label is minted and the claim transferred BEFORE the window is built, so
/// a refusal leaves no empty window behind and the path is never unowned. The
/// open is queued rather than carried on an event: the window has no renderer
/// when the claim lands, which is the case the pending-open queue already
/// exists for.
fn tear_off(
    app: &AppHandle,
    path: &str,
    from: &str,
    position: Option<PhysicalPosition<i32>>,
) -> TabDragResult {
    let label = app.state::<WindowRegistry>().next_doc_label();
    let moved = app.state::<ClaimState>().transfer(path, from, &label);
    if !moved.granted {
        return TabDragResult::refused(moved.owner);
    }
    if !app_windows::deliver_open(app, &label, vec![path.to_string()], false) {
        let _ = app.state::<ClaimState>().transfer(path, &label, from);
        return TabDragResult::refused(from.to_string());
    }
    // Built hidden when it has a position to take: a window that appears
    // centred and then jumps to the cursor reads as two windows opening.
    match app_windows::build_app_window(app, &label, crate::is_e2e_mode(), position.is_none()) {
        Ok(window) => {
            if let Some(position) = position {
                let _ = window.set_position(position);
                let _ = window.show();
            }
            let _ = window.set_focus();
            crate::engine::publish_activity(app);
            TabDragResult::moved(TabDragResult::TORN_OFF, label)
        }
        Err(_) => {
            // Nothing was built, so nothing will ever drain that queue or
            // release that claim — hand both back to the window that still has
            // the document open.
            app.state::<WindowRegistry>().forget(&label);
            let _ = app.state::<ClaimState>().transfer(path, &label, from);
            TabDragResult::refused(from.to_string())
        }
    }
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
    let previous = registry.take_hover();
    match &hovered {
        Some((label, offset)) => {
            if previous.as_deref() != Some(label.as_str()) {
                if let Some(previous) = previous {
                    let _ = app.emit_to(previous.as_str(), LEAVE_EVENT, ());
                }
            }
            registry.set_hover(Some(label));
            // Emitted every move, not only on entry: the caret's position
            // inside the strip is the payload, and it changes with the pointer.
            let _ = app.emit_to(label.as_str(), HOVER_EVENT, HoverPayload { x: *offset });
        }
        None => {
            if let Some(previous) = previous {
                let _ = app.emit_to(previous.as_str(), LEAVE_EVENT, ());
            }
        }
    }
    Ok(hovered.map(|(label, _)| label))
}

/// Abandon a drag (Escape, or a gesture cancelled before release). Nothing
/// crosses; the caret stops being drawn.
#[tauri::command]
pub async fn tabdrag_cancel(app: AppHandle) -> Result<(), String> {
    clear_hover(&app);
    Ok(())
}

/// Would a release here take the document out of this window?
///
/// Classification only: no claim moves, nothing is queued, no caret changes.
/// The source asks before it writes its working copy back over the user's file,
/// because that write is what a MOVE costs and a release that lands back in the
/// dragging window is not one.
#[tauri::command]
pub async fn tabdrag_resolve(
    app: AppHandle,
    window: tauri::WebviewWindow,
    screen_x: i32,
    screen_y: i32,
) -> Result<bool, String> {
    let live = droppable_labels(&app);
    let target = app
        .state::<StripRegistry>()
        .resolve_at(&live, window.label(), screen_x, screen_y);
    Ok(target != DropTarget::Source)
}

/// Resolve a release: transfer to the window under the cursor, tear off a new
/// window where there is none, or report that the pointer never left home.
///
/// Only the path crosses. Page and document ids are minted against a
/// per-renderer generation counter, so the same id string names a different
/// physical page in every window.
///
/// The outcome is the source's whole answer: on a move it closes its tab
/// WITHOUT releasing, because ownership already belongs to the receiving window
/// and a release would strip the claim off it.
#[tauri::command]
pub async fn tabdrag_drop(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    screen_x: i32,
    screen_y: i32,
) -> Result<TabDragResult, String> {
    clear_hover(&app);
    let path = crate::commands::canonical_path(&path);
    let source = window.label().to_string();
    // Everything that decides ownership happens inside `resolve_release`, which
    // holds the registry lock throughout. Only what cannot run under a lock the
    // event loop also takes is left out here: the visibility probe above it, and
    // building a window below it.
    let live = droppable_labels(&app);
    let handed = app.state::<StripRegistry>().resolve_release(
        &app.state::<ClaimState>(),
        &app.state::<WindowRegistry>(),
        &live,
        &source,
        &path,
        screen_x,
        screen_y,
    );
    let result = match handed {
        HandOver::Source => TabDragResult::same_window(),
        HandOver::Refused(owner) => TabDragResult::refused(owner),
        HandOver::Moved(target) => {
            app_windows::signal_open(&app, &target);
            app_windows::focus_label(&app, &target);
            TabDragResult::moved(TabDragResult::TRANSFERRED, target)
        }
        HandOver::TearOff => tear_off(
            &app,
            &path,
            &source,
            Some(PhysicalPosition::new(
                // Offset so the cursor lands inside the new window rather than
                // on the corner it would resize from.
                screen_x - TEAR_OFF_INSET,
                screen_y - TEAR_OFF_INSET,
            )),
        ),
    };
    Ok(result)
}

const TEAR_OFF_INSET: i32 = 24;

/// Window ▸ Move to New Window. The same handover as a tear-off, minus the
/// drop point — releasing and re-claiming instead would leave the path unowned
/// for as long as it takes to build a window.
#[tauri::command]
pub async fn move_document_to_new_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<TabDragResult, String> {
    let path = crate::commands::canonical_path(&path);
    Ok(tear_off(&app, &path, window.label(), None))
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
        registry.set_hover(Some("doc-1"));
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
        registry.set_hover(Some("doc-1"));
        assert_eq!(registry.take_hover().as_deref(), Some("doc-1"));
        assert_eq!(registry.take_hover(), None);
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

    #[test]
    fn a_release_over_another_window_moves_the_claim_and_queues_the_open_together() {
        let (strips, claims, registry) = two_windows();
        assert_eq!(
            strips.resolve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                950,
                110,
            ),
            HandOver::Moved("doc-1".to_string())
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("doc-1"));
        let queued = registry.take_pending("doc-1");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].files, vec![DOC.to_string()]);
        assert!(!queued[0].merge);
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
            strips.resolve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                950,
                110,
            ),
            HandOver::TearOff
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
            strips.resolve_release(&claims, &registry, &live(&["main"]), "main", DOC, 950, 110),
            HandOver::TearOff
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
            strips.resolve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                950,
                110,
            ),
            HandOver::Refused("main".to_string())
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
    }

    #[test]
    fn a_release_the_claim_state_refuses_queues_no_open() {
        let (strips, claims, registry) = two_windows();
        // A second holder means someone else's pending pages address positions
        // in this file: nothing moves, and nothing is promised to the target.
        assert_eq!(
            strips.resolve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "doc-1",
                DOC,
                10,
                10,
            ),
            HandOver::Refused("main".to_string())
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("main").is_empty());
    }

    #[test]
    fn a_release_in_the_sources_own_strip_moves_nothing_and_promises_nothing() {
        let (strips, claims, registry) = two_windows();
        assert_eq!(
            strips.resolve_release(
                &claims,
                &registry,
                &live(&["main", "doc-1"]),
                "main",
                DOC,
                10,
                10,
            ),
            HandOver::Source
        );
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("main").is_empty());
        assert!(registry.take_pending("doc-1").is_empty());
    }

    #[test]
    fn asking_where_a_release_would_go_decides_nothing() {
        let (strips, claims, registry) = two_windows();
        let all = live(&["main", "doc-1"]);
        assert_eq!(
            strips.resolve_at(&all, "main", 950, 110),
            DropTarget::Window("doc-1".into())
        );
        assert_eq!(strips.resolve_at(&all, "main", 10, 10), DropTarget::Source);
        assert_eq!(strips.resolve_at(&all, "main", 600, 600), DropTarget::TearOff);
        // The question the source asks before it writes the user's file must
        // not itself move anything.
        assert_eq!(claims.owner(DOC).as_deref(), Some("main"));
        assert!(registry.take_pending("doc-1").is_empty());
    }
}
