// Carries document-level catalog state through the from-scratch rebuild in
// pdfx-build.ts: /Lang, /ViewerPreferences, /Outlines (bookmarks),
// /PageLabels, /OCProperties (layers), and /AA (document-action
// scripts). Same loss class as the /AcroForm
// and /Names /EmbeddedFiles drops (acroform-carry.ts, embedded-files-carry.ts):
// pdf-lib's copyPages copies page subtrees only, so before this module ONE
// Without this carry, a committed page edit would silently delete bookmarks,
// page labels, layer configuration, document language, and viewer preferences.
// catalog-carry.test.ts pins every carried key.
//
// OWN SOURCE ONLY, the embedded-files rule: these are properties of the
// DOCUMENT, and a page inserted from a donor must not import the donor's
// bookmarks or layer config. (A donor page's optional content still renders
// — unregistered OCGs default to visible; its layers are simply not listed.)
//
// The hard part is REFERENCE IDENTITY: bookmarks point at pages, the layer
// config points at OCG objects that ride the copied page subtrees. A naive
// PDFObjectCopier pass over the catalog would RE-COPY every page it reaches
// (its cache cannot know what copyPages already did), so everything here is
// rebuilt by hand against explicit source→output maps:
//   - pages: the builder's (srcIndex → output PDFPage) pairs;
//   - OCGs and other in-page objects: a parallel walk of the source page's
//     and the copied page's object graphs, which are structurally identical
//     by construction (copyPages preserves shape).

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

export interface CarriedSourcePages {
  /** The SAME loaded instance copyPages ran against — never a re-load. */
  doc: PDFDocument;
  /** Kept pages: source page index → the copied page in the output. */
  pairs: { srcIndex: number; outPage: PDFPage }[];
}

const N = PDFName.of.bind(PDFName);

/** src object ref (by tag) → output object, built by walking the source and
 * copied page graphs in parallel. copyPages preserves structure, so the two
 * graphs pair node-for-node. */
export type ObjectMap = Map<string, PDFRef>;

function mapParallel(
  srcCtxObj: PDFObject | undefined,
  outCtxObj: PDFObject | undefined,
  src: PDFDocument,
  out: PDFDocument,
  map: ObjectMap,
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 6) return;
  let srcObj = srcCtxObj;
  let outObj = outCtxObj;
  if (srcObj instanceof PDFRef) {
    if (!(outObj instanceof PDFRef)) return;
    if (seen.has(srcObj.tag)) return;
    seen.add(srcObj.tag);
    map.set(srcObj.tag, outObj);
    srcObj = src.context.lookup(srcObj);
    outObj = out.context.lookup(outObj);
  }
  if (srcObj instanceof PDFDict && outObj instanceof PDFDict) {
    for (const [key, value] of srcObj.entries()) {
      // /Parent and /P climb OUT of the page subtree; following them would
      // walk the whole document.
      if (key === N('Parent') || key === N('P')) continue;
      mapParallel(value, outObj.get(key), src, out, map, seen, depth + 1);
    }
    return;
  }
  if (srcObj instanceof PDFArray && outObj instanceof PDFArray) {
    const n = Math.min(srcObj.size(), outObj.size());
    for (let i = 0; i < n; i++) {
      mapParallel(srcObj.get(i), outObj.get(i), src, out, map, seen, depth + 1);
    }
  }
}

/** Map every object reachable from the kept pages' resource /Properties
 * (where OCGs live), XObjects (nested properties), and annotations (/OC
 * membership) to its copied counterpart. */
export function buildInPageObjectMap(
  source: CarriedSourcePages,
  output: PDFDocument,
): ObjectMap {
  const map: ObjectMap = new Map();
  const seen = new Set<string>();
  for (const { srcIndex, outPage } of source.pairs) {
    const srcPage = source.doc.getPage(srcIndex);
    for (const key of ['Resources', 'Annots'] as const) {
      mapParallel(
        srcPage.node.get(N(key)),
        outPage.node.get(N(key)),
        source.doc,
        output,
        map,
        seen,
        0,
      );
    }
  }
  return map;
}

