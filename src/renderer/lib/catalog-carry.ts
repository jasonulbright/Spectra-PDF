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
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFNull,
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

// ── /Lang + /ViewerPreferences ─────────────────────────────────────────────

function carryLang(output: PDFDocument, srcCatalog: PDFDict): void {
  const lang = srcCatalog.lookup(N('Lang'));
  if (lang instanceof PDFString || lang instanceof PDFHexString) {
    output.catalog.set(N('Lang'), PDFString.of(lang.decodeText()));
  }
}

function carryViewerPreferences(output: PDFDocument, source: CarriedSourcePages): void {
  const raw = source.doc.catalog.get(N('ViewerPreferences'));
  if (raw === undefined || raw === PDFNull) return;
  const fail = () => new Error(tChrome('app.operation.unverified'));
  const vp = source.doc.context.lookup(raw);
  if (vp === undefined || vp === PDFNull) return;
  if (!(vp instanceof PDFDict)) throw fail();
  // Preferences contain data, not page/annotation/structure graphs. Validate
  // the complete data graph before copying it; unknown data keys survive but
  // cannot drag a detached document tree into the output. Bound malformed
  // cycles even when an indirect reference hides one.
  let visits = 0;
  const active = new Set<PDFObject>(), checked = new Set<PDFObject>();
  const validate = (value: PDFObject, depth = 0): void => {
    if (++visits > 10000 || depth > 64) throw fail();
    const obj = source.doc.context.lookup(value);
    if (obj === undefined) return; // nonexistent references have null semantics (7.3.9)
    if (obj instanceof PDFString || obj instanceof PDFHexString || obj instanceof PDFName || obj instanceof PDFBool || obj === PDFNull) return;
    if (obj instanceof PDFNumber) { if (!Number.isFinite(obj.asNumber())) throw fail(); return; }
    if (active.has(obj)) throw fail();
    if (checked.has(obj)) return;
    active.add(obj);
    if (obj instanceof PDFArray) {
      for (const child of obj.asArray()) validate(child, depth + 1);
    } else if (obj instanceof PDFDict) {
      if ([N('Page'), N('Pages'), N('Catalog'), N('Annot'), N('StructElem'), N('StructTreeRoot'), N('OCG')]
        .includes(obj.lookup(N('Type')) as PDFName) || obj.has(N('FT'))) throw fail();
      for (const [, child] of obj.entries()) validate(child, depth + 1);
    } else throw fail();
    active.delete(obj); checked.add(obj);
  };
  validate(vp);
  const copied = PDFObjectCopier.for(source.doc.context, output.context).copy(vp);
  const ranges = vp.lookup(N('PrintPageRange'));
  if (ranges !== undefined && ranges !== PDFNull) {
    if (!(ranges instanceof PDFArray) || ranges.size() % 2 !== 0) throw fail();
    const limits: [number, number][] = [];
    for (let i = 0; i < ranges.size(); i += 2) {
      const first = ranges.lookup(i), last = ranges.lookup(i + 1);
      if (!(first instanceof PDFNumber) || !(last instanceof PDFNumber)) throw fail();
      const a = first.asNumber(), b = last.asNumber();
      // ISO 32000-2 12.2/Table 147: these page numbers are ONE-based.
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a || b > source.doc.getPageCount()) throw fail();
      limits.push([a, b]);
    }
    const positions = new Map(output.getPages().map((page, index) => [page.ref.tag, index + 1]));
    const selected = new Set<number>();
    for (const { srcIndex, outPage } of source.pairs) {
      if (!Number.isSafeInteger(srcIndex) || srcIndex < 0 || srcIndex >= source.doc.getPageCount()) throw fail();
      const position = positions.get(outPage.ref.tag);
      if (position === undefined) throw fail();
      if (limits.some(([a, b]) => a <= srcIndex + 1 && srcIndex + 1 <= b)) selected.add(position);
    }
    // Dropping the range when all selected pages disappear changes it into
    // the processor's default (often ALL pages). No safe selection remains.
    if (limits.length > 0 && selected.size === 0) throw fail();
    const numbers = [...selected].sort((a, b) => a - b), rebuilt: number[] = [];
    for (const position of numbers) {
      if (rebuilt.length > 0 && position === rebuilt[rebuilt.length - 1] + 1) rebuilt[rebuilt.length - 1] = position;
      else rebuilt.push(position, position);
    }
    copied.set(N('PrintPageRange'), output.context.obj(rebuilt));
  }
  output.catalog.set(N('ViewerPreferences'), copied);
}

// ── /Outlines (bookmarks) ──────────────────────────────────────────────────

interface RebuiltOutline {
  input: PDFDict;
  ref: PDFRef;
  children: RebuiltOutline[];
  visibleDescendants: number;
  open: boolean;
}

