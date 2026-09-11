// Per-occurrence object correspondence and a guarded pure-data copier for the
// structure carry.
//
// Two things the shared in-page map (catalog-carry's buildInPageObjectMap)
// cannot give the structure tree:
//
//   1. ONE MAP PER PAGE OCCURRENCE. A page kept twice is copied twice, so its
//      annotations and Form XObjects exist twice in the output. One map keyed
//      by source tag can only name one of them, and the structure tree has to
//      reach the occurrence it is actually talking about.
//   2. STREAM INTERIORS, AT DEPTH. A Form XObject is a stream, not a
//      dictionary, and marked content can sit inside a Form nested inside a
//      Form. A walk that only descends dictionaries, six levels deep, never
//      reaches those content streams, so an MCR naming one is dropped.
//
// The copier here is for attribute payloads, file specifications and unknown
// extension data. It refuses anything that proves itself a page, a structure
// node, an annotation or an action, so no payload can drag a second copy of
// the document's graphs into the output.
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

import type { CarriedSourcePages, ObjectMap } from './catalog-carry';

const N = PDFName.of.bind(PDFName);

/** How far a parallel walk descends into a page's own graph. Deep enough for
 * Forms nested inside Forms inside appearance streams; bounded so a cyclic or
 * hostile resource graph cannot run away. */
const MAP_DEPTH = 32;

/** Types that prove a dictionary is part of a document graph rather than
 * payload data. Copying one would duplicate pages, tags or annotations. */
const FORBIDDEN_TYPES = new Set([
  '/Catalog',
  '/Page',
  '/Pages',
  '/StructTreeRoot',
  '/StructElem',
  '/OBJR',
  '/MCR',
  '/Annot',
  '/Action',
]);

/** Standard action subtypes, ISO 32000-2 Table 201. An action's /Type is
 * optional and its /S required, so the subtype is what identifies one that
 * left its type out. */
const ACTION_TYPES = new Set([
  '/GoTo', '/GoToR', '/GoToE', '/GoToDp', '/Launch', '/Thread', '/URI', '/Sound', '/Movie',
  '/Hide', '/Named', '/SubmitForm', '/ResetForm', '/ImportData', '/SetOCGState', '/Rendition',
  '/Trans', '/GoTo3DView', '/JavaScript', '/RichMediaExecute',
]);

export interface Budget {
  objects: number;
  bytes: number;
  limitObjects: number;
  limitBytes: number;
  fail: () => Error;
}

export function spend(budget: Budget, count = 1): void {
  budget.objects += count;
  if (budget.objects > budget.limitObjects) throw budget.fail();
}

export function spendBytes(budget: Budget, count: number): void {
  budget.bytes += count;
  if (budget.bytes > budget.limitBytes) throw budget.fail();
}

/** One kept page of one source, and the correspondence between that source
 * page's own objects and the copy made for THIS occurrence. */
export interface PageOccurrence {
  srcIndex: number;
  /** Position of this occurrence among the source's kept pages. */
  order: number;
  outPageRef: PDFRef;
  outPageNode: PDFDict;
  objMap: ObjectMap;
}

/** Walk a source page and its copy in step, recording which output object
 * each source object became FOR THIS OCCURRENCE. copyPages preserves shape,
 * so the two graphs pair node for node. */
function mapParallel(
  srcValue: PDFObject | undefined,
  outValue: PDFObject | undefined,
  source: PDFDocument,
  output: PDFDocument,
  map: ObjectMap,
  seen: Set<string>,
  depth: number,
  budget: Budget,
): void {
  // Every traversed edge is charged, whether or not it leads anywhere new:
  // a direct container entry and a repeat visit are both work.
  spend(budget);
  if (depth > MAP_DEPTH) throw budget.fail();
  let srcObj = srcValue;
  let outObj = outValue;
  if (srcObj instanceof PDFRef) {
    if (!(outObj instanceof PDFRef)) return;
    if (seen.has(srcObj.tag)) return;
    seen.add(srcObj.tag);
    map.set(srcObj.tag, outObj);
    srcObj = source.context.lookup(srcObj);
    outObj = output.context.lookup(outObj);
  }
  // A Form XObject or appearance stream is a stream; its dictionary is where
  // the nested resources live, and that is what has to be walked.
  if (srcObj instanceof PDFStream && outObj instanceof PDFStream) {
    srcObj = srcObj.dict;
    outObj = outObj.dict;
  }
  if (srcObj instanceof PDFDict && outObj instanceof PDFDict) {
    for (const [key, value] of srcObj.entries()) {
      // /Parent and /P climb out of the page subtree; following them would
      // walk the whole document.
      if (key === N('Parent') || key === N('P')) continue;
      mapParallel(value, outObj.get(key), source, output, map, seen, depth + 1, budget);
    }
    return;
  }
  if (srcObj instanceof PDFArray && outObj instanceof PDFArray) {
    for (let i = 0, n = srcObj.size(); i < n; i++) {
      mapParallel(srcObj.get(i), outObj.get(i), source, output, map, seen, depth + 1, budget);
    }
  }
}

/** Every kept page of a source, in output order, each with its own map. A
 * source page kept twice yields two occurrences with two distinct maps. */
export function buildOccurrences(
  source: CarriedSourcePages,
  output: PDFDocument,
  budget: Budget,
): PageOccurrence[] {
  const occurrences: PageOccurrence[] = [];
  source.pairs.forEach(({ srcIndex, outPage }, order) => {
    const srcPage = source.doc.getPage(srcIndex);
    const map: ObjectMap = new Map();
    // A fresh `seen` per occurrence: the point is that the same source object
    // maps to a DIFFERENT output object in each copy of the page.
    const seen = new Set<string>();
    for (const key of ['Resources', 'Annots', 'Contents'] as const) {
      mapParallel(srcPage.node.get(N(key)), outPage.node.get(N(key)), source.doc, output, map, seen, 0, budget);
    }
    occurrences.push({
      srcIndex,
      order,
      outPageRef: outPage.ref,
      outPageNode: outPage.node,
      objMap: map,
    });
  });
  return occurrences;
}

