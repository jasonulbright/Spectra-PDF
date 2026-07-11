import { select } from 'd3-selection';
import { zoomIdentity, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { BUTTON_ZOOM_FACTOR } from './zoom-constants';
import type { RefObject } from 'react';

export interface CanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  clientToWorld(clientX: number, clientY: number): { x: number; y: number; k: number } | null;
  /** Pan/zoom the camera to center the given page (by its data-page-id
   * cell). Built for Find navigation (2m); outline click-to-jump (2n)
   * reuses it. No-op when the page isn't in the DOM. */
  centerOn(pageId: string): void;
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
  };
}
