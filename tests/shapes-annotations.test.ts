// Rung 2 — drawing shapes + callouts: real-subtype emits through the commit
// rebuild, the raw-style sidecar round-trip, the faithful-or-untouched
// import gates, the RESTYLE reducer rules, and the vertex-edit geometry.
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';

import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';
import { readRawAnnotationStyles } from '../src/renderer/lib/annotation-raw-style';
import { importPageAnnotations } from '../src/renderer/lib/annotation-import';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageAnnotation, PageRef } from '../src/renderer/state/types';
import {
  vertexDragged,
  cloudBumps,
  scaledCalloutBox,
  hasVertexHandles,
} from '../src/renderer/lib/annotation-manipulation';

async function sourceBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  return doc.save();
}

function annotBySubtype(doc: PDFDocument, subtype: string): PDFDict | null {
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return null;
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookupMaybe(i, PDFDict);
    if (a && String(a.lookup(PDFName.of('Subtype'))) === `/${subtype}`) return a;
  }
  return null;
}

const num = (v: unknown): number => (v instanceof PDFNumber ? v.asNumber() : NaN);
const text = (v: unknown): string =>
  v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : String(v);

function shape(over: Partial<PageAnnotation>): PageAnnotation {
  return {
    id: 's1',
    kind: 'shape',
    shapeType: 'rect',
    x: 0.2,
    y: 0.2,
    w: 0.4,
    h: 0.3,
    color: '#e0393e',
    strokeWidth: 2,
    ...over,
  } as PageAnnotation;
}

async function emit(annotations: PageAnnotation[]): Promise<PDFDocument> {
  const page: ExportPage = {
    bytes: await sourceBytes(),
    sourceKey: 'src',
    pageIndex: 0,
    annotations: annotations as ExportPage['annotations'],
  };
  return PDFDocument.load(await buildPdf([page], undefined, 'src'));
}

describe('shape emits (real subtypes)', () => {
  it('rect → /Square with /BS /IC /CA', async () => {
    const out = await emit([
      shape({ shapeType: 'rect', fillColor: '#4fc3f7', opacity: 0.5, strokeWidth: 4 }),
    ]);
    const sq = annotBySubtype(out, 'Square');
    expect(sq).not.toBeNull();
    expect(num(sq!.lookupMaybe(PDFName.of('BS'), PDFDict)!.lookup(PDFName.of('W')))).toBe(4);
    expect(sq!.lookupMaybe(PDFName.of('IC'), PDFArray)!.size()).toBe(3);
    expect(num(sq!.lookup(PDFName.of('CA')))).toBeCloseTo(0.5);
  });
  it('ellipse → /Circle', async () => {
    const out = await emit([shape({ shapeType: 'ellipse' })]);
    expect(annotBySubtype(out, 'Circle')).not.toBeNull();
  });
  it('arrow → /Line + /L + /LE OpenArrow', async () => {
    const out = await emit([
      shape({ shapeType: 'arrow', x: 0.1, y: 0.5, w: 0.8, h: 0, points: [0.1, 0.5, 0.9, 0.5] }),
    ]);
    const line = annotBySubtype(out, 'Line');
    expect(line).not.toBeNull();
    expect(line!.lookupMaybe(PDFName.of('L'), PDFArray)!.size()).toBe(4);
    const le = line!.lookupMaybe(PDFName.of('LE'), PDFArray)!;
    expect(String(le.lookup(1))).toBe('/OpenArrow');
  });
  it('cloud → /Polygon + /BE cloudy + /IT PolygonCloud', async () => {
    const out = await emit([
      shape({
        shapeType: 'cloud',
        x: 0.2,
        y: 0.2,
        w: 0.4,
        h: 0.3,
        points: [0.2, 0.2, 0.6, 0.2, 0.6, 0.5, 0.2, 0.5],
        cloudIntensity: 1,
      }),
    ]);
    const poly = annotBySubtype(out, 'Polygon');
    expect(poly).not.toBeNull();
    const be = poly!.lookupMaybe(PDFName.of('BE'), PDFDict)!;
    expect(String(be.lookup(PDFName.of('S')))).toBe('/C');
    expect(num(be.lookup(PDFName.of('I')))).toBe(1);
    expect(String(poly!.lookup(PDFName.of('IT')))).toBe('/PolygonCloud');
    expect(poly!.lookupMaybe(PDFName.of('Vertices'), PDFArray)!.size()).toBe(8);
  });
  it('polyline → /PolyLine + /Vertices', async () => {
    const out = await emit([
      shape({ shapeType: 'polyline', points: [0.2, 0.2, 0.4, 0.4, 0.6, 0.2] }),
    ]);
    const pl = annotBySubtype(out, 'PolyLine');
    expect(pl).not.toBeNull();
    expect(pl!.lookupMaybe(PDFName.of('Vertices'), PDFArray)!.size()).toBe(6);
  });
  it('callout → /FreeText + /IT /FreeTextCallout + /CL + /RD + /Contents', async () => {
    const out = await emit([
      {
        id: 'c1',
        kind: 'callout',
        x: 0.1,
        y: 0.2,
        w: 0.6,
        h: 0.3,
        calloutBox: [0.3, 0.2, 0.4, 0.2],
        points: [0.1, 0.45, 0.2, 0.45, 0.3, 0.3],
        color: '#e0393e',
        strokeWidth: 1,
        note: 'look here',
      } as PageAnnotation,
    ]);
    const ft = annotBySubtype(out, 'FreeText');
    expect(ft).not.toBeNull();
    expect(String(ft!.lookup(PDFName.of('IT')))).toBe('/FreeTextCallout');
    expect(ft!.lookupMaybe(PDFName.of('CL'), PDFArray)!.size()).toBe(6);
    expect(ft!.lookupMaybe(PDFName.of('RD'), PDFArray)!.size()).toBe(4);
    expect(text(ft!.lookup(PDFName.of('Contents')))).toBe('look here');
    expect(String(ft!.lookup(PDFName.of('LE')))).toBe('/OpenArrow');
  });
});