/** Kept pages: source page ref tag → copied output page. */
function pageMapOf(source: CarriedSourcePages): Map<string, PDFPage> {
  const map = new Map<string, PDFPage>();
  for (const { srcIndex, outPage } of source.pairs) {
    map.set(source.doc.getPage(srcIndex).ref.tag, outPage);
  }
  return map;
}

// ── /Lang + /ViewerPreferences ─────────────────────────────────────────────

function carryLang(output: PDFDocument, srcCatalog: PDFDict): void {
  const lang = srcCatalog.lookup(N('Lang'));
  if (lang instanceof PDFString || lang instanceof PDFHexString) {
    output.catalog.set(N('Lang'), PDFString.of(lang.decodeText()));
  }
}

function carryViewerPreferences(output: PDFDocument, source: PDFDocument): void {
  const vp = source.catalog.lookup(N('ViewerPreferences'));
  if (!(vp instanceof PDFDict)) return;
  // Scalar-only dict (names, booleans, numbers, page-ref-free) — a plain
  // deep copy is safe here and ONLY here.
  const copier = PDFObjectCopier.for(source.context, output.context);
  output.catalog.set(N('ViewerPreferences'), copier.copy(vp));
}

// ── /Outlines (bookmarks) ──────────────────────────────────────────────────

/** Resolve an outline item's destination array: /Dest direct, /Dest named
 * (via /Names /Dests or the legacy /Dests dict), or /A GoTo. */
function destArrayOf(source: PDFDocument, item: PDFDict): PDFArray | null {
  const resolveNamed = (name: string): PDFArray | null => {
    // Modern: /Names /Dests name tree.
    const names = source.catalog.lookupMaybe(N('Names'), PDFDict);
    const tree = names?.lookupMaybe(N('Dests'), PDFDict);
    if (tree) {
      const found = lookupNameTree(source, tree, name);
      if (found instanceof PDFArray) return found;
      if (found instanceof PDFDict) {
        const d = found.lookup(N('D'));
        if (d instanceof PDFArray) return d;
      }
    }
    // Legacy: catalog /Dests dictionary.
    const legacy = source.catalog.lookupMaybe(N('Dests'), PDFDict);
    const hit = legacy?.lookup(N(name));
    if (hit instanceof PDFArray) return hit;
    if (hit instanceof PDFDict) {
      const d = hit.lookup(N('D'));
      if (d instanceof PDFArray) return d;
    }
    return null;
  };

  const direct = item.lookup(N('Dest'));
  if (direct instanceof PDFArray) return direct;
  if (direct instanceof PDFString || direct instanceof PDFHexString) {
    return resolveNamed(direct.decodeText());
  }
  if (direct instanceof PDFName) return resolveNamed(direct.decodeText());
  const action = item.lookupMaybe(N('A'), PDFDict);
  if (action) {
    const s = action.lookup(N('S'));
    if (s instanceof PDFName && s.decodeText() === 'GoTo') {
      const d = action.lookup(N('D'));
      if (d instanceof PDFArray) return d;
      if (d instanceof PDFString || d instanceof PDFHexString) return resolveNamed(d.decodeText());
    }
  }
  return null;
}

function lookupNameTree(source: PDFDocument, node: PDFDict, name: string): PDFObject | null {
  const names = node.lookupMaybe(N('Names'), PDFArray);
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const key = names.lookup(i);
      if (
        (key instanceof PDFString || key instanceof PDFHexString) &&
        key.decodeText() === name
      ) {
        return names.lookup(i + 1) ?? null;
      }
    }
  }
  const kids = node.lookupMaybe(N('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookupMaybe(i, PDFDict);
      if (!kid) continue;
      const hit = lookupNameTree(source, kid, name);
      if (hit) return hit;
    }
  }
  return null;
}

interface RebuiltOutline {
  ref: PDFRef;
  descendants: number;
  open: boolean;
}

