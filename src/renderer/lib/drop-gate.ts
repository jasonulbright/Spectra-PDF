/**
 * Whether a drop target is big enough on screen to be aimed at.
 *
 * A page strip drawn at a low zoom packs whole documents into a few dozen
 * pixels: the gaps between insertion points fall below the pointer's own
 * precision, so a drop lands somewhere the pointer never meant and the user
 * has no way to tell which slot they hit. The gate refuses those drops rather
 * than guessing, and the refusal carries the measurement so the surface can
 * say why instead of failing silently.
 *
 * The measured quantity is the CONSTRAINING dimension of the target as
 * rendered — the strip's on-screen height on the board, the column width in a
 * thumbnail grid. On the board the measurement is the whole card's height,
 * which for a card wrapped onto several rows overstates the aimable quantity
 * (a row, not the card) by the number of rows: the gate is lenient there, and
 * deliberately so, since it refuses rather than guesses.
 *
 * A refusal covers every drop slot that shrinks with the board, not only the
 * ones inside a card: the gap between two cards is gated by this same
 * predicate, because at a refusing zoom it is a few pixels wide and hitting it
 * splits pages into a document nobody asked for — the exact outcome the gate
 * exists to prevent. Space that does NOT shrink stays aimable: the open board
 * before the first card and after the last is unbounded at any zoom, so a
 * zoomed-out drag always keeps one usable target.
 *
 * Pure and unit-tested; every surface that gates a drop calls this one
 * predicate, so "too small to aim at" has a single definition.
 */

/** Below this rendered size, in CSS pixels, a drop target is refused. */
export const DROP_TARGET_MIN_SCREEN_PX = 90;

export type DropGateVerdict =
  | { ok: true; screenPx: number }
  | { ok: false; screenPx: number; minPx: number };

export function dropTargetGate(
  screenPx: number,
  minPx: number = DROP_TARGET_MIN_SCREEN_PX,
): DropGateVerdict {
  // A non-finite or negative measurement means the target is not laid out
  // (unmeasured, detached, zero-scale camera) — never treat that as passing.
  if (!Number.isFinite(screenPx) || screenPx < minPx) {
    return { ok: false, screenPx: Number.isFinite(screenPx) ? screenPx : 0, minPx };
  }
  return { ok: true, screenPx };
}

/** How far the camera must zoom for a refused target to pass the gate. A
 * refusal that names the factor lets a surface tell the user what to do. */
export function zoomFactorToPass(
  screenPx: number,
  minPx: number = DROP_TARGET_MIN_SCREEN_PX,
): number {
  if (!Number.isFinite(screenPx) || screenPx <= 0) return Infinity;
  return Math.max(1, minPx / screenPx);
}
