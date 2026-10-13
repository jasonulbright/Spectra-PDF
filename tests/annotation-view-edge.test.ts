// A NoRotate stamp under Rotate View whose stored box or view box meets the
// page edge: a resize stops each axis on its own, a move keeps a view box
// that is longer than the page over the page, and the resize handles stand on
// the part of the box the cell shows.

import { describe, expect, it } from 'vitest';
import type { PageAnnotation } from '../src/renderer/state/types';
import type { ResizeHandle } from '../src/renderer/lib/annotation-manipulation';
import {
  annotationViewBox, handleInsets, resizedInView, translatedInView, turnedFrame, viewTravel,
} from '../src/renderer/lib/annotation-view';

const VIEWS = [90, 180, 270] as const;
const FRAME = turnedFrame(400, 600, 0);

type Box = { x: number; y: number; w: number; h: number };

const stamp = (box: Box): PageAnnotation => ({
  id: 's', kind: 'stamp', color: '#000000', note: '', carriedAppearance: '7R', noRotate: true, ...box,
});
const viewOf = (box: Box, view: number): Box => annotationViewBox({ ...box, noRotate: true }, view, FRAME);
const storedDelta = (view: number, vdx: number, vdy: number): [number, number] =>
  view === 90 ? [vdy, -vdx] : view === 180 ? [-vdx, -vdy] : view === 270 ? [-vdy, vdx] : [vdx, vdy];

const CORNERS: ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];
const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const sides = (handle: ResizeHandle) => ({
  left: handle.includes('w'), right: handle.includes('e'), top: handle.includes('n'), bottom: handle.includes('s'),
});

describe('a resize of a NoRotate stamp whose stored side is at the page edge', () => {
  // The stored bottom side is at the page edge. At view 90 the view box is
  // [0.5, 0.7] by [0.1, 0.85]; its height is the stored height.
  const FLUSH = { x: 0.1, y: 0.5, w: 0.3, h: 0.5 };

  it('view 90: a corner drag that would move that side out still moves the other axis', () => {
    const before = viewOf(FLUSH, 90);
    expect([before.x, before.y, before.w, before.h].map((v) => Number(v.toFixed(9)))).toEqual([0.5, 0.1, 0.2, 0.75]);
    const stored = resizedInView({ ...FLUSH, noRotate: true }, 'se', 0.9, 0.95, false, 90, FRAME);
    const after = viewOf(stored, 90);
    // The width follows the pointer. The height would move the stored bottom
    // side off the page, and stays.
    expect(after.x).toBeCloseTo(0.5, 9);
    expect(after.w).toBeCloseTo(0.4, 9);
    expect(after.y).toBeCloseTo(0.1, 9);
    expect(after.h).toBeCloseTo(0.75, 9);
    expect(stored.y + stored.h).toBeLessThanOrEqual(1 + 1e-12);
  });

  it('view 90: the same drag with the aspect kept stops as a whole', () => {
    const before = viewOf(FLUSH, 90);
    const after = viewOf(resizedInView({ ...FLUSH, noRotate: true }, 'se', 0.9, 0.95, true, 90, FRAME), 90);
    expect(after.w / after.h).toBeCloseTo(before.w / before.h, 9);
    expect(after.h).toBeCloseTo(before.h, 9);
  });

  // One stored side at the page edge for each view; the other sides have room.
  const AT_EDGE: Box[] = [
    { x: 0.1, y: 0.5, w: 0.3, h: 0.5 },
    { x: 0.7, y: 0.3, w: 0.3, h: 0.2 },
    { x: 0, y: 0.4, w: 0.3, h: 0.2 },
    { x: 0.3, y: 0, w: 0.3, h: 0.2 },
  ];

  it.each(VIEWS.flatMap((view) => AT_EDGE.flatMap((box, index) => CORNERS.map((handle) => [view, index, handle] as const))))(
    'view %i, box %i, handle %s: an axis that moves on its own moves in a corner drag',
    (view, index, handle) => {
      const box = AT_EDGE[index];
      const a = { ...box, noRotate: true };
      const before = viewOf(box, view);
      const s = sides(handle);
      // Each dragged side goes 0.04 outward.
      const px = s.left ? before.x - 0.04 : before.x + before.w + 0.04;
      const py = s.top ? before.y - 0.04 : before.y + before.h + 0.04;
      const alongX = viewOf(resizedInView(a, s.left ? 'w' : 'e', px, py, false, view, FRAME), view);
      const alongY = viewOf(resizedInView(a, s.top ? 'n' : 's', px, py, false, view, FRAME), view);
      const stored = resizedInView(a, handle, px, py, false, view, FRAME);
      const corner = viewOf(stored, view);
      // An axis whose own drag is free is not held by the other axis.
      const freeX = Math.abs(alongX.x - before.x) + Math.abs(alongX.w - before.w) > 1e-6;
      const freeY = Math.abs(alongY.y - before.y) + Math.abs(alongY.h - before.h) > 1e-6;
      const movedX = Math.abs(corner.x - before.x) + Math.abs(corner.w - before.w) > 1e-6;
      const movedY = Math.abs(corner.y - before.y) + Math.abs(corner.h - before.h) > 1e-6;
      if (freeX) expect(movedX).toBe(true);
      if (freeY) expect(movedY).toBe(true);
      // The sides the handle does not move stay.
      if (!s.left) expect(corner.x).toBeCloseTo(before.x, 9);
      if (!s.right) expect(corner.x + corner.w).toBeCloseTo(before.x + before.w, 9);
      if (!s.top) expect(corner.y).toBeCloseTo(before.y, 9);
      if (!s.bottom) expect(corner.y + corner.h).toBeCloseTo(before.y + before.h, 9);
      // The stored box is on the page.
      expect(stored.x).toBeGreaterThanOrEqual(-1e-12);
      expect(stored.y).toBeGreaterThanOrEqual(-1e-12);
      expect(stored.x + stored.w).toBeLessThanOrEqual(1 + 1e-12);
      expect(stored.y + stored.h).toBeLessThanOrEqual(1 + 1e-12);
    },
  );

  it.each(VIEWS.flatMap((view) => AT_EDGE.flatMap((_, index) => HANDLES.map((handle) => [view, index, handle] as const))))(
    'view %i, box %i, handle %s: far drags leave the stored box on the page and the other sides in place',
    (view, index, handle) => {
      const box = AT_EDGE[index];
      const before = viewOf(box, view);
      const s = sides(handle);
      for (const [px, py] of [[-1, -1], [2, 2], [-1, 2], [2, -1], [0.5, 0.5], [0.02, 0.97]]) {
        for (const keep of [false, true]) {
          const stored = resizedInView({ ...box, noRotate: true }, handle, px, py, keep, view, FRAME);
          expect(stored.x).toBeGreaterThanOrEqual(-1e-12);
          expect(stored.y).toBeGreaterThanOrEqual(-1e-12);
          expect(stored.x + stored.w).toBeLessThanOrEqual(1 + 1e-12);
          expect(stored.y + stored.h).toBeLessThanOrEqual(1 + 1e-12);
          expect(stored.w).toBeGreaterThan(0);
          expect(stored.h).toBeGreaterThan(0);
          if (keep) continue;
          const after = viewOf(stored, view);
          if (!s.left && !s.right) expect([after.x, after.w].map((v) => Number(v.toFixed(9)))).toEqual([before.x, before.w].map((v) => Number(v.toFixed(9))));
          if (!s.top && !s.bottom) expect([after.y, after.h].map((v) => Number(v.toFixed(9)))).toEqual([before.y, before.h].map((v) => Number(v.toFixed(9))));
        }
      }
    },
  );

  it('a drag inside the page is the drag, value for value', () => {
    const box = { x: 0.4, y: 0.4, w: 0.15, h: 0.1 };
    for (const view of VIEWS) {
      const before = viewOf(box, view);
      const after = viewOf(resizedInView({ ...box, noRotate: true }, 'se', before.x + before.w + 0.02, before.y + before.h + 0.03, false, view, FRAME), view);
      expect(after.x).toBeCloseTo(before.x, 12);
      expect(after.y).toBeCloseTo(before.y, 12);
      expect(after.w).toBeCloseTo(before.w + 0.02, 12);
      expect(after.h).toBeCloseTo(before.h + 0.03, 12);
    }
  });
});