function rebuildOutlineItem(
  output: PDFDocument,
  source: PDFDocument,
  item: PDFDict,
  parentRef: PDFRef,
  pageMap: Map<string, PDFPage>,
  visited: Set<string>,
): RebuiltOutline | null {
  const title = item.lookup(N('Title'));
  const out = output.context.obj({});
  out.set(N('Parent'), parentRef);
  if (title instanceof PDFString || title instanceof PDFHexString) {
    out.set(N('Title'), PDFString.of(title.decodeText()));
  } else {
    out.set(N('Title'), PDFString.of('')); // a title-less item stays a node
  }
  // Destination: remap the page ref when the target survived; an item whose
  // target page is GONE keeps its title (and children) but loses the jump —
  // honest, and matches how viewers treat dangling outline items.
  const dest = destArrayOf(source, item);
  if (dest && dest.size() > 0) {
    const target = dest.get(0);
    if (target instanceof PDFRef) {
      const mapped = pageMap.get(target.tag);
      if (mapped) {
        const rebuilt: PDFObject[] = [mapped.ref];
        for (let i = 1; i < dest.size(); i++) {
          const el = dest.lookup(i);
          if (el instanceof PDFName) rebuilt.push(N(el.decodeText()));
          else if (el instanceof PDFNumber) rebuilt.push(PDFNumber.of(el.asNumber()));
          // null / unexpected entries: preserved as null-equivalent omission
          else rebuilt.push(output.context.obj(null));
        }
        out.set(N('Dest'), output.context.obj(rebuilt));
      }
    }
  }
  const outRef = output.context.register(out);

  // Children via the /First → /Next chain, cycle-guarded.
  const children: RebuiltOutline[] = [];
  let child = item.lookupMaybe(N('First'), PDFDict);
  let childRefTag = (() => {
    const raw = item.get(N('First'));
    return raw instanceof PDFRef ? raw.tag : null;
  })();
  while (child) {
    if (childRefTag) {
      if (visited.has(childRefTag)) break;
      visited.add(childRefTag);
    }
    const rebuilt = rebuildOutlineItem(output, source, child, outRef, pageMap, visited);
    if (rebuilt) children.push(rebuilt);
    const nextRaw = child.get(N('Next'));
    childRefTag = nextRaw instanceof PDFRef ? nextRaw.tag : null;
    child = child.lookupMaybe(N('Next'), PDFDict);
  }
  wireSiblings(output, outRef, out, children);
  const descendants = children.reduce((sum, c) => sum + 1 + c.descendants, 0);
  if (descendants > 0) {
    const srcCount = item.lookup(N('Count'));
    const open = srcCount instanceof PDFNumber ? srcCount.asNumber() > 0 : true;
    out.set(N('Count'), PDFNumber.of(open ? descendants : -descendants));
    return { ref: outRef, descendants, open };
  }
  return { ref: outRef, descendants: 0, open: true };
}

function wireSiblings(
  output: PDFDocument,
  parentRef: PDFRef,
  parent: PDFDict,
  children: RebuiltOutline[],
): void {
  if (children.length === 0) return;
  parent.set(N('First'), children[0].ref);
  parent.set(N('Last'), children[children.length - 1].ref);
  for (let i = 0; i < children.length; i++) {
    const dict = output.context.lookup(children[i].ref) as PDFDict;
    if (i > 0) dict.set(N('Prev'), children[i - 1].ref);
    if (i + 1 < children.length) dict.set(N('Next'), children[i + 1].ref);
  }
  void parentRef;
}

