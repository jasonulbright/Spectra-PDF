/**
 * The renderer half of a cross-window tab drag: the gesture's state machine and
 * its coordinate arithmetic, with no DOM and no IPC.
 *
 * The source window owns the whole gesture — with the button held, its own
 * window-level listeners keep receiving moves while the cursor is over another
 * window, and the window underneath hears nothing until release. Rust owns the
 * geography: which strip a screen point falls in, and who owns the document
 * afterwards. Everything here is the part that can be decided without asking
 * either side, which is also the part worth testing.
 */

import type { TabDragResult } from './tauri-bridge';

/** Travel that separates a drag from the click that focuses a tab. */
export const TAB_DRAG_THRESHOLD_PX = 6;

export interface PhysicalPoint {
  x: number;
  y: number;
}

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The strip's box as the renderer measures it: CSS pixels, viewport-relative. */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A rect with no area. Registering one forgets the strip, so a window whose
 * strip is hidden cannot take a drop. */
export const EMPTY_STRIP: PhysicalRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * A viewport rect in physical pixels, still relative to the window.
 *
 * No screen origin is added here, and none crosses the boundary: the far side
 * composes this rect with the window origin IT reads, under the same lock it
 * re-anchors with. Two sides sampling the origin at different moments is how a
 * window moved between the reads leaves the stored rect permanently offset.
 *
 * A degenerate box collapses to `EMPTY_STRIP` rather than to a zero-area rect at
 * some offset — the far side keys "forget" off the size.
 */
export function stripRectFor(rect: ViewportRect, devicePixelRatio: number): PhysicalRect {
  const width = Math.round(rect.width * devicePixelRatio);
  const height = Math.round(rect.height * devicePixelRatio);
  if (width <= 0 || height <= 0) return EMPTY_STRIP;
  return {
    x: Math.round(rect.left * devicePixelRatio),
    y: Math.round(rect.top * devicePixelRatio),
    width,
    height,
  };
}

/**
 * A pointer event's screen position in physical pixels.
 *
 * `screenX`/`screenY` are CSS pixels in the screen's own coordinate space, so
 * the window's position is already in them and only the scale is missing.
 */
export function physicalPointFor(
  screenX: number,
  screenY: number,
  devicePixelRatio: number,
): PhysicalPoint {
  return {
    x: Math.round(screenX * devicePixelRatio),
    y: Math.round(screenY * devicePixelRatio),
  };
}

/**
 * A hover offset (physical pixels from the hovered strip's own left edge) in
 * the hovering window's CSS pixels.
 *
 * The offset arrives in physical pixels precisely so the source's scale factor
 * never travels with the drag: each window divides by its own ratio.
 */
export function hoverCssX(physicalX: number, devicePixelRatio: number): number {
  return physicalX / devicePixelRatio;
}

// ── Insertion gaps ────────────────────────────────────────────────────────

/** A tab's box in CSS pixels from its strip's own left edge. */
export interface TabBox {
  left: number;
  width: number;
}

/** Where an insertion caret goes: which gap, and how far into the strip it is
 * painted. Both in the strip's own space. */
export interface TabGap {
  /** 0 is before the first tab, `tabs.length` after the last. */
  index: number;
  /** CSS pixels from the strip's left edge. */
  offset: number;
}

/**
 * The gap a pointer at `x` names, counting tabs whose midpoint it has passed.
 *
 * ONE implementation for both carets. The window a drag started in measures
 * its own strip and the window a drag hovers measures its own — neither ever
 * sees the other's DOM — so the only way the caret can mean the same thing in
 * both is for the arithmetic to be the same arithmetic. `x` and the boxes are
 * in the strip's own CSS space, which is also the space a hover offset arrives
 * in, so nothing about either window's scale factor is involved.
 *
 * Boxes are in strip order and do not overlap.
 */
export function gapIndexFor(boxes: TabBox[], x: number): number {
  let index = 0;
  for (const box of boxes) {
    if (x >= box.left + box.width / 2) index += 1;
  }
  return index;
}

