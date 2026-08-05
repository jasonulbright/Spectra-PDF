// Carries the tagged-PDF structure tree (/StructTreeRoot) through the
// from-scratch rebuild in pdfx-build.ts. The marked-content
// operators (MCIDs) survive inside the copied page streams, so before this
// module ANY committed page edit on a tagged file orphaned them all: the
// tree, the ParentTree, and /MarkInfo were silently dropped, and every page
// kept a STALE /StructParents key pointing into a number tree that no
// longer existed. Same family as the /AcroForm and catalog carries.
//
// PER-SOURCE contributions, the ACROFORM precedent (not embedded-files'
// own-bytes-only rule): tags are PAGE-anchored semantics — an inserted donor
// page's MCIDs arrive in its content stream, and dropping the donor's
// subtree would orphan real content. Each contributing source's surviving
// subtree lands under one output root; RoleMap/ClassMap merge first-wins.
//
// Nothing here uses PDFObjectCopier on the TREE: struct elems reference
// pages (/Pg), annotations (OBJR /Obj), and content streams (MCR /Stm), and
// a copier pass would re-copy every page it reached (its cache cannot know
// what copyPages already did). The tree is rebuilt by hand against the
// builder's page pairs and the parallel in-page object map; only page-free
// attribute payloads (/A, ClassMap values) go through a copier.
//
// The ParentTree is renumbered from scratch in OUTPUT order, and the stale
// key sweep runs UNCONDITIONALLY — an untagged rebuild must also drop the
// dangling /StructParents (+ annotation /StructParent) integers the page
// copies drag along.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  PDFString,
} from 'pdf-lib';

import { buildInPageObjectMap, type CarriedSourcePages, type ObjectMap } from './catalog-carry';

const N = PDFName.of.bind(PDFName);

interface Registration {
  /** Container tag: an output PAGE ref tag, or a mapped content-STREAM ref
   * tag (marked content inside a Form XObject). */
  containerTag: string;
  mcid: number;
  elem: PDFRef;
}

interface AnnotParent {
  annotRef: PDFRef;
  elem: PDFRef;
}

interface CarryCtx {
  output: PDFDocument;
  source: PDFDocument;
  pageByTag: Map<string, PDFPage>;
  objMap: ObjectMap;
  copier: PDFObjectCopier;
  registrations: Registration[];
  annotParents: AnnotParent[];
  idEntries: Map<string, PDFRef>;
  visited: Set<string>;
}

function copyText(v: PDFObject | undefined): PDFString | null {
  if (v instanceof PDFString || v instanceof PDFHexString) return PDFString.of(v.decodeText());
  return null;
}

/** Normalize a /K value to an array of kid entries. */
function kidsOf(source: PDFDocument, k: PDFObject | undefined): PDFObject[] {
  if (k === undefined) return [];
  const resolved = k instanceof PDFRef ? source.context.lookup(k) : k;
  if (resolved instanceof PDFArray) {
    const out: PDFObject[] = [];
    for (let i = 0; i < resolved.size(); i++) {
      const el = resolved.get(i);
      if (el !== undefined) out.push(el);
    }
    return out;
  }
  return [k];
}

