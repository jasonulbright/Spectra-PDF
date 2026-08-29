// Pure geometry for annotation manipulation (rung 1 of the catch-up ladder):
// move/resize transforms, alignment, distribution, size matching, nudges, and
// the measure-value recompute. Everything here works on display-normalized
// 0..1 coordinates in the page.rotation frame (the frame PageAnnotation
// stores) — callers un-project view-frame gestures BEFORE calling in, so this
// module never sees view rotation. Pure functions only: the reducer and the
// canvas both consume these, and the tests exercise them without a DOM.

import type { PageAnnotation } from '../state/types';
import {
  polylineLengthPts,
  ringAreaPts2,
  formatDistanceWithFactor,
  formatAreaWithFactor,
} from './measure';

/** One geometry edit, the TRANSFORM_ANNOTATIONS entry shape. */
export interface AnnotationTransform {
  pageId: string;
  annotationId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  points?: number[];
  strokes?: number[][];
  note?: string;
  calloutBox?: [number, number, number, number];
}

/** Kinds whose geometry the user may change. Text markup remains anchored to
 * the text it covers because a moved quad set would misrepresent its target. */
export function isTransformable(a: PageAnnotation): boolean {
  return a.kind !== 'textmarkup';
}

/** Kinds that resize. Sticky notes are a fixed icon (their /Rect is
 * viewer-managed) and a count mark is a fixed MARKER (a resized
 * count symbol would read as a different-weight count); everything else
 * transformable scales. */
export function isResizable(a: PageAnnotation): boolean {
  return isTransformable(a) && a.kind !== 'note' && a.kind !== 'count';
}

/** Smallest displayed box a resize may produce, normalized per axis. Keeps a
 * handle grabbable after the gesture (8 CSS px at 1× on a ~600pt page ≈
 * 0.013) without blocking legitimately thin ink/measure boxes, which bypass
 * the floor via their zero-area allowance at commit. */
export const MIN_SIZE_NORM = 0.012;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Translate an annotation's box (and path points) by a normalized delta,
 * clamped so the box stays on the page. Returns the applied delta too —
 * multi-move uses the LEAD annotation's applied delta for the whole group so
 * the group never smears apart at a page edge. */
export function translated(
  a: PageAnnotation,
  dx: number,
  dy: number,
): {
  x: number;
  y: number;
  points?: number[];
  strokes?: number[][];
  calloutBox?: [number, number, number, number];
  dx: number;
  dy: number;
} {
  const x = clamp01(Math.min(a.x + dx, 1 - a.w));
  const y = clamp01(Math.min(a.y + dy, 1 - a.h));
  const adx = x - a.x;
  const ady = y - a.y;
  return {
    x,
    y,
    ...(a.points
      ? { points: a.points.map((v, i) => (i % 2 === 0 ? v + adx : v + ady)) }
      : {}),
    ...(a.strokes
      ? { strokes: a.strokes.map((s) => s.map((v, i) => (i % 2 === 0 ? v + adx : v + ady))) }
      : {}),
    ...(a.calloutBox
      ? { calloutBox: [a.calloutBox[0] + adx, a.calloutBox[1] + ady, a.calloutBox[2], a.calloutBox[3]] as [number, number, number, number] }
      : {}),
    dx: adx,
    dy: ady,
  };
}

/** Apply a group translation using one shared, pre-clamped delta (from the
 * lead's `translated`). Members keep formation; a member that would leave the
 * page is clamped individually (formation yields to the page boundary). */
