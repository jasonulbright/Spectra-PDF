// The embedded-files carry (lib/embedded-files-carry.ts): document-level
// /Names /EmbeddedFiles and /Collection survive the from-scratch commit
// rebuild. Before the carry, ONE committed page edit silently deleted every
// attachment a document carried — same loss class as the /AcroForm drop
// acroform-carry exists for, found while building portfolio authoring.
import { describe, expect, it } from 'vitest';
import {
  AFRelationship,
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

// ISO 32000-2 14.13: document-level /AF is the union of the contributing
// sources' arrays, and a filespec also listed in /EmbeddedFiles is the SAME
// output object in both places.
describe('associated files (/AF) carry', () => {
  async function withAssociated(name: string, relationship: AFRelationship): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    await doc.attach(new TextEncoder().encode(`payload ${name}`), name, { mimeType: 'text/plain', afRelationship: relationship });
    return doc.save();
  }
  const filespecs = (doc: PDFDocument) => doc.context.enumerateIndirectObjects()
    .filter(([, obj]) => obj instanceof PDFDict && obj.lookup(PDFName.of('Type')) === PDFName.of('Filespec'));

  it.each(['pdf', 'pdfx'] as const)('unions own and donor /AF with identity and relationship intact (%s)', async format => {
    const own = await withAssociated('own.txt', AFRelationship.Source);
    const donor = await withAssociated('donor.txt', AFRelationship.Data);
    const pages: ExportPage[] = [
      { bytes: own, sourceKey: 'own', pageIndex: 0 },
      { bytes: donor, sourceKey: 'donor', pageIndex: 0 },
    ];
    const built = format === 'pdf' ? await buildPdf(pages, own, 'own')
      : await buildPdfx([{ name: 'Document', pages }], 'Document', own, 'own');
    const out = await PDFDocument.load(built);
    const af = out.catalog.lookup(PDFName.of('AF'), PDFArray).asArray();
    const specs = af.map(ref => out.context.lookup(ref, PDFDict));
    const names = specs.map(spec => (spec.lookup(PDFName.of('UF')) as PDFHexString | PDFString).decodeText());
    expect(names.slice(0, 2)).toEqual(['own.txt', 'donor.txt']);
    expect(specs.slice(0, 2).map(spec => spec.get(PDFName.of('AFRelationship')))).toEqual([PDFName.of('Source'), PDFName.of('Data')]);
    const tree = out.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict)
      .lookup(PDFName.of('Names'), PDFArray);
    const ownIndex = embeddedNames(out).indexOf('own.txt');
    expect(tree.get(ownIndex * 2 + 1)).toBe(af[0]);
    expect(embeddedNames(out)).not.toContain('donor.txt');
    expect(filespecs(out)).toHaveLength(format === 'pdf' ? 2 : 3);
  });

  async function annotatedAssociated(name: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    await doc.attach(new TextEncoder().encode(`payload ${name}`), name, { mimeType: 'text/plain', afRelationship: AFRelationship.Supplement });
    await doc.flush();
    const spec = doc.catalog.lookup(PDFName.of('AF'), PDFArray).get(0);
    const annot = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'FileAttachment', Rect: [10, 10, 30, 30], FS: spec, Contents: PDFString.of(name),
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    return doc.save();
  }
  const annotationSpec = (out: PDFDocument, pageIndex: number) =>
    out.getPage(pageIndex).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict).get(PDFName.of('FS'));

  it.each(['own', 'donor'] as const)('copies a filespec shared by /AF and a page annotation once (%s)', async role => {
    const shared = await annotatedAssociated('shared.txt');
    const plain = await plainSource();
    const pages: ExportPage[] = role === 'own'
      ? [{ bytes: shared, sourceKey: 'own', pageIndex: 0 }]
      : [{ bytes: plain, sourceKey: 'own', pageIndex: 0 }, { bytes: shared, sourceKey: 'donor', pageIndex: 0 }];
    const out = await PDFDocument.load(await buildPdf(pages, role === 'own' ? shared : plain, 'own'));
    const af = out.catalog.lookup(PDFName.of('AF'), PDFArray).asArray();
    expect(af).toHaveLength(1);
    expect(annotationSpec(out, role === 'own' ? 0 : 1)).toBe(af[0]);
    expect(filespecs(out)).toHaveLength(1);
  });

  it('carries donor /AF when the build has no owner bytes', async () => {
    const donor = await withAssociated('donor.txt', AFRelationship.Data);
    const out = await PDFDocument.load(await buildPdf([{ bytes: donor, sourceKey: 'donor', pageIndex: 0 }]));
    expect(out.catalog.lookup(PDFName.of('AF'), PDFArray).size()).toBe(1);
  });

  it('does not count the owner as a donor when only its bytes are given', async () => {
    const own = await withAssociated('own.txt', AFRelationship.Source);
    const out = await PDFDocument.load(await buildPdf([{ bytes: own, sourceKey: 'k', pageIndex: 0 }], own));
    expect(out.catalog.lookup(PDFName.of('AF'), PDFArray).size()).toBe(1);
    expect(filespecs(out)).toHaveLength(1);
    expect(embeddedNames(out)).toEqual(['own.txt']);
  });

  it('writes no /AF for sources without one', async () => {
    const plain = await plainSource();
    const out = await PDFDocument.load(await buildPdf([pageOf(plain)], plain, 'src'));
    expect(out.catalog.get(PDFName.of('AF'))).toBeUndefined();
  });
});
