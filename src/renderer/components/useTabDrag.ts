// Wiring for the cross-window tab drag: the source window's pointer gesture,
// the strip rectangle every window publishes, and the insertion caret a target
// window paints for a drag it is not running.
//
// The gesture is pointer-event based with WINDOW-level listeners, like the
// canvas drag: HTML5 drag-and-drop cannot complete in the webview while native
// file-drop is enabled, and React synthetic pointermove does not deliver.
// Unlike the canvas drag there is no teardown on window blur — the pointer
// leaving this window is the normal case here, not an interruption.
//
// Every decision worth testing lives in `lib/tab-drag.ts`; what is here is the
// part that only exists against a live DOM.

import { useCallback, useEffect, useRef, useState } from 'react';
import { pushEscapeInterceptor } from '../commands/context';
import { tabDrag, type PhysicalScreenPoint } from '../lib/tauri-bridge';
import {
  EMPTY_STRIP,
  NO_DRAG,
  advanceDrag,
  armDrag,
  cancelDrag,
  createFrameThrottle,
  hoverCssX,
  physicalPointFor,
  pinGhost,
  releaseDrag,
  settleDrop,
  stripRectFor,
  type FrameThrottle,
  type TabDragState,
  type ViewportRect,
} from '../lib/tab-drag';
import { buildTabGhost, moveTabGhost, removeTabGhost, snapTabGhostBack } from '../lib/tab-drag-ghost';

const ratio = (): number => window.devicePixelRatio || 1;

/**
 * Publish this window's strip box whenever it can have changed.
 *
 * Window MOVES are not among those moments: the far side hears them first and
 * re-anchors the stored rect itself, so a rect published several frames ago
 * still names the right window.
 */
export function useStripRegistration(
  stripRef: React.RefObject<HTMLElement | null>,
  relayoutKey: number,
): void {
  // A publish reads the window origin asynchronously, so two in flight can
  // land out of order; the newest ticket is the only one allowed to write.
  const ticket = useRef(0);

  const publish = useCallback(async (rect: ViewportRect | null): Promise<void> => {
    const mine = ++ticket.current;
    if (!rect) {
      await tabDrag.registerStrip(EMPTY_STRIP);
      return;
    }
    const origin = await tabDrag.windowOrigin();
    if (mine !== ticket.current) return;
    await tabDrag.registerStrip(stripRectFor(rect, origin, ratio()));
  }, []);

  const remeasure = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = (): void => {
      const box = el.getBoundingClientRect();
      void publish({ left: box.left, top: box.top, width: box.width, height: box.height }).catch(
        () => {
          // A window that cannot report its own origin simply takes no drops.
        },
      );
    };
    remeasure.current = measure;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Also on window resize: moving between monitors changes the device pixel
    // ratio without changing the strip's CSS box, and the rect is physical.
    window.addEventListener('resize', measure);
    return () => {
      remeasure.current = null;
      observer.disconnect();
      window.removeEventListener('resize', measure);
      void publish(null).catch(() => {});
    };
  }, [stripRef, publish]);

  // A relayout republishes rather than re-running the effect above: tearing
  // that down would forget the strip for a round trip, and a drag hovering it
  // at that moment would resolve to a tear-off.
  useEffect(() => {
    remeasure.current?.();
  }, [relayoutKey]);
}

/**
 * The insertion caret this window paints for someone else's drag, in CSS
 * pixels from its own strip's left edge. Null when no drag is over it.
 */
export function useTabDropCaret(): number | null {
  const [caret, setCaret] = useState<number | null>(null);
  useEffect(() => {
    const hover = tabDrag.onHover((x) => setCaret(hoverCssX(x, ratio())));
    const leave = tabDrag.onLeave(() => setCaret(null));
    return () => {
      void hover.then((fn) => fn());
      void leave.then((fn) => fn());
    };
  }, []);
  return caret;
}

interface DragSession {
  el: HTMLElement;
  pointerId: number;
  width: number;
  height: number;
  /** Where the ghost rests if the drop changes nothing. */
  home: { x: number; y: number };
  ghost: HTMLElement | null;
  throttle: FrameThrottle<PhysicalScreenPoint>;
  unregisterEscape: () => void;
}

/** Resolves true when the document changed hands (the tab is gone). */
export type TabDropHandler = (path: string, point: PhysicalScreenPoint) => Promise<boolean>;

export interface TabDragSource {
  onTabPointerDown: (path: string, draggable: boolean, e: React.PointerEvent<HTMLElement>) => void;
  /** The tab currently being dragged out, for the strip's own styling. */
  draggingPath: string | null;
}

