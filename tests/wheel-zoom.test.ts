import { describe, expect, it } from 'vitest';
import { wheelZoomFactor } from '../src/renderer/canvas/zoom-constants';

describe('wheelZoomFactor', () => {
  it('uses a gradual, symmetric zoom step for a full wheel delta', () => {
    expect(wheelZoomFactor(-50)).toBeCloseTo(1.1, 5);
    expect(wheelZoomFactor(50)).toBeCloseTo(1 / 1.1, 5);
  });

  it('keeps smaller trackpad deltas proportional and clamps large deltas', () => {
    expect(wheelZoomFactor(-2)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-2)).toBeLessThan(1.01);
    expect(wheelZoomFactor(-120)).toBe(wheelZoomFactor(-50));
    expect(wheelZoomFactor(120)).toBe(wheelZoomFactor(50));
  });
});
