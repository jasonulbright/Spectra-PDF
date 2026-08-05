// N11 slice A — SNAPPING math. Pure functions only: no DOM, no fetch, no
// React, no i18n. This repo has no DOM test environment, so the breakable
// part must be the testable part (the `measure.ts` precedent, stated in its
// own header for the same reason).
//
// SPACE. Everything here is DISPLAY-NORMALIZED (0..1 against the displayed
// page), the same space every canvas gesture already works in — so a caller
// hands over the points it already has and gets one back it can use
// unchanged. The one exception is the search RADIUS, which is expressed in
// SCREEN PIXELS: a snap tolerance is a felt distance, and a normalized radius
// would tighten as you zoom in, which is exactly backwards. The page's
// displayed pixel size converts it (`viewW`/`viewH`), and distances are
// measured in that pixel space so a landscape page's x and y tolerances are
// the same felt size rather than the same fraction.
//
// WHAT IS NOT HERE. Fetching page geometry (that is `lib/snap-geometry.ts`,
// the impure boundary) and drawing the marker (PageCell). Nothing in this
// file knows where candidates came from.

export type SnapType =
  | 'endpoint'
  | 'intersection'
  | 'midpoint'
  | 'center'
  | 'guide'
  | 'grid'
  | 'edge';

/**
 * Priority when several candidates fall inside the radius. An EXPLICIT
 * geometric target beats a derived one, and a derived one beats a synthetic
 * grid; `edge` is last because a segment's nearest point exists everywhere
 * along it and would otherwise drown out the discrete targets that share its
 * neighbourhood.
 *
 * Ties break by distance, then by derivation order — deterministic, and
 * tested as such, because Tab cycling walks this exact sequence and a user
 * pressing Tab twice must land back where they started.
 */
export const SNAP_PRIORITY: readonly SnapType[] = [
  'endpoint',
  'intersection',
  'midpoint',
  'center',
  'guide',
  'grid',
  'edge',
];

/** Per-type on/off. A DISABLED type is not a candidate at all — never merely
 * deprioritized — so turning off `edge` cannot leave an edge hit winning a
 * radius that contains nothing else. */
export type SnapTypeFlags = Readonly<Record<SnapType, boolean>>;

export const ALL_SNAP_TYPES_ON: SnapTypeFlags = {
  endpoint: true,
  intersection: true,
  midpoint: true,
  center: true,
  guide: true,
  grid: true,
  edge: true,
};

/** The default felt tolerance, in CSS pixels. */
export const DEFAULT_SNAP_RADIUS_PX = 8;

export interface SnapPoint {
  x: number;
  y: number;
}

export interface SnapHit extends SnapPoint {
  type: SnapType;
  /** Distance from the query point, in SCREEN pixels. */
  distancePx: number;
}

/** One path's display-normalized geometry: flat [x,y,x,y,…] subpaths and a
 * parallel closed flag (a closed subpath has the last→first segment and
 * contributes a CENTRE candidate). This is exactly `list_page_geometry`'s
 * payload after projection, and also the shape a live annotation projects
 * into — one candidate derivation serves page content and markup both. */
export interface SnapPath {
  subpaths: readonly (readonly number[])[];
  closed: readonly boolean[];
}

/** A slice-B guide line, kept here because its CANDIDATE math belongs with
 * the rest: an `x` guide is a vertical line at that normalized x. */
export interface SnapGuide {
  axis: 'x' | 'y';
  pos: number;
}

/** A slice-B grid. Spacing and origin are display-normalized; the caller
 * converts from paper or real-world units. Non-positive spacing yields no
 * candidates rather than dividing by zero. */
export interface SnapGrid {
  spacingX: number;
  spacingY: number;
  originX: number;
  originY: number;
}

export interface SnapOptions {
  /** Felt tolerance in CSS pixels. */
  radiusPx: number;
  /** The page's DISPLAYED size in CSS pixels — what converts the radius. */
  viewW: number;
  viewH: number;
  types: SnapTypeFlags;
  guides?: readonly SnapGuide[];
  grid?: SnapGrid | null;
}

interface IndexedPoint extends SnapPoint {
  type: SnapType;
  order: number;
}

interface IndexedSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  order: number;
}

