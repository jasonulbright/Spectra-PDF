// Real dimension annotations (the resolved 2026-07-30 /Measure deferral):
// kind 'measure' commits as /Line //PolyLine //Polygon carrying /IT and a
// /Measure dict with the NumberFormat /C factors other tools re-measure
// with. The value in /Contents is a convenience; the geometry + factors are
// the contract.
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';

import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';
import {
  measureRatioLabel,
  measureUnitsPerPoint,
  type MeasureScale,
} from '../src/renderer/lib/measure';

const SCALE: MeasureScale = { from: 1, fromUnit: 'in', to: 2, toUnit: 'ft' };

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

const text = (v: unknown): string =>
  v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : String(v);

describe('measure math for the /Measure dict', () => {
  it('units-per-point and the ratio label match the scale', () => {
    // 1 in = 2 ft → one PDF point (1/72 in) reads as 2/72 ft.
    expect(measureUnitsPerPoint(SCALE)).toBeCloseTo(2 / 72, 10);
    expect(measureRatioLabel(SCALE)).toBe('1 in = 2 ft');
  });
});

describe('dimension annotations through the rebuild', () => {
  it('a distance commits as /Line + /IT + /Measure with re-measurable factors', async () => {
    const src = await sourceBytes();
    const page: ExportPage = {
      bytes: src,
      sourceKey: 'src',
      pageIndex: 0,
      annotations: [
        {
          kind: 'measure',
          measureKind: 'distance',
          measureRatio: measureRatioLabel(SCALE),
          measureUnitsPerPt: measureUnitsPerPoint(SCALE),
          measureUnit: 'ft',
          x: 0.1,
          y: 0.5,
          w: 0.8,
          h: 0,
          color: '#f59e0b',
          points: [0.1, 0.5, 0.9, 0.5],
          note: '6.67 ft',
        },
      ],
    };
    const out = await PDFDocument.load(await buildPdf([page], undefined, 'src'));
    const line = annotBySubtype(out, 'Line');
    expect(line).not.toBeNull();
    expect(String(line!.lookup(PDFName.of('IT')))).toBe('/LineDimension');
    const l = line!.lookupMaybe(PDFName.of('L'), PDFArray);
    expect(l?.size()).toBe(4);
    const measure = line!.lookupMaybe(PDFName.of('Measure'), PDFDict);
    expect(measure).toBeDefined();
    expect(text(measure!.lookup(PDFName.of('R')))).toBe('1 in = 2 ft');
    const x = measure!.lookupMaybe(PDFName.of('X'), PDFArray);
    const fmt = x!.lookupMaybe(0, PDFDict)!;
    expect((fmt.lookup(PDFName.of('C')) as PDFNumber).asNumber()).toBeCloseTo(2 / 72, 8);
    expect(text(fmt.lookup(PDFName.of('U')))).toBe('ft');
    const area = measure!.lookupMaybe(PDFName.of('A'), PDFArray)!.lookupMaybe(0, PDFDict)!;
    expect((area.lookup(PDFName.of('C')) as PDFNumber).asNumber()).toBeCloseTo((2 / 72) ** 2, 10);
    expect(text(line!.lookup(PDFName.of('Contents')))).toBe('6.67 ft');
    // The appearance draws — a viewer with no /Measure support still sees it.
    expect(line!.get(PDFName.of('AP'))).toBeDefined();
  });

  it('an area commits as /Polygon whose vertices drop the closing duplicate', async () => {
    const src = await sourceBytes();
    const ring = [0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.2]; // closed (dup last)
    const page: ExportPage = {
      bytes: src,
      sourceKey: 'src',
      pageIndex: 0,
      annotations: [
        {
          kind: 'measure',
          measureKind: 'area',
          measureRatio: measureRatioLabel(SCALE),
          measureUnitsPerPt: measureUnitsPerPoint(SCALE),
          measureUnit: 'ft',
          x: 0.2,
          y: 0.2,
          w: 0.6,
          h: 0.6,
          color: '#f59e0b',
          points: ring,
          note: '25 sq ft',
        },
      ],
    };
    const out = await PDFDocument.load(await buildPdf([page], undefined, 'src'));
    const poly = annotBySubtype(out, 'Polygon');
    expect(poly).not.toBeNull();
    expect(String(poly!.lookup(PDFName.of('IT')))).toBe('/PolygonDimension');
    const vertices = poly!.lookupMaybe(PDFName.of('Vertices'), PDFArray);
    expect(vertices?.size()).toBe(ring.length - 2); // /Polygon self-closes
    expect(poly!.lookupMaybe(PDFName.of('Measure'), PDFDict)).toBeDefined();
  });

  it('a perimeter commits as /PolyLine keeping every vertex', async () => {
    const src = await sourceBytes();
    const page: ExportPage = {
      bytes: src,
      sourceKey: 'src',
      pageIndex: 0,
      annotations: [
        {
          kind: 'measure',
          measureKind: 'perimeter',
          measureRatio: measureRatioLabel(SCALE),
          measureUnitsPerPt: measureUnitsPerPoint(SCALE),
          measureUnit: 'ft',
          x: 0.1,
          y: 0.1,
          w: 0.5,
          h: 0.5,
          color: '#f59e0b',
          points: [0.1, 0.1, 0.6, 0.1, 0.6, 0.6],
          note: '10 ft',
        },
      ],
    };
    const out = await PDFDocument.load(await buildPdf([page], undefined, 'src'));
    const poly = annotBySubtype(out, 'PolyLine');
    expect(poly).not.toBeNull();
    expect(String(poly!.lookup(PDFName.of('IT')))).toBe('/PolyLineDimension');
    expect(poly!.lookupMaybe(PDFName.of('Vertices'), PDFArray)?.size()).toBe(6);
  });
});
