// N11 slice A — the pure snapping math. Everything breakable about snapping
// lives in `lib/snap.ts` precisely so it can be tested without a DOM (this
// repo has none); the ten call sites in PageCell are covered by the existing
// gesture specs continuing to pass with snapping OFF.
import { describe, it, expect } from 'vitest';
import {
  ALL_SNAP_TYPES_ON,
  buildSnapIndex,
  DEFAULT_SNAP_RADIUS_PX,
  EMPTY_SNAP_INDEX,
  gridPoint,
  objectSnapPoints,
  pickSnap,
  constrainAngle,
  segmentIntersection,
  snapCandidates,
  snapDelta,
  snapPoint,
  SNAP_PRIORITY,
  type SnapOptions,
  type SnapPath,
  type SnapType,
  type SnapTypeFlags,
} from '../src/renderer/lib/snap';

// A 1000×1000 px page keeps the arithmetic legible: one normalized unit is
// 1000 px, so a radius of 8 px is 0.008 normalized.
const VIEW = { viewW: 1000, viewH: 1000 };

function opts(over: Partial<SnapOptions> = {}): SnapOptions {
  return {
    radiusPx: DEFAULT_SNAP_RADIUS_PX,
    ...VIEW,
    types: ALL_SNAP_TYPES_ON,
    ...over,
  };
}

function only(...on: SnapType[]): SnapTypeFlags {
  const flags = {} as Record<SnapType, boolean>;
  for (const t of SNAP_PRIORITY) flags[t] = on.includes(t);
  return flags;
}

/** A horizontal segment from (0.1,0.5) to (0.5,0.5). */
const LINE: SnapPath = { subpaths: [[0.1, 0.5, 0.5, 0.5]], closed: [false] };
/** A closed unit-ish square from (0.2,0.2) to (0.6,0.6). */
const SQUARE: SnapPath = {
  subpaths: [[0.2, 0.2, 0.6, 0.2, 0.6, 0.6, 0.2, 0.6]],
  closed: [true],
};

describe('candidate derivation', () => {
  it('offers every vertex as an endpoint, not just the two ends', () => {
    // The interior vertex is the case a bbox listing cannot spell — the whole
    // reason the geometry probe exists.
    const poly: SnapPath = { subpaths: [[0.1, 0.1, 0.3, 0.2, 0.5, 0.1]], closed: [false] };
    const index = buildSnapIndex([poly]);
    const hit = snapPoint(index, { x: 0.3005, y: 0.2005 }, opts({ types: only('endpoint') }));
    expect(hit.hit?.type).toBe('endpoint');
    expect(hit.point).toEqual({ x: 0.3, y: 0.2 });
  });

  it('offers each segment midpoint', () => {
    const index = buildSnapIndex([LINE]);
    const hit = snapPoint(index, { x: 0.301, y: 0.5 }, opts({ types: only('midpoint') }));
    expect(hit.hit?.type).toBe('midpoint');
    expect(hit.point.x).toBeCloseTo(0.3, 10);
  });

  it('offers a CLOSED subpath its centre, and an open one none', () => {
    const closed = buildSnapIndex([SQUARE]);
    expect(
      snapPoint(closed, { x: 0.4, y: 0.4 }, opts({ types: only('center') })).hit?.type,
    ).toBe('center');
    const open: SnapPath = {
      subpaths: [[0.2, 0.2, 0.6, 0.2, 0.6, 0.6, 0.2, 0.6]],
      closed: [false],
    };
    expect(
      snapPoint(buildSnapIndex([open]), { x: 0.4, y: 0.4 }, opts({ types: only('center') }))
        .hit,
    ).toBeNull();
  });

  it('closes the ring: a closed subpath has the last→first segment', () => {
    // The midpoint of the closing edge (0.2,0.6)→(0.2,0.2) is (0.2,0.4).
    const index = buildSnapIndex([SQUARE]);
    const hit = snapPoint(index, { x: 0.2, y: 0.4 }, opts({ types: only('midpoint') }));
    expect(hit.point).toEqual({ x: 0.2, y: 0.4 });
    const open = buildSnapIndex([{ subpaths: SQUARE.subpaths, closed: [false] }]);
    expect(snapPoint(open, { x: 0.2, y: 0.4 }, opts({ types: only('midpoint') })).hit).toBeNull();
  });

  it('treats a placement quad exactly like any other closed ring', () => {
    // An image lands as one closed 4-point subpath, so its corners, edge
    // midpoints and centre all come out of the same derivation.
    const quad: SnapPath = { subpaths: [[0.1, 0.1, 0.5, 0.1, 0.5, 0.3, 0.1, 0.3]], closed: [true] };
    const index = buildSnapIndex([quad]);
    expect(snapPoint(index, { x: 0.5, y: 0.1 }, opts({ types: only('endpoint') })).point).toEqual({
      x: 0.5,
      y: 0.1,
    });
    expect(snapPoint(index, { x: 0.3, y: 0.1 }, opts({ types: only('midpoint') })).point).toEqual({
      x: 0.3,
      y: 0.1,
    });
    expect(snapPoint(index, { x: 0.3, y: 0.2 }, opts({ types: only('center') })).point).toEqual({
      x: 0.3,
      y: 0.2,
    });
  });

  it('snaps to MARKUP geometry the same way as page content', () => {
    const index = buildSnapIndex([], [LINE]);
    expect(snapPoint(index, { x: 0.1, y: 0.5 }, opts({ types: only('endpoint') })).hit?.type).toBe(
      'endpoint',
    );
  });

  it('ignores a degenerate subpath and odd-length coordinate runs', () => {
    const junk: SnapPath = { subpaths: [[0.4, 0.4], [0.4, 0.4, 0.5]], closed: [false, false] };
    const index = buildSnapIndex([junk]);
    expect(snapCandidates(index, { x: 0.4, y: 0.4 }, opts())).toEqual([]);
  });

  it('an empty index snaps nothing', () => {
    expect(snapPoint(EMPTY_SNAP_INDEX, { x: 0.5, y: 0.5 }, opts()).hit).toBeNull();
  });
});