/**
 * The per-page snap universe, built once when the geometry lands.
 *
 * The spatial index is a uniform grid over the NORMALIZED page rather than
 * over the search radius (the brief's phrasing). Same idea, one deviation
 * with a reason: a radius-sized index would have to be rebuilt on every zoom
 * change, because the radius is a screen quantity. A fixed normalized grid is
 * zoom-independent, and a query still touches only the handful of cells the
 * radius rectangle overlaps — at any zoom the radius is a small fraction of a
 * page, so that is 1 to 9 cells in practice.
 */
export interface SnapIndex {
  readonly points: readonly IndexedPoint[];
  readonly segments: readonly IndexedSegment[];
  readonly cells: number;
  /** cell key ("cx,cy") → indices into `points`. */
  readonly pointCells: ReadonlyMap<string, number[]>;
  /** cell key → indices into `segments`. */
  readonly segmentCells: ReadonlyMap<string, number[]>;
}

export const EMPTY_SNAP_INDEX: SnapIndex = {
  points: [],
  segments: [],
  cells: 1,
  pointCells: new Map(),
  segmentCells: new Map(),
};

const DEFAULT_CELLS = 64;

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

function clampCell(v: number, cells: number): number {
  return v < 0 ? 0 : v >= cells ? cells - 1 : v;
}

function pushCell(map: Map<string, number[]>, cx: number, cy: number, idx: number): void {
  const key = cellKey(cx, cy);
  const bucket = map.get(key);
  if (bucket) bucket.push(idx);
  else map.set(key, [idx]);
}

/** Every vertex of a subpath, as [x,y] pairs. Odd-length input is truncated
 * — a listing never aborts on bad geometry, and neither does this. */
function verticesOf(sub: readonly number[]): SnapPoint[] {
  const out: SnapPoint[] = [];
  for (let i = 0; i + 1 < sub.length; i += 2) out.push({ x: sub[i], y: sub[i + 1] });
  return out;
}

/**
 * Derive every static candidate and index it.
 *
 * Static means "does not depend on the cursor": vertices, segment midpoints,
 * closed-subpath centres, and the segments themselves. Intersections, guides
 * and grid points are cursor-dependent and are produced at query time —
 * intersections because precomputing them is O(n²) on a sheet with 40 000
 * segments and never necessary (only one can be inside the radius).
 *
 * `paths` is page content; `markup` is live annotation geometry. They derive
 * identically — snapping to markup you already placed is a plus-extra that
 * costs nothing — and are separate parameters only so a caller can index one
 * without the other.
 */
export function buildSnapIndex(
  paths: readonly SnapPath[],
  markup: readonly SnapPath[] = [],
  cells: number = DEFAULT_CELLS,
): SnapIndex {
  const n = Math.max(1, Math.floor(cells));
  const points: IndexedPoint[] = [];
  const segments: IndexedSegment[] = [];
  const pointCells = new Map<string, number[]>();
  const segmentCells = new Map<string, number[]>();
  let order = 0;

  const addPoint = (x: number, y: number, type: SnapType): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const idx = points.length;
    points.push({ x, y, type, order: order++ });
    pushCell(pointCells, clampCell(Math.floor(x * n), n), clampCell(Math.floor(y * n), n), idx);
  };
  const addSegment = (x0: number, y0: number, x1: number, y1: number): void => {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    if (x0 === x1 && y0 === y1) return; // a zero-length segment has no edge
    const idx = segments.length;
    segments.push({ x0, y0, x1, y1, order: order++ });
    // A segment lands in every cell its bounding box touches — cheap, and it
    // means a long rule is still found from anywhere along it.
    const cx0 = clampCell(Math.floor(Math.min(x0, x1) * n), n);
    const cx1 = clampCell(Math.floor(Math.max(x0, x1) * n), n);
    const cy0 = clampCell(Math.floor(Math.min(y0, y1) * n), n);
    const cy1 = clampCell(Math.floor(Math.max(y0, y1) * n), n);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) pushCell(segmentCells, cx, cy, idx);
    }
  };

  for (const source of [paths, markup]) {
    for (const path of source) {
      for (let s = 0; s < path.subpaths.length; s++) {
        const verts = verticesOf(path.subpaths[s]);
        if (verts.length < 2) continue;
        const isClosed = Boolean(path.closed[s]);
        // Every VERTEX is an endpoint candidate, not just the two ends: an
        // interior vertex of a polyline is precisely the target a bbox
        // cannot spell, and is why the geometry probe exists at all.
        for (const v of verts) addPoint(v.x, v.y, 'endpoint');
        const last = isClosed ? verts.length : verts.length - 1;
        for (let i = 0; i < last; i++) {
          const a = verts[i];
          const b = verts[(i + 1) % verts.length];
          addPoint((a.x + b.x) / 2, (a.y + b.y) / 2, 'midpoint');
          addSegment(a.x, a.y, b.x, b.y);
        }
        if (isClosed) {
          // The BOX centre, not the polygon centroid: for a rectangle, a
          // circle and an image quad — the shapes anyone actually aims at —
          // they agree, and the box centre stays predictable on the shapes
          // where they do not.
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const v of verts) {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
          }
          addPoint((minX + maxX) / 2, (minY + maxY) / 2, 'center');
        }
      }
    }
  }
  return { points, segments, cells: n, pointCells, segmentCells };
}

