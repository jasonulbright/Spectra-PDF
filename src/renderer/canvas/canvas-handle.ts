import { select } from 'd3-selection';
import { zoomIdentity, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { BUTTON_ZOOM_FACTOR } from './zoom-constants';
import type { RefObject } from 'react';

export interface CanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  /**
   * Zoom presets — Acrobat's Actual Size (Ctrl+1) and Fit Width (Ctrl+2).
   *
   * On the READING view they act on the current page/spread (DocumentView's
   * own implementations). On the Organize board (P10, 2026-08-01 — this
   * replaced an "absent, not faked" refusal) they anchor to the SELECTED
   * page cell, else the cell nearest the viewport centre, and solve the
   * camera zoom from the cell's `data-natural-*` extents: Actual Size makes
   * that page render at its true PDF size (1pt = 1 CSS px), Fit Width fills
   * the pane with it. Same definitions as the reading view, expressed
   * through the board camera. Optional in the TYPE because minimal handles
   * (presentation) still omit them.
   */
  actualSize?(): void;
  fitWidth?(): void;
  clientToWorld(clientX: number, clientY: number): { x: number; y: number; k: number } | null;
  /** Pan/zoom the camera to center the given page (by its data-page-id
   * cell). Built for Find navigation (2m); outline click-to-jump (2n)
   * reuses it. No-op when the page isn't in the DOM. */
  centerOn(pageId: string): void;
  /** N3 marquee zoom (reading view only): zoom until the display-normalized
   * page rect fills the pane, scroll it centered, and return the APPLIED
   * zoom (null when the request names nothing) — the split layer syncs
   * sibling panes to that value, since quad zoom must stay equal. */
  zoomToPageRect?(pageId: string, rect: { x: number; y: number; w: number; h: number }): number | null;
  /** Clamped absolute zoom set — the sibling half of zoomToPageRect. */
  setZoomAbsolute?(zoom: number): void;
}

interface CanvasHandleArgs {
  viewportRef: RefObject<HTMLDivElement | null>;
  worldRef: RefObject<HTMLDivElement | null>;
  zoomRef: RefObject<ZoomBehavior<HTMLDivElement, unknown> | null>;
  userMovedRef: RefObject<boolean>;
  fitTransform: () => ReturnType<typeof zoomIdentity.translate>;
}

const center = (vp: HTMLDivElement): [number, number] => [vp.clientWidth / 2, vp.clientHeight / 2];

/** A page cell's rect in WORLD coordinates: accumulate offsets up to the
 * world element. offsetLeft/offsetTop are unaffected by the world's own CSS
 * transform, so this is camera-independent. */
function worldRectOf(
  world: HTMLDivElement,
  el: HTMLElement,
): { x: number; y: number; w: number; h: number } | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== world) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== world) return null;
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

// Camera scale bounds when jumping to a page: comfortable reading, never a
// violent zoom (the page should fill roughly half the viewport's minor side).
const CENTER_ON_FILL = 0.55;
const CENTER_ON_MAX_SCALE = 1.6;

// Fit Width keeps the page off the pane edges (the reading view's gutter).
const FIT_WIDTH_GUTTER = 48;

/** The cell the zoom presets anchor to: the first SELECTED page, else the
 * cell nearest the viewport centre (the user's focus), else null. Collapsed
 * cells (width 0 during a drag) never anchor. */
function anchorCell(vp: HTMLDivElement, world: HTMLDivElement): HTMLElement | null {
  const selected = world.querySelector<HTMLElement>('[data-page-id].selected');
  if (selected && selected.offsetWidth > 0) return selected;
  const vpRect = vp.getBoundingClientRect();
  const cx = vpRect.left + vpRect.width / 2;
  const cy = vpRect.top + vpRect.height / 2;
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const el of world.querySelectorAll<HTMLElement>('[data-page-id]')) {
    if (el.offsetWidth === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const d = Math.hypot((r.left + r.right) / 2 - cx, (r.top + r.bottom) / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = el;
    }
  }
  return best;
}

