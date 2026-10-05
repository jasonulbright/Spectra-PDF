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

export interface LayoutNode<T> {
  readonly children: ArrayLike<T>;
}

/**
 * The boxes that take part in the host's own flow layout, in document order.
 * A `display: contents` child generates no box (its offsets read as zero), so
 * its children are the host's layout items and are collected in its place;
 * the wrappers are returned so their child lists can be watched too. Without
 * the descent, a document region inside such a wrapper is invisible and the
 * status bar is taken for the region, which pushes top-anchored overlays
 * below the view.
 */
export function flowItems<T extends LayoutNode<T>>(
  nodes: ArrayLike<T>,
  layout: (node: T) => { display: string; position: string } | null,
): { items: T[]; wrappers: T[] } {
  const items: T[] = [];
  const wrappers: T[] = [];
  const visit = (list: ArrayLike<T>): void => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const box = layout(node);
      if (!box || box.display === 'none') continue;
      if (box.display === 'contents') {
        wrappers.push(node);
        visit(node.children);
        continue;
      }
      if (box.position === 'absolute' || box.position === 'fixed') continue;
      items.push(node);
    }
  };
  visit(nodes);
  return { items, wrappers };
}

/**
 * Publishes {@link canvasChromeInsets} on `host` as the custom properties
 * {@link CANVAS_INSET_START} and {@link CANVAS_INSET_END}. Re-measures when the
 * host or any in-flow item resizes (a tool strip that wraps) and when the
 * items change (a strip that mounts with an armed tool, a document region
 * that mounts inside a `display: contents` wrapper).
 */
export function useCanvasChromeInsets(host: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!host) return;
    const collect = (): { items: HTMLElement[]; wrappers: Element[] } => {
      const { items, wrappers } = flowItems<Element>(host.children, (el) => {
        if (!(el instanceof HTMLElement)) return null;
        const cs = getComputedStyle(el);
        return { display: cs.display, position: cs.position };
      });
      return {
        items: items.filter((el): el is HTMLElement => el instanceof HTMLElement),
        wrappers,
      };
    };
    const measure = (): void => {
      const { start, end } = canvasChromeInsets(
        host.clientHeight,
        collect().items.map((el) => ({ top: el.offsetTop, height: el.offsetHeight })),
      );
      host.style.setProperty(CANVAS_INSET_START, `${start}px`);
      host.style.setProperty(CANVAS_INSET_END, `${end}px`);
    };
    const resize = new ResizeObserver(measure);
    let mutation: MutationObserver | null = null;
    const attach = (): void => {
      resize.disconnect();
      mutation?.disconnect();
      mutation = new MutationObserver(attach);
      mutation.observe(host, { childList: true });
      resize.observe(host);
      const { items, wrappers } = collect();
      for (const el of wrappers) mutation.observe(el, { childList: true });
      for (const el of items) resize.observe(el);
      measure();
    };
    attach();
    return () => {
      mutation?.disconnect();
      resize.disconnect();
    };
  }, [host]);
}
