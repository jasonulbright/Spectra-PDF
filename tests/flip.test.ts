// The reorder animation's decision math. The hook that drives it has no DOM
// test environment, so everything that decides WHETHER and HOW FAR an element
// travels lives here.
import { describe, expect, it } from 'vitest';
import {
  computeFlipMoves,
  flipTransform,
  flipTransition,
  FLIP_DURATION_MS,
  FLIP_EPSILON_PX,
  FLIP_MAX_ANIMATED,
  type FlipPoint,
} from '../src/renderer/lib/flip';

const at = (pairs: Record<string, [number, number]>): Map<string, FlipPoint> =>
  new Map(Object.entries(pairs).map(([id, [x, y]]) => [id, { x, y }]));

describe('computeFlipMoves', () => {
  it('offsets a moved element back to where it was', () => {
    const moves = computeFlipMoves(
      at({ a: [0, 0], b: [100, 0] }),
      at({ a: [100, 0], b: [0, 0] }),
      { reducedMotion: false },
    );
    expect(moves).toEqual([
      { id: 'a', dx: -100, dy: 0 },
      { id: 'b', dx: 100, dy: 0 },
    ]);
  });

  it('travels on both axes (a wrapped row)', () => {
    const moves = computeFlipMoves(at({ a: [600, 0] }), at({ a: [0, 300] }), {
      reducedMotion: false,
    });
    expect(moves).toEqual([{ id: 'a', dx: 600, dy: -300 }]);
  });

  it('ignores sub-pixel jitter', () => {
    const moves = computeFlipMoves(
      at({ a: [0, 0], b: [10, 10] }),
      at({ a: [FLIP_EPSILON_PX / 2, 0], b: [10, 10 - FLIP_EPSILON_PX / 2] }),
      { reducedMotion: false },
    );
    expect(moves).toEqual([]);
  });

  it('animates nothing when motion is reduced', () => {
    const moves = computeFlipMoves(at({ a: [0, 0] }), at({ a: [500, 0] }), {
      reducedMotion: true,
    });
    expect(moves).toEqual([]);
  });

  it('skips elements that entered or left — they have no travel to show', () => {
    const moves = computeFlipMoves(
      at({ gone: [0, 0], stays: [100, 0] }),
      at({ stays: [0, 0], arrived: [100, 0] }),
      { reducedMotion: false },
    );
    expect(moves).toEqual([{ id: 'stays', dx: 100, dy: 0 }]);
  });

  it('animates a drag-sized reorder', () => {
    const first = new Map<string, FlipPoint>();
    const last = new Map<string, FlipPoint>();
    for (let i = 0; i < FLIP_MAX_ANIMATED; i++) {
      first.set(`p${i}`, { x: i * 10, y: 0 });
      last.set(`p${i}`, { x: (i + 1) * 10, y: 0 });
    }
    expect(computeFlipMoves(first, last, { reducedMotion: false })).toHaveLength(
      FLIP_MAX_ANIMATED,
    );
  });

  it('refuses to stampede: a bulk change animates nothing', () => {
    const first = new Map<string, FlipPoint>();
    const last = new Map<string, FlipPoint>();
    for (let i = 0; i < FLIP_MAX_ANIMATED + 1; i++) {
      first.set(`p${i}`, { x: i * 10, y: 0 });
      last.set(`p${i}`, { x: (i + 1) * 10, y: 0 });
    }
    expect(computeFlipMoves(first, last, { reducedMotion: false })).toEqual([]);
    // ...and the cap is what decides it, not the element count: a 500-page
    // file where only two pages actually moved still animates those two.
    const bulkFirst = new Map(first);
    const bulkLast = new Map(first);
    bulkLast.set('p0', { x: 4000, y: 0 });
    bulkLast.set('p1', { x: 4010, y: 0 });
    expect(computeFlipMoves(bulkFirst, bulkLast, { reducedMotion: false })).toHaveLength(2);
  });

  it('takes an explicit cap', () => {
    const first = at({ a: [0, 0], b: [10, 0], c: [20, 0] });
    const last = at({ a: [30, 0], b: [40, 0], c: [50, 0] });
    expect(computeFlipMoves(first, last, { reducedMotion: false, max: 2 })).toEqual([]);
    expect(computeFlipMoves(first, last, { reducedMotion: false, max: 3 })).toHaveLength(3);
  });
});

describe('flip css', () => {
  it('inverts with a translate and plays back over the duration', () => {
    expect(flipTransform({ id: 'a', dx: -12.5, dy: 4 })).toBe('translate(-12.5px, 4px)');
    expect(flipTransition()).toContain(`${FLIP_DURATION_MS}ms`);
    expect(flipTransition().startsWith('transform ')).toBe(true);
  });
});