function cellRange(
  lo: number,
  hi: number,
  cells: number,
): { from: number; to: number } {
  return {
    from: clampCell(Math.floor(lo * cells), cells),
    to: clampCell(Math.floor(hi * cells), cells),
  };
}

function gatherCells(
  map: ReadonlyMap<string, number[]>,
  x: number,
  y: number,
  rx: number,
  ry: number,
  cells: number,
): number[] {
  const xs = cellRange(x - rx, x + rx, cells);
  const ys = cellRange(y - ry, y + ry, cells);
  const seen = new Set<number>();
  for (let cx = xs.from; cx <= xs.to; cx++) {
    for (let cy = ys.from; cy <= ys.to; cy++) {
      const bucket = map.get(cellKey(cx, cy));
      if (!bucket) continue;
      for (const i of bucket) seen.add(i);
    }
  }
  return [...seen];
}

/** Nearest point on segment AB to P, clamped to the segment. Measured in
 * PIXEL space so the projection is not skewed by a non-square page. */
function nearestOnSegment(
  s: IndexedSegment,
  px: number,
  py: number,
  vw: number,
  vh: number,
): SnapPoint {
  const ax = s.x0 * vw;
  const ay = s.y0 * vh;
  const bx = s.x1 * vw;
  const by = s.y1 * vh;
  const dx = bx - ax;
  const dy = by - ay;
  const span = dx * dx + dy * dy;
  if (span < 1e-12) return { x: s.x0, y: s.y0 };
  let t = ((px * vw - ax) * dx + (py * vh - ay) * dy) / span;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: s.x0 + (s.x1 - s.x0) * t, y: s.y0 + (s.y1 - s.y0) * t };
}

/**
 * Where two segments cross, or null.
 *
 * Returns null for parallel and for COLLINEAR overlap (an overlap has no
 * single point to snap to — offering the caller an arbitrary one is worse
 * than offering nothing), and for a crossing that lies beyond either
 * segment's extent. A touch AT an endpoint is a real intersection and is
 * returned; it simply loses to the endpoint candidate on priority.
 */
export function segmentIntersection(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): SnapPoint | null {
  const r = { x: a.x1 - a.x0, y: a.y1 - a.y0 };
  const s = { x: b.x1 - b.x0, y: b.y1 - b.y0 };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-12) return null; // parallel or collinear
  const qp = { x: b.x0 - a.x0, y: b.y0 - a.y0 };
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  const u = (qp.x * r.y - qp.y * r.x) / denom;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: a.x0 + r.x * t, y: a.y0 + r.y * t };
}

/** Quantize to the grid. Non-positive spacing leaves that axis alone. */
export function gridPoint(p: SnapPoint, grid: SnapGrid): SnapPoint {
  const q = (v: number, spacing: number, origin: number): number =>
    spacing > 0 ? origin + Math.round((v - origin) / spacing) * spacing : v;
  return {
    x: q(p.x, grid.spacingX, grid.originX),
    y: q(p.y, grid.spacingY, grid.originY),
  };
}

function priorityOf(type: SnapType): number {
  const i = SNAP_PRIORITY.indexOf(type);
  return i < 0 ? SNAP_PRIORITY.length : i;
}

/**
 * Every candidate inside the radius, in the order Tab cycles them: priority
 * first, then distance, then derivation order.
 *
 * Return the full list rather than only the winner so callers can cycle among
 * overlapping candidates; priority alone cannot express "use the other
 * one". Callers that do not cycle simply take `[0]`.
 */