function rebuildElem(
  ctx: CarryCtx,
  srcElem: PDFDict,
  srcTag: string | null,
  parentRef: PDFRef,
  inheritedPgTag: string | null,
): PDFRef | null {
  if (srcTag) {
    if (ctx.visited.has(srcTag)) return null; // cycle — a malformed tree must not hang the commit
    ctx.visited.add(srcTag);
  }
  const srcPg = srcElem.get(N('Pg'));
  const ownPgTag = srcPg instanceof PDFRef ? srcPg.tag : null;
  const effectivePgTag = ownPgTag ?? inheritedPgTag;

  const out = ctx.output.context.obj({ Type: 'StructElem' });
  const outRef = ctx.output.context.register(out);
  out.set(N('P'), parentRef);
  const s = srcElem.lookup(N('S'));
  if (s instanceof PDFName) out.set(N('S'), N(s.decodeText()));
  for (const key of ['Lang', 'Alt', 'ActualText', 'E', 'T'] as const) {
    const copied = copyText(srcElem.lookup(N(key)));
    if (copied) out.set(N(key), copied);
  }
  const id = copyText(srcElem.lookup(N('ID')));
  // Attribute payloads are page-ref-free (Layout/List/Table dicts, class
  // names) — the one place a plain deep copy is safe.
  const attrs = srcElem.get(N('A'));
  if (attrs !== undefined) {
    const resolved = attrs instanceof PDFRef ? ctx.source.context.lookup(attrs) : attrs;
    if (resolved !== undefined) out.set(N('A'), ctx.copier.copy(resolved));
  }
  const classes = srcElem.get(N('C'));
  if (classes !== undefined) {
    const resolved = classes instanceof PDFRef ? ctx.source.context.lookup(classes) : classes;
    if (resolved instanceof PDFName) out.set(N('C'), N(resolved.decodeText()));
    else if (resolved instanceof PDFArray) out.set(N('C'), ctx.copier.copy(resolved));
  }

  // Kids — registrations are PENDED and flushed only if the elem survives,
  // so a fully-pruned elem leaves no ParentTree ghosts.
  const pendingRegs: Registration[] = [];
  const pendingAnnots: AnnotParent[] = [];
  const outKids: PDFObject[] = [];
  for (const kid of kidsOf(ctx.source, srcElem.get(N('K')))) {
    if (kid instanceof PDFNumber) {
      // A bare MCID refers to the nearest /Pg up the chain.
      if (!effectivePgTag) continue;
      const outPage = ctx.pageByTag.get(effectivePgTag);
      if (!outPage) continue;
      pendingRegs.push({ containerTag: outPage.ref.tag, mcid: kid.asNumber(), elem: outRef });
      outKids.push(PDFNumber.of(kid.asNumber()));
      continue;
    }
    const kidTag = kid instanceof PDFRef ? kid.tag : null;
    const resolved = kid instanceof PDFRef ? ctx.source.context.lookup(kid) : kid;
    if (!(resolved instanceof PDFDict)) continue;
    const type = resolved.lookup(N('Type'));
    const typeName = type instanceof PDFName ? type.decodeText() : null;
    if (typeName === 'MCR') {
      const mcid = resolved.lookup(N('MCID'));
      if (!(mcid instanceof PDFNumber)) continue;
      const mcrPg = resolved.get(N('Pg'));
      const mcrPgTag = mcrPg instanceof PDFRef ? mcrPg.tag : effectivePgTag;
      if (!mcrPgTag) continue;
      const outPage = ctx.pageByTag.get(mcrPgTag);
      if (!outPage) continue;
      const stm = resolved.get(N('Stm'));
      const mappedStm = stm instanceof PDFRef ? ctx.objMap.get(stm.tag) : undefined;
      if (stm instanceof PDFRef && !mappedStm) continue; // its XObject is gone
      const outMcr = ctx.output.context.obj({ Type: 'MCR', MCID: mcid.asNumber() });
      outMcr.set(N('Pg'), outPage.ref);
      if (mappedStm) outMcr.set(N('Stm'), mappedStm);
      pendingRegs.push({
        containerTag: mappedStm ? mappedStm.tag : outPage.ref.tag,
        mcid: mcid.asNumber(),
        elem: outRef,
      });
      outKids.push(outMcr);
      continue;
    }
    if (typeName === 'OBJR') {
      const obj = resolved.get(N('Obj'));
      const mapped = obj instanceof PDFRef ? ctx.objMap.get(obj.tag) : undefined;
      if (!mapped) continue; // the annotation's page was dropped
      const outObjr = ctx.output.context.obj({ Type: 'OBJR' });
      outObjr.set(N('Obj'), mapped);
      const objrPg = resolved.get(N('Pg'));
      const objrPgTag = objrPg instanceof PDFRef ? objrPg.tag : effectivePgTag;
      const outPage = objrPgTag ? ctx.pageByTag.get(objrPgTag) : undefined;
      if (outPage) outObjr.set(N('Pg'), outPage.ref);
      pendingAnnots.push({ annotRef: mapped, elem: outRef });
      outKids.push(outObjr);
      continue;
    }
    // A child structure element.
    const childRef = rebuildElem(ctx, resolved, kidTag, outRef, effectivePgTag);
    if (childRef) outKids.push(childRef);
  }

  if (outKids.length === 0) return null; // nothing survived below — prune
  if (ownPgTag) {
    const outPage = ctx.pageByTag.get(ownPgTag);
    if (outPage) out.set(N('Pg'), outPage.ref);
  }
  out.set(N('K'), outKids.length === 1 ? outKids[0] : ctx.output.context.obj(outKids));
  ctx.registrations.push(...pendingRegs);
  ctx.annotParents.push(...pendingAnnots);
  if (id && !ctx.idEntries.has(id.decodeText())) ctx.idEntries.set(id.decodeText(), outRef);
  return outRef;
}

/** Merge a name→name dict (RoleMap) or name→object dict (ClassMap),
 * first-wins on collision. */
function mergeMap(
  out: PDFDict,
  src: PDFDict | undefined,
  copier: PDFObjectCopier,
): void {
  if (!src) return;
  for (const [key, value] of src.entries()) {
    if (out.has(key)) continue;
    out.set(key, copier.copy(value));
  }
}

/** Remove the stale structure keys the page copies drag along. Runs for
 * EVERY rebuild — with no carried tree, a lingering /StructParents integer
 * points into a ParentTree that does not exist. */
function sweepStaleKeys(output: PDFDocument): void {
  for (const page of output.getPages()) {
    page.node.delete(N('StructParents'));
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict);
      annot?.delete(N('StructParent'));
    }
  }
}

/**
 * Rebuild the output /StructTreeRoot from every contributing source's
 * surviving tags. Call AFTER all pages are added, with the SAME loaded
 * source instances the builder copied from.
 */
