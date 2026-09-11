import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
const N = PDFName.of;
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
async function fixture(header = '1.7', level?: number, privateValue?: number) {
  const doc = await PDFDocument.create({ updateMetadata: false }); doc.addPage([300, 700]); doc.addPage([400, 500]);
  if (level !== undefined) {
    const entry = doc.context.obj({ BaseVersion: '1.7', ExtensionLevel: level });
    if (privateValue !== undefined) entry.set(N('Private'), PDFNumber.of(privateValue));
    doc.catalog.set(N('Extensions'), doc.context.obj({ ADBE: entry }));
  }
  const bytes = await doc.save(); bytes.set(new TextEncoder().encode(`%PDF-${header}`), 0); return bytes;
}
const page = (bytes: Uint8Array, sourceKey: string, pageIndex = 0) => ({ bytes, sourceKey, pageIndex });
const modes = ['pdf', 'pdfx'] as const;
const build = (mode: typeof modes[number], pages: ReturnType<typeof page>[], own?: Uint8Array) => mode === 'pdf'
  ? buildPdf(pages, own, own ? 'own' : undefined)
  : buildPdfx([{ name: 'member', pages }], 'Collection', own, own ? 'own' : undefined);
const header = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 8));

describe('document format declarations at both builder exits', () => {
  it.each(modes)('%s preserves the owner requirement when no owner page remains', async mode => {
    const own = await fixture('2.0', 4), donor = await fixture();
    const bytes = await build(mode, [page(donor, 'donor')], own), output = await load(bytes);
    expect(header(bytes)).toBe('%PDF-2.0'); expect(output.getPageCount()).toBe(1);
    expect(output.catalog.lookup(N('Extensions'), PDFDict).lookup(N('ADBE'), PDFDict).lookup(N('ExtensionLevel'), PDFNumber).asNumber()).toBe(4);
  });
  it.each(modes.flatMap(mode => [false, true].map(reverse => [mode, reverse] as const)))('%s keeps donor requirements in either order (%s)', async (mode, reverse) => {
    const own = await fixture('1.7', 3), donor = await fixture('2.0', 8);
    const pages = [page(own, 'own', 1), page(donor, 'donor')]; if (reverse) pages.reverse();
    const bytes = await build(mode, pages, own), output = await load(bytes);
    expect(header(bytes)).toBe('%PDF-2.0'); expect(output.getPageCount()).toBe(2);
    const entries = output.catalog.lookup(N('Extensions'), PDFDict).lookup(N('ADBE'), PDFArray);
    expect(entries.asArray().map(entry => (entry as PDFDict).lookup(N('ExtensionLevel'), PDFNumber).asNumber()).sort()).toEqual([3, 8]);
  });
  it.each(modes)('%s carries all contributing format requirements without an owner', async mode => {
    const bytes = await fixture('2.0', 8), result = await build(mode, [page(bytes, 'member')]);
    expect(header(result)).toBe('%PDF-2.0');
    expect((await load(result)).catalog.lookup(N('Extensions'))).toBeInstanceOf(PDFDict);
  });
  it.each(modes)('%s stays ordinary 1.7 when no source requires more', async mode => {
    const own = await fixture(), bytes = await build(mode, [page(own, 'own')], own);
    expect(header(bytes)).toBe('%PDF-1.7');
    expect((await load(bytes)).catalog.lookup(N('Extensions'))).toBeUndefined();
  });
  it.each(modes)('%s refuses conflicting same-identity extensions and leaves both inputs exact', async mode => {
    const own = await fixture('1.7', 3, 1), donor = await fixture('1.7', 3, 2), before = [own.slice(), donor.slice()];
    await expect(build(mode, [page(own, 'own'), page(donor, 'donor')], own)).rejects.toThrow();
    expect(own).toEqual(before[0]); expect(donor).toEqual(before[1]);
  });
  it.each(modes)('%s retains a page-specific output-intent requirement and data', async mode => {
    const doc = await load(await fixture('2.0'));
    doc.getPage(0).node.set(N('OutputIntents'), doc.context.obj([doc.context.register(doc.context.obj({
      Type: 'OutputIntent', S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('local condition'),
    }))]));
    const source = await doc.save(); source.set(new TextEncoder().encode('%PDF-2.0'), 0);
    const bytes = await build(mode, [page(source, 'own')], source), output = await load(bytes);
    expect(header(bytes)).toBe('%PDF-2.0');
    expect(output.getPage(0).node.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict).lookup(N('OutputConditionIdentifier'), PDFString).decodeText()).toBe('local condition');
  });
});