export function snapCandidates(
  index: SnapIndex,
  at: SnapPoint,
  opts: SnapOptions,
): SnapHit[] {
  const { radiusPx, viewW, viewH, types } = opts;
  if (!(radiusPx > 0) || !(viewW > 0) || !(viewH > 0)) return [];
  const rx = radiusPx / viewW;
  const ry = radiusPx / viewH;
  const distPx = (x: number, y: number): number =>
    Math.hypot((x - at.x) * viewW, (y - at.y) * viewH);

  const hits: (SnapHit & { order: number })[] = [];
  const consider = (x: number, y: number, type: SnapType, order: number): void => {
    if (!types[type]) return;
    const d = distPx(x, y);
    if (d > radiusPx) return;
    hits.push({ x, y, type, distancePx: d, order });
  };

  // Static point candidates from the touched buckets.
  for (const i of gatherCells(index.pointCells, at.x, at.y, rx, ry, index.cells)) {
    const p = index.points[i];
    consider(p.x, p.y, p.type, p.order);
  }

  // Segment-derived candidates: the nearest point on each segment (edge), and
  // — LAZILY, only among the segments this query actually touched — their
  // pairwise intersections.
  const segIdx = gatherCells(index.segmentCells, at.x, at.y, rx, ry, index.cells);
  if (types.edge) {
    for (const i of segIdx) {
      const s = index.segments[i];
      const p = nearestOnSegment(s, at.x, at.y, viewW, viewH);
      consider(p.x, p.y, 'edge', s.order);
    }
  }
  if (types.intersection) {
    for (let i = 0; i < segIdx.length; i++) {
      for (let j = i + 1; j < segIdx.length; j++) {
        const a = index.segments[segIdx[i]];
        const b = index.segments[segIdx[j]];
        const p = segmentIntersection(a, b);
        if (p) consider(p.x, p.y, 'intersection', Math.min(a.order, b.order));
      }
    }
  }

  // Guides: the cursor's projection onto the line.
  const guides = opts.guides ?? [];
  if (types.guide) {
    for (let i = 0; i < guides.length; i++) {
      const g = guides[i];
      if (g.axis === 'x') consider(g.pos, at.y, 'guide', i);
      else consider(at.x, g.pos, 'guide', i);
    }
  }
  // Where two guides cross is an INTERSECTION, and is gated on that type
  // rather than on `guide` — a user who turned guide-projection off but left
  // intersections on still means "the corner where those two lines meet".
  if (types.intersection) {
    for (let i = 0; i < guides.length; i++) {
      if (guides[i].axis !== 'x') continue;
      for (let j = 0; j < guides.length; j++) {
        if (guides[j].axis !== 'y') continue;
        consider(guides[i].pos, guides[j].pos, 'intersection', i);
      }
    }
  }

  if (types.grid && opts.grid) {
    const g = gridPoint(at, opts.grid);
    consider(g.x, g.y, 'grid', 0);
  }

  hits.sort(
    (a, b) =>
      priorityOf(a.type) - priorityOf(b.type) ||
      a.distancePx - b.distancePx ||
      a.order - b.order,
  );
  // Two derivations can land on the same spot with the same type (a shared
  // vertex between two paths). Collapsing them keeps Tab cycling meaningful.
  const out: SnapHit[] = [];
  for (const h of hits) {
    if (
      out.some(
        (o) =>
          o.type === h.type &&
          Math.abs(o.x - h.x) < 1e-9 &&
          Math.abs(o.y - h.y) < 1e-9,
      )
    ) {
      continue;
    }
    out.push({ x: h.x, y: h.y, type: h.type, distancePx: h.distancePx });
  }
  return out;
}

/**
 * The chosen candidate for a cycle position, or null when nothing is in
 * range. `cycle` counts Tab presses and wraps — pressing Tab as many times as
 * there are candidates returns to the first, which is the property the
 * gesture's determinism test asserts.
 */
export function pickSnap(hits: readonly SnapHit[], cycle: number): SnapHit | null {
  if (hits.length === 0) return null;
  const i = ((cycle % hits.length) + hits.length) % hits.length;
  return hits[i];
}

/** The one call a POINT gesture makes: snap this point, or return it. */
export function snapPoint(
  index: SnapIndex,
  at: SnapPoint,
  opts: SnapOptions,
  cycle = 0,
): { point: SnapPoint; hit: SnapHit | null; candidates: SnapHit[] } {
  const candidates = snapCandidates(index, at, opts);
  const hit = pickSnap(candidates, cycle);
  return { point: hit ? { x: hit.x, y: hit.y } : at, hit, candidates };
}

