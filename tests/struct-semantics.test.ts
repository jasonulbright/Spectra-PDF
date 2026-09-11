// Structure semantics through the rebuild (lib/struct-carry.ts +
// struct-carry-objects.ts). The carry used to keep a shape and lose the
// meaning: two sources' role and class maps merged first-wins so one source's
// elements silently took the other's meaning, namespaces vanished, UTF-16
// descriptions and byte-string identifiers were re-encoded into different
// values, element revisions and Ref relationships were dropped, and MarkInfo
// was replaced by an unqualified Marked assertion (BA-39).
//
// Field shapes and semantics follow ISO 32000-2 14.7.2–14.7.6 (Tables
// 353–358) and 14.8.6. Every assertion here reads a SAVED AND REOPENED
// document, so it measures what the file says rather than what a map held.
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';

import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';
import { carryStructTree } from '../src/renderer/lib/struct-carry';

const N = PDFName.of.bind(PDFName);

const pageOf = (bytes: Uint8Array, index = 0, sourceKey = 'own'): ExportPage => ({
  bytes,
  sourceKey,
  pageIndex: index,
});

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

/** Build then reopen: the assertions are about the serialized document. */
async function rebuild(pages: ExportPage[], own?: Uint8Array, ownKey = 'own'): Promise<PDFDocument> {
  return load(await buildPdf(pages, own, ownKey));
}

/** An identifier's identity: the byte sequence it decodes to. */
const idBytes = (id: PDFString | PDFHexString): string =>
  [...id.asBytes()].map((b) => b.toString(16).padStart(2, '0')).join('');

const rootOf = (doc: PDFDocument): PDFDict => doc.catalog.lookup(N('StructTreeRoot'), PDFDict);

/** Top-level structure elements, whether /K is one dictionary or an array. */
function topElements(doc: PDFDocument): PDFDict[] {
  const raw = rootOf(doc).lookup(N('K'));
  if (raw instanceof PDFArray) {
    const out: PDFDict[] = [];
    for (let i = 0, n = raw.size(); i < n; i++) out.push(raw.lookup(i, PDFDict));
    return out;
  }
  return [raw as PDFDict];
}

/** Every element in the tree, depth first. */
function allElements(doc: PDFDocument): PDFDict[] {
  const out: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  const walk = (elem: PDFDict) => {
    if (seen.has(elem)) return;
    seen.add(elem);
    out.push(elem);
    const raw = elem.lookup(N('K'));
    const kids = raw instanceof PDFArray
      ? Array.from({ length: raw.size() }, (_, i) => raw.lookup(i))
      : [raw];
    for (const kid of kids) {
      if (kid instanceof PDFDict) {
        const type = kid.lookup(N('Type'));
        const name = type instanceof PDFName ? type.asString() : null;
        if (name === '/MCR' || name === '/OBJR') continue;
        walk(kid);
      }
    }
  };
  for (const elem of topElements(doc)) walk(elem);
  return out;
}

/** Follow a role through the output RoleMap the way a consumer must: to a
 * name it recognises, or back to one already seen (14.7.3 permits cycles). */
function resolvedRole(root: PDFDict, elem: PDFDict): string {
  const map = root.lookupMaybe(N('RoleMap'), PDFDict);
  let name = elem.lookup(N('S'), PDFName);
  const seen = new Set<string>([name.asString()]);
  while (map && map.has(name)) {
    const next = map.lookup(name, PDFName);
    if (seen.has(next.asString())) break;
    seen.add(next.asString());
    name = next;
  }
  return name.asString();
}

/** The attribute value a class name resolves to in the output ClassMap. */
function classValue(root: PDFDict, elem: PDFDict, key: string): string | undefined {
  const classes = root.lookup(N('ClassMap'), PDFDict);
  const raw = elem.lookup(N('C'));
  const name = raw instanceof PDFArray ? raw.lookup(0, PDFName) : (raw as PDFName);
  const attrs = classes.lookupMaybe(name, PDFDict);
  const value = attrs?.lookup(N(key));
  return value instanceof PDFName ? value.asString() : undefined;
}

interface TagOptions {
  role?: string;
  align?: string;
  namespace?: string;
  namespaceRole?: string;
  classRevision?: number;
  marked?: boolean;
  suspects?: boolean;
  roleChain?: Record<string, string>;
  pages?: number;
}

/** One tagged page whose custom role and attribute class both resolve through
 * the root's maps — the shape the independent probe uses, parameterised. */
async function tagged(options: TagOptions = {}): Promise<Uint8Array> {
  const {
    role = 'P', align = 'Start', namespace, namespaceRole, classRevision,
    marked = true, suspects = false, roleChain, pages = 1,
  } = options;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const pageList = Array.from({ length: pages }, () => doc.addPage([300, 700]));
  pageList.forEach((page, i) => {
    page.node.set(N('Contents'), ctx.register(ctx.stream(`/P <</MCID ${i}>> BDC 0 0 10 10 re f EMC`)));
  });

  const root = ctx.obj({ Type: 'StructTreeRoot' });
  const rootRef = ctx.register(root);
  const elems = pageList.map((page, i) => {
    const elem = ctx.obj({
      Type: 'StructElem', S: 'CustomRole', P: rootRef, Pg: page.ref, K: i,
    });
    elem.set(N('C'), classRevision === undefined
      ? N('SharedClass')
      : ctx.obj([N('SharedClass'), PDFNumber.of(classRevision)]));
    return ctx.register(elem);
  });
  root.set(N('K'), elems.length === 1 ? elems[0] : ctx.obj(elems));
  const roleMapDict = ctx.obj({ CustomRole: role });
  for (const [from, to] of Object.entries(roleChain ?? {})) roleMapDict.set(N(from), N(to));
  root.set(N('RoleMap'), roleMapDict);
  root.set(N('ClassMap'), ctx.obj({ SharedClass: { O: 'Layout', TextAlign: align } }));
  root.set(N('ParentTree'), ctx.obj({ Nums: elems.flatMap((ref, i) => [i, ctx.obj([ref])]) }));
  root.set(N('ParentTreeNextKey'), PDFNumber.of(elems.length));
  pageList.forEach((page, i) => page.node.set(N('StructParents'), PDFNumber.of(i)));

  if (namespace) {
    const ns = ctx.obj({
      Type: 'Namespace',
      NS: PDFString.of(namespace),
      RoleMapNS: { CustomRole: namespaceRole ?? role },
    });
    const nsRef = ctx.register(ns);
    for (const ref of elems) ctx.lookup(ref, PDFDict).set(N('NS'), nsRef);
    root.set(N('Namespaces'), ctx.obj([nsRef]));
  }
  doc.catalog.set(N('StructTreeRoot'), rootRef);
  const markInfo = ctx.obj({ Marked: marked });
  if (suspects) markInfo.set(N('Suspects'), ctx.obj(true));
  doc.catalog.set(N('MarkInfo'), markInfo);
  return doc.save();
}

