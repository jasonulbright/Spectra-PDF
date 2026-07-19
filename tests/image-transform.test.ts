import { describe, expect, it } from 'vitest';
import {
  applyMove,
  applyResizeCorner,
  applyRotate,
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
