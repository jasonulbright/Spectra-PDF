// The zoom gate on drop targets. Every surface that accepts a page drop asks
// this one predicate, and none of them has a DOM test environment.
import { describe, expect, it } from 'vitest';
import {
  dropTargetGate,
  zoomFactorToPass,
  DROP_TARGET_MIN_SCREEN_PX,
} from '../src/renderer/lib/drop-gate';
import { computeDropTarget, DOC_HEIGHT, computeLayout } from '../src/renderer/canvas/layout';
import type { OpenDocument } from '../src/renderer/state/types';

describe('dropTargetGate', () => {
  it('accepts a target at or above the minimum', () => {
    expect(dropTargetGate(DROP_TARGET_MIN_SCREEN_PX).ok).toBe(true);
    expect(dropTargetGate(DROP_TARGET_MIN_SCREEN_PX + 400).ok).toBe(true);
  });

  it('refuses a target below it, and reports the measurement', () => {
    const verdict = dropTargetGate(40);
    expect(verdict.ok).toBe(false);
    expect(verdict.screenPx).toBe(40);
    if (!verdict.ok) expect(verdict.minPx).toBe(DROP_TARGET_MIN_SCREEN_PX);
  });

  it('refuses an unmeasured target rather than treating it as passing', () => {
    expect(dropTargetGate(Number.NaN).ok).toBe(false);
    // Infinity is not a measurement either — a degenerate camera scale, not
    // an enormous target.
    expect(dropTargetGate(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(dropTargetGate(0).ok).toBe(false);
    expect(dropTargetGate(-10).ok).toBe(false);
  });

  it('takes an explicit minimum', () => {
    expect(dropTargetGate(50, 40).ok).toBe(true);
    expect(dropTargetGate(50, 60).ok).toBe(false);
  });
});

describe('zoomFactorToPass', () => {
  it('names how much closer the camera must come', () => {
    expect(zoomFactorToPass(45)).toBeCloseTo(2);
    expect(zoomFactorToPass(DROP_TARGET_MIN_SCREEN_PX)).toBe(1);
    expect(zoomFactorToPass(500)).toBe(1); // already passing — never a zoom OUT
    expect(zoomFactorToPass(0)).toBe(Infinity);
  });
});

function doc(id: string, pages: number): OpenDocument {
  return {
    id,
    name: id,
    path: `C:/${id}.pdf`,
    pages: Array.from({ length: pages }, (_, i) => ({
      id: `${id}#p${i}`,
      sourceDocId: `C:/${id}.pdf`,
      sourcePageIndex: i,
      width: 612,
      height: 792,
      rotation: 0 as const,
      annotations: [],
    })),
  } as unknown as OpenDocument;
}

describe('computeDropTarget under the gate', () => {
  const layout = computeLayout([doc('a', 3), doc('b', 3)]);
  const first = layout.items[0];
  const insideFirst = { x: first.x + 40, y: first.y + first.height / 2 };

  it('names an insertion point when the strip is big enough', () => {
    const target = computeDropTarget(layout, insideFirst.x, insideFirst.y, 1, null, true);
    expect(target.kind).toBe('into');
  });

  it('refuses, rather than silently making a new document, when it is not', () => {
    // A scale that draws the card under the minimum.
    const scale = (DROP_TARGET_MIN_SCREEN_PX - 1) / DOC_HEIGHT;
    const target = computeDropTarget(layout, insideFirst.x, insideFirst.y, scale, null, true);
    expect(target.kind).toBe('refused');
    if (target.kind === 'refused') {
      expect(target.reason).toBe('zoom');
      expect(target.minPx).toBe(DROP_TARGET_MIN_SCREEN_PX);
    }
  });

  it('still offers the between-row slot away from any card', () => {
    const scale = (DROP_TARGET_MIN_SCREEN_PX - 1) / DOC_HEIGHT;
    const belowEverything = layout.items[1].y + layout.items[1].height + 10;
    expect(computeDropTarget(layout, 0, belowEverything, scale, null, true).kind).toBe('between');
    // ...and the open space above the first card, for the same reason: neither
    // shrinks with the board.
    expect(computeDropTarget(layout, 0, layout.items[0].y - 10, scale, null, true).kind).toBe(
      'between',
    );
  });

  it('refuses the sliver between two cards under the same gate', () => {
    // The gap scales with the board: at a refusing zoom it is a few pixels
    // wide, and taking it would split pages into a new document — the outcome
    // the card refusal exists to prevent.
    const scale = (DROP_TARGET_MIN_SCREEN_PX - 1) / DOC_HEIGHT;
    const gapY = (layout.items[0].y + layout.items[0].height + layout.items[1].y) / 2;
    expect(computeDropTarget(layout, 0, gapY, scale, null, true).kind).toBe('refused');
    // Above the gate the same point is an ordinary between-row slot.
    expect(computeDropTarget(layout, 0, gapY, 1, null, true).kind).toBe('between');
  });
});