describe('priority and tie-breaking', () => {
  it('ranks endpoint > intersection > midpoint > center > guide > grid > edge', () => {
    expect([...SNAP_PRIORITY]).toEqual([
      'endpoint',
      'intersection',
      'midpoint',
      'center',
      'guide',
      'grid',
      'edge',
    ]);
  });

  it('prefers an endpoint over a nearer edge point', () => {
    // The cursor sits ON the segment (edge distance 0) 3 px from its end.
    const index = buildSnapIndex([LINE]);
    const hit = snapPoint(index, { x: 0.103, y: 0.5 }, opts());
    expect(hit.hit?.type).toBe('endpoint');
    expect(hit.point).toEqual({ x: 0.1, y: 0.5 });
  });

  it('prefers an intersection over a midpoint', () => {
    // Two crossing segments meeting at (0.3,0.3); the vertical one's midpoint
    // is also (0.3,0.3) — but the intersection outranks it.
    const cross: SnapPath[] = [
      { subpaths: [[0.1, 0.3, 0.5, 0.3]], closed: [false] },
      { subpaths: [[0.3, 0.1, 0.3, 0.5]], closed: [false] },
    ];
    const index = buildSnapIndex(cross);
    const hit = snapPoint(index, { x: 0.3005, y: 0.3005 }, opts({ types: only('intersection', 'midpoint') }));
    expect(hit.hit?.type).toBe('intersection');
  });

  it('breaks a same-type tie by distance', () => {
    const two: SnapPath[] = [
      { subpaths: [[0.3, 0.5, 0.35, 0.5]], closed: [false] },
      { subpaths: [[0.304, 0.5, 0.36, 0.5]], closed: [false] },
    ];
    const index = buildSnapIndex(two);
    const hits = snapCandidates(index, { x: 0.3035, y: 0.5 }, opts({ types: only('endpoint') }));
    expect(hits[0].x).toBeCloseTo(0.304, 10);
    expect(hits[1].x).toBeCloseTo(0.3, 10);
  });

  it('breaks a same-type same-distance tie by derivation order, deterministically', () => {
    const two: SnapPath[] = [
      { subpaths: [[0.294, 0.5, 0.34, 0.5]], closed: [false] },
      { subpaths: [[0.306, 0.5, 0.36, 0.5]], closed: [false] },
    ];
    const index = buildSnapIndex(two);
    const run = (): number[] =>
      snapCandidates(index, { x: 0.3, y: 0.5 }, opts({ types: only('endpoint') })).map((h) => h.x);
    expect(run()).toEqual([0.294, 0.306]);
    expect(run()).toEqual(run());
  });

  it('a DISABLED type is not a candidate at all, never merely deprioritized', () => {
    const index = buildSnapIndex([LINE]);
    const hits = snapCandidates(index, { x: 0.103, y: 0.5 }, opts({ types: only('edge') }));
    expect(hits.every((h) => h.type === 'edge')).toBe(true);
    expect(snapCandidates(index, { x: 0.103, y: 0.5 }, opts({ types: only('grid') }))).toEqual([]);
  });

  it('collapses duplicate candidates of the same type at the same spot', () => {
    // Two paths sharing a vertex: one endpoint candidate, not two, so Tab
    // cycling stays meaningful.
    const shared: SnapPath[] = [
      { subpaths: [[0.3, 0.3, 0.4, 0.4]], closed: [false] },
      { subpaths: [[0.3, 0.3, 0.2, 0.4]], closed: [false] },
    ];
    const hits = snapCandidates(
      buildSnapIndex(shared),
      { x: 0.3, y: 0.3 },
      opts({ types: only('endpoint') }),
    );
    expect(hits).toHaveLength(1);
  });
});

