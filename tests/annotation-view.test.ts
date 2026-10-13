// An annotation under Rotate View. ISO 32000-2 12.5.3 (Table 167 and the
// text after it) defines the NoRotate flag against the page's /Rotate and has
// no rule for a rotation the viewer applies. The view turn is treated as a
// page rotation: a stamp with the flag stays upright with its upper-left
// corner at its place on the page, and every other annotation turns with the
// page as one box.

import { describe, expect, it } from 'vitest';
import type { PageAnnotation } from '../src/renderer/state/types';
import {
  alignEdits, distributeEdits, nudgeDelta, sizeMatchEdits, translated,
} from '../src/renderer/lib/annotation-manipulation';
import type { ResizeHandle } from '../src/renderer/lib/annotation-manipulation';
import {
  annotationStoredBox, annotationViewBox, bodyTurnsWithView, pendingPageRotation, resizedInView, translatedInView,
  turnedFrame, viewGroupFrame,
} from '../src/renderer/lib/annotation-view';
import { pdfRectToDisplay, pdfRectToUprightDisplay } from '../src/renderer/lib/pdfx-build';
import { rotateNormalizedRect } from '../src/renderer/lib/redaction';
import { quarterTurn, stampRasterTurn } from '../src/renderer/lib/stamp-raster';

const { displayFrame, rotateAnnotationRect } = await import('../src/renderer/state/reducer');

const TURNS = [0, 90, 180, 270] as const;
const VIEWS = [90, 180, 270] as const;
const BOX = { x: 0, y: 0, width: 400, height: 600 };
const RECT: [number, number, number, number] = [50, 400, 250, 500];

const near = (box: { x: number; y: number; w: number; h: number }): number[] =>
  [box.x, box.y, box.w, box.h].map((v) => Number(v.toFixed(9)));

/** The page's display size under `rotation`, in points. */
const shown = (rotation: number): { width: number; height: number } => turnedFrame(BOX.width, BOX.height, rotation);

const stamp = (box: { x: number; y: number; w: number; h: number }, noRotate: boolean): PageAnnotation => ({
  id: 's', kind: 'stamp', color: '#000000', note: '', carriedAppearance: '7R', ...box, ...(noRotate ? { noRotate: true as const } : {}),
});

describe('the box of a NoRotate stamp under Rotate View', () => {
  it.each(TURNS.flatMap((file) => VIEWS.map((view) => [file, view] as const)))(
    'page /Rotate %i, view %i: the box a page of that total rotation gives',
    (file, view) => {
      const stored = pdfRectToUprightDisplay(RECT, BOX, file);
      const viewBox = annotationViewBox({ ...stored, noRotate: true }, view, shown(file));
      expect(near(viewBox)).toEqual(near(pdfRectToUprightDisplay(RECT, BOX, file + view)));
      // The size in points is that of /Rect in every view.
      const frame = shown(file + view);
      expect([viewBox.w * frame.width, viewBox.h * frame.height].map((v) => Number(v.toFixed(6)))).toEqual([200, 100]);
      expect(near(annotationStoredBox(viewBox, true, view, shown(file)))).toEqual(near(stored));
    },
  );

  it.each(TURNS.flatMap((pending) => VIEWS.map((view) => [pending, view] as const)))(
    'pending page rotation %i, view %i: the view turn projects as the page rotation does',
    (pending, view) => {
      const imported = stamp(pdfRectToUprightDisplay(RECT, BOX, 0), true);
      const stored = rotateAnnotationRect(imported, pending, displayFrame({ width: BOX.width, height: BOX.height, rotation: 0 }));
      const viewBox = annotationViewBox(stored, view, shown(pending));
      expect(near(viewBox)).toEqual(near(pdfRectToUprightDisplay(RECT, BOX, pending + view)));
    },
  );

  it('falls back to the rigid turn when the page size is unknown', () => {
    const stored = { x: 0.1, y: 0.2, w: 0.3, h: 0.1, noRotate: true };
    expect(annotationViewBox(stored, 90, { width: 0, height: 0 })).toEqual(rotateNormalizedRect(stored, 90));
  });
});

