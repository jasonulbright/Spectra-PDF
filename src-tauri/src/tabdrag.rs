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
//! Strip rectangles are held in PHYSICAL SCREEN pixels, anchored to the window's
//! `inner_position`. The outer origin includes the frame, whose title bar alone
//! is taller than the gap between the strip and the toolbar below it, so a rect
//! measured against it hit-tests into the wrong band. Each entry remembers the
//! inner origin it was measured against and is re-anchored whenever the window
//! moves or resizes, so a rect the renderer last published several frames ago
//! still names the right window.

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
    rect: StripRect,
    /// The window's inner origin when the rect was measured.
    origin: (i32, i32),
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

    fn set(&self, label: &str, rect: StripRect, origin: (i32, i32)) {
        if let Ok(mut strips) = self.strips.lock() {
            strips.insert(label.to_string(), StripEntry { rect, origin });
        }
    }

    /// Move a label's rect by however far its window's inner origin has moved.
    ///
    /// Windows minimize to an off-screen origin, so a minimized window's strip
    /// leaves the hit-testable area by the same arithmetic that follows an
    /// ordinary drag, and comes back when the window is restored.
    fn reanchor(&self, label: &str, origin: (i32, i32)) {
        if let Ok(mut strips) = self.strips.lock() {
            if let Some(entry) = strips.get_mut(label) {
                entry.rect.x += origin.0 - entry.origin.0;
                entry.rect.y += origin.1 - entry.origin.1;
                entry.origin = origin;
            }
        }
    }

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
        let mut out: Vec<(String, StripRect)> = strips
            .iter()
            .map(|(label, entry)| (label.clone(), entry.rect))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
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

/// Strips that can actually receive a drop: registered, still alive, and on
/// screen. A window hidden to the tray keeps its rect (nothing tells this side
/// it moved), and a document dropped into an invisible window is gone as far as
/// the user can tell — a tear-off is the recoverable answer.
fn droppable_strips(app: &AppHandle) -> Vec<(String, StripRect)> {
    let windows = app.webview_windows();
    app.state::<StripRegistry>()
        .snapshot()
        .into_iter()
        .filter(|(label, _)| {
            windows
                .get(label)
                .map(|w| w.is_visible().unwrap_or(false))
                .unwrap_or(false)
        })
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
    app_windows::deliver_open(app, &label, vec![path.to_string()], false);
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

/// Publish this window's tab-strip rectangle, in physical screen pixels.
///
/// The renderer measures it (`getBoundingClientRect` scaled by its own device
/// pixel ratio, offset by `inner_position`) because only the renderer knows
/// where the strip sits inside the page; this side records it against the
/// window's inner origin so it can follow the window afterwards. A strip with
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
    let result = match resolve_drop(&droppable_strips(&app), &source, screen_x, screen_y) {
        DropTarget::Source => TabDragResult::same_window(),
        DropTarget::Window(target) => {
            let moved = app.state::<ClaimState>().transfer(&path, &source, &target);
            if moved.granted {
                app_windows::deliver_open(&app, &target, vec![path.clone()], false);
                app_windows::focus_label(&app, &target);
                TabDragResult::moved(TabDragResult::TRANSFERRED, target)
            } else {
                TabDragResult::refused(moved.owner)
            }
        }
        DropTarget::TearOff => tear_off(
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
        registry.set(
            "doc-1",
            StripRect {
                x: 940,
                y: 131,
                width: 400,
                height: 40,
            },
            (900, 100),
        );
        // Dragged 200 right and 50 up: the strip keeps its offset inside the
        // window, which is the whole reason the origin is stored with it.
        registry.reanchor("doc-1", (1100, 50));
        assert_eq!(
            registry.snapshot(),
            vec![strip("doc-1", 1140, 81, 400, 40)]
        );
        // Re-anchoring twice must not double-count the first move.
        registry.reanchor("doc-1", (1100, 50));
        assert_eq!(registry.snapshot(), vec![strip("doc-1", 1140, 81, 400, 40)]);
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
}
