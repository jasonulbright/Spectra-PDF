import { describe, expect, it } from 'vitest';
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFString } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';

const N = PDFName.of.bind(PDFName);
async function source(range: (number | string)[] | number = [2, 2]) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const width of [300, 400, 500, 600]) doc.addPage([width, 700]);
  doc.catalog.set(N('ViewerPreferences'), doc.context.obj({ PrintPageRange: range, DisplayDocTitle: true,
    Direction: 'R2L', NumCopies: 2, PrintScaling: 'None', Enforce: ['PrintScaling'], PrivateText: PDFString.of('Keep exactly') }));
  return doc;
}
async function rebuild(doc: PDFDocument, order: number[], pdfx = false, donorPositions: number[] = []) {
  const bytes = await doc.save(), before = bytes.slice();
  const donor = await PDFDocument.create(); donor.addPage([900, 700]);
  const donorBytes = await donor.save();
  const pages = order.map(pageIndex => ({ bytes, sourceKey: 'own', pageIndex }));
  for (const index of donorPositions) pages.splice(index, 0, { bytes: donorBytes, sourceKey: 'donor', pageIndex: 0 });
  const result = pdfx ? await buildPdfx([{ name: 'Original', pages }], 'Collection', bytes, 'own') : await buildPdf(pages, bytes, 'own');
  expect(bytes).toEqual(before);
  return PDFDocument.load(result, { updateMetadata: false });
}
function values(doc: PDFDocument) {
  const prefs = doc.catalog.lookup(N('ViewerPreferences'), PDFDict);
  return prefs.lookup(N('PrintPageRange'), PDFArray).asArray().map(n => (n as PDFNumber).asNumber());
}
describe('viewer preference page identity', () => {
  it.each([false, true])('remaps selected pages with donor insertions (PDFX=%s)', async pdfx => {
    const out = await rebuild(await source([2, 3]), [2, 0, 1, 3], pdfx, [1]);
    expect(values(out)).toEqual([1, 1, 4, 4]);
    const prefs = out.catalog.lookup(N('ViewerPreferences'), PDFDict);
    expect(prefs.lookup(N('DisplayDocTitle'))).toBe(PDFBool.True);
    expect(prefs.lookup(N('Direction'))).toBe(N('R2L'));
    expect(prefs.lookup(N('NumCopies'), PDFNumber).asNumber()).toBe(2);
    expect(prefs.lookup(N('PrivateText'), PDFString).decodeText()).toBe('Keep exactly');
    expect(prefs.lookup(N('Enforce'), PDFArray).get(0)).toBe(N('PrintScaling'));
  });
  it('includes every retained copy of selected source pages', async () => {
    expect(values(await rebuild(await source(), [1, 0, 1, 2]))).toEqual([1, 1, 3, 3]);
  });
  it('retains the surviving part of a deleted selection', async () => {
    expect(values(await rebuild(await source([2, 3]), [2, 3]))).toEqual([1, 1]);
  });
  it('refuses deletion of every selected page instead of defaulting to all', async () => {
    await expect(rebuild(await source(), [0, 2, 3])).rejects.toThrow();
    await expect(rebuild(await source(), [], false, [0])).rejects.toThrow();
  });
  it('preserves an explicitly empty range without inventing a selection', async () => {
    expect(values(await rebuild(await source([]), [3, 0]))).toEqual([]);
  });
  it.each([[0, 1], [1, 5], [3, 2], [1, 1.5], [1], ['1', '2'], 42].map(range => ({ range })))('refuses malformed ranges $range', async ({ range }) => {
    await expect(rebuild(await source(range), [0, 1, 2, 3])).rejects.toThrow();
  });
  it('resolves indirect range arrays and endpoints', async () => {
    const doc = await source();
    const arr = doc.context.obj([doc.context.register(PDFNumber.of(2)), doc.context.register(PDFNumber.of(2))]);
    doc.catalog.lookup(N('ViewerPreferences'), PDFDict).set(N('PrintPageRange'), doc.context.register(arr));
    expect(values(await rebuild(doc, [1, 0, 2]))).toEqual([1, 1]);
  });
  it('refuses cyclic preference data or references into the page graph', async () => {
    for (const cyclic of [false, true]) {
      const doc = await source(); const prefs = doc.catalog.lookup(N('ViewerPreferences'), PDFDict);
      prefs.set(N('Private'), cyclic ? doc.context.register(prefs) : doc.getPage(0).ref);
      await expect(rebuild(doc, [0, 1, 2, 3])).rejects.toThrow();
    }
  });
  it('does not create preferences when absent or PDF null', async () => {
    for (const nullValue of [false, true]) {
      const doc = await source(); doc.catalog.delete(N('ViewerPreferences'));
      if (nullValue) doc.catalog.set(N('ViewerPreferences'), PDFNull);
      expect((await rebuild(doc, [0])).catalog.get(N('ViewerPreferences'))).toBeUndefined();
    }
  });
});
