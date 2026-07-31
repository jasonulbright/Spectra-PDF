// The structure-tree carry (lib/struct-carry.ts) — § I P19. Before it, ANY
// committed page edit on a tagged file dropped /StructTreeRoot + /MarkInfo
// and left every page's /StructParents pointing into a ParentTree that no
// longer existed. The carry rebuilds the surviving tree per contributing
// source (the AcroForm precedent), renumbers the ParentTree in output
// order, and unconditionally sweeps stale keys.
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from 'pdf-lib';

import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

const N = PDFName.of.bind(PDFName);

const pageOf = (bytes: Uint8Array, index: number, sourceKey = 'own'): ExportPage => ({
  bytes,
  sourceKey,
  pageIndex: index,
});

const nameOf = (v: unknown): string => String(v); // PDFName stringifies as /Name

/**
 * Two tagged pages + one annotation:
 *   Document
 *     ├─ P   (page 0, MCID 0, /ID 'p-one')
 *     ├─ P2  (page 1, kids [MCID 1, MCR{pg1, MCID 0}])
 *     └─ Link (OBJR → the page-0 annotation)
 * plus RoleMap {Chap: Sect} and /MarkInfo.
 */
async function taggedSource(roleMap: Record<string, string> = { Chap: 'Sect' }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.addPage([200, 200]);
  const ctx = doc.context;
  const [pg0, pg1] = doc.getPages();

  const annot = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10], StructParent: 3 });
  const annotRef = ctx.register(annot);
  pg0.node.set(N('Annots'), ctx.obj([annotRef]));

  const rootDict = ctx.obj({ Type: 'StructTreeRoot' });
  const rootRef = ctx.register(rootDict);
  const docElem = ctx.obj({ Type: 'StructElem', S: 'Document' });
  const docRef = ctx.register(docElem);
  docElem.set(N('P'), rootRef);

  const p1 = ctx.obj({ Type: 'StructElem', S: 'P', K: 0, ID: PDFString.of('p-one') });
  const p1Ref = ctx.register(p1);
  p1.set(N('P'), docRef);
  p1.set(N('Pg'), pg0.ref);

  const mcr = ctx.obj({ Type: 'MCR', MCID: 0 });
  mcr.set(N('Pg'), pg1.ref);
  const p2 = ctx.obj({ Type: 'StructElem', S: 'P' });
  const p2Ref = ctx.register(p2);
  p2.set(N('P'), docRef);
  p2.set(N('Pg'), pg1.ref);
  p2.set(N('K'), ctx.obj([1, mcr]));

  const objr = ctx.obj({ Type: 'OBJR' });
  objr.set(N('Obj'), annotRef);
  objr.set(N('Pg'), pg0.ref);
  const link = ctx.obj({ Type: 'StructElem', S: 'Link' });
  const linkRef = ctx.register(link);
  link.set(N('P'), docRef);
  link.set(N('Pg'), pg0.ref);
  link.set(N('K'), objr);

  docElem.set(N('K'), ctx.obj([p1Ref, p2Ref, linkRef]));
  rootDict.set(N('K'), docRef);
  const rm = ctx.obj({});
  for (const [k, v] of Object.entries(roleMap)) rm.set(N(k), N(v));
  rootDict.set(N('RoleMap'), rm);
  // A realistic (soon stale) source ParentTree + page keys.
  rootDict.set(
    N('ParentTree'),
    ctx.obj({ Nums: [0, ctx.obj([p1Ref]), 1, ctx.obj([ctx.obj(null), p2Ref]), 3, linkRef] }),
  );
  rootDict.set(N('ParentTreeNextKey'), PDFNumber.of(4));
  pg0.node.set(N('StructParents'), PDFNumber.of(0));
  pg1.node.set(N('StructParents'), PDFNumber.of(1));
  doc.catalog.set(N('StructTreeRoot'), rootRef);
  doc.catalog.set(N('MarkInfo'), ctx.obj({ Marked: true }));
  return doc.save();
}

async function untaggedWithStaleKeys(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pg = doc.addPage([200, 200]);
  pg.node.set(N('StructParents'), PDFNumber.of(7)); // stale garbage
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [0, 0, 5, 5],
    StructParent: 9,
  });
  pg.node.set(N('Annots'), doc.context.obj([doc.context.register(annot)]));
  return doc.save();
}

async function rebuild(pages: ExportPage[]): Promise<PDFDocument> {
  return PDFDocument.load(await buildPdf(pages, undefined, 'own'));
}

function structRoot(doc: PDFDocument): PDFDict | undefined {
  return doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict);
}

function parentTreeEntries(doc: PDFDocument): Map<number, unknown> {
  const root = structRoot(doc)!;
  const tree = root.lookupMaybe(N('ParentTree'), PDFDict)!;
  const nums = tree.lookupMaybe(N('Nums'), PDFArray)!;
  const out = new Map<number, unknown>();
  for (let i = 0; i + 1 < nums.size(); i += 2) {
    out.set((nums.lookup(i) as PDFNumber).asNumber(), nums.get(i + 1));
  }
  return out;
}

