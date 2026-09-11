import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFString } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
const N = PDFName.of.bind(PDFName);

async function fixture() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const width of [300, 400, 500]) doc.addPage([width, 700]);
  const root = doc.context.obj({ Type: 'Outlines', Count: 1 });
  const rootRef = doc.context.register(root);
  const item = doc.context.obj({ Title: PDFHexString.fromText('Original α'), Parent: rootRef });
  const ref = doc.context.register(item);
  root.set(N('First'), ref); root.set(N('Last'), ref); doc.catalog.set(N('Outlines'), rootRef);
  return { doc, root, rootRef, item, ref };
}
async function rebuild(doc: PDFDocument, order = [0, 1, 2], pdfx = false, donorOnly = false) {
  const bytes = await doc.save(), before = bytes.slice();
  const donor = await PDFDocument.create({ updateMetadata: false }); donor.addPage([900, 700]);
  const pages = donorOnly ? [{ bytes: await donor.save(), pageIndex: 0, sourceKey: 'donor' }]
    : order.map(pageIndex => ({ bytes, pageIndex, sourceKey: 'own' }));
  const built = pdfx ? await buildPdfx([{ name: 'Member', pages }], 'Collection', bytes, 'own') : await buildPdf(pages, bytes, 'own');
  expect(bytes).toEqual(before);
  return PDFDocument.load(built, { updateMetadata: false });
}
const first = (doc: PDFDocument) => doc.catalog.lookup(N('Outlines'), PDFDict).lookup(N('First'), PDFDict);
const numbers = (arr: PDFArray) => arr.asArray().map(x => (x as PDFNumber).asNumber());
function addTag(doc: PDFDocument) {
  const root = doc.context.obj({ Type: 'StructTreeRoot' }), rootRef = doc.context.register(root);
  const elem = doc.context.obj({ Type: 'StructElem', S: 'P', P: rootRef, Pg: doc.getPage(1).ref, K: 0 });
  const elemRef = doc.context.register(elem); root.set(N('K'), elemRef);
  doc.getPage(1).node.set(N('StructParents'), PDFNumber.of(0));
  root.set(N('ParentTree'), doc.context.obj({ Nums: [0, [elemRef]] }));
  doc.catalog.set(N('StructTreeRoot'), rootRef); doc.catalog.set(N('MarkInfo'), doc.context.obj({ Marked: true }));
  return elemRef;
}

