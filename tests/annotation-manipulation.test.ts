import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageAnnotation, PageRef } from '../src/renderer/state/types';
import {
  translated,
  translatedBy,
  resized,
  scaledPoints,
  recomputedMeasureNote,
  alignEdits,
  distributeEdits,
  sizeMatchEdits,
  nudgeDelta,
  isTransformable,
  isResizable,
  MIN_SIZE_NORM,
} from '../src/renderer/lib/annotation-manipulation';

function makeFile(path: string, pageCount: number): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount,
    buffer: [1, 2, 3],
    dirty: false,
    undoStack: [],
    redoStack: [],
  };
}

function makePages(path: string, count: number): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${path}#p${i}`,
    sourceDocId: path,
    sourcePageIndex: i,
    rotation: 0 as const,
    width: 300,
    height: 400,
  }));
}

function makeDoc(file: OpenFile, id: string, pages: PageRef[]): OpenDocument {
  return { ...file, id, pages, pageCount: pages.length };
}

function stateWith(files: OpenFile[], documents: OpenDocument[]): AppState {
  return {
    ...initialState,
    files: new Map(files.map((f) => [f.path, f])),
    workspace: { documents },
  };
}

function annot(id: string, over: Partial<PageAnnotation> = {}): PageAnnotation {
  return { id, kind: 'highlight', x: 0.2, y: 0.2, w: 0.2, h: 0.1, color: '#ffd54f', ...over };
}

function stateWithAnnots(annots: PageAnnotation[]): AppState {
  const f = makeFile('a.pdf', 1);
  const pages = makePages('a.pdf', 1);
  pages[0] = { ...pages[0], annotations: annots };
  return stateWith([f], [makeDoc(f, 'a.pdf#0', pages)]);
}

const annotsOf = (s: AppState): PageAnnotation[] =>
  s.workspace.documents[0].pages[0].annotations ?? [];

describe('transformability rules', () => {
  it('text markup never transforms; sticky notes move but never resize', () => {
    expect(isTransformable(annot('m', { kind: 'textmarkup' }))).toBe(false);
    expect(isTransformable(annot('n', { kind: 'note' }))).toBe(true);
    expect(isResizable(annot('n', { kind: 'note' }))).toBe(false);
    expect(isResizable(annot('h'))).toBe(true);
  });
});

describe('translated / translatedBy', () => {
  it('translates the box and its points together', () => {
    const a = annot('i', { kind: 'ink', points: [0.2, 0.2, 0.4, 0.3] });
    const t = translated(a, 0.1, 0.05);
    expect(t.x).toBeCloseTo(0.3);
    expect(t.y).toBeCloseTo(0.25);
    expect(t.points![0]).toBeCloseTo(0.3);
    expect(t.points![3]).toBeCloseTo(0.35);
  });
  it('clamps at the page edge and reports the APPLIED delta', () => {
    const a = annot('h', { x: 0.7, w: 0.2 });
    const t = translated(a, 0.5, 0);
    expect(t.x).toBeCloseTo(0.8); // 1 - w
    expect(t.dx).toBeCloseTo(0.1);
    // A follower clamps individually too.
    const b = translatedBy(annot('b', { x: 0.85, w: 0.1 }), t.dx, 0);
    expect(b.x).toBeCloseTo(0.9);
  });
});

