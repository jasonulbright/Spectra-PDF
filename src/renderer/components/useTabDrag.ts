// Wiring for the tab drag: the source window's pointer gesture, the strip
// rectangle and tab order every window publishes, the insertion caret a target
// window paints for a drag it is not running, and the caret a window paints for
// its own drag over its own strip — which is a reorder, resolved locally.
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
  createSerialPublisher,
  hoverCssX,
  physicalPointFor,
  pinGhost,
  releaseDrag,
  settleDrop,
  stripRectFor,
  type FrameThrottle,
  type SerialPublisher,
  type TabDragState,
  type TabGap,
  type ViewportRect,
} from '../lib/tab-drag';
import { buildTabGhost, moveTabGhost, removeTabGhost, snapTabGhostBack } from '../lib/tab-drag-ghost';

const ratio = (): number => window.devicePixelRatio || 1;

/**
 * Publish this window's strip box whenever it can have changed.
 *
 * The box is window-relative and no screen origin is measured here: the far
 * side composes it with the window origin it reads itself, so no drop rect is
 * ever assembled from two positions sampled at different moments.
 *
 * Window MOVES are not among those moments either — the far side hears them
 * first and re-anchors the stored rect, so a rect published several frames ago
 * still names the right window.
 */
export function useStripRegistration(
  stripRef: React.RefObject<HTMLElement | null>,
  relayoutKey: number,
): void {
  // One publisher for the hook's whole life: it carries which publish is still
  // outstanding, and a replacement would start again with none.
  const publisher = useRef<SerialPublisher<ViewportRect | null> | null>(null);
  if (publisher.current === null) {
    publisher.current = createSerialPublisher<ViewportRect | null>(async (rect) => {
      await tabDrag.registerStrip(rect ? stripRectFor(rect, ratio()) : EMPTY_STRIP);
    });
  }
  const publish = publisher.current;

  const remeasure = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = (): void => {
      const box = el.getBoundingClientRect();
      publish.post({ left: box.left, top: box.top, width: box.width, height: box.height });
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
      publish.post(null);
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
 * Publish this window's tab order whenever it changes.
 *
 * The order is what a session snapshot arranges a window's documents by. It
 * rides the same serial-publisher shape the strip rect does, for the same
 * reason: two publishes in flight can be applied in either order, and the
 * loser leaves the far side holding an order the strip has already left.
 */
export function useTabOrderPublication(paths: string[]): void {
  const publisher = useRef<SerialPublisher<string[]> | null>(null);
  if (publisher.current === null) {
    publisher.current = createSerialPublisher<string[]>(async (order) => {
      await tabDrag.setTabOrder(order);
    });
  }
  const publish = publisher.current;
  // Keyed on the order itself rather than on the array: an open, a close, a
  // reorder and a document handed to another window all change this string,
  // and nothing else does.
  const key = paths.join('\n');
  useEffect(() => {
    publish.post(key.length === 0 ? [] : key.split('\n'));
  }, [key, publish]);
}

/** What this window is painting for someone else's drag. */
export interface ForeignCaret {
  /** The offset the far side reported, in this window's CSS pixels. Published
   * on the strip as the one place a device-pixel-ratio disagreement between
   * two windows would show up. */
  x: number | null;
  /** Where that offset lands among THIS window's tabs. Null when no drag is
   * over the strip. */
  gap: TabGap | null;
}

/**
 * The insertion caret this window paints for someone else's drag.
 *
 * The far side sends an offset into this strip and nothing more; the gap is
 * derived here, from this window's own tabs, and reported back so a release
 * lands where the caret promised. Nothing about the other window's layout or
 * scale is involved in either direction.
 */
export function useTabDropCaret(resolveGap: (x: number) => TabGap | null): ForeignCaret {
  const [x, setX] = useState<number | null>(null);
  const [gap, setGap] = useState<TabGap | null>(null);
  const resolve = useRef(resolveGap);
  resolve.current = resolveGap;

  const publisher = useRef<SerialPublisher<number> | null>(null);
  if (publisher.current === null) {
    publisher.current = createSerialPublisher<number>(async (index) => {
      await tabDrag.hoverIndex(index);
    });
  }
  const publish = publisher.current;

  useEffect(() => {
    const hover = tabDrag.onHover((physicalX) => {
      const css = hoverCssX(physicalX, ratio());
      setX(css);
      const next = resolve.current(css);
      setGap(next);
      // Only a live gap is published. The far side drops the index with the
      // caret on leave and on cancel, so a window that stopped hovering has
      // nothing left to retract.
      if (next) publish.post(next.index);
    });
    const leave = tabDrag.onLeave(() => {
      setX(null);
      setGap(null);
    });
    return () => {
      void hover.then((fn) => fn());
      void leave.then((fn) => fn());
    };
  }, [publish]);
  return { x, gap };
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

/**
 * A released drag, with the gap it landed in when the release never left this
 * window's own strip (`reorderTo` is the index the tab takes, already
 * corrected for the tab's own place in the list). Null for every other point,
 * which is a hand-off the far side resolves.
 */
export type TabReleaseHandler = (
  path: string,
  point: PhysicalScreenPoint,
  reorderTo: number | null,
) => Promise<boolean>;

export interface TabDragSource {
  onTabPointerDown: (path: string, draggable: boolean, e: React.PointerEvent<HTMLElement>) => void;
  /** The tab currently being dragged out, for the strip's own styling. */
  draggingPath: string | null;
  /** Where a release would put the dragged tab, while the pointer is over this
   * window's own strip. Null while it is anywhere else. */
  ownGap: TabGap | null;
}

const sameGap = (a: TabGap | null, b: TabGap | null): boolean =>
  a === b || (a !== null && b !== null && a.index === b.index && a.offset === b.offset);

export function useTabDragSource(
  onTabDrop: TabDropHandler,
  ownGapAt: (point: PhysicalScreenPoint) => TabGap | null,
): TabDragSource {
  const dropRef = useRef(onTabDrop);
  dropRef.current = onTabDrop;
  const gapRef = useRef(ownGapAt);
  gapRef.current = ownGapAt;

  const state = useRef<TabDragState>(NO_DRAG);
  const session = useRef<DragSession | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [ownGap, setOwnGap] = useState<TabGap | null>(null);

  // Stable identities: the same function objects have to be handed to
  // addEventListener and removeEventListener across the whole gesture.
  const handlers = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: (e: PointerEvent) => void;
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
    setOwnGap(null);
  }, [unlisten]);

  const dissolve = useCallback((): void => {
    const s = session.current;
    if (!s) return;
    quiesce();
    if (s.ghost) removeTabGhost(s.ghost);
    session.current = null;
  }, [quiesce]);

  const abandon = useCallback(
    (pointerId?: number): void => {
      const outcome = cancelDrag(state.current, pointerId);
      if (outcome.state === state.current) return;
      state.current = outcome.state;
      if (outcome.notify) void tabDrag.cancel().catch(() => {});
      dissolve();
    },
    [dissolve],
  );

  // Unmount, or a strip that stops being rendered, mid-gesture. A drag the far
  // side knows about has a caret painted in the hovered window, and that window
  // is told to stop only from here — dissolving locally leaves it drawn for a
  // drag that no longer exists.
  const teardown = useCallback((): void => {
    const outcome = cancelDrag(state.current);
    if (outcome.notify) void tabDrag.cancel().catch(() => {});
    state.current = outcome.state;
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
        const step = advanceDrag(state.current, e.pointerId, e.clientX, e.clientY);
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
        const point = physicalPointFor(e.screenX, e.screenY, ratio());
        // The caret for a drag over its OWN strip is resolved here rather than
        // round-tripped: the far side would answer from a rectangle this
        // window published about geometry this window measured. The gap moves
        // only when the pointer crosses a tab's midpoint, so the strip
        // re-renders on a crossing rather than on a move.
        const gap = gapRef.current(point);
        setOwnGap((previous) => (sameGap(previous, gap) ? previous : gap));
        s.throttle.post(point);
      },
      up: (e: PointerEvent): void => {
        const s = session.current;
        if (!s) return;
        const release = releaseDrag(state.current, e.pointerId);
        // Another pointer lifting says nothing about the one holding the tab.
        if (release.foreign) return;
        const point = physicalPointFor(e.screenX, e.screenY, ratio());
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
      cancel: (e: PointerEvent): void => abandon(e.pointerId),
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
      // Re-arming over a live drag — a second pointer, or a gesture whose
      // pointerup never arrived — leaves the hovered window drawing a caret
      // nothing else will ever clear.
      if (cancelDrag(state.current).notify) void tabDrag.cancel().catch(() => {});
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

  useEffect(() => teardown, [teardown]);

  return { onTabPointerDown, draggingPath, ownGap };
}