export function translatedBy(
  a: PageAnnotation,
  dx: number,
  dy: number,
): { x: number; y: number; points?: number[]; strokes?: number[][]; calloutBox?: [number, number, number, number] } {
  const t = translated(a, dx, dy);
  return {
    x: t.x,
    y: t.y,
    ...(t.points ? { points: t.points } : {}),
    ...(t.strokes ? { strokes: t.strokes } : {}),
    ...(t.calloutBox ? { calloutBox: t.calloutBox } : {}),
  };
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Resize an annotation's box by dragging one handle to a new pointer
 * position (normalized page coords), optionally aspect-locked (Shift, and the
 * default for image stamps). Path points scale into the new box. The box is
 * clamped to the page and floored at MIN_SIZE_NORM per resizable axis. */
export function resized(
  a: PageAnnotation,
  handle: ResizeHandle,
  px: number,
  py: number,
  keepAspect: boolean,
): { x: number; y: number; w: number; h: number; points?: number[]; strokes?: number[][] } {
  const out = resizedRect(a, handle, px, py, keepAspect);
  return {
    ...out,
    ...(a.points ? { points: scaledPoints(a, out) } : {}),
    ...(a.strokes ? { strokes: scaledStrokes(a, out) } : {}),
    ...(a.calloutBox ? { calloutBox: scaledCalloutBox(a, out) } : {}),
  };
}

/** The box half of `resized`, on a bare rect: every banded overlay that
 * resizes (an annotation, the crop band) shares this one derivation, so a
 * corner drag cannot mean two different things on the same page. Normalized
 * 0..1, clamped to the page, floored at MIN_SIZE_NORM per axis. */
export function resizedRect(
  box: { x: number; y: number; w: number; h: number },
  handle: ResizeHandle,
  px: number,
  py: number,
  keepAspect: boolean,
): { x: number; y: number; w: number; h: number } {
  const a = box;
  // Anchor = the box corner/edge opposite the dragged handle; it never moves.
  const left = a.x;
  const top = a.y;
  const right = a.x + a.w;
  const bottom = a.y + a.h;
  const movesLeft = handle === 'nw' || handle === 'w' || handle === 'sw';
  const movesRight = handle === 'ne' || handle === 'e' || handle === 'se';
  const movesTop = handle === 'nw' || handle === 'n' || handle === 'ne';
  const movesBottom = handle === 'sw' || handle === 's' || handle === 'se';

  let x0 = movesLeft ? clamp01(px) : left;
  let x1 = movesRight ? clamp01(px) : right;
  let y0 = movesTop ? clamp01(py) : top;
  let y1 = movesBottom ? clamp01(py) : bottom;

  // A crossed drag pins at the floor rather than flipping — flipped ink
  // would silently mirror the stroke, which reads as corruption, not intent.
  if (movesLeft) x0 = Math.min(x0, x1 - MIN_SIZE_NORM);
  if (movesRight) x1 = Math.max(x1, x0 + MIN_SIZE_NORM);
  if (movesTop) y0 = Math.min(y0, y1 - MIN_SIZE_NORM);
  if (movesBottom) y1 = Math.max(y1, y0 + MIN_SIZE_NORM);
  x0 = clamp01(x0);
  x1 = clamp01(x1);
  y0 = clamp01(y0);
  y1 = clamp01(y1);

  if (keepAspect && a.w > 0 && a.h > 0) {
    // Scale both axes by the dominant factor, growing from the anchor.
    const fw = (x1 - x0) / a.w;
    const fh = (y1 - y0) / a.h;
    // Corner handles honour the larger stretch; edge handles their own axis.
    const isCorner = handle.length === 2;
    const f = isCorner ? Math.max(fw, fh) : movesLeft || movesRight ? fw : fh;
    let w = Math.max(a.w * f, MIN_SIZE_NORM);
    let h = Math.max(a.h * f, MIN_SIZE_NORM);
    // Re-derive the moving corner from the anchor; clamp inside the page,
    // shrinking uniformly if the page edge cuts the scaled box.
    const ax = movesLeft ? right : left; // anchor x
    const ay = movesTop ? bottom : top; // anchor y
    const availW = movesLeft ? ax : 1 - ax;
    const availH = movesTop ? ay : 1 - ay;
    const shrink = Math.min(1, availW / w, availH / h);
    w *= shrink;
    h *= shrink;
    x0 = movesLeft ? ax - w : ax;
    y0 = movesTop ? ay - h : ay;
    x1 = x0 + w;
    y1 = y0 + h;
  }

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Scale a callout's text sub-rect with the same box mapping scaledPoints
 * uses, so the box and the leader stay attached through a resize. */
export function scaledCalloutBox(
  a: PageAnnotation,
  box: { x: number; y: number; w: number; h: number },
): [number, number, number, number] {
  const cb = a.calloutBox ?? [a.x, a.y, a.w, a.h];
  const sx = a.w > 0 ? box.w / a.w : 1;
  const sy = a.h > 0 ? box.h / a.h : 1;
  return [
    box.x + (cb[0] - a.x) * sx,
    box.y + (cb[1] - a.y) * sy,
    cb[2] * sx,
    cb[3] * sy,
  ];
}

/** Kinds whose geometry is edited per-VERTEX (a dragged endpoint or corner)
 * rather than via the 8 box handles: the point-defined shapes, and the
 * callout's leader. rect/ellipse keep box handles; the callout gets BOTH
 * (box handles resize everything, vertex handles move the leader). */
export function hasVertexHandles(a: PageAnnotation): boolean {
  if (a.kind === 'callout') return true;
  if (a.kind !== 'shape') return false;
  return a.shapeType !== 'rect' && a.shapeType !== 'ellipse';
}

/** Bounding box of a flat point list, PADDED to a minimum size per axis — a
 * perfectly flat line's box would otherwise have no height to click, no SVG
 * pixel to draw in, and no handle to grab. Points stay exact; only the box
 * grows (symmetrically) around them. The emit reads geometry from the
 * points, so the pad never reaches the PDF's /L or /Vertices. */
export function paddedPointsBbox(
  points: number[],
  extraXs: number[] = [],
  extraYs: number[] = [],
): { x: number; y: number; w: number; h: number } {
  const xs = [...points.filter((_, i) => i % 2 === 0), ...extraXs];
  const ys = [...points.filter((_, i) => i % 2 === 1), ...extraYs];
  let x = Math.min(...xs);
  let y = Math.min(...ys);
  let w = Math.max(...xs) - x;
  let h = Math.max(...ys) - y;
  if (w < MIN_SIZE_NORM) {
    x = clamp01(x - (MIN_SIZE_NORM - w) / 2);
    w = MIN_SIZE_NORM;
  }
  if (h < MIN_SIZE_NORM) {
    y = clamp01(y - (MIN_SIZE_NORM - h) / 2);
    h = MIN_SIZE_NORM;
  }
  return { x, y, w, h };
}

/** Move one vertex of a points-carrying annotation to a new normalized page
 * position; the bbox re-derives from the moved points (∪ the callout's text
 * box, which a leader-vertex drag never moves), flat-padded like creation. */
export function vertexDragged(
  a: PageAnnotation,
  vertexIndex: number,
  nx: number,
  ny: number,
): { x: number; y: number; w: number; h: number; points: number[]; calloutBox?: [number, number, number, number] } {
  const points = [...(a.points ?? [])];
  points[vertexIndex * 2] = clamp01(nx);
  points[vertexIndex * 2 + 1] = clamp01(ny);
  const box = paddedPointsBbox(
    points,
    a.calloutBox ? [a.calloutBox[0], a.calloutBox[0] + a.calloutBox[2]] : [],
    a.calloutBox ? [a.calloutBox[1], a.calloutBox[1] + a.calloutBox[3]] : [],
  );
  return {
    ...box,
    points,
    ...(a.calloutBox ? { calloutBox: a.calloutBox } : {}),
  };
}

/** Scale stored path points from the annotation's current box into a new
 * box. Degenerate source axes (a flat line's zero height) translate instead
 * of dividing by zero — the axis has no interior geometry to scale. */
export function scaledPoints(
  a: PageAnnotation,
  box: { x: number; y: number; w: number; h: number },
): number[] {
  const pts = a.points ?? [];
  const sx = a.w > 0 ? box.w / a.w : 1;
  const sy = a.h > 0 ? box.h / a.h : 1;
  return pts.map((v, i) =>
    i % 2 === 0 ? box.x + (v - a.x) * sx : box.y + (v - a.y) * sy,
  );
}

/** Per-stroke scaledPoints — ink's strokes all scale with the one box. */
export function scaledStrokes(
  a: PageAnnotation,
  box: { x: number; y: number; w: number; h: number },
): number[][] {
  const sx = a.w > 0 ? box.w / a.w : 1;
  const sy = a.h > 0 ? box.h / a.h : 1;
  return (a.strokes ?? []).map((stroke) =>
    stroke.map((v, i) =>
      i % 2 === 0 ? box.x + (v - a.x) * sx : box.y + (v - a.y) * sy,
    ),
  );
}

/** Recompute a measure annotation's reported value after a geometry change,
 * from its CAPTURED units-per-point factor — never the live toolbar scale.
 * Mirrors measureValueFor's phrasing exactly (area reports its perimeter
 * beside it; the stored area ring is already closed). Non-measure kinds and
 * measures missing their factor return undefined (leave the note alone). */
export function recomputedMeasureNote(
  a: PageAnnotation,
  points: number[],
  pageWidth: number,
  pageHeight: number,
  rotation: number,
): string | undefined {
  if (a.kind !== 'measure' || !a.measureUnitsPerPt || !a.measureUnit) return undefined;
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? pageHeight : pageWidth;
  const dispH = swapped ? pageWidth : pageHeight;
  if (a.measureKind === 'area') {
    const area = formatAreaWithFactor(
      ringAreaPts2(points, dispW, dispH),
      a.measureUnitsPerPt,
      a.measureUnit,
    );
    const perim = formatDistanceWithFactor(
      polylineLengthPts(points, dispW, dispH),
      a.measureUnitsPerPt,
      a.measureUnit,
    );
    return `${area} · perimeter ${perim}`;
  }
  return formatDistanceWithFactor(
    polylineLengthPts(points, dispW, dispH),
    a.measureUnitsPerPt,
    a.measureUnit,
  );
}

export type AlignMode = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';
export type DistributeMode = 'horizontal' | 'vertical';
export type SizeMatchMode = 'width' | 'height' | 'both';

// Alignment deltas accumulate float error (distribute's running cursor); a
// sub-billionth "move" is a pinned member, not an edit.
const EPS = 1e-9;

interface Placed {
  annotation: PageAnnotation;
  pageId: string;
}

/** Align a same-page selection to the group's bounding box.
 * Returns only the members that actually move. */
export function alignEdits(members: Placed[], mode: AlignMode): AnnotationTransform[] {
  const movable = members.filter((m) => isTransformable(m.annotation));
  if (movable.length < 2) return [];
  const xs0 = movable.map((m) => m.annotation.x);
  const ys0 = movable.map((m) => m.annotation.y);
  const xs1 = movable.map((m) => m.annotation.x + m.annotation.w);
  const ys1 = movable.map((m) => m.annotation.y + m.annotation.h);
  const box = {
    x0: Math.min(...xs0),
    y0: Math.min(...ys0),
    x1: Math.max(...xs1),
    y1: Math.max(...ys1),
  };
  const out: AnnotationTransform[] = [];
  for (const m of movable) {
    const a = m.annotation;
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case 'left':
        dx = box.x0 - a.x;
        break;
      case 'right':
        dx = box.x1 - (a.x + a.w);
        break;
      case 'centerH':
        dx = (box.x0 + box.x1) / 2 - (a.x + a.w / 2);
        break;
      case 'top':
        dy = box.y0 - a.y;
        break;
      case 'bottom':
        dy = box.y1 - (a.y + a.h);
        break;
      case 'centerV':
        dy = (box.y0 + box.y1) / 2 - (a.y + a.h / 2);
        break;
    }
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) continue;
    const t = translatedBy(a, dx, dy);
    out.push({
      pageId: m.pageId,
      annotationId: a.id,
      x: t.x,
      y: t.y,
      w: a.w,
      h: a.h,
      ...(t.points ? { points: t.points } : {}),
      ...(t.strokes ? { strokes: t.strokes } : {}),
    });
  }
  return out;
}