describe('the box of every other annotation under Rotate View', () => {
  it.each(TURNS.flatMap((file) => VIEWS.map((view) => [file, view] as const)))(
    'page /Rotate %i, view %i: the rectangle turned with the page',
    (file, view) => {
      const stored = pdfRectToDisplay(RECT, BOX, file);
      const viewBox = annotationViewBox(stored, view, shown(file));
      expect(near(viewBox)).toEqual(near(pdfRectToDisplay(RECT, BOX, file + view)));
      expect(near(annotationStoredBox(viewBox, false, view, shown(file)))).toEqual(near(stored));
    },
  );

  it('is the stored box with no view turn', () => {
    const stored = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
    expect(annotationViewBox({ ...stored, noRotate: true }, 0, shown(0))).toEqual(stored);
    expect(annotationStoredBox(stored, true, 0, shown(0))).toEqual(stored);
  });
});

describe('body, box and bitmap of a carried stamp agree', () => {
  /** How far the appearance stands turned on the screen: the bitmap's turn in
   *  the body plus the turn of the wrapper around the body. */
  const onScreen = (file: number, pending: number, view: number, noRotate: boolean): number => {
    // The cell is given the page with the view turn composed in.
    const cellRotation = quarterTurn(pending, view);
    const body = stampRasterTurn(file, pendingPageRotation(cellRotation, view), noRotate);
    const wrapper = bodyTurnsWithView({ kind: 'stamp', ...(noRotate ? { noRotate: true as const } : {}) }, view) ? view : 0;
    return quarterTurn(body, wrapper);
  };

  it('a NoRotate stamp is upright for every page rotation and view turn', () => {
    for (const file of [0, 90]) for (const pending of TURNS) for (const view of TURNS) {
      expect([file, pending, view, onScreen(file, pending, view, true)]).toEqual([file, pending, view, 0]);
    }
    expect(VIEWS.map((view) => bodyTurnsWithView({ kind: 'stamp', noRotate: true }, view))).toEqual([false, false, false]);
  });

  it('every other stamp is turned by the page rotation and the view turn, each once', () => {
    for (const file of [0, 90]) for (const pending of TURNS) for (const view of TURNS) {
      expect([file, pending, view, onScreen(file, pending, view, false)]).toEqual([file, pending, view, quarterTurn(file, pending, view)]);
    }
  });

  it('text bodies turn with the view and other kinds do not', () => {
    expect(bodyTurnsWithView({ kind: 'freetext' }, 90)).toBe(true);
    expect(bodyTurnsWithView({ kind: 'stamp' }, 270)).toBe(true);
    expect(bodyTurnsWithView({ kind: 'stamp' }, 0)).toBe(false);
    expect(bodyTurnsWithView({ kind: 'highlight' }, 90)).toBe(false);
  });

  it('takes the view turn out of the rotation a cell shows', () => {
    expect(TURNS.flatMap((pending) => TURNS.map((view) => pendingPageRotation(quarterTurn(pending, view), view))))
      .toEqual(TURNS.flatMap((pending) => TURNS.map(() => pending)));
  });
});

