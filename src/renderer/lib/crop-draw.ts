/**
 * On-canvas crop draw.
 *
 * Page cropping accepts numeric per-edge insets in the Page Boxes panel and a
 * rectangle drawn directly on the page. This module converts
 * between the two, kept out of the component because there is no DOM test
 * environment — the arithmetic is where the mistakes live, so the
 * arithmetic is what gets pinned.
 *
 * The band arrives in DISPLAY-NORMALISED coordinates (0..1 of the drawn
 * frame, y from the TOP — the same frame every other banded gesture uses,
 * so a crop drag and a redaction drag mean the same thing by the same
 * rule). `set_page_boxes` wants per-edge INSETS in points against the page
 * as the user sees it. Two conversions, both here:
 *
 *   - normalised → points, against the DISPLAYED width/height;
 *   - top/left/bottom/right insets, with y flipped for the ones measured
 *     from the bottom.
 *
 * Rotation is the subtle half. A page with /Rotate 90 is displayed turned,
 * so the band's "top" is the page's LEFT — and `set_page_boxes` insets the
 * page box, which lives in unrotated page space. The inset quadruple is
 * therefore rotated by the same amount the display was, or a crop on a
 * landscape scan trims the wrong two edges.
 */

import { resizedRect, type ResizeHandle } from './annotation-manipulation';

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Drag one handle of an existing crop band to a new pointer position, in the
 * display frame the band is currently shown in.
 *
 * The box derivation is the annotation resize's (`resizedRect`) rather than a
 * second one: same clamp to the page box, same per-axis floor, so the crop
 * band and an annotation answer a corner drag identically. The floor is above
 * `insetsFromBand`'s no-area threshold, so a resize can never collapse a band
 * into a rect the panel refuses.
 */
export function resizeCropBand(
  band: NormRect,
  handle: ResizeHandle,
  px: number,
  py: number,
  keepAspect = false,
): NormRect {
  return resizedRect(band, handle, px, py, keepAspect);
}

/** Whether a drag actually moved the band, at the precision the panel's
 * fields carry — a handle pressed and released without travel republishes
 * nothing, so the fields the user has since typed into survive. */
export function cropBandChanged(before: NormRect, after: NormRect): boolean {
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  return !(
    same(before.x, after.x) &&
    same(before.y, after.y) &&
    same(before.w, after.w) &&
    same(before.h, after.h)
  );
}

/** Points-per-edge insets for a band drawn on a page displayed at
 * `displayW` x `displayH` points, already turned by `rotation` degrees. */
export function insetsFromBand(
  band: NormRect,
  displayW: number,
  displayH: number,
  rotation = 0,
): CropInsets | null {
  if (!(displayW > 0) || !(displayH > 0)) return null;
  const x = Math.min(Math.max(band.x, 0), 1);
  const y = Math.min(Math.max(band.y, 0), 1);
  const w = Math.min(Math.max(band.w, 0), 1 - x);
  const h = Math.min(Math.max(band.h, 0), 1 - y);
  // A band with no area is a click, not a crop — never a "crop everything".
  if (w <= 0.001 || h <= 0.001) return null;

  // In DISPLAY space first: what the user sees themselves trimming away.
  const displayed: CropInsets = {
    left: x * displayW,
    right: (1 - (x + w)) * displayW,
    top: y * displayH,
    bottom: (1 - (y + h)) * displayH,
  };

  // Then back into unrotated page space. /Rotate turns the page CLOCKWISE
  // for display, so an edge shown at the top came from the edge one
  // quarter-turn anticlockwise of it.
  const turns = (((Math.round(rotation / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  switch (turns) {
    case 1:
      return {
        top: displayed.right,
        right: displayed.bottom,
        bottom: displayed.left,
        left: displayed.top,
      };
    case 2:
      return {
        top: displayed.bottom,
        right: displayed.left,
        bottom: displayed.top,
        left: displayed.right,
      };
    case 3:
      return {
        top: displayed.left,
        right: displayed.top,
        bottom: displayed.right,
        left: displayed.bottom,
      };
    default:
      return displayed;
  }
}

/**
 * The page-space rect a band covers, given the page's own view box
 * `[x0, y0, x1, y1]` and the turn it was displayed at. The box's origin is
 * added back — a page whose crop box does not start at (0, 0) would otherwise
 * put every rect one offset away. Returns null for a band with no area: a
 * click is not a box.
 *
 * The rotation half is `insetsFromBand`'s, read from the other side: a rect
 * against the page box IS the insets the band left. Everything that turns a
 * band into user space goes through this one function — an article bead, a
 * link region — because two implementations of the quarter-turn rule is how a
 * landscape scan gets its geometry on the wrong axis.
 */
export function pageRectFromBand(
  band: NormRect,
  view: readonly [number, number, number, number],
  rotation = 0,
): [number, number, number, number] | null {
  const [vx0, vy0, vx1, vy1] = view;
  const pageW = vx1 - vx0;
  const pageH = vy1 - vy0;
  if (!(pageW > 0) || !(pageH > 0)) return null;
  const turned = rotation === 90 || rotation === 270;
  const insets = insetsFromBand(band, turned ? pageH : pageW, turned ? pageW : pageH, rotation);
  if (!insets) return null;
  const x0 = vx0 + insets.left;
  const y0 = vy0 + insets.bottom;
  const x1 = vx1 - insets.right;
  const y1 = vy1 - insets.top;
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const r = (v: number): number => Number(v.toFixed(2));
  return [r(x0), r(y0), r(x1), r(y1)];
}

/** Round to the precision the panel's numeric fields use, so a drawn crop
 * and a typed one that mean the same thing ARE the same request. */
export function roundInsets(insets: CropInsets, places = 2): CropInsets {
  const f = (v: number): number => Number(v.toFixed(places));
  return { top: f(insets.top), bottom: f(insets.bottom), left: f(insets.left), right: f(insets.right) };
}

/**
 * The drawn crop, from the canvas to the Page Boxes panel.
 *
 * A module channel rather than four layers of prop, for the reason the
 * system-font listing uses one: this is a HANDOFF between two surfaces that
 * do not contain each other, and the value is a single transient request
 * with no place in app state. Nothing is committed by publishing — the
 * panel fills its fields and the user still presses Apply, so a mis-drag
 * costs a redraw rather than an undo.
 */
export interface DrawnCrop extends CropInsets {
  /** 1-based page the band was drawn on, so the panel can scope to it. */
  page: number;
  /** The document the band belongs to — a stale publish must not fill the
   * fields of a different file the user has since switched to. */
  path: string;
}

let drawn: DrawnCrop | null = null;
const cropListeners = new Set<(crop: DrawnCrop) => void>();

export function publishDrawnCrop(crop: DrawnCrop): void {
  drawn = crop;
  for (const fn of cropListeners) fn(crop);
}

/**
 * Read the pending crop AND clear it — consume-once, deliberately.
 *
 * The panel reads this on mount (a crop drawn while the dock was collapsed
 * must not be lost) and again from the subscription. Leaving the value in
 * place would mean a panel remount silently refilling the fields with a crop
 * the user already applied, overwriting whatever they had typed since.
 */
export function consumeDrawnCrop(): DrawnCrop | null {
  const c = drawn;
  drawn = null;
  return c;
}

export function subscribeDrawnCrop(fn: (crop: DrawnCrop) => void): () => void {
  cropListeners.add(fn);
  return () => cropListeners.delete(fn);
}

/** Test seam. */
export function __resetDrawnCrop(): void {
  drawn = null;
  cropListeners.clear();
}
