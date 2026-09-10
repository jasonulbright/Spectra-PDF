// Carries document-level catalog state through the from-scratch rebuild in
// pdfx-build.ts: /Lang, /ViewerPreferences, /Outlines (bookmarks),
// /PageLabels, /OCProperties (layers), /Names /JavaScript, /OpenAction and /AA (document-action
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
  PDFRawStream,
  PDFString,
} from 'pdf-lib';
import { tChrome } from '../i18n';

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

// ── document actions and scripts ──────────────────────────────────────────

/** Preserve document-owned action roots, not just script text.
 * Bind page references to actual output pages before copying other objects.
 * Removed/ambiguous targets refuse the rebuild, never silently drop behavior.
 * ISO 32000-2 12.6.2/Table 196 permits action trees via /Next; Table 200
 * defines /AA. Preservation never executes an action. */
export function carryDocumentBehavior(output: PDFDocument, source: CarriedSourcePages, objectMap: ObjectMap): void {
  const names = source.doc.catalog.lookupMaybe(N('Names'), PDFDict), tree = names?.get(N('JavaScript'));
  const aa = source.doc.catalog.get(N('AA')), open = source.doc.catalog.get(N('OpenAction'));
  if (tree === undefined && aa === undefined && open === undefined) return;
  const fail = () => new Error(tChrome('app.operation.unverified'));
  if (aa !== undefined && !(source.doc.context.lookup(aa) instanceof PDFDict)) throw fail();
  // Resolve named local destinations in their source namespace. Only the
  // resolved array travels: donor destinations cannot shadow the source name.
  const nameKey = (value: PDFName | PDFString | PDFHexString) => value instanceof PDFName
    ? `name:${value.decodeText()}` : `string:${Array.from(value.asBytes(), b => b.toString(16).padStart(2, '0')).join('')}`;
  let named: Map<string, PDFObject> | undefined;
  const destination = (raw: PDFObject | undefined): PDFArray => {
    const value = source.doc.context.lookup(raw);
    if (value instanceof PDFArray) {
      if (!(value.get(0) instanceof PDFRef) || !pageRefs.has((value.get(0) as PDFRef).tag)) throw fail();
      return value;
    }
    if (!(value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString)) throw fail();
    if (!named) {
      named = new Map(); let count = 0;
      const seen = new Set<PDFDict>();
      const add = (key: string, child: PDFObject) => { if (named!.has(key)) throw fail(); named!.set(key, child); };
      const walk = (node: PDFObject, depth = 0) => {
        if (++count > 10000 || depth > 64) throw fail();
        const dict = source.doc.context.lookup(node);
        if (!(dict instanceof PDFDict) || seen.has(dict)) throw fail(); seen.add(dict);
        const entries = dict.lookupMaybe(N('Names'), PDFArray), kids = dict.lookupMaybe(N('Kids'), PDFArray);
        if ((entries && kids) || (!entries && !kids)) throw fail();
        if (entries) {
          if (entries.size() % 2 !== 0) throw fail();
          for (let i = 0; i < entries.size(); i += 2) {
            if (++count > 10000) throw fail(); const key = entries.lookup(i);
            if (!(key instanceof PDFString || key instanceof PDFHexString)) throw fail();
            add(nameKey(key), entries.get(i + 1));
          }
        }
        if (kids) for (const child of kids.asArray()) walk(child, depth + 1);
      };
      const dests = names?.get(N('Dests')); if (dests !== undefined) walk(dests);
      const legacy = source.doc.catalog.lookupMaybe(N('Dests'), PDFDict);
      if (legacy) for (const [key, child] of legacy.entries()) {
        if (++count > 10000) throw fail(); add(nameKey(key), child);
      }
    }
    const hit = source.doc.context.lookup(named.get(nameKey(value)));
    // A structure destination needs the structure copier's own identity map;
    // dropping /SD while keeping /D would silently change its semantics.
    if (hit instanceof PDFDict && hit.has(N('SD'))) throw fail();
    const result = hit instanceof PDFDict ? hit.lookup(N('D')) : hit;
    if (!(result instanceof PDFArray)) throw fail(); return destination(result);
  };
  const pageRefs = new Set(source.doc.getPages().map(p => p.ref.tag));
  const pages = new Map<string, PDFRef>(), counts = new Map<number, number>();
  for (const p of source.pairs) counts.set(p.srcIndex, (counts.get(p.srcIndex) ?? 0) + 1);
  for (const p of source.pairs) if (counts.get(p.srcIndex) === 1) pages.set(source.doc.getPage(p.srcIndex).ref.tag, p.outPage.ref);
  const refs = new Map<string, PDFRef>(), direct = new Map<PDFObject, PDFObject>(); let visits = 0;
  const copy = (value: PDFObject, depth = 0): PDFObject => {
    if (++visits > 100000 || depth > 128) throw fail();
    if (value instanceof PDFRef) {
      if (pageRefs.has(value.tag)) { const page = pages.get(value.tag); if (!page) throw fail(); return page; }
      const priorRef = refs.get(value.tag); if (priorRef) return priorRef;
      const target = source.doc.context.lookup(value); if (!target) throw fail();
      // Reuse identity-bearing page objects, not copied action subtrees. An
      // action may also be reachable through a page: that copier's GoTo can
      // still point at a detached page, so it is never an authority here.
      if (target instanceof PDFDict && ([N('OCG'), N('Annot')].includes(target.lookup(N('Type')) as PDFName)
        || target.has(N('FT')) || target.lookup(N('Subtype')) === N('Widget'))) {
        const mapped = objectMap.get(value.tag); if (!mapped) throw fail(); return mapped;
      }
      const ref = output.context.nextRef(); refs.set(value.tag, ref);
      output.context.assign(ref, copy(target, depth + 1)); return ref;
    }
    const prior = direct.get(value); if (prior) return prior;
    if (value instanceof PDFDict) {
      if ([N('Page'), N('Pages'), N('Catalog'), N('StructElem'), N('StructTreeRoot')].includes(value.lookup(N('Type')) as PDFName)) throw fail();
      if (value.lookup(N('S')) === N('GoTo') && !value.has(N('D'))) throw fail();
      const result = output.context.obj({}); direct.set(value, result);
      for (const [key, child] of value.entries()) {
        result.set(key, copy(key === N('D') && value.lookup(N('S')) === N('GoTo') ? destination(child) : child, depth + 1));
      }
      return result;
    }
    if (value instanceof PDFArray) {
      const result = output.context.obj([]); direct.set(value, result);
      for (const child of value.asArray()) result.push(copy(child, depth + 1)); return result;
    }
    if (value instanceof PDFRawStream) {
      const result = PDFRawStream.of(output.context.obj({}), value.getContents().slice()); direct.set(value, result);
      for (const [key, child] of value.dict.entries()) result.dict.set(key, copy(child, depth + 1)); return result;
    }
    return value.clone(output.context);
  };
  if (tree !== undefined) {
    const outNames = output.catalog.lookupMaybe(N('Names'), PDFDict) ?? output.context.obj({});
    outNames.set(N('JavaScript'), copy(tree)); output.catalog.set(N('Names'), outNames);
  }
  if (aa !== undefined) output.catalog.set(N('AA'), copy(aa));
  if (open !== undefined) {
    const value = source.doc.context.lookup(open);
    output.catalog.set(N('OpenAction'), copy(value instanceof PDFDict ? open : destination(open)));
  }
}

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
  carryDocumentBehavior(output, source, objectMap);
}