describe('resized', () => {
  const box = annot('h', { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  it('anchors the opposite corner', () => {
    const r = resized(box, 'se', 0.7, 0.75, false);
    expect(r.x).toBeCloseTo(0.4);
    expect(r.y).toBeCloseTo(0.4);
    expect(r.w).toBeCloseTo(0.3);
    expect(r.h).toBeCloseTo(0.35);
    const r2 = resized(box, 'nw', 0.3, 0.35, false);
    expect(r2.x).toBeCloseTo(0.3);
    expect(r2.y).toBeCloseTo(0.35);
    expect(r2.w).toBeCloseTo(0.3);
    expect(r2.h).toBeCloseTo(0.25);
  });
  it('edge handles resize one axis only', () => {
    const r = resized(box, 'e', 0.9, 0.9, false);
    expect(r.y).toBeCloseTo(0.4);
    expect(r.h).toBeCloseTo(0.2);
    expect(r.w).toBeCloseTo(0.5);
  });
  it('a crossed drag pins at the minimum instead of flipping', () => {
    const r = resized(box, 'se', 0.1, 0.1, false);
    expect(r.w).toBeCloseTo(MIN_SIZE_NORM);
    expect(r.h).toBeCloseTo(MIN_SIZE_NORM);
    expect(r.x).toBeCloseTo(0.4);
  });
  it('aspect lock scales both axes by the dominant factor', () => {
    const r = resized(box, 'se', 0.8, 0.65, true); // fw=2, fh=1.25 → f=2
    expect(r.w).toBeCloseTo(0.4);
    expect(r.h).toBeCloseTo(0.4);
    expect(r.x).toBeCloseTo(0.4);
    expect(r.y).toBeCloseTo(0.4);
  });
  it('scales points into the new box; a flat axis translates instead', () => {
    const ink = annot('i', { kind: 'ink', x: 0.2, y: 0.5, w: 0.4, h: 0, points: [0.2, 0.5, 0.6, 0.5] });
    const pts = scaledPoints(ink, { x: 0.1, y: 0.6, w: 0.2, h: 0 });
    expect(pts[0]).toBeCloseTo(0.1);
    expect(pts[2]).toBeCloseTo(0.3);
    expect(pts[1]).toBeCloseTo(0.6);
  });
});

describe('recomputedMeasureNote', () => {
  const meas = annot('m', {
    kind: 'measure',
    measureKind: 'distance',
    measureUnitsPerPt: 0.1,
    measureUnit: 'ft',
    points: [0, 0, 1, 0],
  });
  it('recomputes distance from the captured factor against page dims', () => {
    // 1.0 normalized across a 300pt-wide page = 300pt → ×0.1 = 30 ft.
    expect(recomputedMeasureNote(meas, [0, 0, 1, 0], 300, 400, 0)).toBe('30 ft');
  });
  it('swaps dims at a 90° rotation', () => {
    // Width axis now spans the 400pt dimension.
    expect(recomputedMeasureNote(meas, [0, 0, 1, 0], 300, 400, 90)).toBe('40 ft');
  });
  it('area reports area and perimeter, both from the captured factor', () => {
    const area = annot('a', {
      kind: 'measure',
      measureKind: 'area',
      measureUnitsPerPt: 0.01,
      measureUnit: 'm',
      points: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0],
    });
    // 300×400pt rect: area 120000 pt² ×0.0001 = 12 sq m; perimeter 1400pt ×0.01 = 14 m.
    expect(recomputedMeasureNote(area, area.points!, 300, 400, 0)).toBe('12 sq m · perimeter 14 m');
  });
  it('returns undefined for non-measure kinds', () => {
    expect(recomputedMeasureNote(annot('h'), [0, 0, 1, 1], 300, 400, 0)).toBeUndefined();
  });
});

describe('alignEdits / distributeEdits / sizeMatchEdits', () => {
  const P = 'a.pdf#p0';
  const m = (a: PageAnnotation) => ({ annotation: a, pageId: P });
  it('aligns to the group bounding box', () => {
    const a = annot('a', { x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
    const b = annot('b', { x: 0.5, y: 0.4, w: 0.2, h: 0.2 });
    const left = alignEdits([m(a), m(b)], 'left');
    expect(left).toHaveLength(1); // a is already at the left edge
    expect(left[0].annotationId).toBe('b');
    expect(left[0].x).toBeCloseTo(0.1);
    const bottom = alignEdits([m(a), m(b)], 'bottom');
    expect(bottom[0].annotationId).toBe('a');
    expect(bottom[0].y).toBeCloseTo(0.5);
  });
  it('excludes text markup and needs two movable members', () => {
    const a = annot('a');
    const t = annot('t', { kind: 'textmarkup', x: 0.6 });
    expect(alignEdits([m(a), m(t)], 'left')).toHaveLength(0);
  });
  it('distributes even gaps, first and last pinned', () => {
    const a = annot('a', { x: 0.0, w: 0.1 });
    const b = annot('b', { x: 0.15, w: 0.1 });
    const c = annot('c', { x: 0.6, w: 0.1 });
    const edits = distributeEdits([m(a), m(b), m(c)], 'horizontal');
    expect(edits).toHaveLength(1);
    expect(edits[0].annotationId).toBe('b');
    expect(edits[0].x).toBeCloseTo(0.3); // gaps: (0.7-0.3)/2 = 0.2 each
  });
  it('matches sizes to the first-selected member', () => {
    const ref = annot('r', { w: 0.3, h: 0.3 });
    const b = annot('b', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 });
    const dims = new Map([[P, { width: 300, height: 400, rotation: 0 }]]);
    const edits = sizeMatchEdits([m(ref), m(b)], 'both', dims);
    expect(edits).toHaveLength(1);
    expect(edits[0].w).toBeCloseTo(0.3);
    expect(edits[0].h).toBeCloseTo(0.3);
  });
});

describe('nudgeDelta', () => {
  it('is one point (ten with shift) in normalized page units', () => {
    expect(nudgeDelta('ArrowRight', false, 300, 400).dx).toBeCloseTo(1 / 300);
    expect(nudgeDelta('ArrowDown', true, 300, 400).dy).toBeCloseTo(10 / 400);
    expect(nudgeDelta('ArrowLeft', false, 300, 400).dx).toBeCloseTo(-1 / 300);
  });
});

describe('TRANSFORM_ANNOTATIONS', () => {
  it('applies geometry as one undo step and marks the file dirty', () => {
    const s0 = stateWithAnnots([annot('h'), annot('i', { kind: 'ink', x: 0.5, y: 0.5, w: 0.2, h: 0.1, points: [0.5, 0.5, 0.7, 0.6] })]);
    const s1 = appReducer(s0, {
      type: 'TRANSFORM_ANNOTATIONS',
      docId: 'a.pdf#0',
      edits: [
        { pageId: 'a.pdf#p0', annotationId: 'h', x: 0.3, y: 0.3, w: 0.25, h: 0.15 },
        { pageId: 'a.pdf#p0', annotationId: 'i', x: 0.6, y: 0.6, w: 0.2, h: 0.1, points: [0.6, 0.6, 0.8, 0.7] },
      ],
    });
    const [h, i] = annotsOf(s1);
    expect(h).toMatchObject({ x: 0.3, y: 0.3, w: 0.25, h: 0.15 });
    expect(i.points).toEqual([0.6, 0.6, 0.8, 0.7]);
    expect(s1.pageUndoStack).toHaveLength(1);
    expect(s1.pageDirtyPaths).toContain('a.pdf');
    // One undo restores BOTH.
    const undone = appReducer(s1, { type: 'UNDO_PAGE_OP' });
    expect(annotsOf(undone)[0].x).toBeCloseTo(0.2);
    expect(annotsOf(undone)[1].points).toEqual([0.5, 0.5, 0.7, 0.6]);
  });
  it('refuses textmarkup transforms and freezes note icon size', () => {
    const s0 = stateWithAnnots([
      annot('t', { kind: 'textmarkup', quads: [0.2, 0.2, 0.4, 0.25] }),
      annot('n', { kind: 'note', w: 0.05, h: 0.04 }),
    ]);
    const s1 = appReducer(s0, {
      type: 'TRANSFORM_ANNOTATIONS',
      docId: 'a.pdf#0',
      edits: [
        { pageId: 'a.pdf#p0', annotationId: 't', x: 0.6, y: 0.6, w: 0.2, h: 0.1 },
        { pageId: 'a.pdf#p0', annotationId: 'n', x: 0.6, y: 0.6, w: 0.3, h: 0.3 },
      ],
    });
    const [t, n] = annotsOf(s1);
    expect(t.x).toBeCloseTo(0.2); // untouched
    expect(n.x).toBeCloseTo(0.6); // moved…
    expect(n.w).toBeCloseTo(0.05); // …but the icon size held
    // The textmarkup no-op did not create an undo entry by itself — the note
    // move did; one entry total.
    expect(s1.pageUndoStack).toHaveLength(1);
  });
  it('updates a measure note and flags a moved import as geometry-diverged', () => {
    const s0 = stateWithAnnots([
      annot('m', { kind: 'measure', points: [0.2, 0.2, 0.4, 0.2], note: '10 ft', measureUnitsPerPt: 0.1, measureUnit: 'ft', measureKind: 'distance' }),
      annot('imp', {
        importedOriginal: { subtype: 'Square', rect: [10, 10, 50, 50], contents: '', color: '#ffd54f', hasAppearance: true },
      }),
    ]);
    const s1 = appReducer(s0, {
      type: 'TRANSFORM_ANNOTATIONS',
      docId: 'a.pdf#0',
      edits: [
        { pageId: 'a.pdf#p0', annotationId: 'm', x: 0.2, y: 0.2, w: 0.4, h: 0, points: [0.2, 0.2, 0.6, 0.2], note: '20 ft' },
        { pageId: 'a.pdf#p0', annotationId: 'imp', x: 0.4, y: 0.4, w: 0.2, h: 0.1 },
      ],
    });
    const [mm, imp] = annotsOf(s1);
    expect(mm.note).toBe('20 ft');
    expect(imp.geometryDiverged).toBe(true);
    // The fingerprint itself is untouched (the commit-time strip matches on it).
    expect(imp.importedOriginal!.rect).toEqual([10, 10, 50, 50]);
  });
  it('is a no-op state when nothing changes', () => {
    const s0 = stateWithAnnots([annot('h')]);
    const s1 = appReducer(s0, {
      type: 'TRANSFORM_ANNOTATIONS',
      docId: 'a.pdf#0',
      edits: [{ pageId: 'a.pdf#p0', annotationId: 'h', x: 0.2, y: 0.2, w: 0.2, h: 0.1 }],
    });
    expect(s1).toBe(s0);
  });
});

describe('REORDER_ANNOTATIONS', () => {
  const ids = (s: AppState): string[] => annotsOf(s).map((a) => a.id);
  const s0 = stateWithAnnots([annot('a'), annot('b'), annot('c'), annot('d')]);
  it('front/back move the group to the ends, keeping internal order', () => {
    const front = appReducer(s0, {
      type: 'REORDER_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['a', 'b'],
      direction: 'front',
    });
    expect(ids(front)).toEqual(['c', 'd', 'a', 'b']);
    const back = appReducer(s0, {
      type: 'REORDER_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['c', 'd'],
      direction: 'back',
    });
    expect(ids(back)).toEqual(['c', 'd', 'a', 'b']);
  });
  it('forward/backward step over one unselected neighbour; at the end they no-op', () => {
    const fwd = appReducer(s0, {
      type: 'REORDER_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['b'],
      direction: 'forward',
    });
    expect(ids(fwd)).toEqual(['a', 'c', 'b', 'd']);
    const bwd = appReducer(s0, {
      type: 'REORDER_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['b'],
      direction: 'backward',
    });
    expect(ids(bwd)).toEqual(['b', 'a', 'c', 'd']);
    const stuck = appReducer(s0, {
      type: 'REORDER_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['d'],
      direction: 'forward',
    });
    expect(stuck).toBe(s0);
  });
});

describe('RECOLOR_ANNOTATIONS / REMOVE_ANNOTATIONS', () => {
  it('recolors the group in one undo step', () => {
    const s0 = stateWithAnnots([annot('a'), annot('b'), annot('c', { color: '#123456' })]);
    const s1 = appReducer(s0, {
      type: 'RECOLOR_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['a', 'c'],
      color: '#ff0000',
    });
    expect(annotsOf(s1).map((a) => a.color)).toEqual(['#ff0000', '#ffd54f', '#ff0000']);
    expect(s1.pageUndoStack).toHaveLength(1);
  });
  it('removes the group in one undo step, keeping import tombstones', () => {
    const s0 = stateWithAnnots([
      annot('a'),
      annot('imp', {
        importedOriginal: { subtype: 'Square', rect: [1, 2, 3, 4], contents: 'x', color: '#ffd54f', hasAppearance: true },
      }),
      annot('keep'),
    ]);
    const s1 = appReducer(s0, {
      type: 'REMOVE_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['a', 'imp'],
    });
    expect(annotsOf(s1).map((a) => a.id)).toEqual(['keep']);
    expect(s1.workspace.documents[0].pages[0].removedImportedOriginals).toHaveLength(1);
    const undone = appReducer(s1, { type: 'UNDO_PAGE_OP' });
    expect(annotsOf(undone).map((a) => a.id)).toEqual(['a', 'imp', 'keep']);
  });
});