describe('radius is a SCREEN tolerance', () => {
  it('accepts a target 7 px away and rejects one 9 px away, at any zoom', () => {
    const index = buildSnapIndex([LINE]);
    // Zoomed out: the page is 500 px wide, so 8 px = 0.016 normalized.
    const out = { viewW: 500, viewH: 500 };
    expect(
      snapPoint(index, { x: 0.1 + 7 / 500, y: 0.5 }, opts({ ...out, types: only('endpoint') })).hit,
    ).not.toBeNull();
    expect(
      snapPoint(index, { x: 0.1 + 9 / 500, y: 0.5 }, opts({ ...out, types: only('endpoint') })).hit,
    ).toBeNull();
    // Zoomed in: 4000 px wide, so 8 px = 0.002 normalized. The SAME felt
    // tolerance, a quite different normalized one.
    const zin = { viewW: 4000, viewH: 4000 };
    expect(
      snapPoint(index, { x: 0.1 + 7 / 4000, y: 0.5 }, opts({ ...zin, types: only('endpoint') })).hit,
    ).not.toBeNull();
    expect(
      snapPoint(index, { x: 0.1 + 9 / 4000, y: 0.5 }, opts({ ...zin, types: only('endpoint') })).hit,
    ).toBeNull();
  });

  it('is isotropic on a non-square page', () => {
    // A landscape page: the same 7 px reach in x and in y, which a normalized
    // radius would get wrong by the aspect ratio.
    const index = buildSnapIndex([{ subpaths: [[0.5, 0.5, 0.5, 0.5000001]], closed: [false] }]);
    const land = { viewW: 1600, viewH: 400 };
    expect(
      snapPoint(index, { x: 0.5 + 7 / 1600, y: 0.5 }, opts({ ...land, types: only('endpoint') }))
        .hit,
    ).not.toBeNull();
    expect(
      snapPoint(index, { x: 0.5, y: 0.5 + 7 / 400 }, opts({ ...land, types: only('endpoint') })).hit,
    ).not.toBeNull();
    expect(
      snapPoint(index, { x: 0.5, y: 0.5 + 9 / 400 }, opts({ ...land, types: only('endpoint') })).hit,
    ).toBeNull();
  });

  it('degenerate viewport or radius snaps nothing rather than dividing by zero', () => {
    const index = buildSnapIndex([LINE]);
    expect(snapCandidates(index, { x: 0.1, y: 0.5 }, opts({ viewW: 0 }))).toEqual([]);
    expect(snapCandidates(index, { x: 0.1, y: 0.5 }, opts({ radiusPx: 0 }))).toEqual([]);
  });

  it('finds a candidate across a spatial-index cell boundary', () => {
    // The default index is 64×64, so a cell edge sits exactly at 0.25. A
    // query just inside one cell must still see a target in the next.
    const index = buildSnapIndex([{ subpaths: [[0.25, 0.5, 0.3, 0.5]], closed: [false] }]);
    const hit = snapPoint(index, { x: 0.25 - 3 / 1000, y: 0.5 }, opts({ types: only('endpoint') }));
    expect(hit.point.x).toBeCloseTo(0.25, 10);
  });
});