describe('raw-style sidecar round-trip (our emit → our reader)', () => {
  it('reads back stroke width, fill, opacity, cloud, endings, CL and RD', async () => {
    const out = await emit([
      shape({ id: 'a', shapeType: 'rect', fillColor: '#4fc3f7', opacity: 0.5, strokeWidth: 4 }),
      shape({
        id: 'b',
        shapeType: 'cloud',
        x: 0.2,
        y: 0.2,
        w: 0.4,
        h: 0.3,
        points: [0.2, 0.2, 0.6, 0.2, 0.6, 0.5, 0.2, 0.5],
      }),
      shape({ id: 'c', shapeType: 'arrow', x: 0.1, y: 0.5, w: 0.8, h: 0, points: [0.1, 0.5, 0.9, 0.5] }),
      {
        id: 'd',
        kind: 'callout',
        x: 0.1,
        y: 0.2,
        w: 0.6,
        h: 0.3,
        calloutBox: [0.3, 0.2, 0.4, 0.2],
        points: [0.1, 0.45, 0.3, 0.3],
        color: '#e0393e',
        strokeWidth: 1,
        note: 'x',
      } as PageAnnotation,
    ]);
    const styles = (await readRawAnnotationStyles(await out.save()))![0];
    const bySub = (s: string) => styles.filter((x) => x.subtype === s);
    const sq = bySub('Square')[0];
    expect(sq.strokeWidth).toBe(4);
    expect(sq.fillColor).toBe('#4fc3f7');
    expect(sq.opacity).toBeCloseTo(0.5);
    const cloud = bySub('Polygon')[0];
    expect(cloud.cloudy).toBe(true);
    expect(cloud.it).toBe('PolygonCloud');
    expect(cloud.vertices).toHaveLength(8);
    const line = bySub('Line')[0];
    expect(line.le).toEqual(['None', 'OpenArrow']);
    expect(line.l).toHaveLength(4);
    const ft = bySub('FreeText')[0];
    expect(ft.it).toBe('FreeTextCallout');
    expect(ft.cl).toHaveLength(4);
    expect(ft.rd).toHaveLength(4);
  });
});

