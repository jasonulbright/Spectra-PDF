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
  note?: string;
}

/** Kinds whose geometry the user may change at all. Text markup is anchored
 * to the text it covers — Acrobat refuses to move it too, and a moved quad
 * set would lie about what it marks. */
export function isTransformable(a: PageAnnotation): boolean {
  return a.kind !== 'textmarkup';
}

/** Kinds that resize. Sticky notes are a fixed icon (their /Rect is
 * viewer-managed); everything else transformable scales. */
export function isResizable(a: PageAnnotation): boolean {
  return isTransformable(a) && a.kind !== 'note';
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
): { x: number; y: number; points?: number[]; dx: number; dy: number } {
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
): { x: number; y: number; points?: number[] } {
  const t = translated(a, dx, dy);
  return { x: t.x, y: t.y, ...(t.points ? { points: t.points } : {}) };
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
): { x: number; y: number; w: number; h: number; points?: number[] } {
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

  const out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  return { ...out, ...(a.points ? { points: scaledPoints(a, out) } : {}) };
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

/** Align a same-page selection to the group's bounding box (Acrobat's model).
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
    });
  }
  return out;
}

/** Even gaps between boxes along one axis, first and last pinned (Acrobat's
 * distribute). Needs three or more movable members. */
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
      ...(note !== undefined ? { note } : {}),
    });
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