describe('struct semantics — source-local roles and classes', () => {
  it.each([
    ['own first', 'a'],
    ['donor first', 'b'],
  ])('keeps both conflicting role meanings with the %s source leading', async (_label, lead) => {
    const a = await tagged({ role: 'P', align: 'Start' });
    const b = await tagged({ role: 'H1', align: 'End' });
    const pages = lead === 'a'
      ? [pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')]
      : [pageOf(b, 0, 'donor'), pageOf(a, 0, 'own')];
    const out = await rebuild(pages, a, 'own');
    const root = rootOf(out);
    const roles = topElements(out).map((elem) => resolvedRole(root, elem));
    expect(roles.sort()).toEqual(['/H1', '/P']);
  });

  it.each([
    ['own first', 'a'],
    ['donor first', 'b'],
  ])('keeps both conflicting class meanings with the %s source leading', async (_label, lead) => {
    const a = await tagged({ role: 'P', align: 'Start' });
    const b = await tagged({ role: 'H1', align: 'End' });
    const pages = lead === 'a'
      ? [pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')]
      : [pageOf(b, 0, 'donor'), pageOf(a, 0, 'own')];
    const out = await rebuild(pages, a, 'own');
    const root = rootOf(out);
    const aligns = topElements(out).map((elem) => classValue(root, elem, 'TextAlign'));
    expect(aligns.sort()).toEqual(['/End', '/Start']);
  });

  it('leaves a single source identity exactly as it was', async () => {
    const a = await tagged({ role: 'P', align: 'Start' });
    const out = await rebuild([pageOf(a)], a);
    const root = rootOf(out);
    // No rename happened: nothing contested the names.
    expect(topElements(out)[0].lookup(N('S'))).toBe(N('CustomRole'));
    expect(root.lookup(N('RoleMap'), PDFDict).lookup(N('CustomRole'))).toBe(N('P'));
    expect(topElements(out)[0].lookup(N('C'))).toBe(N('SharedClass'));
  });

  it('keeps a chained role chain intact when the chain conflicts', async () => {
    // A: CustomRole → Mid → P.  B: CustomRole → Mid → H1.  Both chains must
    // survive, so Mid is contested as well as CustomRole.
    const a = await tagged({ role: 'Mid', roleChain: { Mid: 'P' } });
    const b = await tagged({ role: 'Mid', roleChain: { Mid: 'H1' } });
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const root = rootOf(out);
    expect(topElements(out).map((elem) => resolvedRole(root, elem)).sort()).toEqual(['/H1', '/P']);
  });

  it('does not retarget an element whose source left the name unmapped', async () => {
    // A maps CustomRole to H1; B has no RoleMap at all, so B's element means
    // CustomRole. Merging must not give B's element A's edge.
    const a = await tagged({ role: 'H1' });
    const bDoc = await load(await tagged());
    bDoc.catalog.lookup(N('StructTreeRoot'), PDFDict).delete(N('RoleMap'));
    const b = await bDoc.save();
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const root = rootOf(out);
    // B never mapped the name, so its element still says what it said and
    // resolves to nothing; A's mapped edge moved to a local identity.
    expect(topElements(out).map((elem) => resolvedRole(root, elem)).sort()).toEqual(['/CustomRole', '/H1']);
    expect(root.lookup(N('RoleMap'), PDFDict).get(N('CustomRole'))).toBeUndefined();
  });

  it('does not adopt another source class definition for an undefined class', async () => {
    const a = await tagged({ align: 'End' });
    const bDoc = await load(await tagged());
    bDoc.catalog.lookup(N('StructTreeRoot'), PDFDict).delete(N('ClassMap'));
    const b = await bDoc.save();
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const root = rootOf(out);
    const values = topElements(out).map((elem) => classValue(root, elem, 'TextAlign'));
    expect(values.filter((v) => v === '/End')).toHaveLength(1);
    expect(values.filter((v) => v === undefined)).toHaveLength(1);
  });

  it('renames without colliding with an otherwise unmapped name of the same spelling', async () => {
    // The natural local identity for CustomRole in source 0 is already taken
    // by a real name, so the rename must move past it.
    const a = await tagged({ role: 'P', roleChain: { CustomRole_s0: 'Note' } });
    const b = await tagged({ role: 'H1' });
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const root = rootOf(out);
    expect(topElements(out).map((elem) => resolvedRole(root, elem)).sort()).toEqual(['/H1', '/P']);
    // The pre-existing edge is untouched.
    expect(root.lookup(N('RoleMap'), PDFDict).lookup(N('CustomRole_s0'))).toBe(N('Note'));
  });

  it('preserves a class revision number beside a renamed class', async () => {
    const a = await tagged({ align: 'Start', classRevision: 3 });
    const b = await tagged({ align: 'End', classRevision: 7 });
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const revisions = topElements(out).map((elem) =>
      elem.lookup(N('C'), PDFArray).lookup(1, PDFNumber).asNumber(),
    );
    expect(revisions.sort()).toEqual([3, 7]);
    // And the renamed names still resolve to their own attributes.
    const root = rootOf(out);
    expect(topElements(out).map((elem) => classValue(root, elem, 'TextAlign')).sort())
      .toEqual(['/End', '/Start']);
  });
});

describe('struct semantics — namespaces', () => {
  it('preserves an explicit namespace, its name and the root declaration', async () => {
    const a = await tagged({ namespace: 'https://example.invalid/structure/' });
    const out = await rebuild([pageOf(a)], a);
    const ns = topElements(out)[0].lookup(N('NS'), PDFDict);
    expect(ns.lookup(N('NS'), PDFString).decodeText()).toBe('https://example.invalid/structure/');
    expect(ns.lookup(N('Type'))).toBe(N('Namespace'));
    const declared = rootOf(out).lookup(N('Namespaces'), PDFArray);
    expect(declared.size()).toBe(1);
    expect(declared.get(0)).toBe(topElements(out)[0].get(N('NS')));
  });

  it('refuses one namespace name carrying two different meanings', async () => {
    // Publishing both leaves a consumer unable to resolve the name, and
    // merging them asserts a mapping neither source wrote.
    const uri = 'https://example.invalid/structure/';
    const a = await tagged({ namespace: uri, namespaceRole: 'P' });
    const b = await tagged({ namespace: uri, namespaceRole: 'H1' });
    await expect(rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own')).rejects.toThrow();
  });

  it('shares one declaration when two sources declare a namespace compatibly', async () => {
    const uri = 'https://example.invalid/structure/';
    const a = await tagged({ namespace: uri, namespaceRole: 'P' });
    const b = await tagged({ namespace: uri, namespaceRole: 'P' });
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    expect(rootOf(out).lookup(N('Namespaces'), PDFArray).size()).toBe(1);
    const [first, second] = topElements(out);
    expect(first.get(N('NS'))).toBe(second.get(N('NS')));
  });

  it('does not rename a namespace-local structure type with a default map rename', async () => {
    // The default RoleMap governs default-namespace names only; an element in
    // a namespace names a type that namespace defines.
    const a = await tagged({ namespace: 'https://example.invalid/a/', role: 'P' });
    const b = await tagged({ namespace: 'https://example.invalid/b/', role: 'H1' });
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    for (const elem of topElements(out)) {
      expect(elem.lookup(N('S'))).toBe(N('CustomRole'));
      // And the namespace's own map still keys the name it was written with.
      expect(elem.lookup(N('NS'), PDFDict).lookup(N('RoleMapNS'), PDFDict).has(N('CustomRole'))).toBe(true);
    }
  });

  it.each([1, 3])('refuses a RoleMapNS pair that is not exactly two entries (%i)', async (size) => {
    const doc = await load(await tagged({ namespace: 'https://example.invalid/a/' }));
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const nsRef = root.lookup(N('Namespaces'), PDFArray).get(0) as PDFRef;
    const other = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of('https://example.invalid/b/') }));
    const entries = size === 1 ? [N('Para')] : [N('Para'), other, N('Extra')];
    ctx.lookup(nsRef, PDFDict).set(N('RoleMapNS'), ctx.obj({ CustomRole: entries }));
    root.set(N('Namespaces'), ctx.obj([nsRef, other]));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('preserves a RoleMapNS edge into another namespace', async () => {
    const doc = await load(await tagged({ namespace: 'https://example.invalid/a/' }));
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const ctx = doc.context;
    const target = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of('https://example.invalid/b/') }));
    const first = root.lookup(N('Namespaces'), PDFArray).get(0) as PDFRef;
    const firstNs = ctx.lookup(first, PDFDict);
    firstNs.set(N('RoleMapNS'), ctx.obj({ CustomRole: [N('Para'), target] }));
    root.set(N('Namespaces'), ctx.obj([first, target]));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const ns = topElements(out)[0].lookup(N('NS'), PDFDict);
    const edge = ns.lookup(N('RoleMapNS'), PDFDict).lookup(N('CustomRole'), PDFArray);
    expect(edge.lookup(0, PDFName)).toBe(N('Para'));
    // The edge points at a real output namespace, not a dangling reference.
    const pointed = out.context.lookup(edge.get(1), PDFDict);
    expect(pointed.lookup(N('NS'), PDFString).decodeText()).toBe('https://example.invalid/b/');
    expect(rootOf(out).lookup(N('Namespaces'), PDFArray).size()).toBe(2);
  });

  it('preserves a direct RoleMapNS mapping into the default namespace', async () => {
    const a = await tagged({ namespace: 'https://example.invalid/a/', namespaceRole: 'Sect' });
    const out = await rebuild([pageOf(a)], a);
    const map = topElements(out)[0].lookup(N('NS'), PDFDict).lookup(N('RoleMapNS'), PDFDict);
    expect(map.lookup(N('CustomRole'))).toBe(N('Sect'));
  });

  it('carries a namespace Schema file specification as data', async () => {
    const doc = await load(await tagged({ namespace: 'https://example.invalid/a/' }));
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const nsRef = root.lookup(N('Namespaces'), PDFArray).get(0) as PDFRef;
    ctx.lookup(nsRef, PDFDict).set(
      N('Schema'),
      ctx.obj({ Type: 'Filespec', FS: 'URL', F: PDFString.of('https://example.invalid/schema.rng') }),
    );
    const a = await doc.save();
    const out = await rebuild([pageOf(a)], a);
    const schema = topElements(out)[0].lookup(N('NS'), PDFDict).lookup(N('Schema'), PDFDict);
    // Carried verbatim; nothing fetched it.
    expect(schema.lookup(N('F'), PDFString).decodeText()).toBe('https://example.invalid/schema.rng');
  });

  it('refuses a namespace with no namespace name', async () => {
    const doc = await load(await tagged({ namespace: 'https://example.invalid/a/' }));
    const nsRef = doc.catalog
      .lookup(N('StructTreeRoot'), PDFDict)
      .lookup(N('Namespaces'), PDFArray)
      .get(0) as PDFRef;
    doc.context.lookup(nsRef, PDFDict).delete(N('NS'));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });
});

