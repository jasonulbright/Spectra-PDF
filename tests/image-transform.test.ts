import { describe, expect, it } from 'vitest';
import {
  applyCropEdge,
  applyMove,
  applyResizeCorner,
  applyRotate,
  applySkewEdge,
  cropRectFromLocalPoints,
  displayQuad,
  displayToUser,
  invert,
  matMul,
  transformPoint,
  userCenter,
  userToDisplay,
  type Mat,
} from '../src/renderer/lib/image-transform';
import { pdfRectToDisplay } from '../src/renderer/lib/pdfx-build';

const BOX = { x: 0, y: 0, width: 612, height: 792 };
const ID: Mat = [1, 0, 0, 1, 0, 0];
// A plain scale+translate placement (100×80 at (50,600)) — the pytest fixture.
const M: Mat = [100, 0, 0, 80, 50, 600];

const approx = (a: number[], b: number[], eps = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
  void eps;
};

describe('image-transform matrix core', () => {
  it('matMul matches the row-vector convention (m1 then m2)', () => {
    // Translate-then-scale vs the engine's mat_mult ordering.
    const t: Mat = [1, 0, 0, 1, 10, 20];
    const s: Mat = [2, 0, 0, 3, 0, 0];
    // point (1,1): apply t → (11,21); apply s → (22,63).
    expect(transformPoint(matMul(t, s), 1, 1)).toEqual([22, 63]);
  });

  it('invert round-trips to identity', () => {
    const inv = invert(M)!;
    approx(matMul(M, inv), ID);
    approx(matMul(inv, M), ID);
  });

  it('invert refuses a degenerate matrix', () => {
    expect(invert([0, 0, 0, 0, 5, 6])).toBeNull();
  });
});

describe('gesture builders (user space)', () => {
  it('move shifts only the translation', () => {
    expect(applyMove(M, 25, -40)).toEqual([100, 0, 0, 80, 75, 560]);
  });

  it('resize pins the opposite corner and sends the dragged corner to P', () => {
    // Drag the top-right corner (idx 2, user (150,680)) out to (250,760);
    // bottom-left (50,600) must stay put.
    const m2 = applyResizeCorner(M, 2, 250, 760)!;
    approx(transformPoint(m2, 0, 0), [50, 600]); // opposite corner pinned
    approx(transformPoint(m2, 1, 1), [250, 760]); // dragged corner at P
  });

  it('skew shears the dragged edge along itself and pins the opposite edge (P7)', () => {
    // Top edge (3) of M dragged +30 user-x: bottom corners stay, top corners
    // shift by exactly the drag (k measured at the dragged edge).
    const s = applySkewEdge(M, 3, 100, 680, 130, 680)!;
    approx(transformPoint(s, 0, 0), [50, 600]); // BL pinned
    approx(transformPoint(s, 1, 0), [150, 600]); // BR pinned
    approx(transformPoint(s, 0, 1), [80, 680]); // TL +30
    approx(transformPoint(s, 1, 1), [180, 680]); // TR +30
    // Right edge (2) dragged +40 user-y: left edge pinned, right shifts.
    const r = applySkewEdge(M, 2, 150, 620, 150, 660)!;
    approx(transformPoint(r, 0, 0), [50, 600]);
    approx(transformPoint(r, 0, 1), [50, 680]);
    approx(transformPoint(r, 1, 0), [150, 640]); // BR +40
    approx(transformPoint(r, 1, 1), [150, 720]); // TR +40
  });

  it('skew of the bottom/left edges pins top/right instead', () => {
    const b = applySkewEdge(M, 1, 100, 600, 120, 600)!;
    approx(transformPoint(b, 0, 1), [50, 680]); // TL pinned
    approx(transformPoint(b, 0, 0), [70, 600]); // BL +20
    const l = applySkewEdge(M, 0, 50, 640, 50, 615)!;
    approx(transformPoint(l, 1, 0), [150, 600]); // BR pinned
    approx(transformPoint(l, 0, 0), [50, 575]); // BL −25
  });

  it('skew stays correct on a rotated placement and preserves the determinant', () => {
    const rot = applyRotate(M, Math.PI / 3); // arbitrary rotation
    // Drag the top edge along its own (rotated) direction: express the drag
    // in user space as local Δx=0.3 mapped through the rotated matrix.
    const [sx, sy] = transformPoint(rot, 0.5, 1);
    const [cx2, cy2] = transformPoint(rot, 0.8, 1);
    const s = applySkewEdge(rot, 3, sx, sy, cx2, cy2)!;
    // The bottom edge is exactly where it was.
    approx(transformPoint(s, 0, 0), transformPoint(rot, 0, 0));
    approx(transformPoint(s, 1, 0), transformPoint(rot, 1, 0));
    // Shear preserves area: det unchanged.
    const det = (m: Mat): number => m[0] * m[3] - m[1] * m[2];
    expect(det(s)).toBeCloseTo(det(rot), 6);
  });

  it('skew refuses a degenerate base matrix', () => {
    expect(applySkewEdge([0, 0, 0, 0, 5, 6], 3, 0, 0, 1, 1)).toBeNull();
  });

  it('rotate keeps the center fixed', () => {
    const [cx, cy] = userCenter(M); // (100, 640)
    const r = applyRotate(M, Math.PI / 2);
    approx(userCenter(r), [cx, cy]); // center invariant
    // A 90° CCW rotation swaps the placement's width/height footprint.
    const corners = [0, 1, 2, 3].map((i) => transformPoint(r, i & 1 ? 1 : 0, i & 2 ? 1 : 0));
    void corners;
    // BL corner (0,0) rotates about center to the opposite side.
    const bl = transformPoint(r, 0, 0);
    approx(bl, [cx + (cy - 600), cy - (cx - 50)]); // (100+40, 640-50)=(140,590)
  });
});