/** Where the caret for a gap is painted, in the strip's own CSS space. */
export function gapOffsetFor(boxes: TabBox[], index: number): number {
  if (boxes.length === 0) return 0;
  if (index <= 0) return boxes[0].left;
  const last = boxes[Math.min(index, boxes.length) - 1];
  return last.left + last.width;
}

/** The gap a pointer at `x` names, ready to paint. */
export function tabGapFor(boxes: TabBox[], x: number): TabGap {
  const index = gapIndexFor(boxes, x);
  return { index, offset: gapOffsetFor(boxes, index) };
}

/**
 * The index a tab dragged from position `from` takes when it is released in
 * gap `gap`.
 *
 * A gap counts the tabs BEFORE it, and the dragged tab is still one of them:
 * released past its own position, every tab it passed has already shifted left
 * by one. A document arriving from another window is not in the list yet, so
 * its gap IS its index and it never comes through here.
 */
export function reorderIndexFor(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** What a window knows about itself while resolving a point over its own strip. */
export interface OwnStripFrame {
  /** The window's INNER origin in CSS screen pixels (`window.screenX/Y`) —
   * the same origin the far side anchors this window's strip to. */
  originX: number;
  originY: number;
  devicePixelRatio: number;
  /** The strip's box, viewport-relative CSS pixels. */
  strip: ViewportRect;
}

/**
 * A physical screen point in CSS pixels from this window's own strip's left
 * edge, or null when the point is not over that strip.
 *
 * Within one window the far side is not asked at all: it would answer from a
 * rectangle this window published, about geometry this window measured. The
 * far edges are half-open exactly as they are there, so a point can never be
 * both inside this strip and inside one abutting it.
 */
export function ownStripX(point: PhysicalPoint, frame: OwnStripFrame): number | null {
  const { left, top, width, height } = frame.strip;
  if (width <= 0 || height <= 0) return null;
  const x = point.x / frame.devicePixelRatio - frame.originX;
  const y = point.y / frame.devicePixelRatio - frame.originY;
  if (x < left || x >= left + width) return null;
  if (y < top || y >= top + height) return null;
  return x - left;
}

// ── Arm state machine ─────────────────────────────────────────────────────

export type TabDragPhase = 'idle' | 'armed' | 'dragging' | 'dropping';

export interface TabDragState {
  readonly phase: TabDragPhase;
  readonly path: string;
  readonly pointerId: number;
  /** Where the button went down, in client CSS pixels. */
  readonly startX: number;
  readonly startY: number;
  /** Where inside the tab it was grabbed, so the ghost keeps that grip. */
  readonly grabDX: number;
  readonly grabDY: number;
}

export const NO_DRAG: TabDragState = {
  phase: 'idle',
  path: '',
  pointerId: -1,
  startX: 0,
  startY: 0,
  grabDX: 0,
  grabDY: 0,
};

export interface ArmRequest {
  path: string;
  pointerId: number;
  /** Only the primary button drags. */
  button: number;
  clientX: number;
  clientY: number;
  grabDX: number;
  grabDY: number;
  /** False for anything that is not a movable document tab. */
  draggable: boolean;
}

/**
 * Take a pointerdown.
 *
 * A pointerdown always replaces whatever arm state was left behind, which is
 * what makes the activation hazard survivable: a pointerdown that also
 * activates a background window is cancelled by the activation (Chromium
 * delivers `pointerdown` then `pointercancel`, no capture is established), and
 * the first drag out of an unfocused window only works if the next pointerdown
 * arms from scratch instead of finding a half-live gesture.
 *
 * A drop already in flight is the one state a pointerdown cannot interrupt: the
 * commit gate and the handover are running against the path this state names.
 */
export function armDrag(state: TabDragState, req: ArmRequest): TabDragState {
  if (state.phase === 'dropping') return state;
  if (req.button !== 0 || !req.draggable) return NO_DRAG;
  return {
    phase: 'armed',
    path: req.path,
    pointerId: req.pointerId,
    startX: req.clientX,
    startY: req.clientY,
    grabDX: req.grabDX,
    grabDY: req.grabDY,
  };
}

export interface AdvanceResult {
  state: TabDragState;
  /** True on the single move that crossed the threshold. */
  started: boolean;
  /** Whether this move should be reported to the far side. */
  tracking: boolean;
}

/**
 * Take a pointermove. Below the threshold the gesture is still a click.
 *
 * Scoped to the pointer that armed it: a second touch or a pen moving while a
 * tab is held is a different input device, and letting it drive would move a
 * document the pointer holding the tab never went near.
 */
export function advanceDrag(
  state: TabDragState,
  pointerId: number,
  clientX: number,
  clientY: number,
): AdvanceResult {
  if (pointerId !== state.pointerId) {
    return { state, started: false, tracking: false };
  }
  if (state.phase === 'dragging') {
    return { state, started: false, tracking: true };
  }
  if (state.phase !== 'armed') {
    return { state, started: false, tracking: false };
  }
  const travel = Math.hypot(clientX - state.startX, clientY - state.startY);
  if (travel < TAB_DRAG_THRESHOLD_PX) {
    return { state, started: false, tracking: false };
  }
  return { state: { ...state, phase: 'dragging' }, started: true, tracking: true };
}

export interface ReleaseResult {
  state: TabDragState;
  /** True when the release is a drop rather than the end of a click. */
  drop: boolean;
  /** The document the drop is resolving; empty when it is not one. */
  path: string;
  /**
   * True when the release belonged to some other pointer. The gesture is
   * untouched and the caller must leave it running — treating a foreign
   * release as the end of the gesture drops a drag that is still held.
   */
  foreign: boolean;
}

/** Take a pointerup, from the pointer that armed the gesture or another one. */
export function releaseDrag(state: TabDragState, pointerId: number): ReleaseResult {
  if (pointerId !== state.pointerId) {
    return { state, drop: false, path: '', foreign: true };
  }
  if (state.phase !== 'dragging') {
    return { state: NO_DRAG, drop: false, path: '', foreign: false };
  }
  return { state: { ...state, phase: 'dropping' }, drop: true, path: state.path, foreign: false };
}

export interface CancelResult {
  state: TabDragState;
  /**
   * Whether the far side has to be told. It only knows about a drag that
   * reported a move, so cancelling an armed-but-untravelled gesture — the
   * activation `pointercancel` — has nothing to undo there.
   */
  notify: boolean;
}

/**
 * Take an Escape, an unmount, or a `pointercancel`. A drop in flight is past
 * cancelling.
 *
 * `pointerId` is given only where the cancel came from a pointer: another
 * pointer's cancellation says nothing about the one holding the tab. Escape and
 * teardown belong to the window rather than to any pointer and pass none.
 */
export function cancelDrag(state: TabDragState, pointerId?: number): CancelResult {
  if (pointerId !== undefined && pointerId !== state.pointerId) {
    return { state, notify: false };
  }
  if (state.phase === 'dropping') return { state, notify: false };
  return { state: NO_DRAG, notify: state.phase === 'dragging' };
}

/** Finish an in-flight drop, whatever it resolved to. */
export function settleDrop(state: TabDragState): TabDragState {
  return state.phase === 'dropping' ? NO_DRAG : state;
}

// ── Outcomes ──────────────────────────────────────────────────────────────

/**
 * Whether the document actually changed hands.
 *
 * The source closes its tab — and must NOT release the claim, which already
 * belongs to the receiving window — only for these two outcomes. Closing on
 * `sameWindow` or `refused` loses the document.
 */
export function tabMoved(result: TabDragResult): boolean {
  return result.outcome === 'transferred' || result.outcome === 'tornOff';
}

/** What a hand-off does once the page tier has been flushed. */
export interface HandOffPlan {
  /** Resolve the handover with the far side at all. */
  readonly hand: boolean;
  /**
   * Write the working copy back over the document's own path FIRST. The
   * receiving window opens the path and mints a working copy from whatever is
   * on disk, so the file is the only channel the document travels through, and
   * it is read the instant the claim moves.
   */
  readonly saveFirst: boolean;
}

/**
 * Plan a hand-off from where the release resolved and whether the document has
 * unsaved work.
 *
 * A release that stays in this window is not a hand-off: it must not write the
 * user's file and must not clear the undo history, which is what marking a
 * document saved does. So the destination is settled BEFORE anything is
 * written, and a document that is not going anywhere is left exactly as it was.
 */
export function planHandOff(willMove: boolean, dirty: boolean): HandOffPlan {
  if (!willMove) return { hand: false, saveFirst: false };
  return { hand: true, saveFirst: dirty };
}

// ── Ghost placement ───────────────────────────────────────────────────────

/**
 * Where the ghost sits for a pointer at (`clientX`, `clientY`).
 *
 * The ghost is drawn by the source window, which cannot paint outside itself,
 * so beyond the window edge it pins to the edge rather than disappearing. The
 * cursor keeps going; the pinned ghost is what says the drag is still live.
 */
export function pinGhost(
  clientX: number,
  clientY: number,
  grabDX: number,
  grabDY: number,
  ghost: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const clamp = (value: number, extent: number, span: number): number => {
    const limit = Math.max(0, span - extent);
    return Math.min(Math.max(value, 0), limit);
  };
  return {
    x: clamp(clientX - grabDX, ghost.width, viewport.width),
    y: clamp(clientY - grabDY, ghost.height, viewport.height),
  };
}

// ── Serial publishing ─────────────────────────────────────────────────────

export interface SerialPublisher<T> {
  /** Record a value to publish. The newest one always wins. */
  post(value: T): void;
}

/**
 * Publish values one at a time, newest wins.
 *
 * Two registrations in flight at once can be applied in either order — each
 * command runs on its own task — and the loser overwrites the current rect with
 * a stale one that then survives until the next relayout. Waiting for each
 * publish to be acknowledged before sending the next makes arrival order the
 * order they were measured in; a value measured while one is in flight replaces
 * whatever else was waiting rather than queueing behind it.
 */
export function createSerialPublisher<T>(send: (value: T) => Promise<void>): SerialPublisher<T> {
  let inFlight = false;
  let pending: { value: T } | null = null;
  const drain = (): void => {
    const next = pending;
    pending = null;
    if (!next) {
      inFlight = false;
      return;
    }
    inFlight = true;
    void send(next.value).then(drain, drain);
  };
  return {
    post(value: T): void {
      pending = { value };
      if (inFlight) return;
      drain();
    },
  };
}

// ── Frame throttle ────────────────────────────────────────────────────────

export interface FrameThrottle<T> {
  /** Record a value; the newest one wins when the frame runs. */
  post(value: T): void;
  /** Drop a pending frame without running it. */
  cancel(): void;
}

/**
 * Coalesce a stream of values to one delivery per animation frame.
 *
 * Pointer moves arrive faster than frames and each one would otherwise be its
 * own IPC round trip. Only the newest position matters — an intermediate one is
 * a place the cursor has already left.
 */
export function createFrameThrottle<T>(
  run: (value: T) => void,
  schedule: (callback: () => void) => number,
  unschedule: (handle: number) => void,
): FrameThrottle<T> {
  let handle: number | null = null;
  let pending: T | null = null;
  return {
    post(value: T): void {
      pending = value;
      if (handle !== null) return;
      handle = schedule(() => {
        handle = null;
        const next = pending;
        pending = null;
        if (next !== null) run(next);
      });
    },
    cancel(): void {
      if (handle !== null) unschedule(handle);
      handle = null;
      pending = null;
    },
  };
}