describe('struct semantics — element data', () => {
  it('preserves UTF-16 accessibility text as a hex string, not a re-encoded byte string', async () => {
    const doc = await load(await tagged());
    const elem = doc.context.lookup(
      doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')),
      PDFDict,
    );
    const alt = PDFHexString.fromText('日本語の説明');
    elem.set(N('Alt'), alt);
    elem.set(N('ActualText'), PDFHexString.fromText('Ærø — æøå'));
    elem.set(N('T'), PDFHexString.fromText('第1章'));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const carried = topElements(out)[0];
    expect(carried.lookup(N('Alt'))).toBeInstanceOf(PDFHexString);
    expect(carried.lookup(N('Alt'), PDFHexString).asString()).toBe(alt.asString());
    expect(carried.lookup(N('Alt'), PDFHexString).decodeText()).toBe('日本語の説明');
    expect(carried.lookup(N('ActualText'), PDFHexString).decodeText()).toBe('Ærø — æøå');
    expect(carried.lookup(N('T'), PDFHexString).decodeText()).toBe('第1章');
  });

  it('preserves a byte-string identifier, its revision and the rebuilt ID tree', async () => {
    const doc = await load(await tagged());
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const elem = doc.context.lookup(root.get(N('K')), PDFDict);
    const id = PDFHexString.of('00FF10ABCDEF');
    elem.set(N('ID'), id);
    elem.set(N('R'), PDFNumber.of(2));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const carried = topElements(out)[0];
    expect(carried.lookup(N('ID'))).toBeInstanceOf(PDFHexString);
    expect(carried.lookup(N('ID'), PDFHexString).asString()).toBe('00FF10ABCDEF');
    expect(carried.lookup(N('R'), PDFNumber).asNumber()).toBe(2);
    // The ID tree names the element it says it names.
    const names = rootOf(out).lookup(N('IDTree'), PDFDict).lookup(N('Names'), PDFArray);
    expect(names.lookup(0, PDFHexString).asString()).toBe('00FF10ABCDEF');
    expect(out.context.lookup(names.get(1), PDFDict).lookup(N('S'))).toBe(carried.lookup(N('S')));
  });

  // An identifier is a byte string, so hex against literal, upper against
  // lower nibbles, and an escaped literal against the same bytes are all the
  // SAME identifier and have to be separated.
  const spellId = (kind: string): PDFString | PDFHexString => {
    if (kind === 'lit') return PDFString.of('same');
    if (kind === 'esc') return PDFString.of('s\\141me');
    return PDFHexString.of(kind === 'HEX' ? '73616D65' : '73616d65');
  };

  it.each([
    ['literal against literal', 'lit', 'lit'],
    ['literal against hex', 'lit', 'hex'],
    ['hex against hex of different nibble case', 'hex', 'HEX'],
    ['a literal escape against its own bytes in hex', 'esc', 'hex'],
  ])('resolves an identifier collision by bytes: %s', async (_label, first, second) => {
    const withId = async (align: string, kind: string) => {
      const doc = await load(await tagged({ align }));
      doc.context
        .lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict)
        .set(N('ID'), spellId(kind));
      return doc.save();
    };
    for (const order of ['own-first', 'donor-first']) {
      const a = await withId('Start', first);
      const b = await withId('End', second);
      const pages = order === 'own-first'
        ? [pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')]
        : [pageOf(b, 0, 'donor'), pageOf(a, 0, 'own')];
      const out = await rebuild(pages, a, 'own');
      const ids = topElements(out).map((elem) => idBytes(elem.lookup(N('ID')) as PDFString | PDFHexString));
      expect(new Set(ids).size).toBe(2);
      // Every identifier on an element is in the tree naming that element,
      // and the tree is ordered by the bytes.
      const names = rootOf(out).lookup(N('IDTree'), PDFDict).lookup(N('Names'), PDFArray);
      const treeBytes: string[] = [];
      const mapped = new Map<string, PDFDict>();
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = idBytes(names.lookup(i) as PDFString | PDFHexString);
        treeBytes.push(key);
        mapped.set(key, out.context.lookup(names.get(i + 1), PDFDict));
      }
      expect(treeBytes).toEqual([...treeBytes].sort());
      for (const elem of topElements(out)) {
        expect(mapped.get(idBytes(elem.lookup(N('ID')) as PDFString | PDFHexString))).toBe(elem);
      }
    }
  });

  it('leaves a non-colliding identifier byte-identical and in its own class', async () => {
    for (const id of [PDFString.of('only-one'), PDFHexString.of('00FF10')]) {
      const doc = await load(await tagged());
      doc.context
        .lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict)
        .set(N('ID'), id);
      const a = await doc.save();
      const out = await rebuild([pageOf(a)], a);
      const carried = topElements(out)[0].lookup(N('ID')) as PDFString | PDFHexString;
      expect(carried.constructor).toBe(id.constructor);
      expect(idBytes(carried)).toBe(idBytes(id));
    }
  });

  it('preserves a Ref relationship between two elements as real output objects', async () => {
    const doc = await load(await tagged({ pages: 2 }));
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const kids = root.lookup(N('K'), PDFArray);
    const first = kids.get(0) as PDFRef;
    const second = kids.get(1) as PDFRef;
    // A forward and a backward relationship, so neither direction can rely on
    // the target having been built already.
    doc.context.lookup(first, PDFDict).set(N('Ref'), doc.context.obj([second]));
    doc.context.lookup(second, PDFDict).set(N('Ref'), doc.context.obj([first]));
    const a = await doc.save();

    const out = await rebuild([pageOf(a, 0), pageOf(a, 1)], a);
    const [outFirst, outSecond] = topElements(out);
    expect(out.context.lookup(outFirst.lookup(N('Ref'), PDFArray).get(0), PDFDict)).toBe(outSecond);
    expect(out.context.lookup(outSecond.lookup(N('Ref'), PDFArray).get(0), PDFDict)).toBe(outFirst);
  });

  it('preserves phonetic fields, associated files and unknown extension data', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    elem.set(N('PhoneticAlphabet'), N('x-sampa'));
    elem.set(N('Phoneme'), PDFHexString.fromText('nɪˈhoʊn'));
    elem.set(N('AF'), ctx.obj([{ Type: 'Filespec', F: PDFString.of('notes.txt'), Desc: PDFString.of('notes') }]));
    elem.set(N('VendorField'), ctx.obj({ Depth: PDFNumber.of(3), Label: PDFHexString.fromText('保持') }));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const carried = topElements(out)[0];
    expect(carried.lookup(N('PhoneticAlphabet'))).toBe(N('x-sampa'));
    expect(carried.lookup(N('Phoneme'), PDFHexString).decodeText()).toBe('nɪˈhoʊn');
    expect(carried.lookup(N('AF'), PDFArray).lookup(0, PDFDict).lookup(N('F'), PDFString).decodeText())
      .toBe('notes.txt');
    const vendor = carried.lookup(N('VendorField'), PDFDict);
    expect(vendor.lookup(N('Depth'), PDFNumber).asNumber()).toBe(3);
    expect(vendor.lookup(N('Label'), PDFHexString).decodeText()).toBe('保持');
  });

  it('preserves an attribute object array with its revision numbers', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    elem.set(N('A'), ctx.obj([
      { O: 'Layout', TextAlign: N('Center') }, PDFNumber.of(1),
      { O: 'Table', RowSpan: PDFNumber.of(2) }, PDFNumber.of(4),
    ]));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const attrs = topElements(out)[0].lookup(N('A'), PDFArray);
    expect(attrs.size()).toBe(4);
    expect(attrs.lookup(0, PDFDict).lookup(N('TextAlign'))).toBe(N('Center'));
    expect(attrs.lookup(1, PDFNumber).asNumber()).toBe(1);
    expect(attrs.lookup(2, PDFDict).lookup(N('RowSpan'), PDFNumber).asNumber()).toBe(2);
    expect(attrs.lookup(3, PDFNumber).asNumber()).toBe(4);
  });

  it('carries an attribute stream as bytes', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const payload = new TextEncoder().encode('opaque attribute payload');
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    elem.set(N('A'), ctx.register(ctx.stream(payload, { O: 'Layout' })));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const attrs = topElements(out)[0].lookup(N('A'));
    expect(attrs).toBeInstanceOf(PDFRawStream);
    expect((attrs as PDFRawStream).contents).toEqual(payload);
  });

  it('carries an optional Type only when the source wrote one', async () => {
    const doc = await load(await tagged());
    const elem = doc.context.lookup(
      doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')),
      PDFDict,
    );
    // Table 355: Type is optional on a structure element.
    elem.delete(N('Type'));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    expect(topElements(out)[0].get(N('Type'))).toBeUndefined();
    expect(topElements(out)[0].lookup(N('S'))).toBe(N('CustomRole'));

    const withType = await tagged();
    const out2 = await rebuild([pageOf(withType)], withType);
    expect(topElements(out2)[0].lookup(N('Type'))).toBe(N('StructElem'));
  });

  it('refuses an element with no structure type', async () => {
    const doc = await load(await tagged());
    doc.context
      .lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict)
      .delete(N('S'));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('preserves root auxiliary data and root extension fields', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    root.set(N('AF'), ctx.obj([{ Type: 'Filespec', F: PDFString.of('tree.txt') }]));
    root.set(N('PronunciationLexicon'), ctx.obj([
      ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of('lexicon.pls') })),
    ]));
    root.set(N('VendorRoot'), PDFHexString.fromText('ルート'));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const carried = rootOf(out);
    expect(carried.lookup(N('AF'), PDFArray).lookup(0, PDFDict).lookup(N('F'), PDFString).decodeText())
      .toBe('tree.txt');
    expect(
      carried.lookup(N('PronunciationLexicon'), PDFArray).lookup(0, PDFDict).lookup(N('F'), PDFString).decodeText(),
    ).toBe('lexicon.pls');
    expect(carried.lookup(N('VendorRoot'), PDFHexString).decodeText()).toBe('ルート');
  });
});