export function useTabDragSource(onTabDrop: TabDropHandler): TabDragSource {
  const dropRef = useRef(onTabDrop);
  dropRef.current = onTabDrop;

  const state = useRef<TabDragState>(NO_DRAG);
  const session = useRef<DragSession | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);

  // Stable identities: the same function objects have to be handed to
  // addEventListener and removeEventListener across the whole gesture.
  const handlers = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: () => void;
  } | null>(null);

  const unlisten = useCallback((): void => {
    const h = handlers.current;
    if (!h) return;
    window.removeEventListener('pointermove', h.move);
    window.removeEventListener('pointerup', h.up);
    window.removeEventListener('pointercancel', h.cancel);
  }, []);

  // End the gesture's INPUT half: listeners, capture, Escape, pending frame.
  // The ghost outlives this when a drop is resolving.
  const quiesce = useCallback((): void => {
    const s = session.current;
    if (!s) return;
    unlisten();
    s.throttle.cancel();
    s.unregisterEscape();
    try {
      s.el.releasePointerCapture(s.pointerId);
    } catch {
      // already released, or the tab is gone
    }
    setDraggingPath(null);
  }, [unlisten]);

  const dissolve = useCallback((): void => {
    const s = session.current;
    if (!s) return;
    quiesce();
    if (s.ghost) removeTabGhost(s.ghost);
    session.current = null;
  }, [quiesce]);

  const abandon = useCallback((): void => {
    const outcome = cancelDrag(state.current);
    if (outcome.state === state.current) return;
    state.current = outcome.state;
    if (outcome.notify) void tabDrag.cancel().catch(() => {});
    dissolve();
  }, [dissolve]);

  // Swallow the click that follows a completed drag so the tab is not focused
  // on its way out. Disarmed on the next tick when no click arrives — the tab
  // can unmount before the browser dispatches it.
  const suppressNextClick = (): void => {
    const swallow = (ev: MouseEvent): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  };

  if (handlers.current === null) {
    handlers.current = {
      move: (e: PointerEvent): void => {
        const s = session.current;
        if (!s) return;
        const step = advanceDrag(state.current, e.clientX, e.clientY);
        state.current = step.state;
        if (step.started) {
          s.ghost = buildTabGhost(s.el, s.el.getBoundingClientRect());
          setDraggingPath(step.state.path);
        }
        if (!step.tracking) return;
        if (s.ghost) {
          const at = pinGhost(
            e.clientX,
            e.clientY,
            step.state.grabDX,
            step.state.grabDY,
            { width: s.width, height: s.height },
            { width: window.innerWidth, height: window.innerHeight },
          );
          moveTabGhost(s.ghost, at.x, at.y);
        }
        s.throttle.post(physicalPointFor(e.screenX, e.screenY, ratio()));
      },
      up: (e: PointerEvent): void => {
        const s = session.current;
        if (!s) return;
        const point = physicalPointFor(e.screenX, e.screenY, ratio());
        const release = releaseDrag(state.current);
        state.current = release.state;
        if (!release.drop) {
          dissolve();
          return; // below the threshold — an ordinary click, let it through
        }
        quiesce();
        suppressNextClick();
        void (async () => {
          let moved = false;
          try {
            moved = await dropRef.current(release.path, point);
          } finally {
            state.current = settleDrop(state.current);
            // A drop that resolved already cleared the hovered window's caret;
            // one the commit gate refused never reached the far side at all,
            // and would otherwise leave a caret painted for a drag that ended.
            if (!moved) void tabDrag.cancel().catch(() => {});
            if (s.ghost) {
              if (moved) removeTabGhost(s.ghost);
              else {
                const box = s.el.isConnected ? s.el.getBoundingClientRect() : null;
                snapTabGhostBack(s.ghost, box ? { x: box.left, y: box.top } : s.home);
              }
            }
            session.current = null;
          }
        })();
      },
      cancel: (): void => abandon(),
    };
  }

  const onTabPointerDown = useCallback(
    (path: string, draggable: boolean, e: React.PointerEvent<HTMLElement>): void => {
      const el = e.currentTarget;
      const box = el.getBoundingClientRect();
      const armed = armDrag(state.current, {
        path,
        pointerId: e.pointerId,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        grabDX: e.clientX - box.left,
        grabDY: e.clientY - box.top,
        draggable,
      });
      // Anything else is a press this gesture does not own: a drop still
      // resolving, a secondary button, a tab that never travels.
      if (armed.phase !== 'armed') return;
      dissolve();
      state.current = armed;
      session.current = {
        el,
        pointerId: e.pointerId,
        width: box.width,
        height: box.height,
        home: { x: box.left, y: box.top },
        ghost: null,
        throttle: createFrameThrottle<PhysicalScreenPoint>(
          (point) => {
            void tabDrag.track(point).catch(() => {});
          },
          (cb) => requestAnimationFrame(cb),
          (handle) => cancelAnimationFrame(handle),
        ),
        // Escape belongs to the drag only once it is one; an armed press that
        // has not travelled leaves the rest of the Escape chain alone.
        unregisterEscape: pushEscapeInterceptor(() => {
          if (state.current.phase !== 'dragging') return false;
          abandon();
          return true;
        }),
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // capture is best-effort; the window listeners still track the drag
      }
      const h = handlers.current;
      if (h) {
        window.addEventListener('pointermove', h.move);
        window.addEventListener('pointerup', h.up);
        window.addEventListener('pointercancel', h.cancel);
      }
    },
    [abandon, dissolve],
  );

  useEffect(() => dissolve, [dissolve]);

  return { onTabPointerDown, draggingPath };
}
