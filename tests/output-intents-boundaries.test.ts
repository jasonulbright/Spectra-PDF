import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { copyOutputIntents } from '../src/renderer/lib/output-intents-carry';
const N = PDFName.of;
async function fixture() {
  const source = await PDFDocument.create({ updateMetadata: false }), output = await PDFDocument.create({ updateMetadata: false });
  source.addPage(); output.addPage();
  const item = source.context.obj({ S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('CGATS TR 001') });
  const root = source.context.obj([source.context.register(item)]), ref = source.context.register(root);
  source.catalog.set(N('OutputIntents'), ref);
  return { source, output, item, root, ref };
}
describe('independent output-intent graph boundaries', () => {
  it('does not interpret arbitrary spectral colourant names as action keys', async () => {
    const { source, output, item, ref } = await fixture(), spectra = source.context.obj({});
    for (const name of ['A', 'Next', 'Parent', 'JS']) spectra.set(N(name), source.context.register(source.context.stream('opaque spectral bytes')));
    item.set(N('SpectralData'), spectra);
    const copied = copyOutputIntents(output, source, ref)!.lookup(0, PDFDict).lookup(N('SpectralData'), PDFDict);
    for (const name of ['A', 'Next', 'Parent', 'JS']) expect(copied.lookup(N(name))).toBeInstanceOf(PDFRawStream);
  });
  it('keeps a same-spelled scalar extension without inventing action semantics', async () => {
    const { source, output, item, ref } = await fixture(); item.set(N('A'), PDFNumber.of(7));
    expect(copyOutputIntents(output, source, ref)!.lookup(0, PDFDict).lookup(N('A'), PDFNumber).asNumber()).toBe(7);
  });
  it('refuses an actual action dictionary with optional Type omitted', async () => {
    const { source, output, item, ref } = await fixture();
    item.set(N('Extension'), source.context.obj({ S: 'Launch', F: PDFString.of('not-executed.exe') }));
    expect(() => copyOutputIntents(output, source, ref)).toThrow();
  });
  it('treats indirect null optional fields like direct null', async () => {
    const { source, output, item, ref } = await fixture();
    for (const key of ['Type', 'Info', 'DestOutputProfile', 'MixingHints', 'SpectralData', 'DestOutputProfileRef']) item.set(N(key), source.context.register(PDFNull));
    expect(copyOutputIntents(output, source, ref)).toBeInstanceOf(PDFArray);
  });
  it('preserves a pure metadata stream shared with the source catalog', async () => {
    const { source, output, item, ref } = await fixture();
    const metadata = source.context.register(source.context.stream('opaque metadata packet', { Type: 'Metadata', Subtype: 'XML' }));
    source.catalog.set(N('Metadata'), metadata); item.set(N('ExtensionMetadata'), metadata);
    expect(copyOutputIntents(output, source, ref)!.lookup(0, PDFDict).lookup(N('ExtensionMetadata'))).toBeInstanceOf(PDFRawStream);
  });
  it('bounds aggregate string bytes as well as streams', async () => {
    const { source, output, item, ref } = await fixture(); item.set(N('Extension'), PDFString.of('x'.repeat(33 * 1024 * 1024)));
    expect(() => copyOutputIntents(output, source, ref)).toThrow();
  });
  it('preserves a cycle returning to the supplied root array without forking it', async () => {
    const { source, output, item, ref } = await fixture(); item.set(N('IntentSet'), ref);
    const copied = copyOutputIntents(output, source, ref)!;
    expect(copied.lookup(0, PDFDict).lookup(N('IntentSet'))).toBe(copied);
  });
  it('control: real catalog and page references remain refused', async () => {
    for (const target of ['catalog', 'page']) {
      const { source, output, item, ref } = await fixture();
      item.set(N('Extension'), target === 'catalog' ? source.context.trailerInfo.Root! : source.getPage(0).ref);
      expect(() => copyOutputIntents(output, source, ref)).toThrow();
    }
  });
  it('preserves null semantics for unresolved optional references through serialization', async () => {
    const { source, output, item, ref } = await fixture();
    for (const key of ['Type', 'Info', 'DestOutputProfile', 'MixingHints', 'SpectralData', 'DestOutputProfileRef']) item.set(N(key), PDFRef.of(99999));
    const copied = copyOutputIntents(output, source, ref)!;
    output.catalog.set(N('OutputIntents'), output.context.getObjectRef(copied) ?? copied);
    const reopened = await PDFDocument.load(await output.save(), { updateMetadata: false });
    const intent = reopened.catalog.lookup(N('OutputIntents'), PDFArray).lookup(0, PDFDict);
    for (const key of ['Type', 'Info', 'DestOutputProfile', 'MixingHints', 'SpectralData', 'DestOutputProfileRef']) expect(intent.lookup(N(key))).toBeUndefined();
  });
  it('counts repeated reference edges against the work bound, not only unique objects', async () => {
    const { source, output, item, ref } = await fixture();
    const shared = source.context.register(PDFString.of('one allocation'));
    item.set(N('Extension'), source.context.obj(Array.from({ length: 6000 }, () => shared)));
    expect(() => copyOutputIntents(output, source, ref)).toThrow();
  });
  it('control: a bounded repeated-reference array preserves sharing', async () => {
    const { source, output, item, ref } = await fixture();
    const shared = source.context.register(PDFString.of('one allocation'));
    item.set(N('Extension'), source.context.obj(Array.from({ length: 100 }, () => shared)));
    const array = copyOutputIntents(output, source, ref)!.lookup(0, PDFDict).lookup(N('Extension'), PDFArray);
    expect(array.size()).toBe(100);
    expect(array.get(0)).toBe(array.get(99));
  });
});
