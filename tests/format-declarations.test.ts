import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHeader, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { carryFormatDeclarations, saveWithFormatDeclarations } from '../src/renderer/lib/format-declarations';
const N = PDFName.of;
async function document(header = '1.7', catalog?: string) {
  const doc = await PDFDocument.create({ updateMetadata: false }); doc.addPage();
  doc.context.header = PDFHeader.forVersion(...header.split('.').map(Number) as [number, number]);
  if (catalog) doc.catalog.set(N('Version'), N(catalog));
  return doc;
}
function extension(doc: PDFDocument, level = 3, prefix = 'ADBE', base = '1.7') {
  const item = doc.context.obj({ BaseVersion: base, ExtensionLevel: level });
  doc.catalog.set(N('Extensions'), doc.context.obj({ [prefix]: item }));
  return item;
}
async function saved(sources: PDFDocument[], output?: PDFDocument) {
  output ??= await document(); carryFormatDeclarations(output, sources);
  const bytes = await saveWithFormatDeclarations(output);
  return { bytes, output: await PDFDocument.load(bytes, { updateMetadata: false }) };
}
describe('format declarations are source requirements, not donor metadata', () => {
  it.each([['2.0', undefined], ['1.7', '2.0'], ['2.0', '1.7']])('preserves effective header=%s catalog=%s in saved bytes', async (header, catalog) => {
    const { bytes, output } = await saved([await document(header, catalog)]);
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-2.0');
    expect(output.catalog.get(N('Version'))).toBe(N('2.0')); expect(output.getPageCount()).toBe(1);
  });
  it('does not invent a 2.0 declaration for an ordinary older source', async () => {
    const { bytes, output } = await saved([await document('1.4')]);
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-1.7');
    expect(output.catalog.get(N('Version'))).toBeUndefined(); expect(output.catalog.get(N('Extensions'))).toBeUndefined();
  });
  it.each([false, true])('retains a donor requirement in either input order (reversed=%s)', async reverse => {
    const own = await document(), donor = await document('2.0');
    const result = await saved(reverse ? [donor, own] : [own, donor]);
    expect(result.output.catalog.get(N('Version'))).toBe(N('2.0'));
  });
  it('retains declared base version, extension level and opaque direct fields', async () => {
    const source = await document(), item = extension(source);
    item.set(N('URL'), PDFString.of('https://example.invalid/read-only-reference'));
    item.set(N('ExtensionRevision'), PDFHexString.fromText('revision α'));
    item.set(N('Private'), source.context.obj({ Flag: true, Sequence: [1, 2] }));
    const result = (await saved([source])).output.catalog.lookup(N('Extensions'), PDFDict).lookup(N('ADBE'), PDFDict);
    expect(result.lookup(N('BaseVersion'))).toBe(N('1.7'));
    expect(result.lookup(N('ExtensionLevel'), PDFNumber).asNumber()).toBe(3);
    expect(result.lookup(N('URL'), PDFString).asString()).toBe(item.lookup(N('URL'), PDFString).asString());
    expect(result.lookup(N('ExtensionRevision'), PDFHexString).decodeText()).toBe('revision α');
    expect(result.lookup(N('Private'), PDFDict).lookup(N('Sequence'), PDFArray).size()).toBe(2);
  });
  it('preserves an array and multiple extension levels rather than selecting the highest', async () => {
    const a = await document(), b = await document(); extension(a, 3); extension(b, 8);
    const { output, bytes } = await saved([a, b]);
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-2.0');
    const array = output.catalog.lookup(N('Extensions'), PDFDict).lookup(N('ADBE'), PDFArray);
    expect(array.asArray().map(v => (v as PDFDict).lookup(N('ExtensionLevel'), PDFNumber).asNumber())).toEqual([3, 8]);
  });
  it('keeps an originally array-valued single declaration an array', async () => {
    const source = await document('2.0'), item = extension(source);
    source.catalog.lookup(N('Extensions'), PDFDict).set(N('ADBE'), source.context.obj([item]));
    expect((await saved([source])).output.catalog.lookup(N('Extensions'), PDFDict).lookup(N('ADBE'))).toBeInstanceOf(PDFArray);
  });
  it('deduplicates identical declarations regardless of dictionary insertion order', async () => {
    const a = await document(), b = await document(); extension(a);
    b.catalog.set(N('Extensions'), b.context.obj({ ADBE: { ExtensionLevel: 3, BaseVersion: '1.7' } }));
    expect((await saved([a, b])).output.catalog.lookup(N('Extensions'), PDFDict).lookup(N('ADBE'))).toBeInstanceOf(PDFDict);
  });
  it.each([false, true])('refuses same-identity conflicting data without publishing roots (reversed=%s)', async reverse => {
    const a = await document(), b = await document(), output = await document();
    extension(a).set(N('Private'), PDFNumber.of(1)); extension(b).set(N('Private'), PDFNumber.of(2));
    expect(() => carryFormatDeclarations(output, reverse ? [b, a] : [a, b])).toThrow();
    expect(output.catalog.get(N('Extensions'))).toBeUndefined(); expect(output.catalog.get(N('Version'))).toBeUndefined();
  });
  it('keeps independent developer prefixes independent', async () => {
    const a = await document(), b = await document(); extension(a, 3, 'ADBE'); extension(b, 7, 'ISO_');
    const root = (await saved([a, b])).output.catalog.lookup(N('Extensions'), PDFDict);
    expect(root.keys().map(k => k.decodeText())).toEqual(['ADBE', 'ISO_']);
  });
  it.each(['root', 'entry', 'field'])('refuses indirection in a declared-direct %s', async location => {
    const source = await document(), item = extension(source), root = source.catalog.lookup(N('Extensions'), PDFDict);
    if (location === 'root') source.catalog.set(N('Extensions'), source.context.register(root));
    if (location === 'entry') root.set(N('ADBE'), source.context.register(item));
    if (location === 'field') item.set(N('ExtensionLevel'), source.context.register(PDFNumber.of(3)));
    await expect(saved([source])).rejects.toThrow();
  });
  it.each(['root-kind', 'base-kind', 'level-kind', 'fraction', 'unknown-version', 'url-kind', 'type-kind', 'wrong-type', 'base-exceeds-header'])('refuses malformed %s', async variant => {
    const source = await document(), item = extension(source);
    if (variant === 'root-kind') source.catalog.set(N('Extensions'), PDFString.of('bad'));
    if (variant === 'base-kind') item.set(N('BaseVersion'), PDFNumber.of(1.7));
    if (variant === 'level-kind') item.set(N('ExtensionLevel'), PDFString.of('3'));
    if (variant === 'fraction') item.set(N('ExtensionLevel'), PDFNumber.of(1.5));
    if (variant === 'unknown-version') source.catalog.set(N('Version'), N('9.9'));
    if (variant === 'url-kind') item.set(N('URL'), PDFNumber.of(5));
    if (variant === 'type-kind') item.set(N('Type'), PDFString.of('DeveloperExtensions'));
    if (variant === 'wrong-type') item.set(N('Type'), N('Page'));
    if (variant === 'base-exceeds-header') { source.catalog.set(N('Version'), N('2.0')); item.set(N('BaseVersion'), N('2.0')); }
    await expect(saved([source])).rejects.toThrow();
  });
  it('preserves absent/null catalog-version semantics', async () => {
    for (const value of [PDFNull, PDFRef.of(99999)]) {
      const source = await document(); source.catalog.set(N('Version'), value);
      expect((await saved([source])).output.catalog.get(N('Version'))).toBeUndefined();
    }
  });
  it('raises declared version for actual page output-intent and namespace fields', async () => {
    for (const kind of ['page', 'namespace']) {
      const output = await document();
      if (kind === 'page') output.getPage(0).node.set(N('OutputIntents'), output.context.obj([]));
      else output.catalog.set(N('StructTreeRoot'), output.context.obj({ Type: 'StructTreeRoot', Namespaces: [] }));
      expect((await saved([], output)).output.catalog.get(N('Version'))).toBe(N('2.0'));
    }
  });
  it('bounds direct data before canonicalizing identities', async () => {
    const source = await document(), item = extension(source);
    item.set(N('Private'), PDFString.of('x'.repeat(1024 * 1024 + 1)));
    await expect(saved([source])).rejects.toThrow();
  });
  it('does not exponentially encode nested strings when comparing declarations', async () => {
    const a = await document(), b = await document();
    for (const source of [a, b]) {
      let node = source.context.obj({ Value: PDFString.of('"quoted"') });
      for (let i = 0; i < 25; i++) node = source.context.obj({ Nested: node });
      extension(source).set(N('Private'), node);
    }
    expect((await saved([a, b])).output.catalog.lookup(N('Extensions'))).toBeInstanceOf(PDFDict);
  });
  it('changes only equal-width header bytes after the writer serialized its xrefs', async () => {
    const source = await document('2.0'), output = await document(); carryFormatDeclarations(output, [source]);
    const native = await output.save(), result = await saveWithFormatDeclarations(output);
    expect(result.length).toBe(native.length); expect(result.slice(8)).toEqual(native.slice(8));
    expect(new TextDecoder().decode(result.slice(0, 8))).toBe('%PDF-2.0');
    expect((await PDFDocument.load(result)).getPageCount()).toBe(1);
  });
});