describe('struct semantics — shared payload identity', () => {
  it('keeps one shared object shared across every field category that names it', async () => {
    const doc = await load(await tagged({ pages: 2 }));
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const kids = root.lookup(N('K'), PDFArray);
    const shared = ctx.register(ctx.obj({ O: 'Layout', TextAlign: N('Center') }));
    // The same object named from an attribute, a class definition, an unknown
    // element field, an unknown root field and a namespace extra.
    for (let i = 0; i < kids.size(); i++) ctx.lookup(kids.get(i) as PDFRef, PDFDict).set(N('A'), shared);
    ctx.lookup(kids.get(0) as PDFRef, PDFDict).set(N('VendorField'), shared);
    root.set(N('ClassMap'), ctx.obj({ SharedClass: shared }));
    root.set(N('VendorRoot'), shared);
    const a = await doc.save();

    const out = await rebuild([pageOf(a, 0), pageOf(a, 1)], a);
    const carried = topElements(out);
    const first = carried[0].get(N('A'));
    expect(first).toBeInstanceOf(PDFRef);
    // One object, named five times.
    expect(carried[1].get(N('A'))).toBe(first);
    expect(carried[0].get(N('VendorField'))).toBe(first);
    expect(rootOf(out).get(N('VendorRoot'))).toBe(first);
    const classEntry = rootOf(out).lookup(N('ClassMap'), PDFDict).entries()[0][1];
    expect(classEntry).toBe(first);
    expect(out.context.lookup(first, PDFDict).lookup(N('TextAlign'))).toBe(N('Center'));
  });

  it('lets a payload hold a backreference to the structure root it hangs from', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const rootRef = doc.catalog.get(N('StructTreeRoot')) as PDFRef;
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    // The known source root must bind to the one actual rebuilt root. It is
    // not copied as an opaque second hierarchy.
    elem.set(N('VendorField'), ctx.obj({ Owner: rootRef }));
    const a = await doc.save();
    const out = await rebuild([pageOf(a)], a);
    expect(topElements(out)[0].lookup(N('VendorField'), PDFDict).get(N('Owner'))).toBe(out.catalog.get(N('StructTreeRoot')));
  });

  it('keeps a shared object shared between a namespace extra and an element', async () => {
    const doc = await load(await tagged({ namespace: 'https://example.invalid/a/' }));
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const shared = ctx.register(ctx.obj({ Note: PDFHexString.fromText('共有') }));
    const nsRef = root.lookup(N('Namespaces'), PDFArray).get(0) as PDFRef;
    ctx.lookup(nsRef, PDFDict).set(N('VendorNS'), shared);
    ctx.lookup(root.get(N('K')) as PDFRef, PDFDict).set(N('VendorField'), shared);
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const elemSide = topElements(out)[0].get(N('VendorField'));
    const nsSide = topElements(out)[0].lookup(N('NS'), PDFDict).get(N('VendorNS'));
    expect(elemSide).toBeInstanceOf(PDFRef);
    expect(nsSide).toBe(elemSide);
  });
});

