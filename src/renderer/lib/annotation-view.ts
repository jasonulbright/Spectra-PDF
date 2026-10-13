// An annotation under Rotate View. Stored geometry is display-normalized in
// the frame of the page's own rotation; the view turns that frame by a
// quarter-turn delta that is never written to the file.
//
// ISO 32000-2 12.5.3 (Table 167 and the text after it) defines the NoRotate
// flag against the page's /Rotate: the annotation keeps its orientation on
// the screen, its upper-left corner stays at its place on the page, and its
// size in points stays. The standard has no rule for a rotation the viewer
// applies. The view turn is treated here as a page rotation, so a NoRotate
// annotation is upright under both and the two turns compose. Every other
// annotation turns with the page as one rigid box.
import type { PageAnnotation } from '../state/types';
import { resizedRect, translated } from './annotation-manipulation';
import type { GroupFrame, ResizeHandle } from './annotation-manipulation';
import { rotateNormalizedPoint, rotateNormalizedRect } from './redaction';

export interface NormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A page's display size in points. */
export interface DisplayFrame {
  width: number;
  height: number;
}

const quarter = (angle: number): 0 | 90 | 180 | 270 => ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;

/** The page's pending rotation: the rotation a cell shows less the view turn
 *  composed into it. */
export function pendingPageRotation(shownRotation: number, viewRotation: number): 0 | 90 | 180 | 270 {
  return quarter(shownRotation - viewRotation);
}

/** The display size of a page of `width` by `height` points (as the file's
 *  /Rotate shows it) under a further `rotation`. */
export function turnedFrame(width: number, height: number, rotation: number): DisplayFrame {
  return quarter(rotation) % 180 === 90 ? { width: height, height: width } : { width, height };
}

const usable = (frame: DisplayFrame): boolean => frame.width > 0 && frame.height > 0;

/** The box as the view shows it. `storedFrame` is the page's display size
 *  before the view turn. */
export function annotationViewBox(
  a: NormalizedBox & { noRotate?: boolean },
  viewRotation: number,
  storedFrame: DisplayFrame,
): NormalizedBox {
  const turn = quarter(viewRotation);
  if (turn === 0) return { x: a.x, y: a.y, w: a.w, h: a.h };
  if (!a.noRotate || !usable(storedFrame)) return rotateNormalizedRect(a, turn);
  const corner = rotateNormalizedPoint(a.x, a.y, turn);
  if (turn === 180) return { ...corner, w: a.w, h: a.h };
  const aspect = storedFrame.width / storedFrame.height;
  return { ...corner, w: a.w * aspect, h: a.h / aspect };
}

/** Inverse of `annotationViewBox`: a box in the view frame, as stored. */
export function annotationStoredBox(
  box: NormalizedBox,
  noRotate: boolean,
  viewRotation: number,
  storedFrame: DisplayFrame,
): NormalizedBox {
  const turn = quarter(viewRotation);
  if (turn === 0) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const back = quarter(360 - turn);
  if (!noRotate || !usable(storedFrame)) return rotateNormalizedRect(box, back);
  const corner = rotateNormalizedPoint(box.x, box.y, back);
  if (turn === 180) return { ...corner, w: box.w, h: box.h };
  const aspect = storedFrame.width / storedFrame.height;
  return { ...corner, w: box.w / aspect, h: box.h * aspect };
}

/** Whether the body of an annotation is drawn in the stored frame and turned
 *  with the view as a whole: the text bodies, except a NoRotate stamp, whose
 *  body stands upright in the view box. */
export function bodyTurnsWithView(a: Pick<PageAnnotation, 'kind' | 'noRotate'>, viewRotation: number): boolean {
  if (quarter(viewRotation) === 0) return false;
  return a.kind === 'freetext' || (a.kind === 'stamp' && a.noRotate !== true);
}

/** Whether the view shows the annotation in a box of its own: the corner
 *  turned, the size in points kept. Such a box can reach past the page edge
 *  in the view while the stored box is inside the page. */
