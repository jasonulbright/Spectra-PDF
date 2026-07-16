import { useLayoutEffect, useRef, type RefObject } from 'react';
import { pointer, select } from 'd3-selection';
import { zoomIdentity, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { createZoomBehavior } from './create-zoom-behavior';
import { computeFitTransform } from './fit-transform';
import { WHEEL_ZOOM_SPEED } from './zoom-constants';

export {
  MIN_SCALE,
  MAX_SCALE,
  PAN_MARGIN,
  FIT_MARGIN,
  WHEEL_ZOOM_SPEED,
  BUTTON_ZOOM_FACTOR,
} from './zoom-constants';

interface Dims {
  contentWidth: number;
  contentHeight: number;
  slotHeight: number;
}

interface ZoomBehaviorArgs {
  viewportRef: RefObject<HTMLDivElement | null>;
  worldRef: RefObject<HTMLDivElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
  userMovedRef: RefObject<boolean>;
  dims: RefObject<Dims>;
  handModeRef?: RefObject<boolean>;
  onScaleChange?: (scale: number) => void;
  onSettle?: () => void;
}

export function useZoomBehavior({
  viewportRef,
  worldRef,
  overlayRef,
  userMovedRef,
  dims,
  handModeRef,
  onScaleChange,
  onSettle,
}: ZoomBehaviorArgs): {
  zoomRef: RefObject<ZoomBehavior<HTMLDivElement, unknown> | null>;
  fitTransform: () => ReturnType<typeof zoomIdentity.translate>;
} {
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTick = useRef(0);
  const onScaleRef = useRef(onScaleChange);
  onScaleRef.current = onScaleChange;
  const onSettleRef = useRef(onSettle);
  onSettleRef.current = onSettle;

  const fitTransform = (): ReturnType<typeof zoomIdentity.translate> =>
    computeFitTransform(viewportRef.current!, dims.current!);

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    const zoomBehavior = createZoomBehavior({
      vp,
      worldRef,
      overlayRef,
      userMovedRef,
      idleTimer,
      lastTick,
      onScaleRef,
      onSettleRef,
      handModeRef,
    });

    zoomRef.current = zoomBehavior;
    const sel = select(vp);
    sel.call(zoomBehavior);
    sel.on('dblclick.zoom', null);

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const [px, py] = pointer(event, vp);
      if (event.ctrlKey || event.metaKey) {
        const dy = Math.max(-50, Math.min(50, event.deltaY));
        zoomBehavior.scaleBy(sel, Math.pow(2, -dy * WHEEL_ZOOM_SPEED), [px, py]);
      } else {
        const k = zoomTransform(vp).k;
        zoomBehavior.translateBy(sel, -event.deltaX / k, -event.deltaY / k);
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });

    const resize = new ResizeObserver(() => {
      if (vp.clientWidth === 0 || vp.clientHeight === 0) return;
      zoomBehavior.extent([
        [0, 0],
        [vp.clientWidth, vp.clientHeight],
      ]);
      // The transform is in screen pixels — without this, maximizing the
      // window leaves the content at its old size anchored top-left. Re-fit
      // while the user hasn't taken over; once they have, re-apply the
      // current transform so the constrain runs against the new viewport.
      const d = dims.current;
      if (!userMovedRef.current && d && d.contentWidth > 1 && d.contentHeight > 1) {
        select(vp).call(zoomBehavior.transform, computeFitTransform(vp, d));
      } else {
        select(vp).call(zoomBehavior.transform, zoomTransform(vp));
      }
    });
    resize.observe(vp);

    return () => {
      vp.removeEventListener('wheel', onWheel);
      resize.disconnect();
      sel.on('.zoom', null);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- timer handle, not a DOM ref; clear whatever is pending at teardown
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { zoomRef, fitTransform };
}