describe('outline payload preservation', () => {
  it.each(['action', 'name-tree', 'legacy'])('preserves a Type-absent actual structure target in %s destinations', async mode => {
    const { doc, item } = await fixture(), elemRef = addTag(doc);
    doc.context.lookup(elemRef, PDFDict).delete(N('Type')); // optional under Table 355
    item.set(N('SE'), elemRef);
    const destination = doc.context.obj({ D: [doc.getPage(1).ref, 'Fit'], SD: [elemRef, 'FitH', 500] });
    if (mode === 'action') { destination.set(N('S'), N('GoTo')); item.set(N('A'), destination); }
    else if (mode === 'legacy') { doc.catalog.set(N('Dests'), doc.context.obj({ target: destination })); item.set(N('Dest'), N('target')); }
    else { doc.catalog.set(N('Names'), doc.context.obj({ Dests: { Names: [PDFString.of('target'), destination] } })); item.set(N('Dest'), PDFString.of('target')); }
    const out = await rebuild(doc, [1, 0, 2]), target = out.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K'))!;
    expect(first(out).get(N('SE'))).toEqual(target);
    expect(out.context.lookup(target, PDFDict).get(N('Type'))).toBeUndefined();
    const result = mode === 'action' ? first(out).lookup(N('A'), PDFDict)
      : mode === 'legacy' ? out.catalog.lookup(N('Dests'), PDFDict).lookup(N('target'), PDFDict)
      : out.catalog.lookup(N('Names'), PDFDict).lookup(N('Dests'), PDFDict).lookup(N('Names'), PDFArray).lookup(1, PDFDict);
    expect(result.lookup(N('SD'), PDFArray).get(0)).toEqual(target);
    expect(out.context.lookup(target, PDFDict).get(N('Pg'))).toEqual(out.getPage(0).ref);
  });
  it.each([false, true])('retains URI actions, raw title, style and extension values (PDFX=%s)', async pdfx => {
    const { doc, item } = await fixture();
    item.set(N('A'), doc.context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/manual'), IsMap: false }));
    item.set(N('F'), PDFNumber.of(3)); item.set(N('C'), doc.context.obj([1, 0.25, 0]));
    item.set(N('Private'), PDFString.of('preserved'));
    const out = first(await rebuild(doc, [1, 0, 2], pdfx));
    expect(out.lookup(N('Title'), PDFHexString).toString()).toBe(item.lookup(N('Title'), PDFHexString).toString());
    expect(out.lookup(N('A'), PDFDict).lookup(N('URI'), PDFString).decodeText()).toBe('https://example.invalid/manual');
    expect(out.lookup(N('F'), PDFNumber).asNumber()).toBe(3); expect(numbers(out.lookup(N('C'), PDFArray))).toEqual([1, 0.25, 0]);
    expect(out.lookup(N('Private'), PDFString).decodeText()).toBe('preserved');
  });
  it('keeps document-owned external bookmarks with only donor pages', async () => {
    const { doc, item } = await fixture(); item.set(N('A'), doc.context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid') }));
    const out = await rebuild(doc, [], false, true);
    expect(first(out).lookup(N('A'), PDFDict).lookup(N('S'))).toBe(N('URI'));
  });
  it('maps local actions and preserves shared/cyclic Next graphs across catalog roots', async () => {
    const { doc, item, ref } = await fixture();
    const action = doc.context.obj({ S: 'GoTo', D: [doc.getPage(1).ref, 'XYZ', null, 600, 0] }), actionRef = doc.context.register(action);
    const next = doc.context.obj({ S: 'Named', N: 'NextPage', PrivateOutline: ref, Next: actionRef });
    action.set(N('Next'), doc.context.obj([doc.context.register(next), actionRef]));
    item.set(N('A'), actionRef); doc.catalog.set(N('OpenAction'), actionRef);
    const out = await rebuild(doc, [1, 0, 2]), top = first(out), copied = top.lookup(N('A'), PDFDict);
    expect(top.get(N('A'))).toEqual(out.catalog.get(N('OpenAction')));
    expect(copied.lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
    const chain = copied.lookup(N('Next'), PDFArray);
    expect(chain.get(1)).toEqual(top.get(N('A')));
    expect(chain.lookup(0, PDFDict).get(N('PrivateOutline'))).toEqual(out.catalog.lookup(N('Outlines'), PDFDict).get(N('First')));
    expect(out.context.enumerateIndirectObjects().filter(([, obj]) => obj instanceof PDFDict && obj.get(N('Type')) === N('Page'))).toHaveLength(3);
  });
  it.each(['GoToR', 'GoToE'])('does not reinterpret %s remote numeric or named destinations', async kind => {
    for (const dest of [PDFString.of('remote-destination'), PDFName.of('remote-name'), [7, 'Fit']]) {
      const { doc, item } = await fixture();
      item.set(N('A'), doc.context.obj({ S: kind, F: PDFString.of('external.pdf'), D: Array.isArray(dest) ? doc.context.obj(dest) : dest }));
      const out = await rebuild(doc, [2, 0]);
      expect(first(out).lookup(N('A'), PDFDict).get(N('D'))?.toString()).toBe(Array.isArray(dest) ? '[ 7 /Fit ]' : dest.toString());
    }
  });
  it('resolves byte-keyed names without conflating a UTF-16 display-equivalent key', async () => {
    const { doc, item } = await fixture();
    item.set(N('Dest'), PDFString.of('target'));
    doc.catalog.set(N('Names'), doc.context.obj({ Dests: { Names: [PDFString.of('target'), [doc.getPage(1).ref, 'Fit'], PDFHexString.fromText('target'), [doc.getPage(2).ref, 'Fit']] } }));
    const out = await rebuild(doc, [1, 2, 0]); expect(first(out).lookup(N('Dest'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
  });
  it('preserves structural identity for SE and SD on actual rebuilt structure elements', async () => {
    const { doc, item } = await fixture(), elemRef = addTag(doc);
    item.set(N('SE'), elemRef); item.set(N('A'), doc.context.obj({ S: 'GoTo', D: [doc.getPage(1).ref, 'Fit'], SD: [elemRef, 'FitH', 500] }));
    const out = await rebuild(doc, [1, 0, 2]), top = first(out);
    const structure = out.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K'))!;
    expect(top.get(N('SE'))).toEqual(structure);
    expect(top.lookup(N('A'), PDFDict).lookup(N('SD'), PDFArray).get(0)).toEqual(structure);
    expect(out.context.lookup(structure, PDFDict).get(N('Pg'))).toEqual(out.getPage(0).ref);
  });
  it.each([false, true])('preserves named destination dictionaries including SD and private values (legacy=%s)', async legacy => {
    const { doc, item } = await fixture(), elemRef = addTag(doc), key = legacy ? N('target') : PDFString.of('target');
    const value = doc.context.obj({ D: [doc.getPage(1).ref, 'Fit'], SD: [elemRef, 'FitH', 500], Private: PDFString.of('retained') });
    if (legacy) doc.catalog.set(N('Dests'), doc.context.obj({ target: value }));
    else doc.catalog.set(N('Names'), doc.context.obj({ Dests: { Names: [key, value] } }));
    item.set(N('Dest'), key);
    const out = await rebuild(doc, [1, 0, 2]); expect(first(out).get(N('Dest'))?.toString()).toBe(key.toString());
    const mapped = legacy ? out.catalog.lookup(N('Dests'), PDFDict).lookup(N('target'), PDFDict)
      : out.catalog.lookup(N('Names'), PDFDict).lookup(N('Dests'), PDFDict).lookup(N('Names'), PDFArray).lookup(1, PDFDict);
    expect(mapped.lookup(N('D'), PDFArray).get(0)).toEqual(out.getPage(0).ref);
    expect(mapped.lookup(N('SD'), PDFArray).get(0)).toEqual(out.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')));
    expect(mapped.lookup(N('Private'), PDFString).decodeText()).toBe('retained');
  });
  it('computes visible descendant counts, including closed subtrees', async () => {
    const { doc, item, ref, root } = await fixture();
    const child = doc.context.obj({ Title: PDFString.of('Closed'), Parent: ref, Count: -7 }), childRef = doc.context.register(child);
    const grand = doc.context.obj({ Title: PDFString.of('Grandchild'), Parent: childRef, Count: 8 }), grandRef = doc.context.register(grand);
    const leaf = doc.context.obj({ Title: PDFString.of('Leaf'), Parent: grandRef }), leafRef = doc.context.register(leaf);
    grand.set(N('First'), leafRef); grand.set(N('Last'), leafRef);
    child.set(N('First'), grandRef); child.set(N('Last'), grandRef);
    item.set(N('First'), childRef); item.set(N('Last'), childRef); item.set(N('Count'), PDFNumber.of(9)); root.set(N('Count'), PDFNumber.of(10));
    const out = await rebuild(doc), top = first(out), middle = top.lookup(N('First'), PDFDict);
    expect(out.catalog.lookup(N('Outlines'), PDFDict).lookup(N('Count'), PDFNumber).asNumber()).toBe(2);
    expect(top.lookup(N('Count'), PDFNumber).asNumber()).toBe(1);
    expect(middle.lookup(N('Count'), PDFNumber).asNumber()).toBe(-2);
    expect(middle.lookup(N('First'), PDFDict).lookup(N('Count'), PDFNumber).asNumber()).toBe(1);
  });
});

describe('outline unsafe-shape refusal', () => {
  it.each(['cycle', 'missing-parent', 'wrong-last', 'wrong-prev', 'direct-item', 'malformed-title', 'two-actions', 'bad-style', 'bad-color', 'missing-action', 'missing-name', 'missing-structure', 'removed-structure', 'removed-action', 'duplicate-action', 'orphan-page'])('refuses %s', async mode => {
    const { doc, root, item, ref } = await fixture();
    if (mode === 'cycle') item.set(N('Next'), ref);
    if (mode === 'missing-parent') item.delete(N('Parent'));
    if (mode === 'wrong-last') root.set(N('Last'), doc.getPage(0).ref);
    if (mode === 'wrong-prev') item.set(N('Prev'), ref);
    if (mode === 'direct-item') root.set(N('First'), item);
    if (mode === 'malformed-title') item.set(N('Title'), PDFNumber.of(1));
    if (mode === 'bad-style') item.set(N('F'), PDFNumber.of(4));
    if (mode === 'bad-color') item.set(N('C'), doc.context.obj([1, -1, 0]));
    if (mode === 'missing-action') item.set(N('A'), doc.context.obj({ S: 'GoTo' }));
    if (mode === 'missing-name') item.set(N('Dest'), PDFString.of('absent'));
    if (mode.includes('structure')) item.set(N('SE'), mode === 'missing-structure' ? doc.context.register(doc.context.obj({ Type: 'StructElem' })) : addTag(doc));
    if (mode === 'two-actions') { item.set(N('Dest'), doc.context.obj([doc.getPage(0).ref, 'Fit'])); item.set(N('A'), doc.context.obj({ S: 'Named', N: 'NextPage' })); }
    if (mode.includes('action') && mode !== 'missing-action' && mode !== 'two-actions') item.set(N('A'), doc.context.obj({ S: 'GoTo', D: [doc.getPage(1).ref, 'Fit'] }));
    if (mode === 'orphan-page') item.set(N('Private'), doc.catalog.get(N('Pages'))!);
    const order = mode.startsWith('removed') ? [0, 2] : mode === 'duplicate-action' ? [1, 1, 0] : [0, 1, 2];
    // No malformed direct linked cycle is serialized by this test harness.
    if (mode === 'direct-item') { item.delete(N('Parent')); }
    await expect(rebuild(doc, order)).rejects.toThrow();
  });
  it.each([['Fit', 1], ['XYZ', null, 10], ['XYZ', 1, 2, PDFString.of('bad')], ['FitR', 0, 0, 10, PDFNull], ['Unknown']].map(view => ({ view })))('refuses an invalid complete view $view', async ({ view }) => {
    const { doc, item } = await fixture();
    item.set(N('Dest'), doc.context.obj([doc.getPage(0).ref, ...view]));
    await expect(rebuild(doc)).rejects.toThrow();
  });
  it.each([['Fit'], ['FitB'], ['XYZ', null, null, 0], ['FitH', null], ['FitV', 20], ['FitR', 0, 0, 100, 200], ['FitBH', 100], ['FitBV', 200]].map(view => ({ view })))('preserves a complete supported view $view', async ({ view }) => {
    const { doc, item } = await fixture(); item.set(N('Dest'), doc.context.obj([doc.getPage(1).ref, ...view]));
    const out = await rebuild(doc, [1, 0, 2]), arr = first(out).lookup(N('Dest'), PDFArray);
    expect(arr.get(0)).toEqual(out.getPage(0).ref);
    expect(arr.asArray().slice(1).map(x => x.toString())).toEqual((item.get(N('Dest')) as PDFArray).asArray().slice(1).map(x => x.toString()));
  });
});