describe('display projection', () => {
  it('userToDisplay/displayToUser round-trip across all rotations', () => {
    for (const baked of [0, 90, 180, 270]) {
      for (const pending of [0, 90, 180, 270]) {
        const [u, v] = userToDisplay(130, 660, BOX, baked, pending);
        const [px, py] = displayToUser(u, v, BOX, baked, pending);
        approx([px, py], [130, 660], 1e-4);
      }
    }
  });

  it('displayQuad of an axis-aligned placement matches the bbox projection', () => {
    // No rotation: the quad's min/max must equal pdfRectToDisplay of the
    // placement's user-space bbox [50,600,150,680].
    const quad = displayQuad(M, BOX, 0, 0);
    const xs = quad.map((p) => p[0]);
    const ys = quad.map((p) => p[1]);
    const bbox = pdfRectToDisplay([50, 600, 150, 680], BOX, 0);
    expect(Math.min(...xs)).toBeCloseTo(bbox.x, 6);
    expect(Math.min(...ys)).toBeCloseTo(bbox.y, 6);
    expect(Math.max(...xs)).toBeCloseTo(bbox.x + bbox.w, 6);
    expect(Math.max(...ys)).toBeCloseTo(bbox.y + bbox.h, 6);
  });
});

describe('crop rect from local drag points (9.C3)', () => {
  it('normalizes any drag direction into an ordered rect', () => {
    expect(cropRectFromLocalPoints([0.8, 0.7], [0.2, 0.1])).toEqual([0.2, 0.1, 0.8, 0.7]);
    expect(cropRectFromLocalPoints([0.2, 0.7], [0.8, 0.1])).toEqual([0.2, 0.1, 0.8, 0.7]);
  });

  it('clamps to the unit square', () => {
    expect(cropRectFromLocalPoints([-0.5, -0.5], [1.5, 1.5])).toEqual([0, 0, 1, 1]);
  });

  it('refuses a degenerate band (a bare click or a sliver)', () => {
    expect(cropRectFromLocalPoints([0.5, 0.5], [0.5, 0.5])).toBeNull();
    expect(cropRectFromLocalPoints([0.5, 0.1], [0.505, 0.9])).toBeNull(); // x sliver
    expect(cropRectFromLocalPoints([0.1, 0.5], [0.9, 0.505])).toBeNull(); // y sliver
  });

  it('honours a custom minimum size', () => {
    expect(cropRectFromLocalPoints([0.4, 0.4], [0.45, 0.45], 0.01)).toEqual([
      0.4, 0.4, 0.45, 0.45,
    ]);
    expect(cropRectFromLocalPoints([0.4, 0.4], [0.45, 0.45], 0.1)).toBeNull();
  });

  it('round-trips through a placement matrix inverse (the overlay path)', () => {
    // Display drag over M=[100,0,0,80,50,600]: user points → local via M⁻¹.
    const inv = invert(M)!;
    const a = transformPoint(inv, 75, 620); // user (75,620) → local (0.25, 0.25)
    const b = transformPoint(inv, 125, 660); // → (0.75, 0.75)
    expect(cropRectFromLocalPoints(a, b)).toEqual([0.25, 0.25, 0.75, 0.75]);
  });
});

describe('crop edge drag (9.C3-tail)', () => {
  const rect: [number, number, number, number] = [0.25, 0.25, 0.75, 0.75];

  it('moves exactly the dragged edge, other three fixed', () => {
    expect(applyCropEdge(rect, 0, [0.1, 0.9])).toEqual([0.1, 0.25, 0.75, 0.75]);
    expect(applyCropEdge(rect, 1, [0.9, 0.1])).toEqual([0.25, 0.1, 0.75, 0.75]);
    expect(applyCropEdge(rect, 2, [0.9, 0.1])).toEqual([0.25, 0.25, 0.9, 0.75]);
    expect(applyCropEdge(rect, 3, [0.1, 0.9])).toEqual([0.25, 0.25, 0.75, 0.9]);
  });

  it('widening past the shipped band is expressible (the tail headline)', () => {
    // Left edge dragged OUTWARD from 0.25 to 0.05 — impossible under the
    // old intersect-only semantics.
    expect(applyCropEdge(rect, 0, [0.05, 0.5])).toEqual([0.05, 0.25, 0.75, 0.75]);
  });

  it('clamps to the unit square and to minSize short of the opposite edge', () => {
    expect(applyCropEdge(rect, 0, [-0.3, 0.5])[0]).toBe(0);
    expect(applyCropEdge(rect, 2, [1.4, 0.5])[2]).toBe(1);
    // Crossing the opposite edge stops minSize short — never inverts.
    expect(applyCropEdge(rect, 0, [0.99, 0.5])[0]).toBeCloseTo(0.73);
    expect(applyCropEdge(rect, 3, [0.5, 0.0])[3]).toBeCloseTo(0.27);
  });
});