describe('struct semantics — optional absence is decided on the resolved value', () => {
  it.each(['K', 'NS', 'Ref', 'R', 'Type', 'A', 'C', 'Alt', 'ID', 'Pg'])(
    'treats an indirect null %s as absent, like a direct null',
    async (key) => {
      const build = async (spelling: 'direct' | 'indirect' | 'dangling') => {
        const doc = await load(await tagged());
        const ctx = doc.context;
        const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
        if (key === 'K' || key === 'Pg') {
          // Without content there is no parent-tree entry to keep.
          doc.getPage(0).node.delete(N('Contents'));
          doc.getPage(0).node.delete(N('StructParents'));
          doc.catalog.lookup(N('StructTreeRoot'), PDFDict).set(N('ParentTree'), ctx.obj({ Nums: [] }));
          elem.delete(N('K'));
        }
        elem.set(
          N(key),
          spelling === 'direct' ? PDFNull : spelling === 'indirect' ? ctx.register(PDFNull) : PDFRef.of(99_999),
        );
        return doc.save();
      };
      for (const spelling of ['direct', 'indirect', 'dangling'] as const) {
        const a = await build(spelling);
        const out = await rebuild([pageOf(a)], a);
        const carried = topElements(out)[0];
        expect(carried.lookup(N('S'))).toBe(N('CustomRole'));
        expect(carried.lookup(N(key))).toBeUndefined();
      }
    },
  );

  it('keeps a valid empty element whose K resolves to null', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    doc.getPage(0).node.delete(N('Contents'));
    doc.getPage(0).node.delete(N('StructParents'));
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    root.set(N('ParentTree'), ctx.obj({ Nums: [] }));
    ctx.lookup(root.get(N('K')) as PDFRef, PDFDict).set(N('K'), ctx.register(PDFNull));
    const a = await doc.save();
    const out = await rebuild([pageOf(a)], a);
    // Absent content is a legal empty element, not content that vanished.
    expect(topElements(out)[0].lookup(N('S'))).toBe(N('CustomRole'));
    expect(topElements(out)[0].get(N('K'))).toBeUndefined();
  });

  it('drops a null entry inside a K array without pruning the element', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    elem.set(N('K'), ctx.obj([PDFNumber.of(0), PDFNull, ctx.register(PDFNull)]));
    const a = await doc.save();
    const out = await rebuild([pageOf(a)], a);
    expect(topElements(out)[0].lookup(N('K'), PDFNumber).asNumber()).toBe(0);
  });
});