describe('a move of a NoRotate stamp under Rotate View', () => {
  // A stored delta that is far to the right and down in the view.
  const FAR: Record<number, [number, number]> = { 90: [2, -2], 180: [-2, -2], 270: [-2, 2] };

  it.each(VIEWS)('view %i: a far move stops at the page edge in the view or in the stored frame', (view) => {
    const stored = stamp(pdfRectToUprightDisplay([150, 250, 250, 300], BOX, 0), true);
    const frame = shown(0);
    const before = annotationViewBox(stored, view, frame);
    const moved = translatedInView(stored, FAR[view][0], FAR[view][1], view, frame);
    const after = annotationViewBox({ ...stored, x: moved.x, y: moved.y }, view, frame);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
    expect(after.x + after.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(after.y + after.h).toBeLessThanOrEqual(1 + 1e-12);
    expect(moved.x).toBeGreaterThanOrEqual(0);
    expect(moved.y).toBeGreaterThanOrEqual(0);
    expect(moved.x + stored.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(moved.y + stored.h).toBeLessThanOrEqual(1 + 1e-12);
    expect(near(after).slice(2)).toEqual(near(before).slice(2));
    expect([moved.dx, moved.dy].map((v) => Number(v.toFixed(9))))
      .toEqual([moved.x - stored.x, moved.y - stored.y].map((v) => Number(v.toFixed(9))));
  });

  it.each(VIEWS)('view %i: a small move is the same delta in the stored frame', (view) => {
    // A rectangle whose upright box is inside the page in every view.
    const stored = stamp(pdfRectToUprightDisplay([150, 250, 250, 300], BOX, 0), true);
    const moved = translatedInView(stored, 0.01, -0.02, view, shown(0));
    expect([moved.dx, moved.dy].map((v) => Number(v.toFixed(9)))).toEqual([0.01, -0.02]);
  });

  it('moves every other annotation, and any annotation with no view turn, as before', () => {
    const turning = stamp(pdfRectToDisplay(RECT, BOX, 0), false);
    expect(translatedInView(turning, 2, 2, 90, shown(0))).toMatchObject({ x: 1 - turning.w, y: 1 - turning.h });
    const fixed = stamp(pdfRectToUprightDisplay(RECT, BOX, 0), true);
    expect(translatedInView(fixed, 2, 2, 0, shown(0))).toMatchObject({ x: 1 - fixed.w, y: 1 - fixed.h });
  });
});

// A stored box of 0.3 by 0.1 at (0.1, 0.1) on a page of 400 by 600 points.
// Its view box reaches past the right edge at 90 and 180 and past the bottom
// edge at 270.
const EDGE = { x: 0.1, y: 0.1, w: 0.3, h: 0.1 };
const FRAME = shown(0);
/** A view-frame delta as the stored-frame delta a gesture hands over. */
const storedDelta = (view: number, vdx: number, vdy: number): [number, number] =>
  view === 90 ? [vdy, -vdx] : view === 180 ? [-vdx, -vdy] : view === 270 ? [-vdy, vdx] : [vdx, vdy];
const viewOf = (a: PageAnnotation, box: { x: number; y: number; w?: number; h?: number }, view: number) =>
  annotationViewBox({ ...a, ...box }, view, FRAME);
/** The axis on which the view box of EDGE reaches past the page. */
const OUT: Record<number, 'x' | 'y'> = { 90: 'x', 180: 'x', 270: 'y' };

describe('a NoRotate stamp whose view box reaches past the page edge', () => {
  it.each(VIEWS)('view %i: the view box reaches past the edge', (view) => {
    const box = viewOf(stamp(EDGE, true), EDGE, view);
    const far = OUT[view] === 'x' ? box.x + box.w : box.y + box.h;
    expect(far).toBeGreaterThan(1.04);
  });

  it.each(VIEWS)('view %i: a drag inward moves the view box by the delta', (view) => {
    const a = stamp(EDGE, true);
    const before = viewOf(a, EDGE, view);
    const moved = translatedInView(a, ...storedDelta(view, -0.01, -0.02), view, FRAME);
    const after = viewOf(a, moved, view);
    expect(after.x - before.x).toBeCloseTo(-0.01, 12);
    expect(after.y - before.y).toBeCloseTo(-0.02, 12);
    expect(moved.dx).toBeCloseTo(storedDelta(view, -0.01, -0.02)[0], 12);
    expect(moved.dy).toBeCloseTo(storedDelta(view, -0.01, -0.02)[1], 12);
  });

  it.each(VIEWS)('view %i: a drag along the edge keeps the side that is outside where it is', (view) => {
    const a = stamp(EDGE, true);
    const before = viewOf(a, EDGE, view);
    const along: [number, number] = OUT[view] === 'x' ? [0, -0.03] : [-0.03, 0];
    const after = viewOf(a, translatedInView(a, ...storedDelta(view, ...along), view, FRAME), view);
    expect(after.x - before.x).toBeCloseTo(along[0], 12);
    expect(after.y - before.y).toBeCloseTo(along[1], 12);
  });

  it.each(VIEWS)('view %i: a drag outward never moves that side further out', (view) => {
    const a = stamp(EDGE, true);
    const before = viewOf(a, EDGE, view);
    const outward: [number, number] = OUT[view] === 'x' ? [0.05, -0.03] : [-0.03, 0.05];
    const after = viewOf(a, translatedInView(a, ...storedDelta(view, ...outward), view, FRAME), view);
    expect(after[OUT[view]] - before[OUT[view]]).toBeCloseTo(0, 12);
    const other = OUT[view] === 'x' ? 'y' : 'x';
    expect(after[other] - before[other]).toBeCloseTo(-0.03, 12);
  });

  it.each(VIEWS.flatMap((view) => (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const).map((key) => [view, key] as const)))(
    'view %i, %s: an arrow nudge moves by its step or not at all',
    (view, key) => {
      const a = stamp(EDGE, true);
      const before = viewOf(a, EDGE, view);
      const step = nudgeDelta(key, false, BOX.width, BOX.height);
      const moved = translatedInView(a, ...storedDelta(view, step.dx, step.dy), view, FRAME);
      const after = viewOf(a, moved, view);
      // A side at the page edge or past it does not move outward.
      const outward = (key === 'ArrowRight' && before.x + before.w >= 1) || (key === 'ArrowDown' && before.y + before.h >= 1);
      expect(after.x - before.x).toBeCloseTo(outward ? 0 : step.dx, 12);
      expect(after.y - before.y).toBeCloseTo(outward ? 0 : step.dy, 12);
    },
  );

  it.each(VIEWS)('view %i: the stored box ends inside the page after any move', (view) => {
    const a = stamp(EDGE, true);
    const before = viewOf(a, EDGE, view);
    for (const [vdx, vdy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [0.2, -0.3], [-0.45, 0.4]]) {
      const moved = translatedInView(a, ...storedDelta(view, vdx, vdy), view, FRAME);
      expect(moved.x).toBeGreaterThanOrEqual(0);
      expect(moved.y).toBeGreaterThanOrEqual(0);
      expect(moved.x + a.w).toBeLessThanOrEqual(1 + 1e-12);
      expect(moved.y + a.h).toBeLessThanOrEqual(1 + 1e-12);
      const after = viewOf(a, moved, view);
      expect(after.x).toBeGreaterThanOrEqual(Math.min(0, before.x) - 1e-12);
      expect(after.y).toBeGreaterThanOrEqual(Math.min(0, before.y) - 1e-12);
      expect(after.x + after.w).toBeLessThanOrEqual(Math.max(1, before.x + before.w) + 1e-12);
      expect(after.y + after.h).toBeLessThanOrEqual(Math.max(1, before.y + before.h) + 1e-12);
    }
  });

  it('a stored box that is outside the page moves back inside, as that of every annotation does', () => {
    const a = stamp({ x: 0.8, y: 0.1, w: 0.3, h: 0.1 }, true);
    const moved = translatedInView(a, 0, 0.01, 180, FRAME);
    expect(moved.x).toBeCloseTo(0.7, 12);
    expect(moved.y).toBeCloseTo(0.11, 12);
  });

  const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const sides = (handle: ResizeHandle) => ({
    left: handle.includes('w'), right: handle.includes('e'), top: handle.includes('n'), bottom: handle.includes('s'),
  });

  it.each(VIEWS.flatMap((view) => HANDLES.map((handle) => [view, handle] as const)))(
    'view %i, handle %s: a resize moves the dragged sides only',
    (view, handle) => {
      const a = stamp(EDGE, true);
      const before = viewOf(a, EDGE, view);
      const s = sides(handle);
      // Left and top sides go 0.1 outward, right and bottom sides 0.02 inward.
      const px = s.left ? before.x - 0.1 : before.x + before.w - 0.02;
      const py = s.top ? before.y - 0.1 : before.y + before.h - 0.02;
      const after = viewOf(a, resizedInView(a, handle, px, py, false, view, FRAME), view);
      expect(after.x).toBeCloseTo(s.left ? px : before.x, 9);
      expect(after.y).toBeCloseTo(s.top ? py : before.y, 9);
      expect(after.x + after.w).toBeCloseTo(s.right ? px : before.x + before.w, 9);
      expect(after.y + after.h).toBeCloseTo(s.bottom ? py : before.y + before.h, 9);
    },
  );

  it.each(VIEWS)('view %i: the handle of the side that is outside moves inward and never further out', (view) => {
    const a = stamp(EDGE, true);
    const before = viewOf(a, EDGE, view);
    const handle: ResizeHandle = OUT[view] === 'x' ? 'e' : 's';
    const start = OUT[view] === 'x' ? before.x + before.w : before.y + before.h;
    const far = (p: number): number => {
      const r = viewOf(a, resizedInView(a, handle, OUT[view] === 'x' ? p : 0.5, OUT[view] === 'x' ? 0.5 : p, false, view, FRAME), view);
      return OUT[view] === 'x' ? r.x + r.w : r.y + r.h;
    };
    expect(far(start + 0.3)).toBeCloseTo(start, 9);
    expect(far(start - 0.02)).toBeCloseTo(start - 0.02, 9);
    expect(start - 0.02).toBeGreaterThan(1);
  });

  it.each(VIEWS)('view %i: a resize with the aspect kept holds the opposite corner and the aspect', (view) => {
    const a = stamp(EDGE, true);
    const before = viewOf(a, EDGE, view);
    const after = viewOf(a, resizedInView(a, 'nw', before.x - 0.1, before.y - 0.01, true, view, FRAME), view);
    expect(after.x + after.w).toBeCloseTo(before.x + before.w, 9);
    expect(after.y + after.h).toBeCloseTo(before.y + before.h, 9);
    expect(after.w / after.h).toBeCloseTo(before.w / before.h, 9);
    expect(after.w).toBeGreaterThan(before.w);
  });

  it.each(VIEWS.flatMap((view) => HANDLES.map((handle) => [view, handle] as const)))(
    'view %i, handle %s: the stored box ends inside the page after any resize',
    (view, handle) => {
      const a = stamp(EDGE, true);
      const before = viewOf(a, EDGE, view);
      for (const [px, py] of [[-1, -1], [2, 2], [-1, 2], [2, -1], [0.5, 0.5], [0.02, 0.97]]) {
        for (const keep of [false, true]) {
          const r = resizedInView(a, handle, px, py, keep, view, FRAME);
          expect(r.x).toBeGreaterThanOrEqual(-1e-12);
          expect(r.y).toBeGreaterThanOrEqual(-1e-12);
          expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-12);
          expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-12);
          expect(r.w).toBeGreaterThan(0);
          expect(r.h).toBeGreaterThan(0);
          const after = viewOf(a, r, view);
          expect(after.x).toBeGreaterThanOrEqual(Math.min(0, before.x) - 1e-9);
          expect(after.y).toBeGreaterThanOrEqual(Math.min(0, before.y) - 1e-9);
          expect(after.x + after.w).toBeLessThanOrEqual(Math.max(1, before.x + before.w) + 1e-9);
          expect(after.y + after.h).toBeLessThanOrEqual(Math.max(1, before.y + before.h) + 1e-9);
        }
      }
    },
  );
});