export function createCanvasHandle({
  viewportRef,
  worldRef,
  zoomRef,
  userMovedRef,
  fitTransform,
}: CanvasHandleArgs): CanvasHandle {
  return {
    zoomIn() {
      const vp = viewportRef.current;
      if (!vp || !zoomRef.current) return;
      zoomRef.current.scaleBy(select(vp), BUTTON_ZOOM_FACTOR, center(vp));
    },
    zoomOut() {
      const vp = viewportRef.current;
      if (!vp || !zoomRef.current) return;
      zoomRef.current.scaleBy(select(vp), 1 / BUTTON_ZOOM_FACTOR, center(vp));
    },
    reset() {
      const vp = viewportRef.current;
      if (!vp || !zoomRef.current) return;
      // Explicit Fit hands control back to auto-fit: content changes and
      // window resizes keep re-fitting until the user pans/zooms again.
      userMovedRef.current = false;
      zoomRef.current.transform(select(vp), fitTransform());
    },
    clientToWorld(clientX, clientY) {
      const vp = viewportRef.current;
      if (!vp) return null;
      const rect = vp.getBoundingClientRect();
      const t = zoomTransform(vp);
      return { x: t.invertX(clientX - rect.left), y: t.invertY(clientY - rect.top), k: t.k };
    },
    centerOn(pageId) {
      const vp = viewportRef.current;
      const world = worldRef.current;
      if (!vp || !world || !zoomRef.current) return;
      const el = world.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(pageId)}"]`);
      if (!el) return;
      const rect = worldRectOf(world, el);
      if (!rect || rect.w === 0 || rect.h === 0) return;
      const k = Math.min(
        CENTER_ON_MAX_SCALE,
        (Math.min(vp.clientWidth, vp.clientHeight) * CENTER_ON_FILL) / Math.max(rect.w, rect.h),
      );
      const tx = vp.clientWidth / 2 - (rect.x + rect.w / 2) * k;
      const ty = vp.clientHeight / 2 - (rect.y + rect.h / 2) * k;
      // A deliberate camera move — behaves like a user pan (auto-fit stays
      // off until an explicit Fit).
      userMovedRef.current = true;
      zoomRef.current.transform(select(vp), zoomIdentity.translate(tx, ty).scale(k));
    },
    actualSize() {
      zoomAnchoredTo((rect, el) => {
        const naturalH = parseFloat(el.dataset.naturalH ?? '');
        if (!Number.isFinite(naturalH) || naturalH <= 0) return null;
        return naturalH / rect.h; // 1pt = 1 CSS px at this k
      });
    },
    fitWidth() {
      zoomAnchoredTo((rect) => {
        const vp = viewportRef.current;
        if (!vp) return null;
        const available = vp.clientWidth - FIT_WIDTH_GUTTER;
        return available > 0 ? available / rect.w : null;
      });
    },
  };

  /** Shared preset core: pick the anchor cell, solve k from its world rect,
   * clamp to the zoom behavior's own extent, and centre the cell at that k. */
  function zoomAnchoredTo(
    solve: (rect: { x: number; y: number; w: number; h: number }, el: HTMLElement) => number | null,
  ): void {
    const vp = viewportRef.current;
    const world = worldRef.current;
    const zoom = zoomRef.current;
    if (!vp || !world || !zoom) return;
    const el = anchorCell(vp, world);
    if (!el) return;
    const rect = worldRectOf(world, el);
    if (!rect || rect.w === 0 || rect.h === 0) return;
    const solved = solve(rect, el);
    if (solved === null || !Number.isFinite(solved) || solved <= 0) return;
    const [minK, maxK] = zoom.scaleExtent();
    const k = Math.max(minK, Math.min(maxK, solved));
    const tx = vp.clientWidth / 2 - (rect.x + rect.w / 2) * k;
    const ty = vp.clientHeight / 2 - (rect.y + rect.h / 2) * k;
    userMovedRef.current = true;
    zoom.transform(select(vp), zoomIdentity.translate(tx, ty).scale(k));
  }
}