describe('struct semantics — namespace meaning', () => {
  const withNamespace = async (build: (doc: PDFDocument, root: PDFDict) => PDFRef) => {
    const doc = await load(await tagged());
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const nsRef = build(doc, root);
    doc.context.lookup(root.get(N('K')) as PDFRef, PDFDict).set(N('NS'), nsRef);
    root.set(N('Namespaces'), doc.context.obj([nsRef]));
    return doc.save();
  };

  it.each([
    ['different schema values', 'first.xsd', 'second.xsd'],
    ['a schema present against absent', 'only.xsd', undefined],
  ])('refuses one namespace name with %s', async (_label, first, second) => {
    const make = (schema: string | undefined) =>
      withNamespace(doc => {
        const fields = doc.context.obj({
          Type: 'Namespace',
          NS: PDFString.of('urn:shared'),
          RoleMapNS: { CustomRole: 'P' },
        });
        if (schema !== undefined) fields.set(N('Schema'), PDFString.of(schema));
        return doc.context.register(fields);
      });
    const a = await make(first);
    const b = await make(second);
    await expect(rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own')).rejects.toThrow();
  });

  it('refuses one namespace name whose unknown fields differ', async () => {
    const make = (note: string) =>
      withNamespace((doc) =>
        doc.context.register(
          doc.context.obj({ Type: 'Namespace', NS: PDFString.of('urn:shared'), VendorNote: PDFString.of(note) }),
        ),
      );
    const a = await make('one');
    const b = await make('two');
    await expect(rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own')).rejects.toThrow();
  });

  it('coalesces one namespace name written in two text encodings, keeping the payload', async () => {
    const make = (uri: PDFString | PDFHexString) =>
      withNamespace((doc) =>
        doc.context.register(
          doc.context.obj({
            Type: 'Namespace',
            NS: uri,
            Schema: PDFString.of('same.xsd'),
            RoleMapNS: { CustomRole: 'P' },
          }),
        ),
      );
    const a = await make(PDFString.of('urn:shared'));
    const b = await make(PDFHexString.fromText('urn:shared'));
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    // One URI, one declaration, and the declaration still says everything.
    expect(rootOf(out).lookup(N('Namespaces'), PDFArray).size()).toBe(1);
    const [first, second] = topElements(out);
    expect(first.get(N('NS'))).toBe(second.get(N('NS')));
    const ns = first.lookup(N('NS'), PDFDict);
    expect(ns.lookup(N('Schema'), PDFString).decodeText()).toBe('same.xsd');
    expect(ns.lookup(N('RoleMapNS'), PDFDict).lookup(N('CustomRole'))).toBe(N('P'));
    expect(ns.lookup(N('NS'), PDFString).decodeText()).toBe('urn:shared');
  });

  it('refuses two encodings of one URI whose maps conflict', async () => {
    const make = (uri: PDFString | PDFHexString, role: string) =>
      withNamespace((doc) =>
        doc.context.register(
          doc.context.obj({ Type: 'Namespace', NS: uri, RoleMapNS: { CustomRole: role } }),
        ),
      );
    const a = await make(PDFString.of('urn:shared'), 'P');
    const b = await make(PDFHexString.fromText('urn:shared'), 'H1');
    await expect(rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own')).rejects.toThrow();
  });

  it('discovers a transitive namespace even when its parent is coalesced', async () => {
    const make = async (targetUri: string) => {
      const doc = await load(await tagged());
      const ctx = doc.context;
      const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
      const target = ctx.register(ctx.obj({ Type: 'Namespace', NS: PDFString.of(targetUri) }));
      const parent = ctx.register(
        ctx.obj({ Type: 'Namespace', NS: PDFString.of('urn:parent'), RoleMapNS: { CustomRole: [N('Para'), target] } }),
      );
      ctx.lookup(root.get(N('K')) as PDFRef, PDFDict).set(N('NS'), parent);
      root.set(N('Namespaces'), ctx.obj([parent, target]));
      return doc.save();
    };
    // Same parent URI and same map shape in both, so the parent coalesces —
    // and the target it names must still be declared and reachable.
    const a = await make('urn:target');
    const b = await make('urn:target');
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const declared = rootOf(out).lookup(N('Namespaces'), PDFArray);
    const uris = Array.from({ length: declared.size() }, (_, i) =>
      out.context.lookup(declared.get(i), PDFDict).lookup(N('NS'), PDFString).decodeText(),
    ).sort();
    expect(uris).toEqual(['urn:parent', 'urn:target']);
    const edge = topElements(out)[0]
      .lookup(N('NS'), PDFDict)
      .lookup(N('RoleMapNS'), PDFDict)
      .lookup(N('CustomRole'), PDFArray);
    expect(out.context.lookup(edge.get(1), PDFDict).lookup(N('NS'), PDFString).decodeText()).toBe('urn:target');
  });
});

describe('struct semantics — content ownership is not chosen by iteration order', () => {
  it('refuses two elements claiming one page marked-content identifier', async () => {
    const doc = await load(await tagged({ pages: 2 }));
    const kids = doc.catalog.lookup(N('StructTreeRoot'), PDFDict).lookup(N('K'), PDFArray);
    // Both elements now name page 0 and both claim MCID 0 there.
    doc.context.lookup(kids.get(1) as PDFRef, PDFDict).set(N('Pg'), doc.getPage(0).ref);
    doc.context.lookup(kids.get(1) as PDFRef, PDFDict).set(N('K'), PDFNumber.of(0));
    const a = await doc.save();
    await expect(rebuild([pageOf(a, 0), pageOf(a, 1)], a)).rejects.toThrow();
  });

  it('accepts one element claiming the same identifier through repeated references', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    const mcr = ctx.obj({ Type: 'MCR', MCID: 0 });
    mcr.set(N('Pg'), doc.getPage(0).ref);
    // The same owner naming its own content twice is not a conflict.
    elem.set(N('K'), ctx.obj([PDFNumber.of(0), mcr]));
    const a = await doc.save();
    const out = await rebuild([pageOf(a)], a);
    expect(topElements(out)[0].lookup(N('K'), PDFArray).size()).toBe(2);
  });

  it('refuses two elements claiming one object reference', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10] }));
    page.node.set(N('Annots'), ctx.obj([annot]));
    const root = ctx.obj({ Type: 'StructTreeRoot' });
    const rootRef = ctx.register(root);
    const claim = (role: string) => {
      const objr = ctx.obj({ Type: 'OBJR' });
      objr.set(N('Obj'), annot);
      objr.set(N('Pg'), page.ref);
      const elem = ctx.obj({ Type: 'StructElem', S: role, P: rootRef });
      elem.set(N('Pg'), page.ref);
      elem.set(N('K'), objr);
      return ctx.register(elem);
    };
    root.set(N('K'), ctx.obj([claim('Link'), claim('Form')]));
    doc.catalog.set(N('StructTreeRoot'), rootRef);
    doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });
});

describe('struct semantics — pronunciation lexicons', () => {
  const withLexicon = async (names: string[]) => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    doc.catalog
      .lookup(N('StructTreeRoot'), PDFDict)
      .set(
        N('PronunciationLexicon'),
        ctx.obj(names.map((name) => ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of(name) })))),
      );
    return doc.save();
  };

  it('carries one source lexicon list in its own order', async () => {
    const a = await withLexicon(['first.pls', 'second.pls']);
    const out = await rebuild([pageOf(a)], a);
    const list = rootOf(out).lookup(N('PronunciationLexicon'), PDFArray);
    expect(
      Array.from({ length: list.size() }, (_, i) =>
        out.context.lookup(list.get(i), PDFDict).lookup(N('F'), PDFString).decodeText(),
      ),
    ).toEqual(['first.pls', 'second.pls']);
  });

  it('refuses two sources whose lexicon precedence cannot be derived', async () => {
    // Concatenating would silently change how the later source's words are
    // pronounced, because the first matching lexicon wins.
    const a = await withLexicon(['own.pls']);
    const b = await withLexicon(['donor.pls']);
    await expect(rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own')).rejects.toThrow();
  });

  it('accepts two sources declaring the same lexicon list', async () => {
    const a = await withLexicon(['shared.pls']);
    const b = await withLexicon(['shared.pls']);
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const list = rootOf(out).lookup(N('PronunciationLexicon'), PDFArray);
    expect(list.size()).toBe(1);
    expect(out.context.lookup(list.get(0), PDFDict).lookup(N('F'), PDFString).decodeText()).toBe('shared.pls');
  });

  it('accumulates associated files from every source', async () => {
    const withAF = async (name: string) => {
      const doc = await load(await tagged());
      const ctx = doc.context;
      doc.catalog
        .lookup(N('StructTreeRoot'), PDFDict)
        .set(N('AF'), ctx.obj([ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of(name) }))]));
      return doc.save();
    };
    const a = await withAF('own.xml');
    const b = await withAF('donor.xml');
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    const list = rootOf(out).lookup(N('AF'), PDFArray);
    expect(
      Array.from({ length: list.size() }, (_, i) =>
        out.context.lookup(list.get(i), PDFDict).lookup(N('F'), PDFString).decodeText(),
      ),
    ).toEqual(['own.xml', 'donor.xml']);
  });
});