describe('every other annotation moves as before under Rotate View', () => {
  const base = { color: '#000000', note: '', x: 0.2, y: 0.3, w: 0.3, h: 0.2 };
  const others: PageAnnotation[] = [
    { id: 'stamp', kind: 'stamp', ...base, carriedAppearance: '7R' },
    { id: 'text', kind: 'freetext', ...base },
    { id: 'note', kind: 'note', ...base },
    { id: 'rect', kind: 'shape', shapeType: 'rect', ...base },
    { id: 'line', kind: 'shape', shapeType: 'line', ...base, points: [0.2, 0.3, 0.5, 0.5] },
    { id: 'ink', kind: 'ink', ...base, strokes: [[0.2, 0.3, 0.5, 0.5], [0.3, 0.4, 0.4, 0.45]] },
    { id: 'measure', kind: 'measure', ...base, points: [0.2, 0.3, 0.5, 0.5] },
    { id: 'callout', kind: 'callout', ...base, points: [0.2, 0.3, 0.3, 0.4], calloutBox: [0.3, 0.35, 0.2, 0.15] },
    { id: 'count', kind: 'count', ...base },
  ];
  const DELTAS: Array<[number, number]> = [[0.01, -0.02], [2, 2], [-2, -2], [0.6, -0.4], [0, 0]];

  it.each(others.map((a) => [a.id, a] as const))('%s: the result is that of the page clamp, value for value', (_id, a) => {
    for (const view of TURNS) for (const [dx, dy] of DELTAS) {
      expect(translatedInView(a, dx, dy, view, FRAME)).toStrictEqual(translated(a, dx, dy));
    }
  });

  it('a NoRotate stamp with no view turn, or with no page size, takes the page clamp', () => {
    const a = stamp(EDGE, true);
    for (const [dx, dy] of DELTAS) {
      expect(translatedInView(a, dx, dy, 0, FRAME)).toStrictEqual(translated(a, dx, dy));
      expect(translatedInView(a, dx, dy, 90, { width: 0, height: 0 })).toStrictEqual(translated(a, dx, dy));
    }
  });
});

