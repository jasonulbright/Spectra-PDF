import { useLayoutEffect, useRef } from 'react';
import {
  computeFlipMoves,
  flipTransform,
  flipTransition,
  type FlipPoint,
} from '../lib/flip';

/**
 * Plays the reorder animation over a container's tagged elements.
 *
 * `orderKey` names the arrangement: when it changes, the elements measured
 * last time are compared against where layout has just put them, and anything
 * that moved is offset back and released. The snapshot is refreshed on every
 * run, so the comparison is against the positions this hook measured last —
 * which are the previously PAINTED ones only if the key names EVERY
 * arrangement the user sees, transient ones included. A caller that reflows
 * the container without changing the key (a cell collapsed mid-drag) must fold
 * that state into the key, or the next run animates from a layout the user
 * stopped seeing.
 *
 * Positions come from the offset chain up to the root, not
 * `getBoundingClientRect`: the board's world element carries the camera's zoom
 * transform, and offsets are unaffected by an ancestor's transform, so the
 * deltas are in the same units the applied transform is interpreted in at any
 * zoom. The decision of WHAT to animate is `lib/flip.ts` (pure, tested); this
 * hook only measures and drives.
 */
export function useFlipReorder(
  getRoot: () => HTMLElement | null,
  orderKey: string,
  selector = '[data-page-id]',
): void {
  const previous = useRef<Map<string, FlipPoint> | null>(null);
  const getRootRef = useRef(getRoot);
  getRootRef.current = getRoot;

  useLayoutEffect(() => {
    const root = getRootRef.current();
    if (!root) {
      previous.current = null;
      return;
    }
    const elements = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const id = el.dataset.pageId ?? el.dataset.flipId;
      // A collapsed cell (zero width, taken out of flow mid-drag) has no
      // position worth remembering — measuring it would record the collapse
      // as the place to travel from.
      if (id && el.offsetWidth > 0) elements.set(id, el);
    }
    const last = new Map<string, FlipPoint>();
    for (const [id, el] of elements) last.set(id, offsetPointIn(root, el));

    const first = previous.current;
    previous.current = last;
    if (!first) return;

    const moves = computeFlipMoves(first, last, { reducedMotion: prefersReducedMotion() });
    if (moves.length === 0) return;

    const played: HTMLElement[] = [];
    for (const move of moves) {
      const el = elements.get(move.id);
      if (!el) continue;
      el.style.transition = 'none';
      el.style.transform = flipTransform(move);
      played.push(el);
    }
    if (played.length === 0) return;
    // Commit the inverted transform before anything schedules its removal.
    // This effect runs inside the event task, ahead of the frame's rendering
    // steps, and a `requestAnimationFrame` callback runs ahead of style recalc
    // too: without a forced flush the browser can coalesce the invert and the
    // release into one recalc, leaving the transition's before-change style at
    // `none`, equal to the after-change style, and no transition fires.
    void played[0].offsetWidth;
    const frame = requestAnimationFrame(() => {
      for (const el of played) {
        el.style.transition = flipTransition();
        el.style.transform = '';
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      // An interrupted run must not leave its offset behind: the transform is
      // an inversion away from where layout has already put the element, so a
      // run cancelled before its release would strand the element visibly
      // displaced with no animation left to carry it back. (Measurement is
      // unaffected either way — `offsetPointIn` reads layout-box properties,
      // which a transform does not move.)
      for (const el of played) {
        el.style.transition = '';
        el.style.transform = '';
      }
    };
  }, [orderKey, selector]);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** An element's position in `root`'s layout space. */
function offsetPointIn(root: HTMLElement, el: HTMLElement): FlipPoint {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y };
}