describe('import gates (faithful-or-untouched)', () => {
  const view = [0, 0, 300, 300] as [number, number, number, number];
  const mockPage = (annots: Record<string, unknown>[]): never =>
    ({ getAnnotations: async () => annots, view, rotate: 0 }) as never;
  const rect = [30, 30, 150, 120] as [number, number, number, number];

  it('a /Line with a sidecar imports as an arrow; without one it stays untouched', async () => {
    const raw = { subtype: 'Line', rect, color: [224, 57, 62], hasAppearance: true };
    const sidecar = [{ subtype: 'Line', rect, l: [30, 30, 150, 120], le: ['None', 'OpenArrow'], strokeWidth: 3 }];
    const withSidecar = await importPageAnnotations(mockPage([raw]), sidecar);
    expect(withSidecar).toHaveLength(1);
    expect(withSidecar[0].kind).toBe('shape');
    expect(withSidecar[0].shapeType).toBe('arrow');
    expect(withSidecar[0].strokeWidth).toBe(3);
    expect(withSidecar[0].lineEndings).toEqual(['None', 'OpenArrow']);
    const without = await importPageAnnotations(mockPage([raw]), []);
    expect(without).toHaveLength(0);
  });
  it('a dimension /Line (IT or /Measure) is never imported', async () => {
    const raw = { subtype: 'Line', rect, hasAppearance: true };
    const byIt = await importPageAnnotations(mockPage([raw]), [
      { subtype: 'Line', rect, l: [30, 30, 150, 120], it: 'LineDimension' },
    ]);
    expect(byIt).toHaveLength(0);
    const byMeasure = await importPageAnnotations(mockPage([raw]), [
      { subtype: 'Line', rect, l: [30, 30, 150, 120], measure: true },
    ]);
    expect(byMeasure).toHaveLength(0);
  });
  it('an exotic line ending keeps the annotation untouched', async () => {
    const raw = { subtype: 'Line', rect, hasAppearance: true };
    const got = await importPageAnnotations(mockPage([raw]), [
      { subtype: 'Line', rect, l: [30, 30, 150, 120], le: ['None', 'Diamond'] },
    ]);
    expect(got).toHaveLength(0);
  });
  it('a cloudy /Polygon imports as a cloud with its intensity', async () => {
    const raw = { subtype: 'Polygon', rect, hasAppearance: true };
    const got = await importPageAnnotations(mockPage([raw]), [
      { subtype: 'Polygon', rect, vertices: [30, 30, 150, 30, 150, 120], cloudy: true, cloudIntensity: 1 },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].shapeType).toBe('cloud');
    expect(got[0].cloudIntensity).toBe(1);
  });
  it('a /Square with /BS imports as a rect; without stays a highlight', async () => {
    const raw = { subtype: 'Square', rect, color: [255, 213, 74], hasAppearance: true };
    const asRect = await importPageAnnotations(mockPage([raw]), [
      { subtype: 'Square', rect, strokeWidth: 2, fillColor: '#123456' },
    ]);
    expect(asRect).toHaveLength(1);
    expect(asRect[0].kind).toBe('shape');
    expect(asRect[0].fillColor).toBe('#123456');
    const asHighlight = await importPageAnnotations(mockPage([raw]), [{ subtype: 'Square', rect }]);
    expect(asHighlight).toHaveLength(1);
    expect(asHighlight[0].kind).toBe('highlight');
  });
  it('a callout imports with its leader and text box; a plain FreeText stays freetext', async () => {
    const raw = { subtype: 'FreeText', rect, contentsObj: { str: 'hi' }, hasAppearance: true };
    const asCallout = await importPageAnnotations(mockPage([raw]), [
      { subtype: 'FreeText', rect, it: 'FreeTextCallout', cl: [10, 40, 30, 75], rd: [20, 0, 0, 0], strokeWidth: 1 },
    ]);
    expect(asCallout).toHaveLength(1);
    expect(asCallout[0].kind).toBe('callout');
    expect(asCallout[0].points).toHaveLength(4);
    expect(asCallout[0].calloutBox).toBeDefined();
    const asFreetext = await importPageAnnotations(mockPage([raw]), []);
    expect(asFreetext).toHaveLength(1);
    expect(asFreetext[0].kind).toBe('freetext');
  });
});

// ── Reducer + geometry ─────────────────────────────────────────────────

function makeFile(path: string): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount: 1,
    buffer: [1, 2, 3],
    dirty: false,
    undoStack: [],
    redoStack: [],
  };
}

function stateWithAnnots(annots: PageAnnotation[]): AppState {
  const f = makeFile('a.pdf');
  const pages: PageRef[] = [
    {
      id: 'a.pdf#p0',
      sourceDocId: 'a.pdf',
      sourcePageIndex: 0,
      rotation: 0,
      width: 300,
      height: 400,
      annotations: annots,
    },
  ];
  const doc: OpenDocument = { ...f, id: 'a.pdf#0', pages, pageCount: 1 };
  return { ...initialState, files: new Map([[f.path, f]]), workspace: { documents: [doc] } };
}

const annotsOf = (s: AppState): PageAnnotation[] => s.workspace.documents[0].pages[0].annotations ?? [];

