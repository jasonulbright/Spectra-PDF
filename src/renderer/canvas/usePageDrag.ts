import { useCallback, useEffect, useRef, useState } from 'react';
import { computeDropTarget, DOC_HEIGHT } from './layout';
import { INTO_MIN_SCREEN_PX } from './drop-target';
import { buildDragGhost, moveDragGhost } from './drag-ghost';
import type { CanvasLayout, DropTarget } from './layout';
import type { CanvasHandle } from './canvas-handle';

export interface DragSource {
  docId: string;
  pageId: string;
}

interface PageDragDeps {
  layout: CanvasLayout;
  canvasRef: React.RefObject<CanvasHandle | null>;
  // The pages that should move when `grabbedPageId` is grabbed: the whole
  // multi-selection if the grabbed page is part of it, otherwise just that
  // page. Returned in workspace-flattened order.
  getMovingPageIds: (grabbedPageId: string) => string[];
  movePagesInto: (movingIds: string[], targetDocId: string, index: number) => void;
  movePagesToNewDoc: (movingIds: string[], docIndex: number) => void;
}

interface DragSession {
  source: DragSource;
  // The full set of pages travelling with this drag (≥1). Captured at grab time
  // so drop-target index math excludes every moving page from the first move,
  // not a frame later like the render-collapse.
  movingIds: string[];
  movingSet: Set<string>;
  el: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  grabDX: number;
  grabDY: number;
  width: number;
  height: number;
  started: boolean;
  ghost: HTMLElement | null;
}

const DRAG_THRESHOLD_PX = 6;
// Zoomed out past the into-target gate, the only possible drop creates a new
// document — demand a clearly deliberate motion so a jittery click can't
// split a page off (review finding: 6px at far zoom-out was an accident trap).
const DRAG_THRESHOLD_ZOOMED_OUT_PX = 24;

// Pointer-event drag controller for canvas pages. Semantics ported from
// PDFx's useDragController/root-drag-handlers (drop-target math, deferred
// collapse, commit flash); the event plumbing is pointer-based because HTML5
// drag-and-drop can't complete inside a Tauri webview on Windows while native
// file drag-drop is enabled. Supports multi-page drags: grabbing a page that is
// part of the current selection moves the whole selection as one undo step.
export function usePageDrag(deps: PageDragDeps) {
  const [draggingPage, setDraggingPage] = useState<DragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string> | null>(null);
  const [committing, setCommitting] = useState(false);

  const depsRef = useRef(deps);
  depsRef.current = deps;
  const session = useRef<DragSession | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  dropTargetRef.current = dropTarget;

  const updateDropTarget = useCallback((next: DropTarget | null) => {
    setDropTarget((prev) => {
      if (prev === next) return prev;
      if (!prev || !next || prev.kind !== next.kind) return next;
      if (prev.kind === 'into' && next.kind === 'into') {
        return prev.docId === next.docId && prev.index === next.index ? prev : next;
      }
      if (prev.kind === 'between' && next.kind === 'between') {
        return prev.docIndex === next.docIndex ? prev : next;
      }
      return next;
    });
  }, []);

  const teardown = useCallback(() => {
    const s = session.current;
    session.current = null;
    if (s?.ghost) s.ghost.remove();
    if (s) {
      // Escape/pointercancel can tear down while the button is still held —
      // without this, the inert page element keeps the capture until release.
      try {
        s.el.releasePointerCapture(s.pointerId);
      } catch {
        // already released or element gone
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onWindowBlur);
    }
    setDraggingPage(null);
    setDropTarget(null);
    setCollapsedIds(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swallow the click that follows a completed drag so it doesn't reselect.
  // If no click arrives (the dropped cell can unmount before the browser
  // dispatches it), disarm on the next tick so an unrelated later click
  // isn't eaten.
  const suppressNextClick = (): void => {
    const swallow = (ev: MouseEvent): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  };

  function onPointerMove(e: PointerEvent): void {
    const s = session.current;
    if (!s) return;
    if (!s.started) {
      const w = depsRef.current.canvasRef.current?.clientToWorld(e.clientX, e.clientY);
      const zoomedOut = w != null && DOC_HEIGHT * w.k < INTO_MIN_SCREEN_PX;
      const threshold = zoomedOut ? DRAG_THRESHOLD_ZOOMED_OUT_PX : DRAG_THRESHOLD_PX;
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < threshold) return;
      s.started = true;
      const rect = s.el.getBoundingClientRect();
      s.ghost = buildDragGhost(s.el, rect, s.movingIds.length);
      setDraggingPage(s.source);
    }
    if (s.ghost) moveDragGhost(s.ghost, e.clientX - s.grabDX, e.clientY - s.grabDY);
    const w = depsRef.current.canvasRef.current?.clientToWorld(e.clientX, e.clientY);
    if (!w) return;
    updateDropTarget(computeDropTarget(depsRef.current.layout, w.x, w.y, w.k, s.movingSet, true));
  }

  function onPointerUp(e: PointerEvent): void {
    const s = session.current;
    if (!s) return;
    if (!s.started) {
      teardown();
      return; // below the threshold — an ordinary click, let it through
    }
    suppressNextClick();
    setCommitting(true);
    const w = depsRef.current.canvasRef.current?.clientToWorld(e.clientX, e.clientY);
    const target = w
      ? computeDropTarget(depsRef.current.layout, w.x, w.y, w.k, s.movingSet, true)
      : dropTargetRef.current;
    const movingIds = s.movingIds;
    teardown();
    if (target?.kind === 'into') depsRef.current.movePagesInto(movingIds, target.docId, target.index);
    else if (target?.kind === 'between') depsRef.current.movePagesToNewDoc(movingIds, target.docIndex);
  }

  function onPointerCancel(): void {
    teardown();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') teardown();
  }

  function onWindowBlur(): void {
    teardown();
  }

  const onPagePointerDown = useCallback(
    (docId: string, pageId: string, e: React.PointerEvent<HTMLElement>): void => {
      if (e.button !== 0 || session.current) return;
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const movingIds = depsRef.current.getMovingPageIds(pageId);
      session.current = {
        source: { docId, pageId },
        movingIds,
        movingSet: new Set(movingIds),
        el,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        grabDX: e.clientX - rect.left,
        grabDY: e.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        started: false,
        ghost: null,
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // capture is best-effort; window listeners still track the drag
      }
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('blur', onWindowBlur);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Collapse the dragged page(s) a frame after the ghost appears (PDFx timing:
  // lets the drag ghost paint before the strip reflows).
  useEffect(() => {
    if (!draggingPage) return;
    const id = requestAnimationFrame(() => {
      const s = session.current;
      if (s) setCollapsedIds(s.movingSet);
    });
    return () => cancelAnimationFrame(id);
  }, [draggingPage]);

  // One-frame transition suppression after a drop so strips snap into place.
  useEffect(() => {
    if (!committing) return;
    const id = requestAnimationFrame(() => setCommitting(false));
    return () => cancelAnimationFrame(id);
  }, [committing]);

  useEffect(() => teardown, [teardown]);

  return {
    draggingPage,
    dropTarget,
    collapsedIds,
    committing,
    onPagePointerDown,
  };
}