function carryOutlines(
  output: PDFDocument,
  source: PDFDocument,
  pageMap: Map<string, PDFPage>,
): void {
  const srcRoot = source.catalog.lookupMaybe(N('Outlines'), PDFDict);
  if (!srcRoot) return;
  const outRoot = output.context.obj({ Type: 'Outlines' });
  const outRootRef = output.context.register(outRoot);
  const visited = new Set<string>();
  const children: RebuiltOutline[] = [];
  let child = srcRoot.lookupMaybe(N('First'), PDFDict);
  let tag = (() => {
    const raw = srcRoot.get(N('First'));
    return raw instanceof PDFRef ? raw.tag : null;
  })();
  while (child) {
    if (tag) {
      if (visited.has(tag)) break;
      visited.add(tag);
    }
    const rebuilt = rebuildOutlineItem(output, source, child, outRootRef, pageMap, visited);
    if (rebuilt) children.push(rebuilt);
    const nextRaw = child.get(N('Next'));
    tag = nextRaw instanceof PDFRef ? nextRaw.tag : null;
    child = child.lookupMaybe(N('Next'), PDFDict);
  }
  if (children.length === 0) return; // an empty tree is not worth carrying
  wireSiblings(output, outRootRef, outRoot, children);
  outRoot.set(
    N('Count'),
    PDFNumber.of(children.reduce((sum, c) => sum + 1 + c.descendants, 0)),
  );
  output.catalog.set(N('Outlines'), outRootRef);
}

// ── /PageLabels ────────────────────────────────────────────────────────────

interface LabelSpec {
  style: string | null;
  prefix: string;
  value: number; // the label value AT this page (range start + offset)
}

/** Expand the source /PageLabels number tree into one resolved spec per
 * source page. Returns null when the document has no labels. */
function expandLabels(source: PDFDocument): (LabelSpec | null)[] | null {
  const rootObj = source.catalog.lookup(N('PageLabels'));
  const root =
    rootObj instanceof PDFDict
      ? rootObj
      : rootObj instanceof PDFRef
        ? source.context.lookup(rootObj, PDFDict)
        : null;
  if (!root) return null;
  const entries: { start: number; style: string | null; prefix: string; st: number }[] = [];
  const walkNums = (node: PDFDict): void => {
    const nums = node.lookupMaybe(N('Nums'), PDFArray);
    if (nums) {
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const idx = nums.lookup(i);
        const dict = nums.lookupMaybe(i + 1, PDFDict);
        if (!(idx instanceof PDFNumber) || !dict) continue;
        const style = dict.lookup(N('S'));
        const prefix = dict.lookup(N('P'));
        const st = dict.lookup(N('St'));
        entries.push({
          start: idx.asNumber(),
          style: style instanceof PDFName ? style.decodeText() : null,
          prefix:
            prefix instanceof PDFString || prefix instanceof PDFHexString
              ? prefix.decodeText()
              : '',
          st: st instanceof PDFNumber ? st.asNumber() : 1,
        });
      }
    }
    const kids = node.lookupMaybe(N('Kids'), PDFArray);
    if (kids) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = kids.lookupMaybe(i, PDFDict);
        if (kid) walkNums(kid);
      }
    }
  };
  walkNums(root);
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.start - b.start);
  const count = source.getPageCount();
  const specs: (LabelSpec | null)[] = new Array<LabelSpec | null>(count).fill(null);
  for (let p = 0; p < count; p++) {
    let active: (typeof entries)[number] | null = null;
    for (const e of entries) {
      if (e.start <= p) active = e;
      else break;
    }
    if (active) {
      specs[p] = { style: active.style, prefix: active.prefix, value: active.st + (p - active.start) };
    }
  }
  return specs;
}

/** Rebuild /PageLabels over the OUTPUT order. Own pages keep their resolved
 * labels (ranges re-based to survive moves and deletions); pages from other
 * sources get plain position numbering — their labels are the donor
 * DOCUMENT's property and are deliberately not imported. */