describe('where a view box may start after a move', () => {
  it('a box no longer than the page stays on the page, and a side that is outside moves inward only', () => {
    expect(viewTravel(0.2, 0.3)).toEqual([0, 0.7]);
    expect(viewTravel(-0.1, 0.3)).toEqual([-0.1, 0.7]);
    expect(viewTravel(0.8, 0.3)).toEqual([0, 0.8]);
    expect(viewTravel(0, 1)).toEqual([0, 0]);
  });

  it('a box longer than the page keeps the page covered', () => {
    const [low, high] = viewTravel(-0.1, 1.2);
    expect(low).toBeCloseTo(-0.2, 12);
    expect(high).toBe(0);
    // Each side may go as far out as the other side has to come in.
    for (const start of [low, -0.15, -0.05, high]) {
      expect(start).toBeLessThanOrEqual(0);
      expect(start + 1.2).toBeGreaterThanOrEqual(1 - 1e-12);
    }
  });

  it('a box longer than the page that does not cover it moves toward the page only', () => {
    const [low, high] = viewTravel(0.1, 1.2);
    expect(low).toBeCloseTo(-0.2, 12);
    expect(high).toBe(0.1);
    const [farLow, farHigh] = viewTravel(-0.5, 1.2);
    expect(farLow).toBe(-0.5);
    expect(farHigh).toBe(0);
  });

  // A stored corner left of the page puts the view box at view 90 past the
  // top and the bottom edge: it spans -0.1 to 1.1 on the view's y axis.
  const BOTH = { x: -0.1, y: 0.1, w: 0.2, h: 0.8 };

  it.each([-0.05, 0.05, 0])('view 90, step %f: a move along the axis that reaches past both edges keeps the page covered', (step) => {
    const before = viewOf(BOTH, 90);
    expect(before.y).toBeLessThan(0);
    expect(before.y + before.h).toBeGreaterThan(1);
    const moved = translatedInView(stamp(BOTH), ...storedDelta(90, 0, step), 90, FRAME);
    const after = viewOf({ ...BOTH, x: moved.x, y: moved.y }, 90);
    expect(after.y).toBeLessThanOrEqual(1e-12);
    expect(after.y + after.h).toBeGreaterThanOrEqual(1 - 1e-12);
    // The stored box takes the page clamp of every move.
    expect(moved.x).toBe(0);
    expect(moved.y).toBeCloseTo(BOTH.y, 12);
  });

  it('view 90: a move on the other axis is the delta', () => {
    const before = viewOf(BOTH, 90);
    const moved = translatedInView(stamp(BOTH), ...storedDelta(90, -0.03, 0), 90, FRAME);
    const after = viewOf({ ...BOTH, x: moved.x, y: moved.y }, 90);
    expect(after.x - before.x).toBeCloseTo(-0.03, 12);
  });

  it('view 270: the page clamp of the stored box decides where a stored corner right of the page lands', () => {
    // The view box spans -0.1 to 1.1 on the view's y axis. The stored box
    // goes back onto the page, which puts the view corner inside the page.
    const box = { x: 1.1, y: 0.1, w: 0.2, h: 0.8 };
    const before = viewOf(box, 270);
    expect(before.y).toBeLessThan(0);
    expect(before.y + before.h).toBeGreaterThan(1);
    for (const step of [-0.05, 0.05]) {
      const moved = translatedInView(stamp(box), ...storedDelta(270, 0, step), 270, FRAME);
      expect(moved.x).toBeCloseTo(0.8, 12);
      expect(moved.y).toBeCloseTo(0.1, 12);
    }
  });
});

