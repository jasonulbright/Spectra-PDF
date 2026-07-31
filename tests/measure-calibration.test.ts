// Rung 3 — scale calibration: the ratio derived from a known length, and the
// per-measurement override (RECALIBRATE_ANNOTATION).
import { describe, expect, it } from 'vitest';
import { scaleFromCalibration, measureRatioLabel, measureUnitsPerPoint } from '../src/renderer/lib/measure';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageAnnotation, PageRef } from '../src/renderer/state/types';

describe('scaleFromCalibration', () => {
  it('derives "1 in = X unit" from a dragged span', () => {
    // 144 pt = 2 in; the user says it is 10 ft → 1 in = 5 ft.
    const s = scaleFromCalibration(144, 10, 'ft');
    expect(s).toEqual({ from: 1, fromUnit: 'in', to: 5, toUnit: 'ft' });
    expect(measureRatioLabel(s)).toBe('1 in = 5 ft');
    // One point then reads as 5/72 ft.
    expect(measureUnitsPerPoint(s)).toBeCloseTo(5 / 72, 10);
  });
  it('degenerate inputs fall back to 1:1', () => {
    expect(scaleFromCalibration(0, 10, 'm').to).toBe(1);
    expect(scaleFromCalibration(100, 0, 'm').to).toBe(1);
  });
});

function stateWith(annots: PageAnnotation[]): AppState {
  const f: OpenFile = {
    path: 'a.pdf',
    workingPath: 'a.pdf.working',
    name: 'a.pdf',
    pageCount: 1,
    buffer: [1],
    dirty: false,
    undoStack: [],
    redoStack: [],
  };
  const pages: PageRef[] = [
    { id: 'p0', sourceDocId: 'a.pdf', sourcePageIndex: 0, rotation: 0, width: 300, height: 400, annotations: annots },
  ];
  const doc: OpenDocument = { ...f, id: 'd0', pages, pageCount: 1 };
  return { ...initialState, files: new Map([[f.path, f]]), workspace: { documents: [doc] } };
}

describe('RECALIBRATE_ANNOTATION', () => {
  const meas: PageAnnotation = {
    id: 'm',
    kind: 'measure',
    measureKind: 'distance',
    measureUnitsPerPt: 0.1,
    measureUnit: 'ft',
    measureRatio: '1 in = 7.2 ft',
    x: 0,
    y: 0.5,
    w: 1,
    h: 0,
    color: '#f59e0b',
    points: [0, 0.5, 1, 0.5],
    note: '30 ft',
  };
  it('rewrites factors + ratio + note in one undo step; geometry untouched', () => {
    const s0 = stateWith([meas]);
    const s1 = appReducer(s0, {
      type: 'RECALIBRATE_ANNOTATION',
      docId: 'd0',
      pageId: 'p0',
      annotationId: 'm',
      measureUnitsPerPt: 0.05,
      measureUnit: 'm',
      measureRatio: '1 in = 3.6 m',
      note: '15 m',
    });
    const a = s1.workspace.documents[0].pages[0].annotations![0];
    expect(a.measureUnitsPerPt).toBe(0.05);
    expect(a.measureUnit).toBe('m');
    expect(a.measureRatio).toBe('1 in = 3.6 m');
    expect(a.note).toBe('15 m');
    expect(a.points).toEqual(meas.points);
    expect(s1.pageUndoStack).toHaveLength(1);
    const undone = appReducer(s1, { type: 'UNDO_PAGE_OP' });
    expect(undone.workspace.documents[0].pages[0].annotations![0].note).toBe('30 ft');
  });
  it('refuses non-measure targets and no-ops identical values', () => {
    const s0 = stateWith([{ ...meas, id: 'h', kind: 'highlight' }]);
    const s1 = appReducer(s0, {
      type: 'RECALIBRATE_ANNOTATION',
      docId: 'd0',
      pageId: 'p0',
      annotationId: 'h',
      measureUnitsPerPt: 0.05,
      measureUnit: 'm',
      measureRatio: 'x',
      note: 'y',
    });
    expect(s1).toBe(s0);
    const s2 = stateWith([meas]);
    const s3 = appReducer(s2, {
      type: 'RECALIBRATE_ANNOTATION',
      docId: 'd0',
      pageId: 'p0',
      annotationId: 'm',
      measureUnitsPerPt: 0.1,
      measureUnit: 'ft',
      measureRatio: '1 in = 7.2 ft',
      note: '30 ft',
    });
    expect(s3).toBe(s2);
  });
});
