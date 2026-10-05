import { useLayoutEffect } from 'react';

export const CANVAS_INSET_START = '--canvas-inset-block-start';
export const CANVAS_INSET_END = '--canvas-inset-block-end';

/** One in-flow child of the canvas view, as offsets from the view's top. */
export interface FlowBox {
  top: number;
  height: number;
}

/**
 * The block insets that the in-flow chrome (tool strip, banners, status bar)
 * takes from the canvas view. The document region is the tallest in-flow
 * child; everything above it is the start inset and everything below it the
 * end inset. Floating overlays are positioned against the whole view, so
 * without these they cover the tool strip and the status bar.
 */
export function canvasChromeInsets(
  hostHeight: number,
  boxes: readonly FlowBox[],
): { start: number; end: number } {
  let region: FlowBox | null = null;
  for (const b of boxes) {
    if (!region || b.height > region.height) region = b;
  }
  if (!region) return { start: 0, end: 0 };
  const start = Math.max(0, region.top);
  const end = Math.max(0, hostHeight - (region.top + region.height));
  return { start, end };
}

/**
 * Publishes {@link canvasChromeInsets} on `host` as the custom properties
 * {@link CANVAS_INSET_START} and {@link CANVAS_INSET_END}. Re-measures when the
 * host or any in-flow child resizes (a tool strip that wraps) and when the
 * children change (a strip that mounts with an armed tool).
 */
export function useCanvasChromeInsets(host: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!host) return;
    const flowChildren = (): HTMLElement[] =>
      Array.from(host.children).filter((el): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const pos = getComputedStyle(el).position;
        return pos !== 'absolute' && pos !== 'fixed';
      });
    const measure = (): void => {
      const { start, end } = canvasChromeInsets(
        host.clientHeight,
        flowChildren().map((el) => ({ top: el.offsetTop, height: el.offsetHeight })),
      );
      host.style.setProperty(CANVAS_INSET_START, `${start}px`);
      host.style.setProperty(CANVAS_INSET_END, `${end}px`);
    };
    const resize = new ResizeObserver(measure);
    const attach = (): void => {
      resize.disconnect();
      resize.observe(host);
      for (const el of flowChildren()) resize.observe(el);
      measure();
    };
    const mutation = new MutationObserver(attach);
    mutation.observe(host, { childList: true });
    attach();
    return () => {
      mutation.disconnect();
      resize.disconnect();
    };
  }, [host]);
}