export function carryStructTree(output: PDFDocument, sources: CarriedSourcePages[]): void {
  sweepStaleKeys(output);

  const rootDict = output.context.obj({ Type: 'StructTreeRoot' });
  const rootRef = output.context.register(rootDict);
  const roleMap = output.context.obj({});
  const classMap = output.context.obj({});
  const topKids: PDFRef[] = [];
  const registrations: Registration[] = [];
  const annotParents: AnnotParent[] = [];
  const idEntries = new Map<string, PDFRef>();

  for (const source of sources) {
    const srcRoot = source.doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict);
    if (!srcRoot) continue;
    const ctx: CarryCtx = {
      output,
      source: source.doc,
      pageByTag: new Map(
        source.pairs.map(({ srcIndex, outPage }) => [source.doc.getPage(srcIndex).ref.tag, outPage]),
      ),
      objMap: buildInPageObjectMap(source, output),
      copier: PDFObjectCopier.for(source.doc.context, output.context),
      registrations,
      annotParents,
      idEntries,
      visited: new Set(),
    };
    for (const kid of kidsOf(source.doc, srcRoot.get(N('K')))) {
      const kidTag = kid instanceof PDFRef ? kid.tag : null;
      const resolved = kid instanceof PDFRef ? source.doc.context.lookup(kid) : kid;
      if (!(resolved instanceof PDFDict)) continue;
      const rebuilt = rebuildElem(ctx, resolved, kidTag, rootRef, null);
      if (rebuilt) topKids.push(rebuilt);
    }
    mergeMap(roleMap, srcRoot.lookupMaybe(N('RoleMap'), PDFDict), ctx.copier);
    mergeMap(classMap, srcRoot.lookupMaybe(N('ClassMap'), PDFDict), ctx.copier);
  }

  if (topKids.length === 0) return; // untagged rebuild — sweep already ran

  // ── ParentTree, renumbered in output order ──────────────────────────────
  // Page containers first (in page order), then stream containers, then one
  // key per referenced annotation. Page/stream entries are MCID-indexed
  // arrays with null holes; annotation entries are single refs.
  const byContainer = new Map<string, Registration[]>();
  for (const reg of registrations) {
    let list = byContainer.get(reg.containerTag);
    if (!list) {
      list = [];
      byContainer.set(reg.containerTag, list);
    }
    list.push(reg);
  }
  const nums: PDFObject[] = [];
  let nextKey = 0;
  const pages = output.getPages();
  const containerOrder: { tag: string; node: PDFDict }[] = [];
  for (const page of pages) {
    if (byContainer.has(page.ref.tag)) containerOrder.push({ tag: page.ref.tag, node: page.node });
  }
  for (const tag of byContainer.keys()) {
    if (containerOrder.some((c) => c.tag === tag)) continue;
    const node = output.context.lookup(PDFRef.of(...tagParts(tag)));
    if (node instanceof PDFDict) containerOrder.push({ tag, node });
  }
  for (const { tag, node } of containerOrder) {
    const regs = byContainer.get(tag)!;
    const maxMcid = regs.reduce((m, r) => Math.max(m, r.mcid), 0);
    const arr: PDFObject[] = new Array<PDFObject>(maxMcid + 1).fill(output.context.obj(null));
    for (const r of regs) arr[r.mcid] = r.elem;
    nums.push(PDFNumber.of(nextKey), output.context.obj(arr));
    node.set(N('StructParents'), PDFNumber.of(nextKey));
    nextKey++;
  }
  for (const { annotRef, elem } of annotParents) {
    const annot = output.context.lookup(annotRef);
    if (!(annot instanceof PDFDict)) continue;
    nums.push(PDFNumber.of(nextKey), elem);
    annot.set(N('StructParent'), PDFNumber.of(nextKey));
    nextKey++;
  }

  rootDict.set(N('K'), topKids.length === 1 ? topKids[0] : output.context.obj(topKids));
  rootDict.set(N('ParentTree'), output.context.obj({ Nums: nums }));
  rootDict.set(N('ParentTreeNextKey'), PDFNumber.of(nextKey));
  if (roleMap.entries().length > 0) rootDict.set(N('RoleMap'), roleMap);
  if (classMap.entries().length > 0) rootDict.set(N('ClassMap'), classMap);
  if (idEntries.size > 0) {
    const names: PDFObject[] = [];
    for (const [id, ref] of [...idEntries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      names.push(PDFString.of(id), ref);
    }
    rootDict.set(N('IDTree'), output.context.obj({ Names: names }));
  }
  output.catalog.set(N('StructTreeRoot'), rootRef);
  output.catalog.set(N('MarkInfo'), output.context.obj({ Marked: true }));
}

/** "obj gen R"-style tag back to its numbers — PDFRef.tag is `${obj} ${gen} R`. */
function tagParts(tag: string): [number, number] {
  const [obj, gen] = tag.split(' ');
  return [Number(obj), Number(gen)];
}
