import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

const N = PDFName.of.bind(PDFName);

/** A producer-shaped page: one embedded TrueType font shared by every page
 * (descriptor, font file, a 2,000-entry /Widths), a unique image, and ten
 * annotations whose appearance streams reference the shared font. */
async function largeDocument(pages: number, layer: boolean, tagged = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const ctx = pdf.context;
  const fontFile = ctx.register(ctx.flateStream(new Uint8Array(2000)));
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Body', Flags: 32, FontBBox: [-100, -200, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80, FontFile2: fontFile }));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Body', FirstChar: 0, LastChar: 1999, Widths: Array.from({ length: 2000 }, (_, i) => 500 + (i % 50)), FontDescriptor: descriptor }));
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: 'Layer' }));
  if (layer) pdf.catalog.set(N('OCProperties'), ctx.obj({ OCGs: [ocg], D: { Order: [ocg], ON: [ocg] } }));
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([612, 792]);
    const image = ctx.register(ctx.flateStream(new Uint8Array(30), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 10, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const resources = ctx.obj({ Font: { F1: font }, XObject: { Im1: image } });
    if (layer) resources.set(N('Properties'), ctx.obj({ L0: ocg }));
    page.node.set(N('Resources'), resources);
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(layer
      ? '/OC /L0 BDC BT /F1 12 Tf 72 720 Td (Body) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q EMC'
      : 'BT /F1 12 Tf 72 720 Td (Body) Tj ET q 100 0 0 100 72 500 cm /Im1 Do Q')));
    const annots: PDFRef[] = [];
    for (let a = 0; a < 10; a++) {
      const appearance = ctx.register(ctx.flateStream('BT /F1 9 Tf 2 6 Td (n) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20], Resources: { Font: { F1: font } } }));
      annots.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [a * 30, 10, a * 30 + 20, 30], P: page.ref, DA: '/F1 9 Tf', AP: { N: appearance } })));
    }
    page.node.set(N('Annots'), ctx.obj(annots));
  }
  if (tagged) {
    const root = ctx.obj({ Type: 'StructTreeRoot' }), rootRef = ctx.register(root);
    const kids: PDFRef[] = [], nums = ctx.obj([]);
    pdf.getPages().forEach((page, i) => {
      const elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: rootRef, Pg: page.ref, K: 0 }));
      kids.push(elem); nums.push(ctx.obj(i)); nums.push(ctx.obj([elem]));
      page.node.set(N('StructParents'), ctx.obj(i));
    });
    root.set(N('K'), ctx.obj(kids)); root.set(N('ParentTree'), ctx.obj({ Nums: nums }));
    pdf.catalog.set(N('StructTreeRoot'), rootRef); pdf.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
  }
  return pdf.save();
}

async function deleteOnePage(format: 'pdf' | 'pdfx', bytes: Uint8Array, pageCount: number, deleted: number) {
  const pages: ExportPage[] = Array.from({ length: pageCount }, (_, pageIndex) => ({ bytes, sourceKey: 'own', pageIndex }))
    .filter(page => page.pageIndex !== deleted);
  return format === 'pdf' ? buildPdf(pages, bytes, 'own') : buildPdfx([{ name: 'Document', pages }], 'Document', bytes, 'own');
}

describe.each([false, true])('deleting one page of a 1,000-page document (layer on every page = %s)', layer => {
  let source: Uint8Array;
  it.each(['pdf', 'pdfx'] as const)('saves with every page accounted for: %s', async format => {
    source ??= await largeDocument(1000, layer);
    const before = source.slice();
    const out = await PDFDocument.load(await deleteOnePage(format, source, 1000, 500), { updateMetadata: false });
    expect(source).toEqual(before);
    expect(out.getPageCount()).toBe(999);
    const tree = new Set(out.getPages().map(page => page.ref.tag));
    const orphans = out.context.enumerateIndirectObjects()
      .filter(([ref, obj]) => obj instanceof PDFDict && obj.lookup(N('Type')) === N('Page') && !tree.has(ref.tag));
    expect(orphans).toHaveLength(0);
    if (layer) expect(out.catalog.lookup(N('OCProperties'), PDFDict).get(N('OCGs'))).toBeDefined();
  }, 600000);
});

describe('deleting one page of a tagged 1,000-page document', () => {
  let source: Uint8Array;
  it.each(['pdf', 'pdfx'] as const)('saves with every page and its structure element accounted for: %s', async format => {
    source ??= await largeDocument(1000, true, true);
    const before = source.slice();
    const out = await PDFDocument.load(await deleteOnePage(format, source, 1000, 500), { updateMetadata: false });
    expect(source).toEqual(before);
    expect(out.getPageCount()).toBe(999);
    const tree = new Set(out.getPages().map(page => page.ref.tag));
    expect(out.context.enumerateIndirectObjects()
      .filter(([ref, obj]) => obj instanceof PDFDict && obj.lookup(N('Type')) === N('Page') && !tree.has(ref.tag))).toHaveLength(0);
    const elements = out.context.enumerateIndirectObjects()
      .filter(([, obj]) => obj instanceof PDFDict && obj.lookup(N('Type')) === N('StructElem'));
    expect(elements).toHaveLength(999);
  }, 600000);
});

describe('page edit work guard', () => {
  it('still refuses a genuinely oversized unique resource graph', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 2; i++) pdf.addPage([612, 792]);
    const ctx = pdf.context;
    const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', Private: Array.from({ length: 250000 }, () => [0, 0]) }));
    pdf.getPage(0).node.set(N('Resources'), ctx.obj({ Font: { F1: font } }));
    const bytes = await pdf.save();
    await expect(deleteOnePage('pdf', bytes, 2, 1)).rejects.toThrow('The operation result could not be verified.');
  }, 120000);
});
