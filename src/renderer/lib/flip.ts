/**
 * Reorder animation math (first/last/invert/play).
 *
 * A reorder moves elements by rewriting the list; the browser paints the new
 * layout with no travel, so a page appears to teleport. The technique here
 * measures each element BEFORE the change and again AFTER it, applies the
 * inverse offset as a transform so the element paints where it used to be,
 * then transitions that transform to identity — the element travels to the
 * place layout already put it. Only `transform` animates, so nothing in the
 * layout depends on the animation being finished.
 *
 * Positions are measured in the container's own layout space (offset chain),
 * never in screen space: the board sits inside a zoom transform, and a
 * screen-space delta would need dividing by a camera scale that can change
 * mid-measurement.
 *
 * Pure and unit-tested; the DOM half is `hooks/useFlipReorder.ts`.
 */

export const FLIP_DURATION_MS = 180;
export const FLIP_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/** Sub-pixel layout jitter is not a move: below this an element is treated as
 * having stayed put, so a reflow that shifts a row by a rounding error does
 * not animate every element in it. */
export const FLIP_EPSILON_PX = 0.5;

/**
 * INVARIANT: a change that moves more than this many elements is a bulk
 * change (a sort, a delete of a range, an insert of another document, a
 * reordered 500-page file), not a drag the eye can follow. Animating those
 * starts hundreds of simultaneous transitions — a stampede that costs frames
 * and communicates nothing, because no single element can be tracked. Above
 * the cap the new layout is painted directly, which is the pre-animation
 * behaviour.
 */
export const FLIP_MAX_ANIMATED = 60;

export interface FlipPoint {
  x: number;
  y: number;
}

/** How far an element must be offset to paint at its former position. */
export interface FlipMove {
  id: string;
  dx: number;
  dy: number;
}

export interface FlipOptions {
  /** The viewer asked for reduced motion — animate nothing. */
  reducedMotion: boolean;
  /** Override the stampede cap (tests; the default is FLIP_MAX_ANIMATED). */
  max?: number;
}

/**
 * The inverse offsets to apply, for every id measured in both snapshots.
 *
 * Returns an EMPTY list — meaning "paint the new layout directly" — when
 * motion is reduced or when the change is a bulk one. An id present in only
 * one snapshot entered or left and has no travel to show.
 */
export function computeFlipMoves(
  first: ReadonlyMap<string, FlipPoint>,
  last: ReadonlyMap<string, FlipPoint>,
  opts: FlipOptions,
): FlipMove[] {
  if (opts.reducedMotion) return [];
  const moves: FlipMove[] = [];
  for (const [id, to] of last) {
    const from = first.get(id);
    if (!from) continue;
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    if (Math.abs(dx) < FLIP_EPSILON_PX && Math.abs(dy) < FLIP_EPSILON_PX) continue;
    moves.push({ id, dx, dy });
  }
  const max = opts.max ?? FLIP_MAX_ANIMATED;
  return moves.length > max ? [] : moves;
}

/** The inverted transform for a move — the "paint it where it was" step. */
export function flipTransform(move: FlipMove): string {
  return `translate(${move.dx}px, ${move.dy}px)`;
}

/** The transition that plays a move back to identity. */
export function flipTransition(): string {
  return `transform ${FLIP_DURATION_MS}ms ${FLIP_EASING}`;
}