describe('Tab cycling', () => {
  const cross: SnapPath[] = [
    { subpaths: [[0.1, 0.3, 0.5, 0.3]], closed: [false] },
    { subpaths: [[0.3, 0.1, 0.3, 0.5]], closed: [false] },
  ];

  it('walks the candidates in priority order and wraps back to the first', () => {
    const index = buildSnapIndex(cross);
    const hits = snapCandidates(index, { x: 0.3, y: 0.3 }, opts());
    expect(hits.length).toBeGreaterThan(1);
    expect(pickSnap(hits, 0)).toEqual(hits[0]);
    expect(pickSnap(hits, 1)).toEqual(hits[1]);
    expect(pickSnap(hits, hits.length)).toEqual(hits[0]);
  });

  it('is stable: the same cursor and cycle always choose the same candidate', () => {
    const index = buildSnapIndex(cross);
    const at = { x: 0.3002, y: 0.2999 };
    for (let c = 0; c < 5; c++) {
      expect(snapPoint(index, at, opts(), c).point).toEqual(snapPoint(index, at, opts(), c).point);
    }
  });

  it('a negative cycle position wraps rather than throwing', () => {
    const hits = snapCandidates(buildSnapIndex(cross), { x: 0.3, y: 0.3 }, opts());
    expect(pickSnap(hits, -1)).toEqual(hits[hits.length - 1]);
  });

  it('picks nothing from an empty candidate list', () => {
    expect(pickSnap([], 3)).toBeNull();
  });
});

describe('intersections', () => {
  const seg = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

  it('finds a plain crossing', () => {
    expect(segmentIntersection(seg(0, 0, 10, 10), seg(0, 10, 10, 0))).toEqual({ x: 5, y: 5 });
  });

  it('returns null for parallel segments', () => {
    expect(segmentIntersection(seg(0, 0, 10, 0), seg(0, 5, 10, 5))).toBeNull();
  });

  it('returns null for COLLINEAR overlap — an overlap has no single point', () => {
    expect(segmentIntersection(seg(0, 0, 10, 0), seg(5, 0, 15, 0))).toBeNull();
  });

  it('returns a touch at an endpoint (priority, not filtering, demotes it)', () => {
    expect(segmentIntersection(seg(0, 0, 10, 0), seg(10, 0, 10, 10))).toEqual({ x: 10, y: 0 });
  });

  it('returns null when the crossing lies BEYOND either segment', () => {
    expect(segmentIntersection(seg(0, 0, 1, 0), seg(5, -5, 5, 5))).toBeNull();
    expect(segmentIntersection(seg(0, 0, 10, 0), seg(5, 3, 5, 8))).toBeNull();
  });

  it('is computed lazily — a far-away crossing is never offered', () => {
    const far: SnapPath[] = [
      { subpaths: [[0.0, 0.9, 1.0, 0.9]], closed: [false] },
      { subpaths: [[0.9, 0.0, 0.9, 1.0]], closed: [false] },
    ];
    const index = buildSnapIndex(far);
    const hits = snapCandidates(index, { x: 0.1, y: 0.1 }, opts({ types: only('intersection') }));
    expect(hits).toEqual([]);
    // …and IS offered when the cursor is on it.
    expect(
      snapCandidates(index, { x: 0.9, y: 0.9 }, opts({ types: only('intersection') })),
    ).toHaveLength(1);
  });

  it('offers where two guides cross', () => {
    const hits = snapCandidates(
      EMPTY_SNAP_INDEX,
      { x: 0.3, y: 0.7 },
      opts({
        types: only('intersection'),
        guides: [
          { axis: 'x', pos: 0.3 },
          { axis: 'y', pos: 0.7 },
        ],
      }),
    );
    expect(hits).toEqual([{ x: 0.3, y: 0.7, type: 'intersection', distancePx: 0 }]);
  });
});

describe('guides', () => {
  it('projects the cursor onto the guide line', () => {
    const hit = snapPoint(
      EMPTY_SNAP_INDEX,
      { x: 0.402, y: 0.6 },
      opts({ types: only('guide'), guides: [{ axis: 'x', pos: 0.4 }] }),
    );
    expect(hit.point).toEqual({ x: 0.4, y: 0.6 });
  });

  it('leaves the cursor alone when the guide is out of reach', () => {
    const hit = snapPoint(
      EMPTY_SNAP_INDEX,
      { x: 0.5, y: 0.6 },
      opts({ types: only('guide'), guides: [{ axis: 'x', pos: 0.4 }] }),
    );
    expect(hit.hit).toBeNull();
    expect(hit.point).toEqual({ x: 0.5, y: 0.6 });
  });
});