describe('struct semantics — MarkInfo', () => {
  it('keeps Suspects rather than promoting suspect content to an unqualified claim', async () => {
    const a = await tagged({ marked: true, suspects: true });
    const out = await rebuild([pageOf(a)], a);
    const info = out.catalog.lookup(N('MarkInfo'), PDFDict);
    expect(String(info.lookup(N('Suspects')))).toBe('true');
    expect(String(info.lookup(N('Marked')))).toBe('true');
  });

  it('does not assert Marked when a contributing source was not marked', async () => {
    const a = await tagged({ marked: true });
    const b = await tagged({ marked: false });
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    expect(String(out.catalog.lookup(N('MarkInfo'), PDFDict).lookup(N('Marked')))).toBe('false');
  });

  it('does not assert Marked when an untagged source contributed a page', async () => {
    const a = await tagged({ marked: true });
    const plain = await PDFDocument.create({ updateMetadata: false });
    plain.addPage([300, 700]);
    const b = await plain.save();
    const out = await rebuild([pageOf(a, 0, 'own'), pageOf(b, 0, 'donor')], a, 'own');
    expect(String(out.catalog.lookup(N('MarkInfo'), PDFDict).lookup(N('Marked')))).toBe('false');
    // The tree itself still carried.
    expect(topElements(out)).toHaveLength(1);
  });

  it('carries UserProperties when a source declared it', async () => {
    const doc = await load(await tagged());
    doc.catalog.lookup(N('MarkInfo'), PDFDict).set(N('UserProperties'), doc.context.obj(true));
    const a = await doc.save();
    const out = await rebuild([pageOf(a)], a);
    expect(String(out.catalog.lookup(N('MarkInfo'), PDFDict).lookup(N('UserProperties')))).toBe('true');
  });

  it('leaves Suspects absent when no source declared it', async () => {
    const a = await tagged();
    const out = await rebuild([pageOf(a)], a);
    expect(out.catalog.lookup(N('MarkInfo'), PDFDict).get(N('Suspects'))).toBeUndefined();
  });
});

describe('struct semantics — content ownership', () => {
  it('gives every occurrence of a repeated page its own parent tree entry', async () => {
    const a = await tagged();
    const out = await rebuild([pageOf(a, 0), pageOf(a, 0)], a);
    const pages = out.getPages();
    expect(pages).toHaveLength(2);
    const keys = pages.map((page) => (page.node.lookup(N('StructParents')) as PDFNumber).asNumber());
    // Two distinct keys, both resolving to the one element that owns MCID 0.
    expect(new Set(keys).size).toBe(2);
    const nums = rootOf(out).lookup(N('ParentTree'), PDFDict).lookup(N('Nums'), PDFArray);
    const byKey = new Map<number, PDFArray>();
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      byKey.set(nums.lookup(i, PDFNumber).asNumber(), nums.lookup(i + 1, PDFArray));
    }
    const owners = keys.map((key) => out.context.lookup(byKey.get(key)!.get(0), PDFDict));
    expect(owners[0]).toBe(owners[1]);
    expect(owners[0]).toBe(topElements(out)[0]);
  });

  it('keeps a valid empty structural element whose K is absent', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const existing = root.get(N('K')) as PDFRef;
    const empty = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Sect', P: doc.catalog.get(N('StructTreeRoot'))! }));
    root.set(N('K'), ctx.obj([existing, empty]));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const roles = topElements(out).map((elem) => (elem.lookup(N('S')) as PDFName).asString());
    expect(roles).toContain('/Sect');
  });

  it('keeps a valid structural element whose K is an empty array', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const existing = root.get(N('K')) as PDFRef;
    const empty = ctx.obj({ Type: 'StructElem', S: 'Div', P: doc.catalog.get(N('StructTreeRoot'))! });
    empty.set(N('K'), ctx.obj([]));
    root.set(N('K'), ctx.obj([existing, ctx.register(empty)]));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    expect(topElements(out).map((elem) => (elem.lookup(N('S')) as PDFName).asString())).toContain('/Div');
  });

  it('prunes an element whose content actually went away', async () => {
    const a = await tagged({ pages: 2 });
    const out = await rebuild([pageOf(a, 1)], a);
    // One page kept, so only its element survives.
    expect(topElements(out)).toHaveLength(1);
    expect(topElements(out)[0].get(N('Pg'))).toBe(out.getPages()[0].ref);
  });

  it('reaches marked content inside a nested Form XObject', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    // Marked content three resource levels down: page → Form → Form.
    const inner = ctx.register(ctx.stream('/P <</MCID 5>> BDC 0 0 4 4 re f EMC', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
    }));
    const outerStream = ctx.stream('/Fm1 Do', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10],
      Resources: { XObject: { Fm1: inner } },
    });
    const outer = ctx.register(outerStream);
    page.node.set(N('Resources'), ctx.obj({ XObject: { Fm0: outer } }));
    page.node.set(N('Contents'), ctx.register(ctx.stream('/Fm0 Do')));

    const root = ctx.obj({ Type: 'StructTreeRoot' });
    const rootRef = ctx.register(root);
    const mcr = ctx.obj({ Type: 'MCR', MCID: 5 });
    mcr.set(N('Pg'), page.ref);
    mcr.set(N('Stm'), inner);
    const elem = ctx.obj({ Type: 'StructElem', S: 'P', P: rootRef });
    elem.set(N('K'), mcr);
    root.set(N('K'), ctx.register(elem));
    root.set(N('ParentTree'), ctx.obj({ Nums: [] }));
    doc.catalog.set(N('StructTreeRoot'), rootRef);
    doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
    const a = await doc.save();

    const out = await rebuild([pageOf(a)], a);
    const carriedMcr = topElements(out)[0].lookup(N('K'), PDFDict);
    expect(carriedMcr.lookup(N('MCID'), PDFNumber).asNumber()).toBe(5);
    // The nested Form survived the six-level ceiling and is a real output
    // stream, so the MCR is not dangling.
    const stm = carriedMcr.get(N('Stm'));
    expect(stm).toBeInstanceOf(PDFRef);
    expect(out.context.lookup(stm)).toBeInstanceOf(PDFRawStream);
  });

  it('gives a duplicated annotation one object reference per occurrence', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([300, 700]);
    const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10] }));
    page.node.set(N('Annots'), ctx.obj([annot]));
    const root = ctx.obj({ Type: 'StructTreeRoot' });
    const rootRef = ctx.register(root);
    const objr = ctx.obj({ Type: 'OBJR' });
    objr.set(N('Obj'), annot);
    objr.set(N('Pg'), page.ref);
    const elem = ctx.obj({ Type: 'StructElem', S: 'Link', P: rootRef });
    elem.set(N('Pg'), page.ref);
    elem.set(N('K'), objr);
    root.set(N('K'), ctx.register(elem));
    doc.catalog.set(N('StructTreeRoot'), rootRef);
    doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
    const a = await doc.save();

    const out = await rebuild([pageOf(a, 0), pageOf(a, 0)], a);
    const kids = topElements(out)[0].lookup(N('K'), PDFArray);
    expect(kids.size()).toBe(2);
    const targets = [0, 1].map((i) => kids.lookup(i, PDFDict).get(N('Obj')));
    // Two renderings, two distinct annotation objects.
    expect(new Set(targets.map(String)).size).toBe(2);
    for (const [i, target] of targets.entries()) {
      const annotDict = out.context.lookup(target, PDFDict);
      const key = (annotDict.lookup(N('StructParent')) as PDFNumber).asNumber();
      expect(Number.isInteger(key)).toBe(true);
      expect(kids.lookup(i, PDFDict).get(N('Pg'))).toBe(out.getPages()[i].ref);
    }
  });
});

