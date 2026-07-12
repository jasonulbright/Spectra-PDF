// Canvas pan constraint (Phase 3 polish): the fitted-content case must
// CENTER-clamp instead of applying no constraint — extreme zoom-out used to
// let a pan fling the workspace off-screen (only "Fit" recovered).
import { describe, expect, it } from 'vitest';
import { zoomIdentity } from 'd3-zoom';
import { reversibleConstrain } from '../src/renderer/canvas/constrain';
import type { Extent } from '../src/renderer/canvas/constrain';

const VIEWPORT: Extent = [
  [0, 0],
  [1000, 800],
];
// Workspace content: 2000x1600 world units.
const CONTENT: Extent = [
  [0, 0],
  [2000, 1600],
];

describe('reversibleConstrain', () => {
  it('re-centers when the content fits inside the viewport (extreme zoom-out)', () => {
    // k=0.25: content renders 500x400 inside a 1000x800 viewport. A wild
    // fling puts it far off-screen; the constraint must bring it back to
    // CENTER, not leave it wherever it drifted.
    const flung = zoomIdentity.translate(5000, -4000).scale(0.25);
    const constrained = reversibleConstrain(flung, VIEWPORT, CONTENT);
    // Centered: world-center (1000, 800) maps to viewport-center (500, 400).
    expect(constrained.applyX(1000)).toBeCloseTo(500, 6);
    expect(constrained.applyY(800)).toBeCloseTo(400, 6);
  });

  it('keeps ordinary edge clamping when the content overflows the viewport', () => {
    // k=1: content 2000x1600 overflows 1000x800. Panning past the left/top
    // edge clamps back to the edge (the world origin pins to the viewport
    // origin), exactly as before.
    const overLeft = zoomIdentity.translate(300, 250).scale(1);
    const constrained = reversibleConstrain(overLeft, VIEWPORT, CONTENT);
    expect(constrained.applyX(0)).toBeCloseTo(0, 6);
    expect(constrained.applyY(0)).toBeCloseTo(0, 6);
    // And past the right/bottom edge clamps to that edge.
    const overRight = zoomIdentity.translate(-1700, -1300).scale(1);
    const c2 = reversibleConstrain(overRight, VIEWPORT, CONTENT);
    expect(c2.applyX(2000)).toBeCloseTo(1000, 6);
    expect(c2.applyY(1600)).toBeCloseTo(800, 6);
  });

  it('leaves an in-bounds transform untouched', () => {
    const inBounds = zoomIdentity.translate(-200, -100).scale(1);
    const constrained = reversibleConstrain(inBounds, VIEWPORT, CONTENT);
    expect(constrained.x).toBeCloseTo(inBounds.x, 6);
    expect(constrained.y).toBeCloseTo(inBounds.y, 6);
    expect(constrained.k).toBe(inBounds.k);
  });
});
