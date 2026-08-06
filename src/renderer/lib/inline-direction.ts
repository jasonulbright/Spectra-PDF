// Direction-aware pointer arithmetic for the chrome's drag handles.
//
// CSS logical properties mirror a layout on their own, but a drag that
// computes a width from a raw `clientX` delta cannot: under `dir=rtl` the
// pane grows toward SMALLER x, so an unconverted handle narrows the pane when
// it is dragged to widen it. Every such site goes through these two helpers
// rather than inventing its own sign convention.
//
// The direction is read from `<html dir>` — the ONE place UI direction is set
// (i18n.ts `syncDocumentLanguage`) — never from a locale list, so a new RTL
// catalog needs no edit here.

/** Bounds along the inline axis. A `DOMRect` satisfies it. */
export interface InlineBounds {
  readonly left: number;
  readonly right: number;
}

export function isRtlUi(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
}

/** A pointer delta measured along the INLINE axis: positive toward the
 * inline-end side, whichever physical direction that is. */
export function inlineDelta(dx: number): number {
  return isRtlUi() ? -dx : dx;
}

/**
 * How far the pointer lies from one of `bounds`' inline edges, growing as the
 * pointer moves away from that edge — which is what a pane anchored to that
 * edge means by its own width.
 */
export function inlineExtent(
  bounds: InlineBounds,
  clientX: number,
  anchor: 'start' | 'end',
): number {
  const rtl = isRtlUi();
  return anchor === 'start'
    ? inlineDelta(clientX - (rtl ? bounds.right : bounds.left))
    : inlineDelta((rtl ? bounds.left : bounds.right) - clientX);
}