function ownViewBox(a: { noRotate?: boolean }, turn: number, storedFrame: DisplayFrame): boolean {
  return turn !== 0 && a.noRotate === true && usable(storedFrame);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The limits of one axis for a box that starts at `start` with `size`: the
 *  page, widened to a side that is outside it. */
const reach = (start: number, size: number): [number, number] => [Math.min(0, start), Math.max(1, start + size)];

/** A view-frame delta in the stored frame. */
function storedDelta(turn: number, vdx: number, vdy: number): [number, number] {
  return turn === 90 ? [vdy, -vdx] : turn === 180 ? [-vdx, -vdy] : turn === 270 ? [-vdy, vdx] : [vdx, vdy];
}

/** `translated` for a stored-frame delta. A box of its own in the view moves
 *  by the delta, except that no side of the view box moves further outside
 *  the page than it is, and the stored box ends on the page as `translated`
 *  leaves it. */
export function translatedInView(
  a: PageAnnotation,
  dx: number,
  dy: number,
  viewRotation: number,
  storedFrame: DisplayFrame,
): ReturnType<typeof translated> {
  const turn = quarter(viewRotation);
  if (turn === 0 || !a.noRotate || !usable(storedFrame)) return translated(a, dx, dy);
  const shown = annotationViewBox(a, turn, storedFrame);
  const [vdx, vdy] = turn === 90 ? [-dy, dx] : turn === 180 ? [-dx, -dy] : [dy, -dx];
  const [x0, x1] = reach(shown.x, shown.w);
  const [y0, y1] = reach(shown.y, shown.h);
  const [sdx, sdy] = storedDelta(
    turn,
    Math.max(x0 - shown.x, Math.min(vdx, x1 - shown.w - shown.x)),
    Math.max(y0 - shown.y, Math.min(vdy, y1 - shown.h - shown.y)),
  );
  const x = clamp01(Math.min(a.x + sdx, 1 - a.w));
  const y = clamp01(Math.min(a.y + sdy, 1 - a.h));
  return { x, y, dx: x - a.x, dy: y - a.y };
}

/** One axis of a box cut to the page. */
function onPage(start: number, size: number): [number, number] {
  if (start >= 0 && start + size <= 1) return [start, size];
  const low = clamp01(start);
  return [low, clamp01(start + size) - low];
}

/** The stored box after a handle of a NoRotate box is dragged to a point of
 *  the view frame; the caller passes the point unclamped. Only for a box
 *  with a view turn and a known page size.
 *
 *  `resizedRect` runs on the view box with the reach of each axis mapped to
 *  0..1, so a side that is outside the page stays where it is unless its own
 *  handle moves it, and then it moves inward only. The size floor of an axis
 *  scales with that reach. The drag then stops where a side of the stored
 *  box would leave the page. */
export function resizedInView(
  a: NormalizedBox & { noRotate?: boolean },
  handle: ResizeHandle,
  px: number,
  py: number,
  keepAspect: boolean,
  viewRotation: number,
  storedFrame: DisplayFrame,
): NormalizedBox {
  const turn = quarter(viewRotation);
  const shown = annotationViewBox(a, turn, storedFrame);
  const [x0, x1] = reach(shown.x, shown.w);
  const [y0, y1] = reach(shown.y, shown.h);
  const sx = x1 - x0;
  const sy = y1 - y0;
  const unit = resizedRect(
    { x: (shown.x - x0) / sx, y: (shown.y - y0) / sy, w: shown.w / sx, h: shown.h / sy },
    handle,
    (px - x0) / sx,
    (py - y0) / sy,
    keepAspect,
  );
  const from = { x: a.x, y: a.y, w: a.w, h: a.h };
  const to = annotationStoredBox(
    { x: x0 + unit.x * sx, y: y0 + unit.y * sy, w: unit.w * sx, h: unit.h * sy },
    a.noRotate === true,
    turn,
    storedFrame,
  );
  // The stored box is affine in the drag, so the part of the drag that keeps
  // every stored side from moving further out is one fraction of it.
  let part = 1;
  const limit = (start: number, end: number, low: boolean): void => {
    const bound = low ? Math.min(0, start) : Math.max(1, start);
    if (low ? end < bound : end > bound) part = Math.min(part, (bound - start) / (end - start));
  };
  limit(from.x, to.x, true);
  limit(from.y, to.y, true);
  limit(from.x + from.w, to.x + to.w, false);
  limit(from.y + from.h, to.y + to.h, false);
  const at = (start: number, end: number): number => (part === 1 ? end : start + (end - start) * part);
  const [x, w] = onPage(at(from.x, to.x), at(from.w, to.w));
  const [y, h] = onPage(at(from.y, to.y), at(from.h, to.h));
  return { x, y, w, h };
}

/** Whether a pointer gesture on the annotation's box takes `resizedInView`. */
export function resizesInView(a: { noRotate?: boolean }, viewRotation: number, storedFrame: DisplayFrame): boolean {
  return ownViewBox(a, quarter(viewRotation), storedFrame);
}

const SAME = 1e-9;

/** The frame align, distribute and size match work in under a view turn: the
 *  boxes the view shows. Undefined with no view turn, where the stored boxes
 *  are those boxes. */
export function viewGroupFrame(viewRotation: number, storedFrame: DisplayFrame): GroupFrame | undefined {
  const turn = quarter(viewRotation);
  if (turn === 0) return undefined;
  return {
    box: (a) => annotationViewBox(a, turn, storedFrame),
    moved: (a, vdx, vdy) => {
      const [dx, dy] = storedDelta(turn, vdx, vdy);
      const t = translatedInView(a, dx, dy, turn, storedFrame);
      return {
        x: t.x,
        y: t.y,
        ...(t.points ? { points: t.points } : {}),
        ...(t.strokes ? { strokes: t.strokes } : {}),
        ...(t.calloutBox ? { calloutBox: t.calloutBox } : {}),
      };
    },
    resized: (a, target) => {
      const shown = annotationViewBox(a, turn, storedFrame);
      if (
        Math.abs(target.x - shown.x) < SAME && Math.abs(target.y - shown.y) < SAME &&
        Math.abs(target.w - shown.w) < SAME && Math.abs(target.h - shown.h) < SAME
      ) {
        return { x: a.x, y: a.y, w: a.w, h: a.h };
      }
      const [x0, x1] = reach(shown.x, shown.w);
      const [y0, y1] = reach(shown.y, shown.h);
      const x = Math.min(target.x, Math.max(x0, x1 - target.w));
      const y = Math.min(target.y, Math.max(y0, y1 - target.h));
      const stored = annotationStoredBox(
        { x, y, w: Math.min(target.w, x1 - x), h: Math.min(target.h, y1 - y) },
        a.noRotate === true,
        turn,
        storedFrame,
      );
      if (!ownViewBox(a, turn, storedFrame)) return stored;
      const sx = Math.min(stored.x, Math.max(0, 1 - stored.w));
      const sy = Math.min(stored.y, Math.max(0, 1 - stored.h));
      return { x: sx, y: sy, w: Math.min(stored.w, 1 - sx), h: Math.min(stored.h, 1 - sy) };
    },
  };
}