describe('grid quantization', () => {
  it('rounds to the nearest cell', () => {
    const grid = { spacingX: 0.1, spacingY: 0.1, originX: 0, originY: 0 };
    const p = gridPoint({ x: 0.34, y: 0.66 }, grid);
    expect(p.x).toBeCloseTo(0.3, 10);
    expect(p.y).toBeCloseTo(0.7, 10);
  });

  it('honours a NON-ZERO origin', () => {
    const grid = { spacingX: 0.1, spacingY: 0.1, originX: 0.05, originY: 0.02 };
    expect(gridPoint({ x: 0.14, y: 0.2 }, grid).x).toBeCloseTo(0.15, 10);
    expect(gridPoint({ x: 0.14, y: 0.2 }, grid).y).toBeCloseTo(0.22, 10);
  });

  it('handles a SCALED (real-world unit) spacing that does not divide the page', () => {
    // 1 ft on a 1/4"=1'0" sheet: 3 pt of paper per foot on a 792 pt page.
    const spacing = 3 / 792;
    const grid = { spacingX: spacing, spacingY: spacing, originX: 0, originY: 0 };
    const snapped = gridPoint({ x: 0.5, y: 0.5 }, grid);
    expect(Math.abs(snapped.x / spacing - Math.round(snapped.x / spacing))).toBeLessThan(1e-9);
    expect(Math.abs(snapped.x - 0.5)).toBeLessThanOrEqual(spacing / 2 + 1e-12);
  });

  it('leaves an axis alone when its spacing is non-positive', () => {
    expect(gridPoint({ x: 0.37, y: 0.41 }, { spacingX: 0, spacingY: -1, originX: 0, originY: 0 }))
      .toEqual({ x: 0.37, y: 0.41 });
  });

  it('only offers the grid point when it is inside the radius', () => {
    const grid = { spacingX: 0.1, spacingY: 0.1, originX: 0, originY: 0 };
    const snapped = snapPoint(
      EMPTY_SNAP_INDEX,
      { x: 0.3005, y: 0.3 },
      opts({ types: only('grid'), grid }),
    ).point;
    expect(snapped.x).toBeCloseTo(0.3, 10);
    expect(snapped.y).toBeCloseTo(0.3, 10);
    expect(
      snapPoint(EMPTY_SNAP_INDEX, { x: 0.35, y: 0.3 }, opts({ types: only('grid'), grid })).hit,
    ).toBeNull();
  });
});

