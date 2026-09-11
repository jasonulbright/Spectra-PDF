import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
const N = PDFName.of;
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
const profileBytes = new TextEncoder().encode('opaque profile fixture; this test asserts bytes, not ICC conformance');
function intent(doc: PDFDocument, label: string) {
  return doc.context.obj([doc.context.register(doc.context.obj({ Type: 'OutputIntent', S: 'GTS_PDFX',
    OutputConditionIdentifier: PDFString.of(label), Info: PDFString.of('Opaque profile preservation'),
    DestOutputProfile: doc.context.register(doc.context.flateStream(profileBytes, { N: 4 })) }))]);
}
async function source(label?: string, pageLabel?: string) {
  const doc = await PDFDocument.create({ updateMetadata: false }); doc.addPage([300, 700]); doc.addPage([400, 700]);
  if (label !== undefined) doc.catalog.set(N('OutputIntents'), intent(doc, label));
  if (pageLabel !== undefined) { doc.getPage(1).node.set(N('OutputIntents'), intent(doc, pageLabel)); doc.catalog.set(N('Version'), N('2.0')); }
  return doc;
}
function condition(dict: PDFDict) {
  const array = dict.lookup(N('OutputIntents'));
  if (array === undefined) return undefined;
  expect(array).toBeInstanceOf(PDFArray);
  const item = (array as PDFArray).lookup(0, PDFDict), stream = item.lookup(N('DestOutputProfile'));
  expect(stream).toBeInstanceOf(PDFRawStream); expect(decodePDFRawStream(stream as PDFRawStream).decode()).toEqual(profileBytes);
  return item.lookup(N('OutputConditionIdentifier'), PDFString).decodeText();
}
const page = (bytes: Uint8Array, sourceKey = 'own', pageIndex = 0) => ({ bytes, sourceKey, pageIndex });
describe('document and explicit page output-condition ownership', () => {
  it.each(['pdf', 'pdfx', 'donor-only'])('keeps the own document condition through %s', async mode => {
    const own = await (await source('OWN')).save(), donor = await (await source('DONOR')).save(), before = own.slice();
    const pages = [mode === 'donor-only' ? page(donor, 'donor') : page(own)];
    const bytes = mode === 'pdfx' ? await buildPdfx([{ name: 'Member', pages }], 'Collection', own, 'own') : await buildPdf(pages, own, 'own');
    const output = await load(bytes); expect(condition(output.catalog)).toBe('OWN'); expect(own).toEqual(before);
  });
  it('does not adopt a donor document default when the own document declares none', async () => {
    const own = await (await source()).save(), donor = await (await source('DONOR')).save();
    const output = await load(await buildPdf([page(donor, 'donor')], own, 'own'));
    expect(condition(output.catalog)).toBeUndefined();
  });
  it('retains an explicit page condition on its physical page after reorder and donor insertion', async () => {
    const own = await (await source('OWN', 'OWN-PAGE')).save(), donor = await (await source('DONOR', 'DONOR-PAGE')).save();
    const output = await load(await buildPdf([page(own, 'own', 1), page(donor, 'donor', 1), page(own)], own, 'own'));
    expect(condition(output.catalog)).toBe('OWN');
    expect(output.getPages().map(p => condition(p.node))).toEqual(['OWN-PAGE', 'DONOR-PAGE', undefined]);
  });
  it('removing a page does not remove the document condition or move its page override', async () => {
    const own = await (await source('OWN', 'REMOVED-PAGE')).save();
    const output = await load(await buildPdf([page(own)], own, 'own'));
    expect(condition(output.catalog)).toBe('OWN'); expect(condition(output.getPage(0).node)).toBeUndefined();
  });
  it('retains root identity across catalog/page sharing and a cycle after serialization', async () => {
    const doc = await source('OWN'), root = doc.catalog.lookup(N('OutputIntents'), PDFArray), ref = doc.context.register(root);
    doc.catalog.set(N('OutputIntents'), ref); doc.getPage(0).node.set(N('OutputIntents'), ref);
    root.lookup(0, PDFDict).set(N('IntentSet'), ref);
    const own = await doc.save(), output = await load(await buildPdf([page(own), page(own)], own, 'own'));
    const outputRef = output.catalog.get(N('OutputIntents'));
    expect(output.getPage(0).node.get(N('OutputIntents'))).toEqual(outputRef);
    expect(output.getPage(1).node.get(N('OutputIntents'))).toEqual(outputRef);
    expect(output.catalog.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict).get(N('IntentSet'))).toEqual(outputRef);
  });
  it.each(['document', 'page'])('refuses a malformed present %s array before producing output', async kind => {
    const doc = await source('OWN');
    (kind === 'document' ? doc.catalog : doc.getPage(0).node).set(N('OutputIntents'), PDFString.of('not an array'));
    const bytes = await doc.save(), before = bytes.slice();
    await expect(buildPdf([page(bytes)], bytes, 'own')).rejects.toThrow(); expect(bytes).toEqual(before);
  });
});
