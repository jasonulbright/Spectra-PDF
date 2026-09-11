import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
import { copyPayload } from '../src/renderer/lib/struct-carry-objects';
const N = PDFName.of;
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
const page = (bytes: Uint8Array, sourceKey = 'own', pageIndex = 0) => ({ bytes, sourceKey, pageIndex });
function elements(doc: PDFDocument) {
  const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict), value = root.lookup(N('K'));
  return { root, list: (value instanceof PDFArray ? value.asArray() : [value]).map(v => doc.context.lookup(v!, PDFDict)) };
}
async function fixture(count = 1) {
  const doc = await PDFDocument.create({ updateMetadata: false }), ctx = doc.context;
  const root = ctx.obj({ Type: 'StructTreeRoot' }), rootRef = ctx.register(root);
  const refs = Array.from({ length: count }, (_, i) => {
    const p = doc.addPage([300, 700]); p.node.set(N('StructParents'), PDFNumber.of(i));
    p.node.set(N('Contents'), ctx.register(ctx.stream('/P <</MCID 0>> BDC 0 0 10 10 re f EMC')));
    return ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: rootRef, Pg: p.ref, K: 0 }));
  });
  root.set(N('K'), ctx.obj(refs)); root.set(N('ParentTree'), ctx.obj({ Nums: refs.flatMap((r, i) => [i, ctx.obj([r])]) }));
  root.set(N('ParentTreeNextKey'), PDFNumber.of(count));
  doc.catalog.set(N('StructTreeRoot'), rootRef); doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
  return { doc, root, refs, elems: refs.map(r => ctx.lookup(r, PDFDict)) };
}
const idBytes = (id: PDFString | PDFHexString) => [...id.asBytes()].map(b => b.toString(16).padStart(2, '0')).join('');