describe('the DELTA variant snaps the object, not the pointer', () => {
  const index = buildSnapIndex([{ subpaths: [[0.8, 0.8, 0.9, 0.8]], closed: [false] }]);

  it('lands the nearest OWN point on the target and corrects the delta', () => {
    // A box whose bottom-right corner is at (0.5,0.5). Dragging it by
    // +0.3/+0.3 puts that corner at (0.8,0.8) — the target endpoint — while
    // the pointer (wherever it is) is nowhere near it.
    const own = objectSnapPoints({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 });
    const res = snapDelta(index, own, { dx: 0.3 + 0.003, dy: 0.3 + 0.003 }, opts());
    expect(res.hit?.type).toBe('endpoint');
    expect(res.delta.dx).toBeCloseTo(0.3, 10);
    expect(res.delta.dy).toBeCloseTo(0.3, 10);
  });

  it('leaves the delta untouched when no own point reaches a target', () => {
    const own = objectSnapPoints({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
    const res = snapDelta(index, own, { dx: 0.01, dy: 0.01 }, opts());
    expect(res.hit).toBeNull();
    expect(res.delta).toEqual({ dx: 0.01, dy: 0.01 });
  });

  it('chooses the BEST own point when two are in reach', () => {
    // Both the corner and the box centre could reach a target; the higher
    // priority (endpoint over midpoint) decides.
    const two = buildSnapIndex([
      { subpaths: [[0.5, 0.5, 0.7, 0.5]], closed: [false] },
    ]);
    const own = objectSnapPoints({ x: 0.0, y: 0.4, w: 0.2, h: 0.2 });
    // Corner (0.2,0.6) + delta → (0.5,0.5) exactly; centre (0.1,0.5) + delta
    // → (0.4,0.4), out of reach of anything.
    const res = snapDelta(two, own, { dx: 0.3, dy: -0.1 }, opts());
    expect(res.hit?.type).toBe('endpoint');
    expect(res.delta.dx).toBeCloseTo(0.3, 10);
    expect(res.delta.dy).toBeCloseTo(-0.1, 10);
  });

  it('includes an annotation VERTEX among the object points', () => {
    const own = objectSnapPoints({ x: 0, y: 0, w: 0.1, h: 0.1, points: [0.05, 0.02] });
    expect(own).toContainEqual({ x: 0.05, y: 0.02 });
    expect(own).toContainEqual({ x: 0.05, y: 0.05 }); // the box centre
    expect(own).toHaveLength(6);
  });
});

// ── N11 slice B: angle constrain ────────────────────────────────────────
describe('constrainAngle (N11 slice B)', () => {
  // A square view, so normalized units and pixels agree and the expected
  // angles are readable. The anisotropic case gets its own test below.
  const W = 1000;
  const H = 1000;

  it('holds a nearly-horizontal drag to exactly horizontal', () => {
    const p = constrainAngle({ x: 0.2, y: 0.5 }, { x: 0.6, y: 0.52 }, 15, W, H);
    expect(p.y).toBeCloseTo(0.5, 10); // the anchor's y — 0° is the nearest ray
    expect(p.x).toBeGreaterThan(0.55); // and it keeps essentially all its reach
  });

  it('picks the NEAREST increment, not the first one', () => {
    // 40° from horizontal, 15° increments → 45° is nearer than 30°.
    const rad = (40 * Math.PI) / 180;
    const to = { x: 0.5 + 0.3 * Math.cos(rad), y: 0.5 + 0.3 * Math.sin(rad) };
    const p = constrainAngle({ x: 0.5, y: 0.5 }, to, 15, W, H);
    const angle = (Math.atan2(p.y - 0.5, p.x - 0.5) * 180) / Math.PI;
    expect(angle).toBeCloseTo(45, 6);
  });

  it('PROJECTS onto the ray rather than rotating the vector', () => {
    // Straight up-right at 45° with the pointer 30° off it: projecting keeps
    // cos(15°) of the length, rotating would keep all of it. The difference
    // is the whole "moving sideways must not change the length" property.
    const rad = (30 * Math.PI) / 180;
    const len = 0.3;
    const to = { x: 0.5 + len * Math.cos(rad), y: 0.5 + len * Math.sin(rad) };
    const p = constrainAngle({ x: 0.5, y: 0.5 }, to, 45, W, H);
    const got = Math.hypot(p.x - 0.5, p.y - 0.5);
    expect(got).toBeCloseTo(len * Math.cos((15 * Math.PI) / 180), 10);
  });

  it('never flips behind the anchor, for any pointer direction at any increment', () => {
    for (const inc of [1, 5, 15, 30, 45, 90]) {
      for (let deg = -360; deg <= 360; deg += 7) {
        const rad = (deg * Math.PI) / 180;
        const to = { x: 0.5 + 0.2 * Math.cos(rad), y: 0.5 + 0.2 * Math.sin(rad) };
        const p = constrainAngle({ x: 0.5, y: 0.5 }, to, inc, W, H);
        const dot = (p.x - 0.5) * (to.x - 0.5) + (p.y - 0.5) * (to.y - 0.5);
        expect(dot).toBeGreaterThan(0);
      }
    }
  });

  it('wraps: 350° and −10° land on the same ray', () => {
    const from = { x: 0.5, y: 0.5 };
    const at = (deg: number): { x: number; y: number } => {
      const rad = (deg * Math.PI) / 180;
      return { x: from.x + 0.2 * Math.cos(rad), y: from.y + 0.2 * Math.sin(rad) };
    };
    const a = constrainAngle(from, at(350), 10, W, H);
    const b = constrainAngle(from, at(-10), 10, W, H);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.y).toBeCloseTo(b.y, 12);
  });

  it('measures the angle in PIXELS, so a landscape page still constrains to 45° on screen', () => {
    // 2:1 view. A normalized-space 45° would show as ~63° on screen; the
    // pixel-space constraint must produce equal pixel components.
    const p = constrainAngle({ x: 0, y: 0 }, { x: 0.4, y: 0.9 }, 45, 2000, 1000);
    expect(p.x * 2000).toBeCloseTo(p.y * 1000, 8);
  });

  it('is a no-op for a zero-length drag or a non-positive increment', () => {
    expect(constrainAngle({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }, 15, W, H)).toEqual({
      x: 0.3,
      y: 0.3,
    });
    expect(constrainAngle({ x: 0, y: 0 }, { x: 0.4, y: 0.1 }, 0, W, H)).toEqual({
      x: 0.4,
      y: 0.1,
    });
    expect(constrainAngle({ x: 0, y: 0 }, { x: 0.4, y: 0.1 }, 15, 0, H)).toEqual({
      x: 0.4,
      y: 0.1,
    });
  });
});
