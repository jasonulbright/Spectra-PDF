import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { carryOptionalContent } from '../src/renderer/lib/optional-content-carry';
const N = PDFName.of;
async function fixture(name = 'source') {
  const doc = await PDFDocument.create({ updateMetadata: false }), ctx = doc.context, p = doc.addPage([300, 700]);
  const group = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
  p.node.set(N('Resources'), ctx.obj({ Properties: { Layer: group } }));
  p.node.set(N('Contents'), ctx.register(ctx.stream('/OC /Layer BDC 0 0 10 10 re f EMC')));
  const config = ctx.obj({ BaseState: 'ON', OFF: [group], Order: [group] });
  const props = ctx.obj({ OCGs: [group], D: config }); doc.catalog.set(N('OCProperties'), props);
  return { doc, p, ctx, group, config, props };
}
async function carry(docs: PDFDocument[]) {
  const output = await PDFDocument.create({ updateMetadata: false }), sources = [];
  for (const doc of docs) {
    const source = await PDFDocument.load(await doc.save(), { updateMetadata: false });
    const pages = await output.copyPages(source, source.getPageIndices()); pages.forEach(p => output.addPage(p));
    sources.push({ doc: source, pairs: pages.map((outPage, srcIndex) => ({ srcIndex, outPage })) });
  }
  const result = carryOptionalContent(output, sources, sources[0]);
  if (result.properties) output.catalog.set(N('OCProperties'), output.context.getObjectRef(result.properties) ?? result.properties);
  return PDFDocument.load(await output.save(), { updateMetadata: false });
}
const properties = (doc: PDFDocument) => doc.catalog.lookup(N('OCProperties'), PDFDict);
const groupAt = (doc: PDFDocument, page = 0) => doc.getPage(page).node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).get(N('Layer')) as PDFRef;
describe('independent optional-content boundaries', () => {
  it('control: preserves a hidden group by actual rendered identity', async () => {
    const f = await fixture(), out = await carry([f.doc]);
    expect(properties(out).lookup(N('D'), PDFDict).lookup(N('OFF'), PDFArray).asArray()).toContainEqual(groupAt(out));
  });
  it('keeps absent usage groups empty rather than inventing automatic state changes', async () => {
    const a = await fixture('first'), b = await fixture('second');
    a.config.set(N('AS'), a.ctx.obj([{ Event: 'View', Category: ['Zoom'] }]));
    const out = await carry([a.doc, b.doc]);
    const application = properties(out).lookup(N('D'), PDFDict).lookup(N('AS'), PDFArray).lookup(0, PDFDict);
    // Table 101: the default is empty, not all groups. This replaces an
    // incorrect reviewer premise; the original failing assertion is retained.
    const groups = application.lookupMaybe(N('OCGs'), PDFArray);
    expect(groups?.asArray() ?? []).toEqual([]);
  });
  it('keeps an explicit usage application scoped to its actual source groups', async () => {
    const a = await fixture('first'), b = await fixture('second');
    a.config.set(N('AS'), a.ctx.obj([{ Event: 'View', Category: ['Zoom'], OCGs: [a.group] }]));
    const out = await carry([a.doc, b.doc]);
    expect(properties(out).lookup(N('D'), PDFDict).lookup(N('AS'), PDFArray).lookup(0, PDFDict).lookup(N('OCGs'), PDFArray).asArray()).toEqual([groupAt(out)]);
  });
  it('retains unknown properties-root data rather than dropping it', async () => {
    const f = await fixture(); f.props.set(N('Private'), PDFString.of('root payload'));
    const out = await carry([f.doc]);
    expect(properties(out).lookup(N('Private'), PDFString).decodeText()).toBe('root payload');
  });
  it('preserves one indirect payload shared by two configuration fields', async () => {
    const f = await fixture(), shared = f.ctx.register(f.ctx.obj({ Label: PDFString.of('shared') }));
    f.config.set(N('First'), shared); f.config.set(N('Second'), shared);
    const out = await carry([f.doc]), config = properties(out).lookup(N('D'), PDFDict);
    expect(config.get(N('First'))).toBeInstanceOf(PDFRef);
    expect(config.get(N('First'))).toEqual(config.get(N('Second')));
  });
  it('binds an extension edge to the group the page actually renders', async () => {
    const f = await fixture(); f.config.set(N('PrivateGroup'), f.group);
    const out = await carry([f.doc]);
    expect(properties(out).lookup(N('D'), PDFDict).get(N('PrivateGroup'))).toEqual(groupAt(out));
  });
  it('refuses a rendered group missing from the required registry', async () => {
    const f = await fixture(), unregistered = f.ctx.register(f.ctx.obj({ Type: 'OCG', Name: PDFString.of('unregistered') }));
    f.p.node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).set(N('Missing'), unregistered);
    f.p.node.set(N('Contents'), f.ctx.register(f.ctx.stream('/OC /Missing BDC 0 0 10 10 re f EMC')));
    await expect(carry([f.doc])).rejects.toThrow('verif');
  });
  it('validates a direct membership dictionary rather than only indirect dictionaries', async () => {
    const f = await fixture();
    f.p.node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).set(N('Layer'), f.ctx.obj({ Type: 'OCMD', OCGs: [f.group], VE: ['Not', f.group, f.group] }));
    await expect(carry([f.doc])).rejects.toThrow('verif');
  });
  it('preserves a valid state-relative alternate on an unchanged single source', async () => {
    const f = await fixture(); f.props.set(N('Configs'), f.ctx.obj([{ Name: PDFString.of('Keep current choices'), BaseState: 'Unchanged', ON: [f.group] }]));
    const out = await carry([f.doc]), config = properties(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict);
    expect(config.lookup(N('BaseState'))).toBe(N('Unchanged'));
    expect(config.lookup(N('ON'), PDFArray).get(0)).toEqual(groupAt(out));
  });
  it('inherits the source default Order when an alternate omits Order', async () => {
    const f = await fixture(); f.props.set(N('Configs'), f.ctx.obj([{ Name: PDFString.of('Inherited presentation') }]));
    const out = await carry([f.doc]);
    const alternate = properties(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict);
    expect(alternate.has(N('Order'))).toBe(false);
    expect(properties(out).lookup(N('D'), PDFDict).lookup(N('Order'), PDFArray).asArray()).toEqual([groupAt(out)]);
  });
  it('retains an explicit empty alternate radio list instead of inheriting default restrictions', async () => {
    const f = await fixture(); f.config.set(N('RBGroups'), f.ctx.obj([[f.group]]));
    f.props.set(N('Configs'), f.ctx.obj([{ Name: PDFString.of('Unlocked radio choices'), RBGroups: [] }]));
    const out = await carry([f.doc]);
    expect(properties(out).lookup(N('D'), PDFDict).lookup(N('RBGroups'), PDFArray).size()).toBe(1);
    expect(properties(out).lookup(N('Configs'), PDFArray).lookup(0, PDFDict).lookup(N('RBGroups'), PDFArray).size()).toBe(0);
  });
  it('does not erase a real ListMode conflict as though it were merely a cosmetic label', async () => {
    const a = await fixture('first'), b = await fixture('second');
    a.config.set(N('ListMode'), N('VisiblePages')); b.config.set(N('ListMode'), N('AllPages'));
    await expect(carry([a.doc, b.doc])).rejects.toThrow('verif');
  });
  it('binds a properties extension to the actual recomposed default configuration', async () => {
    const f = await fixture(), config = f.ctx.register(f.config);
    f.props.set(N('D'), config); f.props.set(N('DefaultAlias'), config);
    const out = await carry([f.doc]), props = properties(out);
    expect(props.lookup(N('DefaultAlias'))).toBe(props.lookup(N('D')));
  });
  it('binds a properties self-reference to the actual returned root', async () => {
    const f = await fixture(), root = f.ctx.register(f.props);
    f.doc.catalog.set(N('OCProperties'), root); f.props.set(N('Self'), root);
    const out = await carry([f.doc]), props = properties(out);
    expect(props.lookup(N('Self'))).toBe(props);
  });
  it('binds an opaque alias to the shared layer across multiple copied pages', async () => {
    const f = await fixture(); f.config.set(N('PrivateGroup'), f.group);
    const source = await PDFDocument.load(await f.doc.save(), { updateMetadata: false });
    const out = await PDFDocument.create({ updateMetadata: false });
    const a = (await out.copyPages(source, [0]))[0], b = (await out.copyPages(source, [0]))[0]; out.addPage(a); out.addPage(b);
    const carried = { doc: source, pairs: [{ srcIndex: 0, outPage: a }, { srcIndex: 0, outPage: b }] };
    const result = carryOptionalContent(out, [carried], carried);
    const group = groupAt(out, 0);
    expect(groupAt(out, 1)).toEqual(group);
    expect(result.properties!.lookup(N('D'), PDFDict).get(N('PrivateGroup'))).toEqual(group);
  });
  it('binds a configuration alias to its actual rebuilt state array', async () => {
    const f = await fixture(), off = f.ctx.register(f.config.lookup(N('OFF'), PDFArray));
    f.config.set(N('OFF'), off); f.config.set(N('PrivateOff'), off);
    const out = await carry([f.doc]), config = properties(out).lookup(N('D'), PDFDict);
    expect(config.lookup(N('PrivateOff')) === config.lookup(N('OFF'))).toBe(true);
  });
  it('accepts non-layer marked-content properties without inventing optional content', async () => {
    const f = await fixture();
    f.props.delete(N('Configs'));
    f.p.node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).set(N('Text'), f.ctx.obj({ Lang: PDFString.of('en-US'), ActualText: PDFString.of('plain') }));
    const out = await carry([f.doc]);
    expect(properties(out).lookup(N('OCGs'), PDFArray).size()).toBe(1);
  });
  it('exports the actual membership identity for downstream action references', async () => {
    const f = await fixture(), membership = f.ctx.register(f.ctx.obj({ Type: 'OCMD', OCGs: [f.group], P: 'AnyOn' }));
    f.p.node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).set(N('Layer'), membership);
    const source = await PDFDocument.load(await f.doc.save(), { updateMetadata: false });
    const sourceMembership = source.getPage(0).node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).get(N('Layer')) as PDFRef;
    const out = await PDFDocument.create({ updateMetadata: false }), page = (await out.copyPages(source, [0]))[0]; out.addPage(page);
    const carried = { doc: source, pairs: [{ srcIndex: 0, outPage: page }] };
    const result = carryOptionalContent(out, [carried], carried);
    const actual = page.node.lookup(N('Resources'), PDFDict).lookup(N('Properties'), PDFDict).get(N('Layer')) as PDFRef;
    expect(result.identities.get(source)?.get(sourceMembership.tag)).toEqual([actual]);
  });
  it('preserves explicit ON targets and their shared state-array identity', async () => {
    const f = await fixture(); f.config.set(N('OFF'), f.ctx.obj([]));
    const on = f.ctx.register(f.ctx.obj([f.group])); f.config.set(N('ON'), on); f.config.set(N('PrivateOn'), on);
    const out = await carry([f.doc]), config = properties(out).lookup(N('D'), PDFDict);
    expect(config.lookup(N('ON'), PDFArray).asArray()).toEqual([groupAt(out)]);
    expect(config.lookup(N('PrivateOn')) === config.lookup(N('ON'))).toBe(true);
  });
  it('does not equate extension edges to different layers just because their dictionaries match', async () => {
    const a = await fixture('same'), b = await fixture('same');
    a.props.set(N('PrivateGroup'), a.group); b.props.set(N('PrivateGroup'), b.group);
    await expect(carry([a.doc, b.doc])).rejects.toThrow('verif');
  });
  it('can agree on an extension edge to the actual composed root', async () => {
    const a = await fixture('same'), b = await fixture('same');
    for (const f of [a, b]) { const ref = f.ctx.register(f.props); f.doc.catalog.set(N('OCProperties'), ref); f.props.set(N('Self'), ref); }
    const out = await carry([a.doc, b.doc]), props = properties(out);
    expect(props.lookup(N('Self')) === props).toBe(true);
    expect(props.lookup(N('OCGs'), PDFArray).size()).toBe(2);
  });
  it('refuses a shared array when default and alternate composition genuinely require different contents', async () => {
    const f = await fixture(), other = f.ctx.register(f.ctx.obj({ Type: 'OCG', Name: PDFString.of('other') }));
    f.props.set(N('OCGs'), f.ctx.obj([f.group, other]));
    const shared = f.ctx.register(f.ctx.obj([f.group]));
    f.config.set(N('BaseState'), N('OFF')); f.config.set(N('OFF'), shared);
    // Default hides both; alternate hides only the named first group. The
    // source's shared array cannot stand for both recomposed arrays.
    f.props.set(N('Configs'), f.ctx.obj([{ BaseState: 'ON', OFF: shared }]));
    await expect(carry([f.doc])).rejects.toThrow('verif');
  });
});