describe('independent complete tag semantics boundaries', () => {
  it('control: an ordinary tagged source retains its content owner', async () => {
    const { doc } = await fixture(), bytes = await doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    expect(elements(output).list[0].get(N('Pg'))).toEqual(output.getPage(0).ref);
    expect(elements(output).list[0].lookup(N('K'), PDFNumber).asNumber()).toBe(0);
  });
  it('compares byte-string IDs by bytes, not hex versus literal spelling', async () => {
    const a = await fixture(), b = await fixture();
    a.elems[0].set(N('ID'), PDFString.of('same')); b.elems[0].set(N('ID'), PDFHexString.of('73616d65'));
    const ab = await a.doc.save(), bb = await b.doc.save();
    const { root, list } = elements(await load(await buildPdf([page(ab), page(bb, 'donor')], ab, 'own')));
    const ids = list.map(e => idBytes(e.lookup(N('ID')) as PDFString | PDFHexString));
    expect(new Set(ids).size).toBe(2);
    const names = root.lookup(N('IDTree'), PDFDict).lookup(N('Names'), PDFArray);
    expect([idBytes(names.lookup(0) as PDFString | PDFHexString), idBytes(names.lookup(2) as PDFString | PDFHexString)]).toEqual([...ids].sort());
  });
  it('does not equate class payloads whose indirect slots spell alike in different sources', async () => {
    const sources = [];
    for (const align of ['Start', 'End']) {
      const f = await fixture(), payload = f.doc.context.register(f.doc.context.obj({ O: 'Layout', TextAlign: align }));
      f.elems[0].set(N('C'), N('Shared'));
      f.root.set(N('ClassMap'), f.doc.context.obj({ Shared: [payload] }));
      sources.push(await f.doc.save());
    }
    const { root, list } = elements(await load(await buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own')));
    const classes = root.lookup(N('ClassMap'), PDFDict);
    expect(list.map(e => classes.lookup(e.lookup(N('C'), PDFName), PDFArray).lookup(0, PDFDict).lookup(N('TextAlign'), PDFName).decodeText())).toEqual(['Start', 'End']);
  });
  it('represents every duplicated bare-MCID page in the forward structure tree', async () => {
    const { doc } = await fixture(), bytes = await doc.save(), output = await load(await buildPdf([page(bytes), page(bytes)], bytes, 'own'));
    const { list } = elements(output), represented = new Set<string>();
    for (const elem of list) {
      const raw = elem.lookup(N('K')), kids = raw instanceof PDFArray ? raw.asArray() : [raw];
      for (const kid of kids) {
        const value = output.context.lookup(kid!);
        if (value instanceof PDFNumber) represented.add((elem.get(N('Pg')) as PDFRef).tag);
        else if (value instanceof PDFDict) represented.add((value.get(N('Pg')) as PDFRef).tag);
      }
    }
    expect([...represented].sort()).toEqual(output.getPages().map(p => p.ref.tag).sort());
  });
  it('retains valid Ref targets after their page content is removed', async () => {
    const f = await fixture(2); f.elems[0].set(N('Ref'), f.doc.context.obj([f.refs[1]]));
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    const target = elements(output).list[0].lookup(N('Ref'), PDFArray).lookup(0);
    expect(target).toBeInstanceOf(PDFDict);
    expect((target as PDFDict).lookup(N('S'))).toBe(N('P'));
  });
  it('retains each source root associated-file payload', async () => {
    const sources = [];
    for (const name of ['own.xml', 'donor.xml']) {
      const f = await fixture(); f.root.set(N('AF'), f.doc.context.obj([f.doc.context.register(f.doc.context.obj({ Type: 'Filespec', F: PDFString.of(name), AFRelationship: 'Data' }))]));
      sources.push(await f.doc.save());
    }
    const output = await load(await buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own'));
    const { root } = elements(output);
    expect(root.lookup(N('AF'), PDFArray).asArray().map(v => output.context.lookup(v, PDFDict).lookup(N('F'), PDFString).decodeText())).toEqual(['own.xml', 'donor.xml']);
  });
  it('charges every repeated reference edge to the payload budget', async () => {
    const source = await PDFDocument.create(), output = await PDFDocument.create();
    const shared = source.context.register(PDFNumber.of(1)), values = source.context.obj(Array.from({ length: 20 }, () => shared));
    expect(() => copyPayload(output, source, values, new Map(), new Set(), { objects: 0, bytes: 0, limitObjects: 10, limitBytes: 1024, fail: () => new Error('budget') })).toThrow('budget');
  });
  it('keeps cross-namespace role mapping targets bound to the role they name', async () => {
    const sources = [];
    for (const target of ['P', 'H1']) {
      const f = await fixture(), ctx = f.doc.context;
      const b = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of(`https://example.invalid/${target}/b`), RoleMapNS: { Local: target } }));
      const a = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of(`https://example.invalid/${target}/a`), RoleMapNS: { Start: [N('Local'), b] } }));
      f.root.set(N('Namespaces'), ctx.obj([a, b])); f.root.set(N('RoleMap'), ctx.obj({ Local: target }));
      f.elems[0].set(N('S'), N('Start')); f.elems[0].set(N('NS'), a);
      sources.push(await f.doc.save());
    }
    const { list } = elements(await load(await buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own')));
    expect(list.map(elem => {
      const ns = elem.lookup(N('NS'), PDFDict), pair = ns.lookup(N('RoleMapNS'), PDFDict).lookup(elem.lookup(N('S'), PDFName), PDFArray);
      return pair.lookup(1, PDFDict).lookup(N('RoleMapNS'), PDFDict).lookup(pair.lookup(0, PDFName));
    })).toEqual([N('P'), N('H1')]);
  });
  it('retains shared attribute-object identity across elements', async () => {
    const f = await fixture(2), shared = f.doc.context.register(f.doc.context.obj({ O: 'Layout', TextAlign: 'Start' }));
    f.elems.forEach(e => e.set(N('A'), shared));
    const bytes = await f.doc.save(), { list } = elements(await load(await buildPdf([page(bytes), page(bytes, 'own', 1)], bytes, 'own')));
    expect(list[0].get(N('A'))).toBeInstanceOf(PDFRef);
    expect(list[0].get(N('A'))).toEqual(list[1].get(N('A')));
  });
  it.each(['K', 'NS'])('treats an indirect null %s exactly like an absent optional value', async key => {
    const f = await fixture();
    if (key === 'K') { f.doc.getPage(0).node.delete(N('Contents')); f.doc.getPage(0).node.delete(N('StructParents')); f.root.set(N('ParentTree'), f.doc.context.obj({ Nums: [] })); }
    f.elems[0].set(N(key), f.doc.context.register(PDFNull));
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    expect(elements(output).list[0].lookup(N('S'))).toBe(N('P'));
    expect(elements(output).list[0].lookup(N(key))).toBeUndefined();
  });
  it('does not coalesce namespace declarations by schema presence while discarding different schema values', async () => {
    const sources = [];
    for (const schema of ['first.xsd', 'second.xsd']) {
      const f = await fixture(), ns = f.doc.context.register(f.doc.context.obj({ Type: 'Namespace', NS: PDFString.of('urn:shared'), Schema: PDFString.of(schema), RoleMapNS: { P: 'P' } }));
      f.elems[0].set(N('NS'), ns); f.root.set(N('Namespaces'), f.doc.context.obj([ns])); sources.push(await f.doc.save());
    }
    await expect(buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own')).rejects.toThrow();
  });
  it('recognizes one namespace URI written in different text encodings before judging map conflicts', async () => {
    const sources = [];
    for (const role of ['P', 'H1']) {
      const f = await fixture(), uri = role === 'P' ? PDFString.of('urn:shared') : PDFHexString.fromText('urn:shared');
      const ns = f.doc.context.register(f.doc.context.obj({ Type: 'Namespace', NS: uri, RoleMapNS: { P: role } }));
      f.elems[0].set(N('NS'), ns); f.root.set(N('Namespaces'), f.doc.context.obj([ns])); sources.push(await f.doc.save());
    }
    await expect(buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own')).rejects.toThrow();
  });
  it('refuses two different elements claiming the same content item instead of silently selecting an owner', async () => {
    const f = await fixture(2); f.elems[1].set(N('Pg'), f.doc.getPage(0).ref);
    const bytes = await f.doc.save();
    await expect(buildPdf([page(bytes), page(bytes, 'own', 1)], bytes, 'own')).rejects.toThrow();
  });
  it('preserves a single-reference K identity needed by an actual structure destination', async () => {
    const f = await fixture(); f.root.set(N('K'), f.refs[0]);
    const outlines = f.doc.context.obj({ Type: 'Outlines', Count: 1 }), rootRef = f.doc.context.register(outlines);
    const item = f.doc.context.register(f.doc.context.obj({ Parent: rootRef, Title: PDFString.of('tag'), SE: f.refs[0] }));
    outlines.set(N('First'), item); outlines.set(N('Last'), item); f.doc.catalog.set(N('Outlines'), rootRef);
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    const carried = output.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict).get(N('SE'));
    expect(carried).toEqual(output.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')));
  });
  it('retains an MCID stored indirectly inside a K array', async () => {
    const f = await fixture(); f.elems[0].set(N('K'), f.doc.context.obj([f.doc.context.register(PDFNumber.of(0))]));
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    expect(elements(output).list[0].lookup(N('K'), PDFNumber).asNumber()).toBe(0);
    expect(output.getPage(0).node.lookup(N('StructParents'))).toBeInstanceOf(PDFNumber);
  });
  it('preserves valid indirect root associated-file arrays', async () => {
    const f = await fixture(); f.root.set(N('AF'), f.doc.context.register(f.doc.context.obj([f.doc.context.obj({ Type: 'Filespec', F: PDFString.of('payload.xml') })])));
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    expect(elements(output).root.lookup(N('AF'), PDFArray).lookup(0, PDFDict).lookup(N('F'), PDFString).decodeText()).toBe('payload.xml');
  });
  it('distinguishes which earlier object an opaque graph reference actually names', async () => {
    const sources = [];
    for (const choice of [0, 1]) {
      const f = await fixture(), ctx = f.doc.context;
      const nodes = [ctx.register(ctx.obj({ Name: 'left' })), ctx.register(ctx.obj({ Name: 'right' }))];
      const extra = ctx.obj({ Nodes: nodes, Pick: nodes[choice] });
      const ns = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of('urn:shared'), RoleMapNS: { P: 'P' }, Extra: extra }));
      f.root.set(N('Namespaces'), ctx.obj([ns])); f.elems[0].set(N('NS'), ns); sources.push(await f.doc.save());
    }
    await expect(buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own')).rejects.toThrow();
  });
  it('does not silently drop a malformed present class value', async () => {
    const f = await fixture(); f.elems[0].set(N('C'), PDFString.of('not a class name'));
    const bytes = await f.doc.save(); await expect(buildPdf([page(bytes)], bytes, 'own')).rejects.toThrow();
  });
  it('does not silently drop a malformed present namespace role map', async () => {
    const f = await fixture(), ctx = f.doc.context;
    const ns = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of('urn:broken'), RoleMapNS: 42 }));
    f.root.set(N('Namespaces'), ctx.obj([ns])); f.elems[0].set(N('NS'), ns);
    const bytes = await f.doc.save(); await expect(buildPdf([page(bytes)], bytes, 'own')).rejects.toThrow();
  });
  it('never emits an unassigned pruned-element reservation through an opaque field', async () => {
    const f = await fixture(2); f.elems[0].set(N('Private'), f.refs[1]);
    const bytes = await f.doc.save();
    // A valid retained semantic target is allowed; a named refusal is also
    // honest. A successful file whose reference became null is neither.
    let result: Uint8Array;
    try { result = await buildPdf([page(bytes)], bytes, 'own'); } catch (error) { expect(String(error)).toContain('verif'); return; }
    const output = await load(result);
    expect(elements(output).list[0].lookup(N('Private'))).toBeInstanceOf(PDFDict);
  });
  it('keeps an object reference to a Form XObject stream with its structural parent', async () => {
    const f = await fixture(), ctx = f.doc.context, p = f.doc.getPage(0);
    const form = ctx.register(ctx.stream('0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20] }));
    p.node.set(N('Resources'), ctx.obj({ XObject: { TaggedForm: form } }));
    p.node.set(N('Contents'), ctx.register(ctx.stream('/TaggedForm Do'))); p.node.delete(N('StructParents'));
    f.elems[0].set(N('K'), ctx.obj({ Type: 'OBJR', Pg: p.ref, Obj: form }));
    (ctx.lookup(form) as PDFRawStream).dict.set(N('StructParent'), PDFNumber.of(0));
    f.root.set(N('ParentTree'), ctx.obj({ Nums: [0, f.refs[0]] }));
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    const obj = elements(output).list[0].lookup(N('K'), PDFDict).lookup(N('Obj'));
    expect(obj).toBeInstanceOf(PDFRawStream);
    expect((obj as PDFRawStream).dict.lookup(N('StructParent'))).toBeInstanceOf(PDFNumber);
  });
  it('uses the declared namespace identity inside an attribute owner', async () => {
    const f = await fixture(), ctx = f.doc.context;
    const ns = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of('urn:attribute'), RoleMapNS: { P: 'P' } }));
    f.root.set(N('Namespaces'), ctx.obj([ns])); f.elems[0].set(N('NS'), ns);
    f.elems[0].set(N('A'), ctx.obj({ NS: ns, PrivateValue: 7 }));
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    const elem = elements(output).list[0]; expect(elem.lookup(N('A'), PDFDict).get(N('NS'))).toEqual(elem.get(N('NS')));
  });
  it('carries a page as the explicit owner of its marked-content stream', async () => {
    const f = await fixture(), ctx = f.doc.context, p = f.doc.getPage(0);
    f.elems[0].set(N('K'), ctx.obj({ Type: 'MCR', MCID: 0, Pg: p.ref, Stm: p.node.get(N('Contents')), StmOwn: p.ref, Private: PDFString.of('retained') }));
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    const mcr = elements(output).list[0].lookup(N('K'), PDFDict);
    expect(mcr.get(N('StmOwn'))).toEqual(output.getPage(0).ref);
    expect(mcr.lookup(N('Private'), PDFString).decodeText()).toBe('retained');
  });
  it('refuses a present malformed MCR stream instead of retargeting the page', async () => {
    const f = await fixture(); f.elems[0].set(N('K'), f.doc.context.obj({ Type: 'MCR', MCID: 0, Stm: 42 }));
    const bytes = await f.doc.save(); await expect(buildPdf([page(bytes)], bytes, 'own')).rejects.toThrow();
  });
  it('retains payload sharing when equivalent namespace declarations are coalesced', async () => {
    const sources = [];
    for (let i = 0; i < 2; i++) {
      const f = await fixture(), ctx = f.doc.context;
      const schema = ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of('shared.xsd') }));
      const ns = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of('urn:shared'), Schema: schema, RoleMapNS: { P: 'P' } }));
      f.root.set(N('Namespaces'), ctx.obj([ns])); f.elems[0].set(N('NS'), ns); f.elems[0].set(N('SchemaAlias'), schema);
      sources.push(await f.doc.save());
    }
    const output = await load(await buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own'));
    for (const elem of elements(output).list) expect(elem.get(N('SchemaAlias'))).toEqual(elem.lookup(N('NS'), PDFDict).get(N('Schema')));
  });
  it('removes stale whole-XObject parent keys when no structure tree survives', async () => {
    const doc = await PDFDocument.create(), p = doc.addPage();
    const form = doc.context.register(doc.context.stream('0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20], StructParent: 700 }));
    p.node.set(N('Resources'), doc.context.obj({ XObject: { Fm: form } }));
    p.node.set(N('Contents'), doc.context.register(doc.context.stream('/Fm Do')));
    const bytes = await doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    const copied = output.getPage(0).node.lookup(N('Resources'), PDFDict).lookup(N('XObject'), PDFDict).lookup(N('Fm')) as PDFRawStream;
    expect(copied.dict.has(N('StructParent'))).toBe(false);
  });
  it.each(['AF', 'PronunciationLexicon'])('retains the actual shared root %s array identity', async key => {
    const f = await fixture(), ctx = f.doc.context;
    const array = ctx.register(ctx.obj([ctx.obj({ Type: 'Filespec', F: PDFString.of('reference.xml') })]));
    f.root.set(N(key), array); f.elems[0].set(N('ArrayAlias'), array);
    const bytes = await f.doc.save(), output = await load(await buildPdf([page(bytes)], bytes, 'own'));
    const { root, list } = elements(output);
    expect(root.get(N(key))).toBeInstanceOf(PDFRef);
    expect(list[0].get(N('ArrayAlias'))).toEqual(root.get(N(key)));
    expect(root.lookup(N(key), PDFArray).size()).toBe(1);
  });
  it('retains the actual namespace role-map identity through compatible coalescing', async () => {
    const sources = [];
    for (let i = 0; i < 2; i++) {
      const f = await fixture(), ctx = f.doc.context, map = ctx.register(ctx.obj({ P: 'P' }));
      const ns = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of('urn:roles'), RoleMapNS: map }));
      f.root.set(N('Namespaces'), ctx.obj([ns])); f.elems[0].set(N('NS'), ns); f.elems[0].set(N('MapAlias'), map);
      sources.push(await f.doc.save());
    }
    const output = await load(await buildPdf([page(sources[0]), page(sources[1], 'donor')], sources[0], 'own'));
    for (const elem of elements(output).list) expect(elem.get(N('MapAlias'))).toEqual(elem.lookup(N('NS'), PDFDict).get(N('RoleMapNS')));
  });
});
