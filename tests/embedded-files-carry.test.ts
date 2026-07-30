// The embedded-files carry (lib/embedded-files-carry.ts): document-level
// /Names /EmbeddedFiles and /Collection survive the from-scratch commit
// rebuild. Before the carry, ONE committed page edit silently deleted every
// attachment a document carried — same loss class as the /AcroForm drop
// acroform-carry exists for, found while building portfolio authoring.
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from 'pdf-lib';

import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

async function sourceWithAttachment(withCollection: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  await doc.attach(new TextEncoder().encode('hello member'), 'notes.txt', {
    mimeType: 'text/plain',
    description: 'a note',
  });
  if (withCollection) {
    doc.catalog.set(
      PDFName.of('Collection'),
      doc.context.obj({ Type: 'Collection', View: 'D' }),
    );
  }
  return doc.save();
}

async function plainSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

const pageOf = (bytes: Uint8Array): ExportPage => ({
  bytes,
  sourceKey: 'src',
  pageIndex: 0,
});

function embeddedNames(doc: PDFDocument): string[] {
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!tree) return [];
  const out: string[] = [];
  const walk = (node: PDFDict): void => {
    const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (arr) {
      for (let i = 0; i < arr.size(); i += 2) {
        const key = arr.lookup(i);
        if (key instanceof PDFString || key instanceof PDFHexString) out.push(key.decodeText());
        else out.push(String(key));
      }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i, PDFDict));
  };
  walk(tree);
  return out;
}

describe('embedded-files carry through the commit rebuild', () => {
  it('carries /EmbeddedFiles through buildPdf (the attachment-loss pin)', async () => {
    const src = await sourceWithAttachment(false);
    const rebuilt = await PDFDocument.load(await buildPdf([pageOf(src)], src));
    expect(embeddedNames(rebuilt)).toEqual(['notes.txt']);
    // No portfolio marker invented for a non-portfolio source.
    expect(rebuilt.catalog.lookupMaybe(PDFName.of('Collection'), PDFDict)).toBeUndefined();
  });

  it('carries /Collection so a page-edited portfolio stays a portfolio', async () => {
    const src = await sourceWithAttachment(true);
    const rebuilt = await PDFDocument.load(await buildPdf([pageOf(src)], src));
    expect(embeddedNames(rebuilt)).toEqual(['notes.txt']);
    const col = rebuilt.catalog.lookupMaybe(PDFName.of('Collection'), PDFDict);
    expect(col).toBeDefined();
    expect(String(col!.lookup(PDFName.of('View')))).toBe('/D');
  });

  it('leaves a plain document byte-clean (no /Names, no /Collection added)', async () => {
    const src = await plainSource();
    const rebuilt = await PDFDocument.load(await buildPdf([pageOf(src)], src));
    expect(embeddedNames(rebuilt)).toEqual([]);
    expect(rebuilt.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)).toBeUndefined();
    expect(rebuilt.catalog.lookupMaybe(PDFName.of('Collection'), PDFDict)).toBeUndefined();
  });

  it('buildPdfx: the carried member and the pdfx manifest coexist', async () => {
    const src = await sourceWithAttachment(false);
    const bytes = await buildPdfx(
      [{ name: 'doc-a', pages: [pageOf(src)] }],
      'title',
      src,
    );
    const rebuilt = await PDFDocument.load(bytes);
    const names = embeddedNames(rebuilt);
    expect(names).toContain('notes.txt');
    expect(names.some((n) => n !== 'notes.txt')).toBe(true); // the manifest is still there
  });
});
