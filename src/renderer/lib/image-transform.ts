// Phase 9.C1 — image-placement transform math.
//
// The engine's `transform_page_image` takes an ABSOLUTE target matrix M' in
// page USER space; the renderer builds it from a move/resize/rotate gesture on
// the selected placement. Every gesture computes in USER space, which is
// invariant to /Rotate (the redaction-mark rule) — so a committed transform is
// correct no matter the baked or pending page rotation. The rotations enter
// ONLY the display projection (to place the overlay and read the pointer).
//
// Row-vector convention throughout, IDENTICAL to the engine's
// `content_walk.mat_mult`: a point maps `[x y 1]·m`, and `matMul(m1, m2)`
// applies m1 THEN m2. This is the one place the two sides must agree, so the
// pytest (engine) and vitest (here) both assert the same round-trips.

import { displayPointToPdf, pdfPointToDisplay } from './pdfx-build';

/** A PDF affine matrix [a, b, c, d, e, f]. */
export type Mat = [number, number, number, number, number, number];

export function matMul(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function transformPoint(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Affine inverse, or null when degenerate (det≈0 — a collapsed placement). */
export function invert(m: Mat): Mat | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** The four local unit-square corners, CCW from bottom-left: BL, BR, TR, TL. */
export const LOCAL_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** User-space center of the placement (the pivot for rotate). */
export function userCenter(m: Mat): [number, number] {
  return transformPoint(m, 0.5, 0.5);
}

// ── gesture builders — each returns the new ABSOLUTE matrix M' ──────────────

/** Translate the placement by a user-space delta. */
export function applyMove(m: Mat, dux: number, duy: number): Mat {
  return [m[0], m[1], m[2], m[3], m[4] + dux, m[5] + duy];
}

/** The smallest scale factor a corner drag may collapse an axis to — keeps a
 * placement from vanishing or flipping inside-out. */
const MIN_SCALE = 0.02;

/** Drag local corner `cornerIdx` to user-space point (pux,puy) with the
 * OPPOSITE corner pinned. Scale is computed in the placement's LOCAL frame (via
 * M⁻¹) so it stays correct for a rotated placement. Null if M is degenerate. */
export function applyResizeCorner(
  m: Mat,
  cornerIdx: number,
  pux: number,
  puy: number,
): Mat | null {
  const inv = invert(m);
  if (!inv) return null;
  const [lx, ly] = transformPoint(inv, pux, puy); // P in local coords
  const corner = LOCAL_CORNERS[cornerIdx];
  const opp = LOCAL_CORNERS[(cornerIdx + 2) % 4];
  const dx = corner[0] - opp[0];
  const dy = corner[1] - opp[1];
  let sx = dx !== 0 ? (lx - opp[0]) / dx : 1;
  let sy = dy !== 0 ? (ly - opp[1]) / dy : 1;
  sx = Math.abs(sx) < MIN_SCALE ? (sx < 0 ? -MIN_SCALE : MIN_SCALE) : sx;
  sy = Math.abs(sy) < MIN_SCALE ? (sy < 0 ? -MIN_SCALE : MIN_SCALE) : sy;
  // Scale about `opp` in local space: p → (p−opp)·diag(sx,sy) + opp.
  const s: Mat = [sx, 0, 0, sy, opp[0] * (1 - sx), opp[1] * (1 - sy)];
  return matMul(s, m); // local scale first, then M
}

/** Rotate the placement about its own center by `angleRad` (CCW in user
 * space). The center is a fixed point, so the image spins in place. */
export function applyRotate(m: Mat, angleRad: number): Mat {
  const [cx, cy] = userCenter(m);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  // Rotation about (cx,cy): translate(−C)·rot·translate(C).
  const rc: Mat = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
  return matMul(m, rc); // M (→ user space) first, then rotate about C
}

// ── display projection (user ⇄ final display-normalized) ────────────────────

export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Rotate a normalized point by the pending in-memory page rotation — the
 * point analogue of redaction.ts `rotateNormalizedRect` (same convention). */
function rotateNormPoint(x: number, y: number, delta: number): [number, number] {
  const d = norm360(delta);
  if (d === 90) return [1 - y, x];
  if (d === 180) return [1 - x, 1 - y];
  if (d === 270) return [y, 1 - x];
  return [x, y];
}

/** User-space point → FINAL display-normalized (0..1, top-left origin): the
 * baked projection, then the pending in-memory rotation (the two-stage
 * pipeline every overlay uses — pdfPointToDisplay then rotateNormalized*). */
export function userToDisplay(
  px: number,
  py: number,
  box: PageBox,
  bakedRotate: number,
  pendingRotate: number,
): [number, number] {
  const [u, v] = pdfPointToDisplay(px, py, box, bakedRotate);
  return rotateNormPoint(u, v, pendingRotate);
}

/** Inverse of userToDisplay: FINAL display-normalized → user-space point. */
export function displayToUser(
  u: number,
  v: number,
  box: PageBox,
  bakedRotate: number,
  pendingRotate: number,
): [number, number] {
  const [bu, bv] = rotateNormPoint(u, v, 360 - norm360(pendingRotate));
  return displayPointToPdf(bu, bv, box, bakedRotate);
}

/** The placement's four corners in FINAL display space (for the overlay quad
 * and handle positions), CCW BL→BR→TR→TL. */
export function displayQuad(
  m: Mat,
  box: PageBox,
  bakedRotate: number,
  pendingRotate: number,
): Array<[number, number]> {
  return LOCAL_CORNERS.map(([lx, ly]) => {
    const [px, py] = transformPoint(m, lx, ly);
    return userToDisplay(px, py, box, bakedRotate, pendingRotate);
  });
}