describe('where the resize handles of a view box stand', () => {
  it('a box on the page has its handles on its own sides', () => {
    expect(handleInsets({ x: 0.1, y: 0.2, w: 0.3, h: 0.1 })).toBeUndefined();
    expect(handleInsets({ x: 0, y: 0, w: 1, h: 1 })).toBeUndefined();
  });

  it('a box that reaches past an edge has them on its part on the page', () => {
    const right = handleInsets({ x: 0.8, y: 0.2, w: 0.4, h: 0.1 })!;
    expect([right.left, right.top, right.right, right.bottom].map((v) => Number(v.toFixed(9)))).toEqual([0, 0, 0.5, 0]);
    const corner = handleInsets({ x: -0.1, y: 0.9, w: 0.4, h: 0.4 })!;
    expect([corner.left, corner.top, corner.right, corner.bottom].map((v) => Number(v.toFixed(9)))).toEqual([0.25, 0, 0, 0.75]);
    const both = handleInsets({ x: -0.1, y: 0.2, w: 1.2, h: 0.1 })!;
    expect(both.left).toBeCloseTo(0.1 / 1.2, 12);
    expect(both.right).toBeCloseTo(0.1 / 1.2, 12);
  });

  it('the frame is the page part of the box', () => {
    for (const box of [{ x: 0.8, y: 0.2, w: 0.4, h: 0.1 }, { x: -0.1, y: 0.9, w: 0.4, h: 0.4 }, { x: -0.3, y: -0.2, w: 1.5, h: 0.5 }]) {
      const insets = handleInsets(box)!;
      const left = box.x + insets.left * box.w;
      const top = box.y + insets.top * box.h;
      const right = box.x + box.w - insets.right * box.w;
      const bottom = box.y + box.h - insets.bottom * box.h;
      expect([left, top, right, bottom].map((v) => Number(v.toFixed(9))))
        .toEqual([Math.max(0, box.x), Math.max(0, box.y), Math.min(1, box.x + box.w), Math.min(1, box.y + box.h)].map((v) => Number(v.toFixed(9))));
    }
  });

  it('a box with no part on the page, or with no area, has none', () => {
    expect(handleInsets({ x: 1.1, y: 0.2, w: 0.3, h: 0.1 })).toBeUndefined();
    expect(handleInsets({ x: 0.2, y: -0.4, w: 0.3, h: 0.3 })).toBeUndefined();
    expect(handleInsets({ x: 0.2, y: 0.2, w: 0, h: 0.3 })).toBeUndefined();
  });

  it.each(VIEWS)('view %i: the handle at the page edge moves the side that is outside inward', (view) => {
    // The view box of this stored box reaches past the right or the bottom
    // edge. The handle of that side stands at the page edge; a press there
    // and a drag inward puts the side at the pointer.
    const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.1 };
    const before = viewOf(box, view);
    const overX = before.x + before.w > 1;
    const insets = handleInsets(before)!;
    expect(overX ? insets.right : insets.bottom).toBeGreaterThan(0);
    const handle: ResizeHandle = overX ? 'e' : 's';
    const after = viewOf(resizedInView({ ...box, noRotate: true }, handle, overX ? 0.97 : 0.5, overX ? 0.5 : 0.97, false, view, FRAME), view);
    expect(overX ? after.x + after.w : after.y + after.h).toBeCloseTo(0.97, 9);
  });
});
