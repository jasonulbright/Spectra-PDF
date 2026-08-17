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
 * A viewport rect in physical screen pixels.
 *
 * The origin is the window's INNER position: the outer origin includes the
 * frame, whose title bar alone is taller than the gap between the strip and the
 * toolbar under it, so a rect measured against it hit-tests into the wrong band.
 * A degenerate box collapses to `EMPTY_STRIP` rather than to a zero-area rect at
 * some screen position — the far side keys "forget" off the size.
 */
export function stripRectFor(
  rect: ViewportRect,
  origin: PhysicalPoint,
  devicePixelRatio: number,
): PhysicalRect {
  const width = Math.round(rect.width * devicePixelRatio);
  const height = Math.round(rect.height * devicePixelRatio);
  if (width <= 0 || height <= 0) return EMPTY_STRIP;
  return {
    x: origin.x + Math.round(rect.left * devicePixelRatio),
    y: origin.y + Math.round(rect.top * devicePixelRatio),
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

/** Take a pointermove. Below the threshold the gesture is still a click. */
export function advanceDrag(
  state: TabDragState,
  clientX: number,
  clientY: number,
): AdvanceResult {
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
}

/** Take a pointerup. */
export function releaseDrag(state: TabDragState): ReleaseResult {
  if (state.phase !== 'dragging') {
    return { state: NO_DRAG, drop: false, path: '' };
  }
  return { state: { ...state, phase: 'dropping' }, drop: true, path: state.path };
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

/** Take an Escape, or a `pointercancel`. A drop in flight is past cancelling. */
export function cancelDrag(state: TabDragState): CancelResult {
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