/** Create even gaps along one axis with the first and last boxes pinned.
 * Requires three or more movable members. */
export function distributeEdits(members: Placed[], mode: DistributeMode): AnnotationTransform[] {
  const movable = members.filter((m) => isTransformable(m.annotation));
  if (movable.length < 3) return [];
  const horiz = mode === 'horizontal';
  const sorted = [...movable].sort((p, q) =>
    horiz ? p.annotation.x - q.annotation.x : p.annotation.y - q.annotation.y,
  );
  const first = sorted[0].annotation;
  const last = sorted[sorted.length - 1].annotation;
  const span = horiz
    ? last.x + last.w - first.x
    : last.y + last.h - first.y;
  const total = sorted.reduce((s, m) => s + (horiz ? m.annotation.w : m.annotation.h), 0);
  const gap = (span - total) / (sorted.length - 1);
  const out: AnnotationTransform[] = [];
  let cursor = horiz ? first.x : first.y;
  for (const m of sorted) {
    const a = m.annotation;
    const target = cursor;
    cursor += (horiz ? a.w : a.h) + gap;
    const dx = horiz ? target - a.x : 0;
    const dy = horiz ? 0 : target - a.y;
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) continue;
    const t = translatedBy(a, dx, dy);
    out.push({
      pageId: m.pageId,
      annotationId: a.id,
      x: t.x,
      y: t.y,
      w: a.w,
      h: a.h,
      ...(t.points ? { points: t.points } : {}),
      ...(t.strokes ? { strokes: t.strokes } : {}),
    });
  }
  return out;
}