describe('struct carry (P19)', () => {
  it('a same-shape rebuild keeps the whole tree, renumbered and re-anchored', async () => {
    const src = await taggedSource();
    const out = await rebuild([pageOf(src, 0), pageOf(src, 1)]);
    const outPages = out.getPages();
    const root = structRoot(out);
    expect(root).toBeDefined();

    const docElem = root!.lookupMaybe(N('K'), PDFDict)!;
    expect(nameOf(docElem.lookup(N('S')))).toBe('/Document');
    const kids = docElem.lookupMaybe(N('K'), PDFArray)!;
    expect(kids.size()).toBe(3);

    const p1 = kids.lookupMaybe(0, PDFDict)!;
    expect(p1.get(N('Pg'))).toEqual(outPages[0].ref);
    // Page 0's StructParents points at a ParentTree entry whose MCID-0 slot
    // is the P element.
    const key0 = (outPages[0].node.lookup(N('StructParents')) as PDFNumber).asNumber();
    const entries = parentTreeEntries(out);
    const raw0 = entries.get(key0);
    const asArray0 =
      raw0 instanceof PDFRef ? (out.context.lookup(raw0) as PDFArray) : (raw0 as PDFArray);
    expect(asArray0).toBeInstanceOf(PDFArray);
    expect(asArray0.get(0)).toEqual(kids.get(0));

    // MCID + MCR kids of P2 registered under page 1's key.
    const key1 = (outPages[1].node.lookup(N('StructParents')) as PDFNumber).asNumber();
    expect(key1).not.toBe(key0);

    // RoleMap + IDTree + MarkInfo carried.
    const roleMap = root!.lookupMaybe(N('RoleMap'), PDFDict)!;
    expect(nameOf(roleMap.lookup(N('Chap')))).toBe('/Sect');
    const idTree = root!.lookupMaybe(N('IDTree'), PDFDict)!;
    const names = idTree.lookupMaybe(N('Names'), PDFArray)!;
    expect((names.lookup(0) as PDFString | PDFHexString).decodeText()).toBe('p-one');
    const markInfo = out.catalog.lookupMaybe(N('MarkInfo'), PDFDict);
    expect(String(markInfo?.lookup(N('Marked')))).toBe('true');
  });

  it('deleting a tagged page prunes its branch; survivors renumber cleanly', async () => {
    const src = await taggedSource();
    const out = await rebuild([pageOf(src, 1)]); // page 0 (P + Link annot) gone
    const root = structRoot(out)!;
    const docElem = root.lookupMaybe(N('K'), PDFDict)!;
    // Only P2 survives — P and Link lost every kid with page 0.
    const k = docElem.get(N('K'));
    const soleKid =
      k instanceof PDFRef ? (out.context.lookup(k) as PDFDict) : docElem.lookupMaybe(N('K'), PDFDict)!;
    expect(nameOf(soleKid.lookup(N('S')))).toBe('/P');
    expect(soleKid.get(N('Pg'))).toEqual(out.getPages()[0].ref);
    const key = (out.getPages()[0].node.lookup(N('StructParents')) as PDFNumber).asNumber();
    expect(key).toBe(0);
    expect((root.lookup(N('ParentTreeNextKey')) as PDFNumber).asNumber()).toBe(1);
  });

  it('an untagged rebuild sweeps stale /StructParents and /StructParent keys', async () => {
    const src = await untaggedWithStaleKeys();
    const out = await rebuild([pageOf(src, 0)]);
    expect(out.catalog.get(N('StructTreeRoot'))).toBeUndefined();
    expect(out.catalog.get(N('MarkInfo'))).toBeUndefined();
    const page = out.getPages()[0];
    expect(page.node.get(N('StructParents'))).toBeUndefined();
    const annot = page.node.lookupMaybe(N('Annots'), PDFArray)!.lookupMaybe(0, PDFDict)!;
    expect(annot.get(N('StructParent'))).toBeUndefined();
  });

  it('two tagged sources merge under one root with unique keys; RoleMap merges first-wins', async () => {
    const a = await taggedSource({ X: 'P' });
    const b = await taggedSource({ X: 'Sect', Y: 'H1' });
    const out = await PDFDocument.load(
      await buildPdf([pageOf(a, 0, 'a'), pageOf(b, 0, 'b')], undefined, 'a'),
    );
    const root = structRoot(out)!;
    const tops = root.lookupMaybe(N('K'), PDFArray)!;
    expect(tops.size()).toBe(2);
    const outPages = out.getPages();
    const k0 = (outPages[0].node.lookup(N('StructParents')) as PDFNumber).asNumber();
    const k1 = (outPages[1].node.lookup(N('StructParents')) as PDFNumber).asNumber();
    expect(k0).not.toBe(k1);
    const roleMap = root.lookupMaybe(N('RoleMap'), PDFDict)!;
    expect(nameOf(roleMap.lookup(N('X')))).toBe('/P'); // first-wins
    expect(nameOf(roleMap.lookup(N('Y')))).toBe('/H1');
  });

  it('an annotation OBJR remaps and its /StructParent is rewritten', async () => {
    const src = await taggedSource();
    const out = await rebuild([pageOf(src, 0), pageOf(src, 1)]);
    const outPages = out.getPages();
    const annots = outPages[0].node.lookupMaybe(N('Annots'), PDFArray)!;
    const annotRef = annots.get(0) as PDFRef;
    const annot = out.context.lookup(annotRef) as PDFDict;
    const key = (annot.lookup(N('StructParent')) as PDFNumber).asNumber();
    const entries = parentTreeEntries(out);
    const linkRef = entries.get(key);
    expect(linkRef).toBeInstanceOf(PDFRef);
    const link = out.context.lookup(linkRef as PDFRef) as PDFDict;
    expect(nameOf(link.lookup(N('S')))).toBe('/Link');
    // The OBJR inside Link points at the COPIED annotation.
    const objr = link.lookupMaybe(N('K'), PDFDict)!;
    expect(objr.get(N('Obj'))).toEqual(annotRef);
  });
});