/** Outline links are structural, while /A, /Dest, /SE and styling are data.
 * Rebuild the linked tree, then copy its payload through the SAME identity
 * authority used by document actions. Bind all outline refs before copying
 * payloads so sharing and forward references do not fork the outline graph.
 * ISO 32000-2 12.3.3/Tables 150-152. */
function carryOutlines(output: PDFDocument, source: CarriedSourcePages, copier: CatalogObjectCopy): void {
  const rawRoot = source.doc.catalog.get(N('Outlines'));
  if (rawRoot === undefined || rawRoot === PDFNull) return;
  const fail = () => new Error(tChrome('app.operation.unverified'));
  const ctx = source.doc.context, root = ctx.lookup(rawRoot);
  if (root === undefined || root === PDFNull) return;
  if (!(root instanceof PDFDict)) throw fail();
  const type = root.lookup(N('Type'));
  if (type !== undefined && type !== N('Outlines')) throw fail();
  const outRoot = output.context.obj({ Type: 'Outlines' }), outRootRef = output.context.register(outRoot);
  if (rawRoot instanceof PDFRef) copier.bind(rawRoot, outRootRef);
  const seen = new Set<PDFDict>(); let visits = 0;
  const count = (dict: PDFDict): number | undefined => {
    const value = dict.lookup(N('Count'));
    if (value === undefined || value === PDFNull) return undefined;
    if (!(value instanceof PDFNumber) || !Number.isSafeInteger(value.asNumber())) throw fail();
    return value.asNumber();
  };
  const parse = (parent: PDFDict, depth: number): RebuiltOutline[] => {
    if (depth > 128) throw fail();
    const result: RebuiltOutline[] = [];
    let cursor = parent.get(N('First')), previous: PDFObject | undefined;
    while (cursor !== undefined && cursor !== PDFNull) {
      if (++visits > 10000 || !(cursor instanceof PDFRef)) throw fail();
      const item = ctx.lookup(cursor);
      if (!(item instanceof PDFDict) || seen.has(item)) throw fail();
      seen.add(item);
      if (ctx.lookup(item.get(N('Parent'))) !== parent) throw fail();
      const prev = item.get(N('Prev'));
      if (previous === undefined ? prev !== undefined && prev !== PDFNull : prev !== previous) throw fail();
      const title = item.lookup(N('Title'));
      if (!(title instanceof PDFString || title instanceof PDFHexString)) throw fail();
      const ref = output.context.register(output.context.obj({}));
      copier.bind(cursor, ref);
      const children = parse(item, depth + 1), oldCount = count(item);
      if (children.length > 0 && oldCount === undefined) throw fail();
      const visibleDescendants = children.reduce((n, child) => n + 1 + (child.open ? child.visibleDescendants : 0), 0);
      result.push({ input: item, ref, children, visibleDescendants, open: oldCount === undefined || oldCount > 0 });
      previous = cursor; cursor = item.get(N('Next'));
    }
    const last = parent.get(N('Last'));
    if (previous === undefined ? last !== undefined && last !== PDFNull : last !== previous) throw fail();
    return result;
  };
  const children = parse(root, 0), rootCount = count(root);
  if (rootCount !== undefined && rootCount < 0) throw fail();
  const kept = new Set(source.pairs.map(pair => source.doc.getPage(pair.srcIndex).ref.tag));
  const structural = new Set(['Parent', 'Prev', 'Next', 'First', 'Last', 'Count']);
  const wire = (parentRef: PDFRef, siblings: RebuiltOutline[]): void => {
    const parent = output.context.lookup(parentRef, PDFDict);
    if (siblings.length > 0) {
      parent.set(N('First'), siblings[0].ref); parent.set(N('Last'), siblings[siblings.length - 1].ref);
    }
    for (let index = 0; index < siblings.length; index++) {
      const node = siblings[index], dict = output.context.lookup(node.ref, PDFDict);
      dict.set(N('Parent'), parentRef);
      if (index > 0) dict.set(N('Prev'), siblings[index - 1].ref);
      if (index + 1 < siblings.length) dict.set(N('Next'), siblings[index + 1].ref);
      const hasValue = (key: string) => { const value = node.input.lookup(N(key)); return value !== undefined && value !== PDFNull; };
      if (hasValue('A') && hasValue('Dest')) throw fail();
      for (const [key, value] of node.input.entries()) {
        const name = key.decodeText();
        if (structural.has(name)) continue;
        if (!hasValue(name)) continue;
        if (name === 'Dest') {
          const dest = copier.destination(value), target = dest.get(0) as PDFRef;
          // A deleted direct jump retains its title/children, as before. An
          // action chain with a removed target instead refuses in the copier;
          // pruning only one action would silently change that chain.
          if (kept.has(target.tag)) dict.set(key, copier.copyDestination(value));
          continue;
        }
        if (name === 'A' && !(ctx.lookup(value) instanceof PDFDict)) throw fail();
        if (name === 'SE') {
          dict.set(key, copier.structure(value));
          continue;
        }
        if (name === 'F') {
          const flags = ctx.lookup(value);
          if (!(flags instanceof PDFNumber) || !Number.isInteger(flags.asNumber()) || flags.asNumber() < 0 || flags.asNumber() > 3) throw fail();
        }
        if (name === 'C') {
          const color = ctx.lookup(value);
          if (!(color instanceof PDFArray) || color.size() !== 3) throw fail();
          for (const raw of color.asArray()) {
            const component = ctx.lookup(raw);
            if (!(component instanceof PDFNumber) || !Number.isFinite(component.asNumber()) || component.asNumber() < 0 || component.asNumber() > 1) throw fail();
          }
        }
        dict.set(key, copier.copy(value));
      }
      wire(node.ref, node.children);
      if (node.children.length > 0) dict.set(N('Count'), PDFNumber.of(node.open ? node.visibleDescendants : -node.visibleDescendants));
    }
  };
  for (const [key, value] of root.entries()) {
    if (!['Type', 'First', 'Last', 'Count'].includes(key.decodeText())) outRoot.set(key, copier.copy(value));
  }
  wire(outRootRef, children);
  if (children.length > 0) outRoot.set(N('Count'), PDFNumber.of(children.reduce((n, child) => n + 1 + (child.open ? child.visibleDescendants : 0), 0)));
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
interface CatalogObjectCopy {
  bind(source: PDFRef, output: PDFRef): void;
  copy(value: PDFObject): PDFObject;
  destination(raw: PDFObject | undefined): PDFArray;
  copyDestination(raw: PDFObject): PDFObject;
  structure(raw: PDFObject | undefined): PDFRef;
}

function catalogObjectCopier(output: PDFDocument, source: CarriedSourcePages, objectMap: ObjectMap,
  structureMap: ObjectMap = new Map()): CatalogObjectCopy {
  const names = source.doc.catalog.lookupMaybe(N('Names'), PDFDict);
  const fail = () => new Error(tChrome('app.operation.unverified'));
  const structure = (raw: PDFObject | undefined): PDFRef => {
    if (!(raw instanceof PDFRef)) throw fail();
    const elem = source.doc.context.lookup(raw), mapped = structureMap.get(raw.tag);
    const type = elem instanceof PDFDict ? elem.lookup(N('Type')) : undefined;
    // Optional Type is not an identity authority. Only a real retained node
    // in the rebuilt hierarchy can satisfy SE, SD or a shared graph reference.
    if (!(elem instanceof PDFDict) || !mapped
      || (type !== undefined && type !== PDFNull && type !== N('StructElem'))) throw fail();
    return mapped;
  };
  // Resolve named local destinations in their source namespace. Only the
  // resolved array travels: donor destinations cannot shadow the source name.
  const nameKey = (value: PDFName | PDFString | PDFHexString) => value instanceof PDFName
    ? `name:${value.decodeText()}` : `string:${Array.from(value.asBytes(), b => b.toString(16).padStart(2, '0')).join('')}`;
  let named: Map<string, PDFObject> | undefined;
  const explicit = (value: PDFObject | undefined, isStructure = false): PDFArray => {
    if (!(value instanceof PDFArray) || value.size() < 2) throw fail();
    const target = value.get(0), mode = value.lookup(1);
    if (!(target instanceof PDFRef) || !(mode instanceof PDFName)) throw fail();
    if (isStructure) structure(target);
    else if (!pageRefs.has(target.tag)) throw fail();
    // ISO 32000-2 12.3.2/Table 149: validate the whole view, not just its page.
    const arity: Record<string, number> = { XYZ: 5, Fit: 2, FitH: 3, FitV: 3, FitR: 6, FitB: 2, FitBH: 3, FitBV: 3 };
    const kind = mode.decodeText();
    if (!Object.hasOwn(arity, kind) || value.size() !== arity[kind]) throw fail();
    for (let i = 2; i < value.size(); i++) {
      const coordinate = value.lookup(i);
      if (coordinate === PDFNull && kind !== 'FitR') continue;
      if (!(coordinate instanceof PDFNumber) || !Number.isFinite(coordinate.asNumber())) throw fail();
    }
    return value;
  };
  const namedValue = (raw: PDFName | PDFString | PDFHexString): PDFObject => {
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
    const hit = source.doc.context.lookup(named.get(nameKey(raw)));
    if (!hit) throw fail();
    return hit;
  };
  const destination = (raw: PDFObject | undefined): PDFArray => {
    const value = source.doc.context.lookup(raw);
    if (value instanceof PDFArray) return explicit(value);
    if (!(value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString)) throw fail();
    const hit = namedValue(value);
    if (hit instanceof PDFDict && hit.has(N('SD'))) explicit(hit.lookup(N('SD')), true);
    return explicit(hit instanceof PDFDict ? hit.lookup(N('D')) : hit);
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
      if (structureMap.has(value.tag)) return structure(value);
      const priorRef = refs.get(value.tag); if (priorRef) return priorRef;
      const target = source.doc.context.lookup(value); if (!target) throw fail();
      if (target instanceof PDFDict && target.lookup(N('Type')) === N('StructElem')) {
        const mapped = structureMap.get(value.tag); if (!mapped) throw fail(); return mapped;
      }
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
        if (key === N('D') && value.lookup(N('S')) === N('GoTo')) result.set(key, copyDestination(child, depth + 1));
        else result.set(key, copy(key === N('SD') && value.lookup(N('S')) === N('GoTo')
          ? explicit(source.doc.context.lookup(child), true) : child, depth + 1));
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
  const retainedNames = new Map<string, { key: PDFString | PDFHexString; value: PDFObject }>();
  const copiedNames = new Set<string>();
  const copyDestination = (raw: PDFObject, depth = 0): PDFObject => {
    const dest = destination(raw), key = source.doc.context.lookup(raw);
    if (key instanceof PDFName || key instanceof PDFString || key instanceof PDFHexString) {
      const hit = namedValue(key);
      // A plain array can be resolved inline. A destination dictionary may
      // additionally carry /SD or extension attributes: preserve its named
      // identity and complete payload rather than flattening those away.
      if (hit instanceof PDFDict && hit.entries().some(([k]) => k !== N('D'))) {
        const tag = nameKey(key);
        if (!copiedNames.has(tag)) {
          copiedNames.add(tag);
          const value = copy(hit, depth + 1);
          if (key instanceof PDFName) {
            const dict = output.catalog.lookupMaybe(N('Dests'), PDFDict) ?? output.context.obj({});
            dict.set(key, value); output.catalog.set(N('Dests'), dict);
          } else {
            retainedNames.set(tag, { key, value });
            const entries = [...retainedNames.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
            const values = output.context.obj([]);
            for (const [, entry] of entries) { values.push(entry.key.clone()); values.push(entry.value); }
            const dict = output.catalog.lookupMaybe(N('Names'), PDFDict) ?? output.context.obj({});
            dict.set(N('Dests'), output.context.obj({ Names: values })); output.catalog.set(N('Names'), dict);
          }
        }
        return key.clone();
      }
    }
    return copy(dest, depth + 1);
  };
  return { copy, destination, copyDestination, structure, bind: (sourceRef, outputRef) => {
    const previous = refs.get(sourceRef.tag);
    if (previous && previous !== outputRef) throw fail();
    refs.set(sourceRef.tag, outputRef);
  } };
}

export function carryDocumentBehavior(output: PDFDocument, source: CarriedSourcePages, objectMap: ObjectMap,
  copier: CatalogObjectCopy = catalogObjectCopier(output, source, objectMap)): void {
  const names = source.doc.catalog.lookupMaybe(N('Names'), PDFDict), tree = names?.get(N('JavaScript'));
  const aa = source.doc.catalog.get(N('AA')), open = source.doc.catalog.get(N('OpenAction'));
  if (tree === undefined && aa === undefined && open === undefined) return;
  if (aa !== undefined && !(source.doc.context.lookup(aa) instanceof PDFDict)) throw new Error(tChrome('app.operation.unverified'));
  const { copy, copyDestination } = copier;
  if (tree !== undefined) {
    const outNames = output.catalog.lookupMaybe(N('Names'), PDFDict) ?? output.context.obj({});
    outNames.set(N('JavaScript'), copy(tree)); output.catalog.set(N('Names'), outNames);
  }
  if (aa !== undefined) output.catalog.set(N('AA'), copy(aa));
  if (open !== undefined) {
    const value = source.doc.context.lookup(open);
    output.catalog.set(N('OpenAction'), value instanceof PDFDict ? copy(open) : copyDestination(open));
  }
}

/**
 * Carry the own document's catalog state into the rebuilt output. `source`
 * must be the SAME loaded instance the builder copied pages from — the page
 * and in-page object maps are what make reference remapping possible at all.
 */
export function carryDocumentCatalog(output: PDFDocument, source: CarriedSourcePages, structureMap?: ObjectMap): void {
  const srcCatalog = source.doc.catalog;
  const objectMap = buildInPageObjectMap(source, output);
  const copier = catalogObjectCopier(output, source, objectMap, structureMap);
  carryLang(output, srcCatalog);
  carryViewerPreferences(output, source);
  carryOutlines(output, source, copier);
  carryPageLabels(output, source);
  carryOcProperties(output, source.doc, objectMap);
  carryDocumentBehavior(output, source, objectMap, copier);
}