describe('struct semantics — malformed input and bounds', () => {
  it('refuses a cyclic structure tree instead of silently truncating it', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('StructTreeRoot'), PDFDict);
    const elemRef = root.get(N('K')) as PDFRef;
    const elem = ctx.lookup(elemRef, PDFDict);
    const child = ctx.obj({ Type: 'StructElem', S: 'Span', P: elemRef });
    const childRef = ctx.register(child);
    child.set(N('K'), ctx.obj([elemRef]));
    elem.set(N('K'), ctx.obj([PDFNumber.of(0), childRef]));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('refuses an MCID past the index bound instead of reserving its array', async () => {
    const doc = await load(await tagged());
    const elem = doc.context.lookup(
      doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')),
      PDFDict,
    );
    elem.set(N('K'), PDFNumber.of(50_000_000));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('refuses an MCR with no marked-content identifier', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    const mcr = ctx.obj({ Type: 'MCR' });
    mcr.set(N('Pg'), doc.getPage(0).ref);
    elem.set(N('K'), mcr);
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('refuses a Ref pointing outside the source structure tree', async () => {
    const doc = await load(await tagged());
    const elem = doc.context.lookup(
      doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')),
      PDFDict,
    );
    elem.set(N('Ref'), doc.context.obj([doc.getPage(0).ref]));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('refuses an attribute payload that proves itself a page', async () => {
    const doc = await load(await tagged());
    const elem = doc.context.lookup(
      doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')),
      PDFDict,
    );
    elem.set(N('A'), doc.context.obj({ O: 'Layout', Vendor: doc.getPage(0).ref }));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('refuses an extension payload carrying an action', async () => {
    const doc = await load(await tagged());
    const ctx = doc.context;
    const elem = ctx.lookup(doc.catalog.lookup(N('StructTreeRoot'), PDFDict).get(N('K')), PDFDict);
    elem.set(N('VendorField'), ctx.obj({ Nested: ctx.obj({ S: 'Launch', F: PDFString.of('no.exe') }) }));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('refuses a RoleMap target that is not a name', async () => {
    const doc = await load(await tagged());
    doc.catalog
      .lookup(N('StructTreeRoot'), PDFDict)
      .lookup(N('RoleMap'), PDFDict)
      .set(N('CustomRole'), PDFString.of('P'));
    const a = await doc.save();
    await expect(rebuild([pageOf(a)], a)).rejects.toThrow();
  });

  it('keeps a circular role chain, which the format permits', async () => {
    // 14.7.3 NOTE 2: circular chains are explicitly allowed, so a source with
    // one is valid input and must survive.
    const a = await tagged({ role: 'Mid', roleChain: { Mid: 'CustomRole' } });
    const out = await rebuild([pageOf(a)], a);
    const map = rootOf(out).lookup(N('RoleMap'), PDFDict);
    expect(map.lookup(N('CustomRole'))).toBe(N('Mid'));
    expect(map.lookup(N('Mid'))).toBe(N('CustomRole'));
  });

  it('an untagged rebuild publishes no structure root and no MarkInfo', async () => {
    const plain = await PDFDocument.create({ updateMetadata: false });
    const page = plain.addPage([300, 700]);
    page.node.set(N('StructParents'), PDFNumber.of(7));
    const b = await plain.save();
    const out = await rebuild([pageOf(b)], b);
    expect(out.catalog.get(N('StructTreeRoot'))).toBeUndefined();
    expect(out.catalog.get(N('MarkInfo'))).toBeUndefined();
    expect(out.getPages()[0].node.get(N('StructParents'))).toBeUndefined();
  });
});

describe('struct semantics — tree consistency', () => {
  it('every element parent, parent tree entry and page key agree', async () => {
    const a = await tagged({ pages: 2 });
    const out = await rebuild([pageOf(a, 0), pageOf(a, 1)], a);
    const root = rootOf(out);
    const rootRef = out.catalog.get(N('StructTreeRoot')) as PDFRef;

    for (const elem of allElements(out)) {
      const parent = elem.get(N('P'));
      expect(parent).toBeInstanceOf(PDFRef);
      const resolved = out.context.lookup(parent);
      expect(resolved === root || resolved instanceof PDFDict).toBe(true);
    }
    expect(topElements(out).every((elem) => elem.get(N('P')) === rootRef)).toBe(true);

    const nums = root.lookup(N('ParentTree'), PDFDict).lookup(N('Nums'), PDFArray);
    const keys: number[] = [];
    for (let i = 0; i + 1 < nums.size(); i += 2) keys.push(nums.lookup(i, PDFNumber).asNumber());
    expect(keys).toEqual([...keys].sort((x, y) => x - y));
    const next = root.lookup(N('ParentTreeNextKey'), PDFNumber).asNumber();
    expect(next).toBeGreaterThan(Math.max(...keys));
    for (const page of out.getPages()) {
      const key = (page.node.lookup(N('StructParents')) as PDFNumber).asNumber();
      expect(keys).toContain(key);
    }
  });

  it('returns a structure map naming the real output element for each source element', async () => {
    // The map this module returns is how carryDocumentCatalog resolves a
    // structure destination, so every source element tag must name an output
    // element that actually exists.
    const a = await tagged({ pages: 2 });
    const src = await load(a);
    const output = await PDFDocument.create({ updateMetadata: false });
    const copied = await output.copyPages(src, [0, 1]);
    for (const page of copied) output.addPage(page);

    const maps = carryStructTree(output, [
      { doc: src, pairs: copied.map((outPage, i) => ({ srcIndex: i, outPage })) },
    ]);
    const map = maps.get(src);
    expect(map).toBeDefined();
    const srcKids = src.catalog.lookup(N('StructTreeRoot'), PDFDict).lookup(N('K'), PDFArray);
    for (let i = 0; i < srcKids.size(); i++) {
      const tag = (srcKids.get(i) as PDFRef).tag;
      const mapped = map!.get(tag);
      expect(mapped).toBeInstanceOf(PDFRef);
      const elem = output.context.lookup(mapped, PDFDict);
      expect(elem.lookup(N('S'))).toBe(N('CustomRole'));
      expect(elem.get(N('P'))).toBe(output.catalog.get(N('StructTreeRoot')));
    }
  });
});