/** Match every member's size to the FIRST-SELECTED resizable member (the
 * reference), growing/shrinking about each member's own top-left. */
export function sizeMatchEdits(
  members: Placed[],
  mode: SizeMatchMode,
  pageDims: Map<string, { width: number; height: number; rotation: number }>,
): AnnotationTransform[] {
  const resizable = members.filter((m) => isResizable(m.annotation));
  if (resizable.length < 2) return [];
  const ref = resizable[0].annotation;
  const out: AnnotationTransform[] = [];
  for (const m of resizable.slice(1)) {
    const a = m.annotation;
    const box = {
      x: a.x,
      y: a.y,
      w: mode === 'height' ? a.w : ref.w,
      h: mode === 'width' ? a.h : ref.h,
    };
    // Keep the resized box on the page.
    box.x = Math.min(box.x, Math.max(0, 1 - box.w));
    box.y = Math.min(box.y, Math.max(0, 1 - box.h));
    box.w = Math.min(box.w, 1 - box.x);
    box.h = Math.min(box.h, 1 - box.y);
    if (box.x === a.x && box.y === a.y && box.w === a.w && box.h === a.h) continue;
    const points = a.points ? scaledPoints(a, box) : undefined;
    const strokes = a.strokes ? scaledStrokes(a, box) : undefined;
    const dims = pageDims.get(m.pageId);
    const note =
      points && dims
        ? recomputedMeasureNote(a, points, dims.width, dims.height, dims.rotation)
        : undefined;
    out.push({
      pageId: m.pageId,
      annotationId: a.id,
      ...box,
      ...(points ? { points } : {}),
      ...(strokes ? { strokes } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }
  return out;
}

// ── Rotate / flip ──────────────────────────────────────────────────────
// Only the VERTEX-carrying kinds rotate: their geometry IS the point list,
// so a quarter-turn or mirror is exactly representable in the file
// (/L//Vertices//InkList move with the points). Box kinds (rect/ellipse,
// stamps, text) do NOT rotate — /Square//Circle are axis-aligned by
// definition, so a "rotation" could only live in the appearance stream and
// would silently shed itself in any tool that regenerates APs from the
// rect. Absent, not faked.

export type RotateDirection = 'cw' | 'ccw';
export type FlipAxis = 'h' | 'v';

export function isRotatable(a: PageAnnotation): boolean {
  return (
    a.kind === 'ink' ||
    a.kind === 'measure' ||
    (a.kind === 'shape' &&
      (a.shapeType === 'line' ||
        a.shapeType === 'arrow' ||
        a.shapeType === 'polygon' ||
        a.shapeType === 'polyline' ||
        a.shapeType === 'cloud'))
  );
}

/** Rotate/flip the selection's rotatable members a quarter turn or mirror.
 *
 * The math runs in PAGE-PIXEL space (normalized coords scaled by the page's
 * display dims): a rotation in the normalized unit square would shear
 * everything on a non-square page. Members share ONE pivot — the group's
 * pixel-space bbox center (a single member's own center degenerates to
 * exactly that) — so a rotated GROUP keeps its arrangement. The result is
 * clamped back onto the page as a whole (one shared shift, so the group
 * never smears), and measure notes recompute from their captured factors,
 * the size-match precedent. */
export function rotateFlipEdits(
  members: Placed[],
  op: { rotate: RotateDirection } | { flip: FlipAxis },
  pageDims: Map<string, { width: number; height: number; rotation: number }>,
): AnnotationTransform[] {
  const rotatable = members.filter((m) => isRotatable(m.annotation));
  if (rotatable.length === 0) return [];
  const dims = pageDims.get(rotatable[0].pageId);
  if (!dims) return [];
  const swapped = dims.rotation === 90 || dims.rotation === 270;
  const W = swapped ? dims.height : dims.width;
  const H = swapped ? dims.width : dims.height;
  if (!(W > 0) || !(H > 0)) return [];

  // Group pivot in pixel space.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of rotatable) {
    const a = m.annotation;
    minX = Math.min(minX, a.x * W);
    minY = Math.min(minY, a.y * H);
    maxX = Math.max(maxX, (a.x + a.w) * W);
    maxY = Math.max(maxY, (a.y + a.h) * H);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Screen coords (y down): CW maps (x,y) -> (cx-(y-cy), cy+(x-cx)).
  const map = (x: number, y: number): [number, number] => {
    if ('rotate' in op) {
      return op.rotate === 'cw'
        ? [cx - (y - cy), cy + (x - cx)]
        : [cx + (y - cy), cy - (x - cx)];
    }
    return op.flip === 'h' ? [2 * cx - x, y] : [x, 2 * cy - y];
  };

  interface Staged {
    m: Placed;
    x: number;
    y: number;
    w: number;
    h: number;
    points?: number[];
    strokes?: number[][];
  }
  const staged: Staged[] = [];
  let outMinX = Infinity;
  let outMinY = Infinity;
  let outMaxX = -Infinity;
  let outMaxY = -Infinity;
  for (const m of rotatable) {
    const a = m.annotation;
    const mapFlat = (flat: number[]): number[] => {
      const out: number[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        const [nx, ny] = map(flat[i] * W, flat[i + 1] * H);
        out.push(nx / W, ny / H);
      }
      return out;
    };
    const points = a.points ? mapFlat(a.points) : undefined;
    const strokes = a.strokes ? a.strokes.map(mapFlat) : undefined;
    const all = [...(points ?? []), ...(strokes ?? []).flat()];
    if (all.length < 2) continue;
    const xs = all.filter((_, i) => i % 2 === 0);
    const ys = all.filter((_, i) => i % 2 === 1);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const s: Staged = {
      m,
      x,
      y,
      w: Math.max(...xs) - x,
      h: Math.max(...ys) - y,
      ...(points ? { points } : {}),
      ...(strokes ? { strokes } : {}),
    };
    staged.push(s);
    outMinX = Math.min(outMinX, s.x);
    outMinY = Math.min(outMinY, s.y);
    outMaxX = Math.max(outMaxX, s.x + s.w);
    outMaxY = Math.max(outMaxY, s.y + s.h);
  }
  if (staged.length === 0) return [];

  // One shared clamp shift keeps the group's arrangement at the page edge.
  const dx = Math.max(0, -outMinX) - Math.max(0, outMaxX - 1);
  const dy = Math.max(0, -outMinY) - Math.max(0, outMaxY - 1);

  const out: AnnotationTransform[] = [];
  for (const s of staged) {
    const shift = (flat: number[]): number[] =>
      flat.map((v, i) => clamp01(i % 2 === 0 ? v + dx : v + dy));
    const points = s.points ? shift(s.points) : undefined;
    const strokes = s.strokes ? s.strokes.map(shift) : undefined;
    const d = pageDims.get(s.m.pageId);
    const note =
      points && d
        ? recomputedMeasureNote(s.m.annotation, points, d.width, d.height, d.rotation)
        : undefined;
    out.push({
      pageId: s.m.pageId,
      annotationId: s.m.annotation.id,
      x: clamp01(s.x + dx),
      y: clamp01(s.y + dy),
      w: s.w,
      h: s.h,
      ...(points ? { points } : {}),
      ...(strokes ? { strokes } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }
  return out;
}

// ── Ink stroke eraser ──────────────────────────────────────────────────

/** Cut everything within the eraser's swath out of an ink annotation's
 * strokes. A stroke crossed in
 * its middle SPLITS into two strokes (which `strokes: number[][]` holds
 * exactly; the per-stroke model is what makes the eraser clean).
 *
 * Geometry runs in an aspect-corrected frame: coordinates scale by the
 * per-axis normalized radius, turning the elliptical eraser (a CIRCLE on
 * screen mapped through the page aspect) into a unit circle. Each stroke
 * segment is cut AT THE ERASER'S EDGE: the quadratic entry/exit of the
 * segment through every eraser-sample disk yields kill intervals along the
 * segment, and the survivors keep interpolated boundary points. Deleting
 * whole segments instead would eat a coarse stroke outright — a quick
 * 3-sample line erased in its middle has BOTH segments within radius of
 * the shared vertex, so the whole drawing would vanish where the user
 * expects two halves (the e2e catch that forced this shape).
 *
 * No tunnelling in EITHER direction: interval math cuts a long stroke
 * segment crossing near an eraser sample (sparse stroke sampling), and the
 * swath itself is treated as a connected CAPSULE CHAIN — the path is
 * densified to ≤ r/2 sample spacing — so a fast flick whose pointer events
 * arrive far apart erases the same continuous band the on-screen swath
 * draws (sparse eraser sampling; the e2e's synthetic 3-waypoint scrub is
 * the extreme case).
 *
 * Returns null when nothing was touched, else the surviving strokes —
 * possibly [] (the annotation is fully erased; the caller removes it).
 * Runs shorter than a drawable segment (a single orphan point) are
 * dropped: a one-point "stroke" renders nothing and round-trips as noise.
 */
export function eraseFromStrokes(
  strokes: number[][],
  eraserPath: number[],
  radius: { x: number; y: number },
): number[][] | null {
  if (eraserPath.length < 2 || radius.x <= 0 || radius.y <= 0) return null;
  const ex: number[] = [];
  const ey: number[] = [];
  {
    let px = eraserPath[0] / radius.x;
    let py = eraserPath[1] / radius.y;
    ex.push(px);
    ey.push(py);
    for (let i = 2; i + 1 < eraserPath.length; i += 2) {
      const nx = eraserPath[i] / radius.x;
      const ny = eraserPath[i + 1] / radius.y;
      const steps = Math.ceil(Math.hypot(nx - px, ny - py) / 0.5);
      for (let s = 1; s <= steps; s++) {
        ex.push(px + ((nx - px) * s) / steps);
        ey.push(py + ((ny - py) * s) / steps);
      }
      px = nx;
      py = ny;
    }
  }

  // Merged t-intervals of scaled segment A→B inside any eraser disk.
  const killIntervals = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): Array<[number, number]> => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const raw: Array<[number, number]> = [];
    for (let i = 0; i < ex.length; i++) {
      const px = ax - ex[i];
      const py = ay - ey[i];
      if (len2 === 0) {
        if (px * px + py * py < 1) raw.push([0, 1]);
        continue;
      }
      // |P + tD|² < 1  →  len2·t² + 2(P·D)t + |P|² − 1 < 0
      const b = px * dx + py * dy;
      const c = px * px + py * py - 1;
      const disc = b * b - len2 * c;
      if (disc <= 0) continue;
      const sq = Math.sqrt(disc);
      const t0 = (-b - sq) / len2;
      const t1 = (-b + sq) / len2;
      if (t1 <= 0 || t0 >= 1) continue;
      raw.push([Math.max(0, t0), Math.min(1, t1)]);
    }
    if (raw.length < 2) return raw;
    raw.sort((p, q) => p[0] - q[0]);
    const merged: Array<[number, number]> = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      const last = merged[merged.length - 1];
      if (raw[i][0] <= last[1]) last[1] = Math.max(last[1], raw[i][1]);
      else merged.push(raw[i]);
    }
    return merged;
  };

  let changed = false;
  const out: number[][] = [];
  for (const stroke of strokes) {
    const n = stroke.length / 2;
    if (n < 2) {
      // Degenerate input stroke: a lone point erases when the eraser
      // touches it, else passes through.
      const px = stroke[0] / radius.x;
      const py = stroke[1] / radius.y;
      const hit = ex.some((x, i) => {
        const dx = x - px;
        const dy = ey[i] - py;
        return dx * dx + dy * dy < 1;
      });
      if (hit) changed = true;
      else out.push(stroke);
      continue;
    }
    let run: number[] = [];
    const closeRun = (): void => {
      if (run.length >= 4) out.push(run);
      run = [];
    };
    for (let s = 0; s < n - 1; s++) {
      const x1 = stroke[s * 2];
      const y1 = stroke[s * 2 + 1];
      const x2 = stroke[s * 2 + 2];
      const y2 = stroke[s * 2 + 3];
      const kills = killIntervals(x1 / radius.x, y1 / radius.y, x2 / radius.x, y2 / radius.y);
      if (kills.length === 0) {
        if (run.length === 0) run.push(x1, y1);
        run.push(x2, y2);
        continue;
      }
      changed = true;
      // Survivors = complement of the kill intervals in [0,1].
      const survivors: Array<[number, number]> = [];
      let cursor = 0;
      for (const [k0, k1] of kills) {
        if (k0 > cursor) survivors.push([cursor, k0]);
        cursor = Math.max(cursor, k1);
      }
      if (cursor < 1) survivors.push([cursor, 1]);
      if (survivors.length === 0) {
        closeRun();
        continue;
      }
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      for (const [a, b] of survivors) {
        // Zero-length float slivers are noise, not geometry.
        if ((b - a) * segLen < 1e-6) {
          if (a === 0) closeRun();
          continue;
        }
        const pbx = x1 + (x2 - x1) * b;
        const pby = y1 + (y2 - y1) * b;
        if (a === 0 && run.length > 0) {
          run.push(pbx, pby); // continues the open run to the cut edge
        } else {
          closeRun();
          run.push(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, pbx, pby);
        }
        if (b < 1) closeRun(); // the cut ends this piece mid-segment
      }
    }
    closeRun();
  }
  return changed ? out : null;
}

/** Bbox of a strokes list — the erased annotation's new frame. */
export function strokesBbox(
  strokes: number[][],
): { x: number; y: number; w: number; h: number } | null {
  const all = strokes.flat();
  if (all.length < 2) return null;
  const xs = all.filter((_, i) => i % 2 === 0);
  const ys = all.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** One scallop of a cloud border: a cubic from `s` to `e` with control
 * points offset outward by (4/3)r — the standard half-circle Bézier. Shared
 * by the SVG renderer and the PDF appearance emit so the two cannot drift. */
export interface CloudBump {
  s: [number, number];
  c1: [number, number];
  c2: [number, number];
  e: [number, number];
}

/** Scallops marching along each edge of a closed ring, bulging AWAY from the
 * centroid (winding-independent). Coordinates are whatever space the caller
 * works in — the bump radius `r` just has to match it. */
export function cloudBumps(verts: [number, number][], r: number): CloudBump[] {
  if (verts.length < 3) return [];
  const cx = verts.reduce((s, v) => s + v[0], 0) / verts.length;
  const cy = verts.reduce((s, v) => s + v[1], 0) / verts.length;
  const out: CloudBump[] = [];
  const k = (4 / 3) * r;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % verts.length];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len = Math.hypot(ex, ey);
    if (len < 0.01) continue;
    const steps = Math.max(1, Math.round(len / (r * 1.8)));
    let nx = -ey / len;
    let ny = ex / len;
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    if (nx * (mx - cx) + ny * (my - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let s = 0; s < steps; s++) {
      const sx = p[0] + (ex * s) / steps;
      const sy = p[1] + (ey * s) / steps;
      const tx = p[0] + (ex * (s + 1)) / steps;
      const ty = p[1] + (ey * (s + 1)) / steps;
      out.push({
        s: [sx, sy],
        c1: [sx + nx * k, sy + ny * k],
        c2: [tx + nx * k, ty + ny * k],
        e: [tx, ty],
      });
    }
  }
  return out;
}

/** Arrow-key nudge: one point at 1×, ten at Shift, in normalized units. */
export function nudgeDelta(
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  big: boolean,
  pageWidth: number,
  pageHeight: number,
): { dx: number; dy: number } {
  const step = big ? 10 : 1;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step / pageWidth, dy: 0 };
    case 'ArrowRight':
      return { dx: step / pageWidth, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step / pageHeight };
    case 'ArrowDown':
      return { dx: 0, dy: step / pageHeight };
  }
}

/** The body classes an annotation's overlay div carries.
 *
 * A PRISTINE IMPORT is drawn by pdf.js from the file's own appearance stream,
 * so the overlay contributes geometry and hit-testing only — it must add no
 * paint of its own. `page-annot-text` paints an opaque near-white plate
 * (`rgba(250,250,245,0.92)`), which is the freetext body's ground when the
 * overlay OWNS the drawing; over a pristine import it covered the appearance
 * stream and left 8% of it bleeding through — the note rendered at 1.11:1 on
 * the page while the same note showed at full contrast in the comment panel.
 * The stamp and ink classes carry layout only, so they are unconditional.
 *
 * Extracted from the component so the rule is testable: there is no DOM test
 * environment, and the pairing of "who draws the body" with "who paints the
 * ground" is exactly the kind of thing that regresses silently. */
export function annotationBodyClasses(
  kind: PageAnnotation['kind'],
  pristineImport: boolean,
): string {
  return (
    'page-annot' +
    (kind === 'freetext' && !pristineImport ? ' page-annot-text' : '') +
    (kind === 'ink' || kind === 'measure' ? ' page-annot-ink' : '') +
    (kind === 'textmarkup' ? ' page-annot-ink' : '') +
    (kind === 'shape' || kind === 'callout' ? ' page-annot-ink' : '') +
    (kind === 'count' || kind === 'countlegend' ? ' page-annot-ink' : '') +
    (kind === 'stamp' ? ' page-annot-stamp' : '')
  );
}
