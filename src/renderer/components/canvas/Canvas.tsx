import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { select } from 'd3-selection';
import { useZoomBehavior, PAN_MARGIN } from '../../canvas/use-zoom-behavior';
import { createCanvasHandle } from '../../canvas/canvas-handle';
import type { CanvasHandle } from '../../canvas/canvas-handle';

interface CanvasProps {
  contentWidth: number;
  contentHeight: number;
  slotHeight: number;
  dragging?: boolean;
  onScaleChange?: (scale: number) => void;
  onSettle?: () => void;
  onBackgroundClick?: () => void;
  children: React.ReactNode;
  overlay?: React.ReactNode;
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  {
    contentWidth,
    contentHeight,
    slotHeight,
    dragging,
    onScaleChange,
    onSettle,
    onBackgroundClick,
    children,
    overlay,
  },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const userMovedRef = useRef(false);
  const dims = useRef({ contentWidth, contentHeight, slotHeight });
  dims.current = { contentWidth, contentHeight, slotHeight };
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  const { zoomRef, fitTransform } = useZoomBehavior({
    viewportRef,
    worldRef,
    overlayRef,
    userMovedRef,
    dims,
    onScaleChange,
    onSettle,
  });

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    const zoomBehavior = zoomRef.current;
    if (!vp || !zoomBehavior) return;
    zoomBehavior.extent([
      [0, 0],
      [vp.clientWidth, vp.clientHeight],
    ]);
    const mx = contentWidth * PAN_MARGIN;
    const my = contentHeight * PAN_MARGIN;
    zoomBehavior.translateExtent([
      [-mx, -my],
      [contentWidth + mx, contentHeight + my],
    ]);
    if (!userMovedRef.current && !draggingRef.current && contentWidth > 1 && contentHeight > 1) {
      select(vp).call(zoomBehavior.transform, fitTransform());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentWidth, contentHeight]);

  useImperativeHandle(ref, () =>
    createCanvasHandle({ viewportRef, zoomRef, userMovedRef, fitTransform }),
  );

  return (
    <div
      className="canvas-viewport"
      ref={viewportRef}
      onClick={(event) => {
        const target = event.target as Element;
        if (
          !target.closest('.page') &&
          !target.closest('button') &&
          !target.closest('.doc-header')
        ) {
          onBackgroundClick?.();
        }
      }}
    >
      <div className="canvas-world" ref={worldRef}>
        {children}
      </div>
      <div className="canvas-overlay" ref={overlayRef}>
        {overlay}
      </div>
    </div>
  );
});