describe('RESTYLE_ANNOTATIONS', () => {
  it('applies width/fill/opacity by kind rules in one undo step', () => {
    const s0 = stateWithAnnots([
      shape({ id: 's' }),
      { id: 'i', kind: 'ink', x: 0.2, y: 0.2, w: 0.2, h: 0.2, color: '#2f6fed', points: [0.2, 0.2, 0.4, 0.4] },
      { id: 'h', kind: 'highlight', x: 0.5, y: 0.5, w: 0.2, h: 0.1, color: '#ffd54f' },
    ]);
    const s1 = appReducer(s0, {
      type: 'RESTYLE_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['s', 'i', 'h'],
      style: { strokeWidth: 6, fillColor: '#123456', opacity: 0.5 },
    });
    const [sh, ink, hl] = annotsOf(s1);
    expect(sh).toMatchObject({ strokeWidth: 6, fillColor: '#123456', opacity: 0.5 });
    expect(ink.strokeWidth).toBe(6);
    expect(ink.opacity).toBe(0.5);
    expect(ink.fillColor).toBeUndefined(); // no interior to fill
    expect(hl.strokeWidth).toBeUndefined(); // highlight keeps its fixed look
    expect(s1.pageUndoStack).toHaveLength(1);
    // fillColor: null clears.
    const s2 = appReducer(s1, {
      type: 'RESTYLE_ANNOTATIONS',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationIds: ['s'],
      style: { fillColor: null },
    });
    expect(annotsOf(s2)[0].fillColor).toBeUndefined();
  });
});

describe('vertex + callout geometry', () => {
  it('vertexDragged moves one point and re-derives the bbox', () => {
    const a = shape({ shapeType: 'polyline', x: 0.2, y: 0.2, w: 0.4, h: 0.2, points: [0.2, 0.2, 0.6, 0.4] });
    const r = vertexDragged(a, 1, 0.8, 0.1);
    expect(r.points).toEqual([0.2, 0.2, 0.8, 0.1]);
    expect(r.x).toBeCloseTo(0.2);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.w).toBeCloseTo(0.6);
    expect(r.h).toBeCloseTo(0.1);
  });
  it('a callout leader drag keeps the text box inside the bbox union', () => {
    const a: PageAnnotation = {
      id: 'c',
      kind: 'callout',
      x: 0.1,
      y: 0.2,
      w: 0.6,
      h: 0.3,
      calloutBox: [0.3, 0.2, 0.4, 0.2],
      points: [0.1, 0.45, 0.3, 0.3],
      color: '#e0393e',
    };
    const r = vertexDragged(a, 0, 0.05, 0.6);
    expect(r.calloutBox).toEqual([0.3, 0.2, 0.4, 0.2]);
    expect(r.x).toBeCloseTo(0.05);
    expect(r.y).toBeCloseTo(0.2);
    expect(r.h).toBeCloseTo(0.4); // leader tip now below the box
  });
  it('scaledCalloutBox follows the box mapping', () => {
    const a: PageAnnotation = {
      id: 'c',
      kind: 'callout',
      x: 0,
      y: 0,
      w: 0.5,
      h: 0.5,
      calloutBox: [0.25, 0.25, 0.25, 0.25],
      points: [0, 0.4, 0.25, 0.375],
      color: '#000000',
    };
    const cb = scaledCalloutBox(a, { x: 0, y: 0, w: 1, h: 1 });
    expect(cb).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
  it('hasVertexHandles: points shapes and callouts only', () => {
    expect(hasVertexHandles(shape({ shapeType: 'line' }))).toBe(true);
    expect(hasVertexHandles(shape({ shapeType: 'rect' }))).toBe(false);
    expect(hasVertexHandles({ id: 'c', kind: 'callout', x: 0, y: 0, w: 1, h: 1, color: '#000' })).toBe(true);
    expect(hasVertexHandles({ id: 'i', kind: 'ink', x: 0, y: 0, w: 1, h: 1, color: '#000' })).toBe(false);
  });
  it('cloudBumps bulge outward and cover every edge', () => {
    const bumps = cloudBumps(
      [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
      10,
    );
    expect(bumps.length).toBeGreaterThanOrEqual(4);
    // A bump on the top edge (y=0 between x 0..100) must bulge to NEGATIVE y
    // (away from the centroid at 50,50).
    const top = bumps.find((b) => b.s[1] === 0 && b.e[1] === 0);
    expect(top).toBeDefined();
    expect(top!.c1[1]).toBeLessThan(0);
  });
});