function carryPageLabels(
  output: PDFDocument,
  source: CarriedSourcePages,
): void {
  const specs = expandLabels(source.doc);
  if (!specs) return;
  const outPageRefs = output.getPages().map((p) => p.ref.tag);
  const srcIndexByOutTag = new Map<string, number>();
  for (const { srcIndex, outPage } of source.pairs) srcIndexByOutTag.set(outPage.ref.tag, srcIndex);

  const nums: PDFObject[] = [];
  let prev: { srcIndex: number; spec: LabelSpec } | null = null;
  let coveredAll = true;
  for (let pos = 0; pos < outPageRefs.length; pos++) {
    const srcIndex = srcIndexByOutTag.get(outPageRefs[pos]);
    const spec = srcIndex !== undefined ? specs[srcIndex] : undefined;
    if (srcIndex === undefined || !spec) {
      // Donor or unlabeled page: plain position numbering, one range per
      // stretch (a following own page breaks it anyway).
      if (prev !== null || pos === 0) {
        nums.push(PDFNumber.of(pos), output.context.obj({ S: 'D', St: pos + 1 }));
      }
      prev = null;
      if (srcIndex !== undefined && !spec) coveredAll = false;
      continue;
    }
    const continues =
      prev !== null &&
      prev.spec.style === spec.style &&
      prev.spec.prefix === spec.prefix &&
      prev.srcIndex + 1 === srcIndex &&
      prev.spec.value + 1 === spec.value;
    if (!continues) {
      const dict = output.context.obj({});
      dict.set(N('St'), PDFNumber.of(spec.value));
      if (spec.style) dict.set(N('S'), N(spec.style));
      if (spec.prefix) dict.set(N('P'), PDFString.of(spec.prefix));
      nums.push(PDFNumber.of(pos), dict);
    }
    prev = { srcIndex, spec };
  }
  void coveredAll;
  if (nums.length === 0) return;
  output.catalog.set(N('PageLabels'), output.context.obj({ Nums: nums }));
}

// ── /OCProperties (layers) ─────────────────────────────────────────────────

function mapRefArray(arr: PDFArray | undefined, map: ObjectMap, out: PDFDocument): PDFArray {
  const rebuilt = out.context.obj([]);
  if (!arr) return rebuilt;
  for (let i = 0; i < arr.size(); i++) {
    const el = arr.get(i);
    if (el instanceof PDFRef) {
      const mapped = map.get(el.tag);
      if (mapped) rebuilt.push(mapped);
    } else if (el instanceof PDFArray) {
      const sub = mapRefArray(el, map, out);
      if (sub.size() > 0) rebuilt.push(sub);
    } else if (el instanceof PDFString || el instanceof PDFHexString) {
      rebuilt.push(PDFString.of(el.decodeText())); // /Order group labels
    }
  }
  return rebuilt;
}

function carryOcProperties(
  output: PDFDocument,
  source: PDFDocument,
  objectMap: ObjectMap,
): void {
  const src = source.catalog.lookupMaybe(N('OCProperties'), PDFDict);
  if (!src) return;
  const srcOcgs = src.lookupMaybe(N('OCGs'), PDFArray);
  const ocgs = mapRefArray(srcOcgs, objectMap, output);
  if (ocgs.size() === 0) return; // every configured OCG's pages were dropped

  const d = src.lookupMaybe(N('D'), PDFDict);
  const outD = output.context.obj({});
  if (d) {
    for (const key of ['Name', 'Creator', 'BaseState', 'ListMode'] as const) {
      const v = d.lookup(N(key));
      if (v instanceof PDFName) outD.set(N(key), N(v.decodeText()));
      else if (v instanceof PDFString || v instanceof PDFHexString)
        outD.set(N(key), PDFString.of(v.decodeText()));
    }
    for (const key of ['Order', 'OFF', 'ON', 'Locked', 'RBGroups'] as const) {
      const arr = d.lookupMaybe(N(key), PDFArray);
      if (arr) {
        const mapped = mapRefArray(arr, objectMap, output);
        if (mapped.size() > 0 || key === 'Order') outD.set(N(key), mapped);
      }
    }
    // /AS usage-application entries drive auto state (zoom/print); each names
    // OCGs — carried with the refs mapped, dropped when none survive.
    const as = d.lookupMaybe(N('AS'), PDFArray);
    if (as) {
      const outAs = output.context.obj([]);
      for (let i = 0; i < as.size(); i++) {
        const entry = as.lookupMaybe(i, PDFDict);
        if (!entry) continue;
        const entryOcgs = mapRefArray(entry.lookupMaybe(N('OCGs'), PDFArray), objectMap, output);
        if (entryOcgs.size() === 0) continue;
        const outEntry = output.context.obj({});
        const event = entry.lookup(N('Event'));
        if (event instanceof PDFName) outEntry.set(N('Event'), N(event.decodeText()));
        const category = entry.lookupMaybe(N('Category'), PDFArray);
        if (category) {
          const cats = output.context.obj([]);
          for (let c = 0; c < category.size(); c++) {
            const cat = category.lookup(c);
            if (cat instanceof PDFName) cats.push(N(cat.decodeText()));
          }
          outEntry.set(N('Category'), cats);
        }
        outEntry.set(N('OCGs'), entryOcgs);
        outAs.push(outEntry);
      }
      if (outAs.size() > 0) outD.set(N('AS'), outAs);
    }
  }
  const rebuilt = output.context.obj({});
  rebuilt.set(N('OCGs'), ocgs);
  rebuilt.set(N('D'), outD);
  output.catalog.set(N('OCProperties'), rebuilt);
}