/** Copy payload data — an attribute object, a file specification, a schema
 * reference, an unknown extension field — into the output context.
 *
 * References are followed once and remembered, so shared payload stays shared
 * and a cycle terminates. `preallocated` lets the caller pin source objects to
 * output objects it has already reserved (structure elements, namespaces), so
 * a payload referring to one points at the real object rather than a clone.
 * Anything that proves itself a document graph refuses. */
export function copyPayload(
  output: PDFDocument,
  source: PDFDocument,
  value: PDFObject,
  preallocated: ReadonlyMap<string, PDFRef>,
  forbidden: ReadonlySet<string>,
  budget: Budget,
  mapped: Map<string, PDFRef> = new Map(),
  depth = 0,
): PDFObject {
  const fail = budget.fail;
  if (depth > MAP_DEPTH) throw fail();

  if (value instanceof PDFRef) {
    // The edge is charged first: a repeated reference to one object is still
    // an edge traversed, so a cache hit cannot be free work.
    spend(budget);
    const pinned = preallocated.get(value.tag);
    if (pinned) {
      // Remember uses as well as allocations: the caller proves every
      // referenced reservation was assigned after pruning finishes.
      mapped.set(value.tag, pinned);
      return pinned;
    }
    const seen = mapped.get(value.tag);
    if (seen) return seen;
    if (forbidden.has(value.tag)) throw fail();
    const resolved = source.context.lookup(value);
    // A reference to a nonexistent object is null (ISO 32000-2 7.3.9), and a
    // null payload entry means the entry is not there.
    if (resolved === undefined) return PDFNull;
    const placeholder = output.context.nextRef();
    mapped.set(value.tag, placeholder);
    output.context.assign(
      placeholder,
      copyPayload(output, source, resolved, preallocated, forbidden, budget, mapped, depth + 1),
    );
    return placeholder;
  }

  if (value instanceof PDFRawStream) {
    spend(budget);
    spendBytes(budget, value.contents.length);
    guardDict(source, value.dict, fail);
    const dict = copyPayload(output, source, value.dict, preallocated, forbidden, budget, mapped, depth + 1);
    if (!(dict instanceof PDFDict)) throw fail();
    // Encoded bytes and filter dictionary travel as they are.
    return PDFRawStream.of(dict, value.contents.slice());
  }
  if (value instanceof PDFStream) throw fail();

  if (value instanceof PDFDict) {
    spend(budget);
    guardDict(source, value, fail);
    const out = PDFDict.withContext(output.context);
    for (const [key, entry] of value.entries()) {
      spendBytes(budget, key.asString().length);
      out.set(key, copyPayload(output, source, entry, preallocated, forbidden, budget, mapped, depth + 1));
    }
    return out;
  }

  if (value instanceof PDFArray) {
    spend(budget);
    const out = PDFArray.withContext(output.context);
    for (let i = 0, n = value.size(); i < n; i++) {
      out.push(copyPayload(output, source, value.get(i), preallocated, forbidden, budget, mapped, depth + 1));
    }
    return out;
  }

  if (value instanceof PDFString || value instanceof PDFHexString) {
    spend(budget);
    spendBytes(budget, value.asString().length);
    // Cloning keeps the raw bytes the string was written with — a hex string
    // stays a hex string, so UTF-16 text is not flattened.
    return value.clone();
  }
  if (value instanceof PDFName) {
    spend(budget);
    spendBytes(budget, value.asString().length);
    return value.clone();
  }
  if (value instanceof PDFNumber || value instanceof PDFBool) {
    spend(budget);
    if (value instanceof PDFNumber && !Number.isFinite(value.asNumber())) throw fail();
    return value.clone();
  }
  if (value === PDFNull) {
    spend(budget);
    return PDFNull;
  }
  throw fail();
}

function guardDict(source: PDFDocument, dict: PDFDict, fail: () => Error): void {
  const type = source.context.lookup(dict.get(N('Type')));
  if (type instanceof PDFName && FORBIDDEN_TYPES.has(type.asString())) throw fail();
  const subtype = source.context.lookup(dict.get(N('S')));
  if (subtype instanceof PDFName && ACTION_TYPES.has(subtype.asString())) throw fail();
}

/** Source objects a payload copy must never reach: the catalog, its document
 * and structural roots, and every page. */
export function forbiddenSourceRefs(source: PDFDocument, budget: Budget): Set<string> {
  const refs = new Set<string>();
  const add = (value: PDFObject | undefined) => {
    spend(budget);
    if (value instanceof PDFRef) refs.add(value.tag);
  };
  add(source.context.trailerInfo.Root as PDFObject | undefined);
  for (const key of ['Pages', 'StructTreeRoot', 'AcroForm', 'Outlines', 'Threads', 'Names', 'Dests', 'OpenAction', 'AA']) {
    add(source.catalog.get(N(key), true));
  }
  // The page list is read inside the guard; charging and recording happen
  // outside it, so a budget refusal can never be mistaken for a page tree
  // that merely could not be enumerated.
  let pages: { ref: PDFRef }[];
  try {
    pages = source.getPages();
  } catch {
    throw budget.fail();
  }
  for (const page of pages) {
    spend(budget);
    refs.add(page.ref.tag);
  }
  return refs;
}
