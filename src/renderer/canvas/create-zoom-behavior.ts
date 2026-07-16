import { zoom as d3zoom, type ZoomBehavior } from 'd3-zoom';
import { reversibleConstrain } from './constrain';
import { MIN_SCALE, MAX_SCALE } from './zoom-constants';

interface ZoomHandlerRefs {
  vp: HTMLDivElement;
  worldRef: { current: HTMLDivElement | null };
  overlayRef: { current: HTMLDivElement | null };
  userMovedRef: { current: boolean };
  idleTimer: { current: ReturnType<typeof setTimeout> | null };
  lastTick: { current: number };
  onScaleRef: { current: ((scale: number) => void) | undefined };
  onSettleRef: { current: (() => void) | undefined };
  /** Hand mode (M6.2): pages become pannable surface — the filter admits
   * presses on `.page` (pickup is separately suppressed), while buttons and
   * inputs stay interactive. */
  handModeRef?: { current: boolean };
}

/** May a press on `target` start a pan/zoom gesture? Pure — unit-tested.
 * Hand (M6.2): a press ON a page pans (pickup is separately suppressed);
 * controls stay controls. Otherwise pages/headers belong to their own
 * interactions and only the background pans. */
export function zoomGestureAllowed(target: Element | null, handMode: boolean): boolean {
  if (handMode) {
    return !target?.closest('button, input, textarea, .doc-actions');
  }
  return !target?.closest('.page, button, input, textarea, .doc-actions, .doc-header');
}

export function createZoomBehavior(refs: ZoomHandlerRefs): ZoomBehavior<HTMLDivElement, unknown> {
  const { vp, worldRef, overlayRef, userMovedRef, idleTimer, lastTick, onScaleRef, onSettleRef, handModeRef } =
    refs;
  return d3zoom<HTMLDivElement, unknown>()
    .scaleExtent([MIN_SCALE, MAX_SCALE])
    .constrain(reversibleConstrain)
    .filter((event) => {
      if (event.type === 'wheel') return false;
      if ((event as MouseEvent).button) return false;
      return zoomGestureAllowed(event.target as Element | null, handModeRef?.current ?? false);
    })
    .on('start', () => vp.classList.add('panning'))
    .on('end', () => vp.classList.remove('panning'))
    .on('zoom', (event) => {
      if (event.sourceEvent) userMovedRef.current = true;
      const t = event.transform;
      const world = worldRef.current;
      if (world) {
        world.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
        world.style.willChange = 'transform';
      }
      const overlayEl = overlayRef.current;
      if (overlayEl) {
        overlayEl.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
        overlayEl.style.setProperty('--k', String(t.k));
      }
      const now = performance.now();
      if (now - lastTick.current >= 90) {
        lastTick.current = now;
        onScaleRef.current?.(t.k);
      }
      if (idleTimer.current) clearTimeout(idleTimer.current);
      const k = t.k;
      idleTimer.current = setTimeout(() => {
        if (world) world.style.willChange = 'auto';
        onScaleRef.current?.(k);
        onSettleRef.current?.();
      }, 200);
    });
}
