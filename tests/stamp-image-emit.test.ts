// Custom IMAGE stamps through the commit rebuild (pdfx-build): the /Stamp's
// appearance draws a pre-embedded raster, and an unreadable image falls back
// to the bordered-label look instead of failing the commit.
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';

import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

// The canonical 1×1 red PNG.
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function sourceBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  return doc.save();
}

function firstStampAp(doc: PDFDocument): PDFDict | null {
  const page = doc.getPage(0);
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return null;
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i, PDFDict);
    if (String(a.lookup(PDFName.of('Subtype'))) !== '/Stamp') continue;
    const ap = a.lookupMaybe(PDFName.of('AP'), PDFDict);
    const n = ap?.get(PDFName.of('N'));
    const stream = n instanceof PDFRef ? doc.context.lookup(n) : n;
    return stream instanceof PDFRawStream || stream instanceof PDFDict
      ? ((stream as PDFRawStream).dict ?? (stream as PDFDict))
      : null;
  }
  return null;
}

describe('custom image stamps through the rebuild', () => {
  it('emits a /Stamp whose appearance draws an embedded /Image XObject', async () => {
    const src = await sourceBytes();
    const page: ExportPage = {
      bytes: src,
      sourceKey: 'src',
      pageIndex: 0,
      annotations: [
        {
          kind: 'stamp',
          x: 0.1,
          y: 0.1,
          w: 0.3,
          h: 0.2,
          color: '#2f6fed',
          note: 'Logo',
          imageData: PNG_1X1,
        },
      ],
    };
    const rebuilt = await PDFDocument.load(await buildPdf([page], src));
    const apDict = firstStampAp(rebuilt);
    expect(apDict).not.toBeNull();
    const resources = apDict!.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    expect(xobjects).toBeDefined();
    const imRef = xobjects!.get(PDFName.of('Im0'));
    expect(imRef).toBeDefined();
    const img = rebuilt.context.lookup(imRef as PDFRef) as PDFRawStream;
    expect(String(img.dict.lookup(PDFName.of('Subtype')))).toBe('/Image');
  });

  it('an unreadable image falls back to the bordered label, never failing', async () => {
    const src = await sourceBytes();
    const page: ExportPage = {
      bytes: src,
      sourceKey: 'src',
      pageIndex: 0,
      annotations: [
        {
          kind: 'stamp',
          x: 0.1,
          y: 0.1,
          w: 0.3,
          h: 0.2,
          color: '#e0393e',
          note: 'BROKEN',
          imageData: 'data:image/png;base64,not-a-png!!',
        },
      ],
    };
    const rebuilt = await PDFDocument.load(await buildPdf([page], src));
    const apDict = firstStampAp(rebuilt);
    expect(apDict).not.toBeNull();
    // Fallback = the TEXT look: a Font resource, no image XObject.
    const resources = apDict!.lookupMaybe(PDFName.of('Resources'), PDFDict);
    expect(resources?.lookupMaybe(PDFName.of('Font'), PDFDict)).toBeDefined();
    expect(resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)).toBeUndefined();
  });
});