/**
 * The one call a MOVE gesture makes — and the reason the API has two entries.
 *
 * Dragging a rectangle by its middle and having the POINTER land on an
 * endpoint is not what any CAD tool does: the corner nearest a target is what
 * should land on it. So this resolves the snap over the moved copies of the
 * dragged object's OWN candidate points and returns the corrected delta,
 * choosing whichever of them produces the best hit (priority, then distance).
 *
 * `own` is the object's candidate points in display-normalized space, already
 * in the same frame as `delta`.
 */
export function snapDelta(
  index: SnapIndex,
  own: readonly SnapPoint[],
  delta: { dx: number; dy: number },
  opts: SnapOptions,
  cycle = 0,
): { delta: { dx: number; dy: number }; hit: SnapHit | null; candidates: SnapHit[] } {
  let best: { hit: SnapHit; from: SnapPoint; all: SnapHit[] } | null = null;
  for (const p of own) {
    const moved = { x: p.x + delta.dx, y: p.y + delta.dy };
    const all = snapCandidates(index, moved, opts);
    const hit = pickSnap(all, cycle);
    if (!hit) continue;
    if (
      !best ||
      priorityOf(hit.type) < priorityOf(best.hit.type) ||
      (priorityOf(hit.type) === priorityOf(best.hit.type) &&
        hit.distancePx < best.hit.distancePx)
    ) {
      best = { hit, from: p, all };
    }
  }
  if (!best) return { delta, hit: null, candidates: [] };
  return {
    delta: { dx: best.hit.x - best.from.x, dy: best.hit.y - best.from.y },
    hit: best.hit,
    candidates: best.all,
  };
}

// ── Angle constrain (N11 slice B) ────────────────────────────────────────
// Shift, while a drag is live, holds the segment to the nearest increment.
// Apply this after point snapping so an explicit geometric target takes
// precedence over a constraint.

/** Increment bounds, in degrees. 90 is the ortho case; below 1 the constraint
 * stops constraining anything. */
export const SNAP_ANGLE_MIN = 1;
export const SNAP_ANGLE_MAX = 90;
export const DEFAULT_SNAP_ANGLE_DEG = 15;

/**
 * `to`, held to the nearest multiple of `incrementDeg` measured from `from`.
 *
 * PIXEL space, like the radius: a "45°" constraint has to look like 45° on
 * screen, and a normalized-space angle on a landscape page would not.
 *
 * The constrained point is the PROJECTION of the pointer onto the chosen ray,
 * not the pointer's length rotated onto it — moving the pointer sideways then
 * changes only the direction it picks, never the length, which is what "ortho"
 * feels like everywhere it exists. Projecting is safe precisely because the
 * ray is the NEAREST one: the pointer is at most half an increment off it, so
 * the projection keeps at least cos(45°) of the length for any increment up to
 * 90 and can never flip behind the anchor.
 */
export function constrainAngle(
  from: SnapPoint,
  to: SnapPoint,
  incrementDeg: number,
  viewW: number,
  viewH: number,
): SnapPoint {
  if (!(incrementDeg > 0) || !(viewW > 0) || !(viewH > 0)) return to;
  const dx = (to.x - from.x) * viewW;
  const dy = (to.y - from.y) * viewH;
  if (dx === 0 && dy === 0) return to;
  const step = (incrementDeg * Math.PI) / 180;
  // Math.round carries the 0/360 wrap and negative angles for free: atan2
  // returns (−π, π] and the rounding is on a continuous multiple, so the
  // ray at 350° and the ray at −10° are the same ray.
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const proj = dx * ux + dy * uy;
  return { x: from.x + (proj * ux) / viewW, y: from.y + (proj * uy) / viewH };
}

/** The candidate points a dragged annotation offers: its box corners, its box
 * centre, and its vertices when it has them. Pure, so the move gesture's
 * "snap the OBJECT, not the pointer" rule is testable without a DOM. */
export function objectSnapPoints(box: {
  x: number;
  y: number;
  w: number;
  h: number;
  points?: readonly number[];
}): SnapPoint[] {
  const out: SnapPoint[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w / 2, y: box.y + box.h / 2 },
  ];
  const pts = box.points;
  if (pts) {
    for (let i = 0; i + 1 < pts.length; i += 2) out.push({ x: pts[i], y: pts[i + 1] });
  }
  return out;
}
