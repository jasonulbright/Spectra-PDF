import { select } from 'd3-selection';
import { zoomTransform, type zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { BUTTON_ZOOM_FACTOR } from './zoom-constants';
import type { RefObject } from 'react';

export interface CanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  clientToWorld(clientX: number, clientY: number): { x: number; y: number; k: number } | null;
}

interface CanvasHandleArgs {
  viewportRef: RefObject<HTMLDivElement | null>;
  zoomRef: RefObject<ZoomBehavior<HTMLDivElement, unknown> | null>;
  userMovedRef: RefObject<boolean>;
  fitTransform: () => ReturnType<typeof zoomIdentity.translate>;
}

const center = (vp: HTMLDivElement): [number, number] => [vp.clientWidth / 2, vp.clientHeight / 2];

export function createCanvasHandle({
  viewportRef,
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
  };
}
