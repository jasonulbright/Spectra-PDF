import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNull, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from 'pdf-lib';
import { DOMParser } from '@xmldom/xmldom';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import { carryDocumentMetadata } from '../src/renderer/lib/metadata-carry';
import { PDFX_VERSION } from '../src/renderer/lib/pdfx-format';
import { processMetadata } from '../src/renderer/lib/metadata-process';
import { metadataInput } from '../src/renderer/lib/metadata-stream';
const N = PDFName.of.bind(PDFName);
const packet = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:m="https://example.invalid/matter/" pdf:Producer="Original"><m:MatterID>Case-2026-143</m:MatterID><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original title</rdf:li><rdf:li xml:lang="fr">Titre original</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));
afterEach(() => vi.unstubAllGlobals());
async function source(xml = packet, compressed = true) {
  const pdf = await PDFDocument.create({ updateMetadata: false }); pdf.addPage([300, 700]); pdf.addPage([400, 700]);
  const encoded = new TextEncoder().encode(xml);
  const stream = compressed ? pdf.context.flateStream(encoded, { Type: 'Metadata', Subtype: 'XML', Private: PDFString.of('opaque'), DL: encoded.length }) : pdf.context.stream(encoded, { Type: 'Metadata', Subtype: 'XML' });
  pdf.catalog.set(N('Metadata'), pdf.context.register(stream)); return pdf;
}
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
function streamOf(pdf: PDFDocument) { const stream = pdf.catalog.lookup(N('Metadata')); expect(stream).toBeInstanceOf(PDFRawStream); return stream as PDFRawStream; }
function xmlOf(pdf: PDFDocument) { return new TextDecoder().decode(decodePDFRawStream(streamOf(pdf)).decode()); }
const pages = (bytes: Uint8Array, key = 'own') => [0, 1].map(pageIndex => ({ bytes, pageIndex, sourceKey: key }));
describe('document XMP carry through actual isolated parser worker', () => {
  it('runs the decoded packet core directly as well as in the worker', async () => {
    const pdf = await load(await (await source()).save());
    await expect(processMetadata({ input: metadataInput(streamOf(pdf)), overrides: {} })).resolves.toEqual({ changed: false });
  });
  it.each(['pdf', 'pdfx', 'donor-only'])('preserves own packet and reconciles generated identities through %s', async mode => {
    const bytes = await (await source()).save(), before = bytes.slice(), donor = await (await source(packet.replace('Case-2026-143', 'DONOR'))).save();
    const output = mode === 'pdfx' ? await buildPdfx([{ name: 'Member', pages: pages(bytes) }], 'Collection & <title>', bytes, 'own') : await buildPdf(mode === 'pdf' ? pages(bytes) : pages(donor, 'donor'), bytes, 'own');
    const pdf = await load(output), xml = xmlOf(pdf), dom = new DOMParser().parseFromString(xml, 'text/xml');
    expect(xml).toContain('Case-2026-143'); expect(xml).not.toContain('DONOR'); expect(xml).toContain('Titre original');
    expect(dom.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description').item(0)!.getAttributeNS('http://ns.adobe.com/pdf/1.3/', 'Producer')).toBe(`PDFX ${PDFX_VERSION}`);
    expect(xml).toContain('xpacket'); expect(streamOf(pdf).dict.lookup(N('Private'), PDFString).decodeText()).toBe('opaque');
    expect(bytes).toEqual(before);
    if (mode === 'pdfx') {
      expect(dom.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title').item(0)!.textContent).toContain('Collection & <title>');
      expect(xml).toContain('PDFX');
    } else expect(xml).toContain('Original title');
  });
  it('keeps the original compressed bytes/filter when overrides are a no-op', async () => {
    const src = await source(), out = await PDFDocument.create({ updateMetadata: false }); out.addPage();
    const original = streamOf(await load(await src.save()));
    await carryDocumentMetadata(out, await load(await src.save()), {});
    expect(streamOf(out).getContents()).toEqual(original.getContents());
    expect(streamOf(out).dict.get(N('Filter'))).toEqual(original.dict.get(N('Filter')));
    expect(xmlOf(out)).toBe(packet);
  });
  it('does not inherit a donor packet when own metadata is absent', async () => {
    const own = await PDFDocument.create({ updateMetadata: false }); own.addPage();
    const donor = await (await source()).save();
    const out = await load(await buildPdf(pages(donor, 'donor'), await own.save(), 'own'));
    expect(out.catalog.has(N('Metadata'))).toBe(false);
  });
  it.each([undefined, PDFNull, PDFRef.of(999999)])('treats absent/null/nonexistent references as absent %#', async metadata => {
    const src = await PDFDocument.create({ updateMetadata: false }), out = await PDFDocument.create(); src.addPage();
    if (metadata) src.catalog.set(N('Metadata'), metadata);
    await expect(carryDocumentMetadata(out, src, {})).resolves.toBeUndefined(); expect(out.catalog.has(N('Metadata'))).toBe(false);
  });
  it.each(['<r/>', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///private">]><r>&e;</r>', packet.replace('</rdf:RDF>', '')])('refuses malformed/non-XMP packets before publishing %#', async xml => {
    const src = await load(await (await source(xml)).save()), out = await PDFDocument.create();
    const sentinel = PDFString.of('untouched'); out.catalog.set(N('Metadata'), sentinel);
    await expect(carryDocumentMetadata(out, src, {})).rejects.toThrow(); expect(out.catalog.get(N('Metadata'))).toBe(sentinel);
  });
  it('refuses wrong metadata types, external stream references and page-graph attributes', async () => {
    for (const change of ['not-stream', 'subtype', 'external', 'page']) {
      const src = await load(await (await source()).save()), out = await PDFDocument.create();
      if (change === 'not-stream') src.catalog.set(N('Metadata'), PDFString.of('packet'));
      else streamOf(src).dict.set(N(change === 'subtype' ? 'Subtype' : change === 'external' ? 'F' : 'Private'), change === 'subtype' ? N('Image') : change === 'external' ? PDFString.of('file:///private') : src.getPage(0).ref);
      await expect(carryDocumentMetadata(out, src, {})).rejects.toThrow(); expect(out.catalog.has(N('Metadata'))).toBe(false);
    }
  });
});