// ── document actions (/AA) ──────────────────────────────────────────
// Document-scoped scripts (will/did save, will/did print, will close).
// Carried whole via a copier UNLESS the subtree reaches a page or page-tree
// object — an action chain ending in a GoTo destination would make the
// copier re-copy a page copyPages already copied (the module-header hazard).
// Real-world doc /AA is JavaScript actions, which reach no pages; the rare
// page-destination chain drops with its reason stated here rather than
// duplicating a page graph. (The app never EXECUTES AcroJS — this preserves
// the document's behavior for readers that do.)

function aaReachesPage(
  doc: PDFDocument,
  value: unknown,
  depth: number,
  seen: Set<string>,
): boolean {
  if (depth > 8) return true; // over-deep — fail toward not carrying
  if (value instanceof PDFRef) {
    if (seen.has(value.tag)) return false;
    seen.add(value.tag);
    return aaReachesPage(doc, doc.context.lookup(value), depth + 1, seen);
  }
  if (value instanceof PDFDict) {
    const type = value.get(N('Type'));
    if (type === N('Page') || type === N('Pages')) return true;
    for (const [, v] of value.entries()) {
      if (aaReachesPage(doc, v, depth + 1, seen)) return true;
    }
    return false;
  }
  if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) {
      if (aaReachesPage(doc, value.get(i), depth + 1, seen)) return true;
    }
    return false;
  }
  return false;
}

function carryDocActions(output: PDFDocument, src: PDFDocument): void {
  const aa = src.catalog.get(N('AA'));
  const aaDict = aa instanceof PDFRef ? src.context.lookup(aa) : aa;
  if (!(aaDict instanceof PDFDict)) return;
  if (aaReachesPage(src, aaDict, 0, new Set<string>())) return; // stated boundary above
  const copier = PDFObjectCopier.for(src.context, output.context);
  output.catalog.set(N('AA'), output.context.register(copier.copy(aaDict)));
}

// ── entry point ────────────────────────────────────────────────────────────

/**
 * Carry the own document's catalog state into the rebuilt output. `source`
 * must be the SAME loaded instance the builder copied pages from — the page
 * and in-page object maps are what make reference remapping possible at all.
 */
export function carryDocumentCatalog(output: PDFDocument, source: CarriedSourcePages): void {
  const srcCatalog = source.doc.catalog;
  const pageMap = pageMapOf(source);
  carryLang(output, srcCatalog);
  carryViewerPreferences(output, source.doc);
  carryOutlines(output, source.doc, pageMap);
  carryPageLabels(output, source);
  const objectMap = buildInPageObjectMap(source, output);
  carryOcProperties(output, source.doc, objectMap);
  carryDocActions(output, source.doc);
}
