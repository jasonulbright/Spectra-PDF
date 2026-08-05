// Ruler GUIDES: the projection, the lookup, and the lifetime
// helpers. Pure, so the rotation algebra is proven here rather than by
// eyeballing a rotated page.
import { describe, it, expect } from 'vitest';
import {
  guideAt,
  guidesOnPage,
  isOffPage,
  projectGuide,
  prunedToPages,
  rotateGuide,
  toSnapGuides,
  withGuidePos,
  withoutGuide,
  withoutPaths,
  type PageGuide,
} from '../src/renderer/lib/guides';
import { rotateNormalizedPoint } from '../src/renderer/lib/redaction';

const g = (over: Partial<PageGuide> = {}): PageGuide => ({
  id: 'g1',
  path: 'a.pdf',
  pageId: 'a.pdf#g1#p0',
  axis: 'x',
  pos: 0.25,
  rotationAtDraw: 0,
  ...over,
});

describe('rotateGuide', () => {
  it('agrees with the POINT rotation it has to stay consistent with', () => {
    // The line x = p is the set of points (p, t). Rotating any two of those
    // points must land on the rotated line, for every quarter turn and both
    // axes — that is the whole correctness condition.
    for (const delta of [0, 90, 180, 270]) {
      for (const axis of ['x', 'y'] as const) {
        for (const pos of [0, 0.25, 0.5, 0.9, 1]) {
          const line = rotateGuide({ axis, pos }, delta);
          for (const t of [0, 0.3, 1]) {
            const src = axis === 'x' ? { x: pos, y: t } : { x: t, y: pos };
            const moved = rotateNormalizedPoint(src.x, src.y, delta);
            const got = line.axis === 'x' ? moved.x : moved.y;
            expect(got).toBeCloseTo(line.pos, 12);
          }
        }
      }
    }
  });

  it('swaps the axis on a quarter turn and keeps it on a half turn', () => {
    expect(rotateGuide({ axis: 'x', pos: 0.3 }, 90).axis).toBe('y');
    expect(rotateGuide({ axis: 'x', pos: 0.3 }, 180).axis).toBe('x');
    expect(rotateGuide({ axis: 'y', pos: 0.3 }, 270).axis).toBe('x');
  });

  it('composes back to the identity over four turns', () => {
    let cur: { axis: 'x' | 'y'; pos: number } = { axis: 'y', pos: 0.37 };
    for (let i = 0; i < 4; i++) cur = rotateGuide(cur, 90);
    expect(cur.axis).toBe('y');
    expect(cur.pos).toBeCloseTo(0.37, 12);
  });

  it('normalizes a negative or over-full delta', () => {
    expect(rotateGuide({ axis: 'x', pos: 0.2 }, -90)).toEqual(
      rotateGuide({ axis: 'x', pos: 0.2 }, 270),
    );
    expect(rotateGuide({ axis: 'x', pos: 0.2 }, 450)).toEqual(
      rotateGuide({ axis: 'x', pos: 0.2 }, 90),
    );
  });
});

describe('projectGuide', () => {
  it('is the identity when the page has not turned since the drag', () => {
    expect(projectGuide(g({ rotationAtDraw: 90 }), 90)).toEqual({ axis: 'x', pos: 0.25 });
  });

  it('follows the paper when it has', () => {
    // Drawn as a vertical line at 0.25 on an upright page; the page is now at
    // 90°, so it reads as a horizontal line at 0.25.
    expect(projectGuide(g({ rotationAtDraw: 0 }), 90)).toEqual({ axis: 'y', pos: 0.25 });
    // And drawn on a 90° page, read upright, it turns the other way.
    expect(projectGuide(g({ rotationAtDraw: 90 }), 0)).toEqual({ axis: 'y', pos: 0.75 });
  });
});

describe('guidesOnPage', () => {
  const all = [
    g({ id: 'a', pageId: 'p1', axis: 'x', pos: 0.2 }),
    g({ id: 'b', pageId: 'p2', axis: 'y', pos: 0.4 }),
    g({ id: 'c', pageId: 'p1', axis: 'y', pos: 0.8, rotationAtDraw: 180 }),
  ];

  it('keeps only this page, projected', () => {
    const got = guidesOnPage(all, 'p1', 0);
    expect(got.map((x) => x.id)).toEqual(['a', 'c']);
    expect(got[0]).toEqual({ id: 'a', axis: 'x', pos: 0.2 });
    // 'c' was drawn upside down: read upright it is at 1 − 0.8.
    expect(got[1].axis).toBe('y');
    expect(got[1].pos).toBeCloseTo(0.2, 12);
  });

  it('projects into the SNAP candidate shape unchanged', () => {
    expect(toSnapGuides(guidesOnPage(all, 'p2', 0))).toEqual([{ axis: 'y', pos: 0.4 }]);
  });
});

describe('guideAt', () => {
  const shown = [
    { id: 'v', axis: 'x' as const, pos: 0.5 },
    { id: 'h', axis: 'y' as const, pos: 0.5 },
  ];

  it('finds the guide whose OWN axis the pointer is near', () => {
    expect(guideAt(shown, 0.502, 0.1, 0.01, 0.01)?.id).toBe('v');
    expect(guideAt(shown, 0.1, 0.503, 0.01, 0.01)?.id).toBe('h');
  });

  it('returns null when nothing is within tolerance', () => {
    expect(guideAt(shown, 0.1, 0.1, 0.01, 0.01)).toBeNull();
  });

  it('breaks a tie toward the LATER guide — the one you just dragged is on top', () => {
    const stacked = [
      { id: 'old', axis: 'x' as const, pos: 0.5 },
      { id: 'new', axis: 'x' as const, pos: 0.5 },
    ];
    expect(guideAt(stacked, 0.5, 0.5, 0.01, 0.01)?.id).toBe('new');
  });

  it('prefers the CLOSER of two within tolerance', () => {
    const two = [
      { id: 'far', axis: 'x' as const, pos: 0.508 },
      { id: 'near', axis: 'x' as const, pos: 0.501 },
    ];
    expect(guideAt(two, 0.5, 0.5, 0.01, 0.01)?.id).toBe('near');
  });
});

describe('lifetime helpers', () => {
  it('treats only a position OFF the page as a delete', () => {
    expect(isOffPage(0.5)).toBe(false);
    expect(isOffPage(0)).toBe(false);
    expect(isOffPage(1)).toBe(false);
    expect(isOffPage(-0.01)).toBe(true);
    expect(isOffPage(1.4)).toBe(true);
  });

  it('moves one guide and leaves the others identical', () => {
    const all = [g({ id: 'a' }), g({ id: 'b', pos: 0.7 })];
    const moved = withGuidePos(all, 'a', 0.9);
    expect(moved[0].pos).toBe(0.9);
    expect(moved[1]).toBe(all[1]);
  });

  it('removes by id, by PATH (buffer identity) and by live page id', () => {
    const all = [
      g({ id: 'a', path: 'a.pdf', pageId: 'p1' }),
      g({ id: 'b', path: 'b.pdf', pageId: 'p2' }),
    ];
    expect(withoutGuide(all, 'a').map((x) => x.id)).toEqual(['b']);
    expect(withoutPaths(all, new Set(['a.pdf'])).map((x) => x.id)).toEqual(['b']);
    expect(prunedToPages(all, new Set(['p2'])).map((x) => x.id)).toEqual(['b']);
    // A guide whose page id is gone must never survive — the id-holder
    // rule, the same one the snap-geometry map follows.
    expect(prunedToPages(all, new Set())).toEqual([]);
  });
});