describe('align, distribute and size match under Rotate View', () => {
  const P = 'a.pdf#p0';
  const m = (a: PageAnnotation) => ({ annotation: a, pageId: P });
  const dims = new Map([[P, { width: BOX.width, height: BOX.height, rotation: 0 }]]);
  const fixed = (): PageAnnotation => ({ ...stamp({ x: 0.2, y: 0.3, w: 0.3, h: 0.1 }, true), id: 'fixed' });
  const rect = (id: string, box: { x: number; y: number; w: number; h: number }): PageAnnotation =>
    ({ id, kind: 'shape', shapeType: 'rect', color: '#000000', ...box });
  const line = (): PageAnnotation =>
    ({ id: 'line', kind: 'shape', shapeType: 'line', color: '#000000', x: 0.5, y: 0.6, w: 0.2, h: 0.1, points: [0.5, 0.6, 0.7, 0.7] });

  /** The view boxes of the members after `edits`, by id. */
  const after = (members: PageAnnotation[], edits: ReturnType<typeof alignEdits>, view: number) =>
    new Map(members.map((a) => {
      const e = edits.find((x) => x.annotationId === a.id);
      return [a.id, annotationViewBox(e ? { ...a, x: e.x, y: e.y, w: e.w, h: e.h } : a, view, FRAME)] as const;
    }));
  const edge = (b: { x: number; y: number; w: number; h: number }, mode: string): number =>
    mode === 'left' ? b.x : mode === 'right' ? b.x + b.w : mode === 'centerH' ? b.x + b.w / 2
      : mode === 'top' ? b.y : mode === 'bottom' ? b.y + b.h : b.y + b.h / 2;
  const MODES = ['left', 'centerH', 'right', 'top', 'centerV', 'bottom'] as const;

  it('view 0: a NoRotate stamp and a line give the edits of the stored boxes', () => {
    const members = [fixed(), line()].map(m);
    expect(alignEdits(members, 'left')).toStrictEqual([
      { pageId: P, annotationId: 'line', x: 0.2, y: 0.6, w: 0.2, h: 0.1, points: [0.2, 0.6, 0.39999999999999997, 0.7] },
    ]);
    expect(alignEdits(members, 'bottom')).toStrictEqual([
      { pageId: P, annotationId: 'fixed', x: 0.2, y: 0.5999999999999999, w: 0.3, h: 0.1 },
    ]);
    expect(sizeMatchEdits(members, 'both', dims)).toStrictEqual([
      { pageId: P, annotationId: 'line', x: 0.5, y: 0.6, w: 0.3, h: 0.1, points: [0.5, 0.6, 0.7999999999999998, 0.7] },
    ]);
  });

  it('view 0: there is no frame, and the edits are those of a call without one', () => {
    expect(viewGroupFrame(0, FRAME)).toBeUndefined();
    expect(viewGroupFrame(360, FRAME)).toBeUndefined();
    const members = [fixed(), line()].map(m);
    const three = [fixed(), rect('mid', { x: 0.55, y: 0.5, w: 0.1, h: 0.1 }), rect('end', { x: 0.8, y: 0.7, w: 0.1, h: 0.1 })].map(m);
    for (const mode of MODES) {
      expect(alignEdits(members, mode, viewGroupFrame(0, FRAME))).toStrictEqual(alignEdits(members, mode));
    }
    expect(distributeEdits(three, 'horizontal', viewGroupFrame(0, FRAME))).toStrictEqual(distributeEdits(three, 'horizontal'));
    expect(distributeEdits(three, 'horizontal')).toHaveLength(1);
    expect(sizeMatchEdits(members, 'both', dims, viewGroupFrame(0, FRAME))).toStrictEqual(sizeMatchEdits(members, 'both', dims));
  });

  it.each(MODES)('view 90, %s: a NoRotate stamp and a line align on the boxes the view shows', (mode) => {
    const members = [fixed(), line()];
    const before = after(members, [], 90);
    const edits = alignEdits(members.map(m), mode, viewGroupFrame(90, FRAME));
    expect(edits).toHaveLength(mode === 'centerH' || mode === 'centerV' ? 2 : 1);
    const boxes = [...after(members, edits, 90).values()];
    expect(edge(boxes[0], mode)).toBeCloseTo(edge(boxes[1], mode), 9);
    const group = [...before.values()];
    const x0 = Math.min(...group.map((b) => b.x));
    const x1 = Math.max(...group.map((b) => b.x + b.w));
    const y0 = Math.min(...group.map((b) => b.y));
    const y1 = Math.max(...group.map((b) => b.y + b.h));
    expect(edge(boxes[0], mode)).toBeCloseTo(edge({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, mode), 9);
    // The sizes in the view do not change.
    expect(boxes.map((b) => [b.w, b.h].map((v) => Number(v.toFixed(9)))))
      .toEqual(group.map((b) => [b.w, b.h].map((v) => Number(v.toFixed(9)))));
  });

  it('view 90: the points of a moved line travel with its box', () => {
    const [edit] = alignEdits([fixed(), line()].map(m), 'right', viewGroupFrame(90, FRAME));
    expect(edit.annotationId).toBe('line');
    const l = line();
    expect(edit.points!.map((v, i) => Number((v - (i % 2 === 0 ? edit.x : edit.y)).toFixed(9))))
      .toEqual(l.points!.map((v, i) => Number((v - (i % 2 === 0 ? l.x : l.y)).toFixed(9))));
  });

  it.each([90, 180, 270])('view %i: two ordinary annotations align on the boxes the view shows', (view) => {
    const members = [rect('a', { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }), rect('b', { x: 0.5, y: 0.4, w: 0.2, h: 0.2 })];
    const edits = alignEdits(members.map(m), 'left', viewGroupFrame(view, FRAME));
    const boxes = [...after(members, edits, view).values()];
    expect(boxes[0].x).toBeCloseTo(boxes[1].x, 9);
    expect(edits).toHaveLength(1);
  });

  it('view 180: an align on the other axis keeps a side that is outside the page where it is', () => {
    const out: PageAnnotation = { ...stamp(EDGE, true), id: 'out' };
    const members = [out, rect('b', { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })];
    const before = after(members, [], 180);
    const boxes = after(members, alignEdits(members.map(m), 'top', viewGroupFrame(180, FRAME)), 180);
    expect(before.get('out')!.x + before.get('out')!.w).toBeGreaterThan(1.1);
    expect(boxes.get('out')!.x).toBeCloseTo(before.get('out')!.x, 12);
    expect(boxes.get('out')!.y).toBeCloseTo(boxes.get('b')!.y, 9);
  });

  it.each(['horizontal', 'vertical'] as const)('view 90, %s: the gaps the view shows are even', (mode) => {
    const members = [
      rect('first', { x: 0.05, y: 0.85, w: 0.1, h: 0.05 }),
      { ...stamp({ x: 0.3, y: 0.5, w: 0.15, h: 0.06 }, true), id: 'fixed' },
      rect('last', { x: 0.8, y: 0.05, w: 0.1, h: 0.05 }),
    ];
    const edits = distributeEdits(members.map(m), mode, viewGroupFrame(90, FRAME));
    expect(edits.map((e) => e.annotationId)).toEqual(['fixed']);
    const horiz = mode === 'horizontal';
    const boxes = [...after(members, edits, 90).values()]
      .map((b) => (horiz ? [b.x, b.x + b.w] : [b.y, b.y + b.h]))
      .sort((p, q) => p[0] - q[0]);
    expect(boxes[1][0] - boxes[0][1]).toBeCloseTo(boxes[2][0] - boxes[1][1], 9);
    expect(boxes[1][0] - boxes[0][1]).toBeGreaterThan(0);
  });

  it.each(['width', 'height', 'both'] as const)('view 90, %s: a line takes the size the view shows of a NoRotate stamp', (mode) => {
    const members = [fixed(), line()];
    const before = after(members, [], 90);
    const edits = sizeMatchEdits(members.map(m), mode, dims, viewGroupFrame(90, FRAME));
    expect(edits.map((e) => e.annotationId)).toEqual(['line']);
    const boxes = after(members, edits, 90);
    const ref = before.get('fixed')!;
    const was = before.get('line')!;
    const now = boxes.get('line')!;
    expect(now.w).toBeCloseTo(mode === 'height' ? was.w : ref.w, 9);
    expect(now.h).toBeCloseTo(mode === 'width' ? was.h : ref.h, 9);
    expect([now.x, now.y].map((v) => Number(v.toFixed(9)))).toEqual([was.x, was.y].map((v) => Number(v.toFixed(9))));
    // The points fill the new stored box.
    const e = edits[0];
    expect(Math.min(e.points![0], e.points![2])).toBeCloseTo(e.x, 9);
    expect(Math.max(e.points![0], e.points![2])).toBeCloseTo(e.x + e.w, 9);
    expect(Math.min(e.points![1], e.points![3])).toBeCloseTo(e.y, 9);
    expect(Math.max(e.points![1], e.points![3])).toBeCloseTo(e.y + e.h, 9);
  });

  it('view 90: a NoRotate stamp takes the size the view shows of a rectangle and keeps its corner', () => {
    const members = [rect('ref', { x: 0.5, y: 0.6, w: 0.2, h: 0.1 }), fixed()];
    const before = after(members, [], 90);
    const edits = sizeMatchEdits(members.map(m), 'both', dims, viewGroupFrame(90, FRAME));
    expect(edits.map((e) => e.annotationId)).toEqual(['fixed']);
    const now = after(members, edits, 90).get('fixed')!;
    expect([now.w, now.h].map((v) => Number(v.toFixed(9)))).toEqual([before.get('ref')!.w, before.get('ref')!.h].map((v) => Number(v.toFixed(9))));
    expect([now.x, now.y].map((v) => Number(v.toFixed(9)))).toEqual([before.get('fixed')!.x, before.get('fixed')!.y].map((v) => Number(v.toFixed(9))));
    expect([edits[0].x, edits[0].y].map((v) => Number(v.toFixed(9)))).toEqual([0.2, 0.3]);
  });

  it('view 90: members of one size in the view give no size edit', () => {
    const a = rect('a', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const b = rect('b', { x: 0.5, y: 0.5, w: 0.2, h: 0.1 });
    expect(sizeMatchEdits([a, b].map(m), 'both', dims, viewGroupFrame(90, FRAME))).toEqual([]);
  });
});
