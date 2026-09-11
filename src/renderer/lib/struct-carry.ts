// Carries the tagged-PDF structure tree (/StructTreeRoot) through the
// from-scratch rebuild in pdfx-build.ts. The marked-content operators (MCIDs)
// survive inside the copied page streams, so before this module ANY committed
// page edit on a tagged file orphaned them all: the tree, the ParentTree, and
// /MarkInfo were silently dropped, and every page kept a STALE /StructParents
// key pointing into a number tree that no longer existed. Same family as the
// /AcroForm and catalog carries.
//
// PER-SOURCE contributions, the ACROFORM precedent (not embedded-files'
// own-bytes-only rule): tags are PAGE-anchored semantics — an inserted donor
// page's MCIDs arrive in its content stream, and dropping the donor's subtree
// would orphan real content. Each contributing source's surviving subtree
// lands under one output root.
//
// A NAME IS ONLY MEANINGFUL INSIDE ITS OWN DOCUMENT. Two sources can spell
// the same structure type or attribute class and mean different things, and a
// source that does not map a name at all means the name unmapped — a merged
// map that simply took one source's edge would silently retarget the other
// source's elements. So names whose resolved meaning differs between the
// sources that use them are renamed to deterministic source-local identities,
// carrying every S, C, RoleMap edge and class reference with them; names that
// every user agrees on keep their original spelling. ISO 32000-2 14.7.3 makes
// this unavoidable: role mapping applies even to a standard-looking name, and
// role chains may be circular.
//
// Nothing here uses a blind deep copy on the TREE: struct elems reference
// pages (/Pg), annotations (OBJR /Obj), and content streams (MCR /Stm), and a
// copier pass would re-copy every page it reached. The tree is rebuilt by hand
// against the builder's page pairs and a per-occurrence object map; only
// payload data (attributes, class values, file specifications, extension
// fields) goes through the guarded copier in struct-carry-objects.ts.
//
// The ParentTree is renumbered from scratch in OUTPUT order, and the stale key
// sweep runs UNCONDITIONALLY — an untagged rebuild must also drop the dangling
// /StructParents (+ annotation /StructParent) integers the page copies drag
// along.
//
// What cannot be preserved provably refuses rather than publishing a tree that
// misstates the document: a cyclic or over-deep tree, an element with no
// structure type, an MCID index past the bound, a payload that proves itself a
// page or an action.

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

import { tChrome } from '../i18n';
import type { CarriedSourcePages, ObjectMap } from './catalog-carry';
import {
  buildOccurrences,
  copyPayload,
  forbiddenSourceRefs,
  spend,
  spendBytes,
  type Budget,
  type PageOccurrence,
} from './struct-carry-objects';

const N = PDFName.of.bind(PDFName);

// Bounds, not predictions. Every phase spends from one pair of counters.
const MAX_OBJECTS = 200_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_TREE_DEPTH = 256;
/** An MCID becomes an index into a ParentTree array, so a sparse maximum
 * decides an allocation. Past this the rebuild refuses instead of reserving
 * an arbitrary array. */
const MAX_MCID = 1_000_000;
/** How far the stale-key sweep descends into a page's resource graph. */
const MAX_STREAM_SWEEP_DEPTH = 32;
/** How far a namespace-meaning signature descends. */
const MAX_SIGNATURE_DEPTH = 32;

/** Element fields that are raw text or byte strings: they travel as the exact
 * object the source wrote, never through a decode and re-encode, or a UTF-16
 * description becomes mojibake and a byte-string ID becomes a different ID. */
const RAW_STRING_FIELDS = ['T', 'Lang', 'Alt', 'ActualText', 'E', 'Phoneme'] as const;

/** Element fields this module builds itself and must not copy blindly. */
const REBUILT_FIELDS = new Set(['/Type', '/S', '/P', '/K', '/Pg', '/ID', '/C', '/NS', '/Ref']);

/** Root fields this module builds itself. */
const REBUILT_ROOT_FIELDS = new Set([
  '/Type', '/K', '/IDTree', '/ParentTree', '/ParentTreeNextKey', '/RoleMap', '/ClassMap', '/Namespaces',
]);

const refuse = (): Error => new Error(tChrome('app.operation.unverified'));

interface Registration {
  /** An output PAGE ref tag, or a mapped content-STREAM ref tag (marked
   * content inside a Form XObject). */
  containerTag: string;
  mcid: number;
  elem: PDFRef;
}

interface AnnotParent {
  annotRef: PDFRef;
  elem: PDFRef;
}

/** One source's analysed name usage, decided before any element is built. */
interface SourceNames {
  roleMap: Map<string, string>;
  classValues: Map<string, PDFObject>;
  usedRoles: Set<string>;
  usedClasses: Set<string>;
}

interface Renames {
  role: Map<string, string>;
  class: Map<string, string>;
}

interface CarrySource {
  doc: PDFDocument;
  /** Source element tags that some element's /Ref names. */
  refTargets: Set<string>;
  /** Position in the source list, for deterministic local identities. */
  index: number;
  /** Source page ref tag → its index, built once. */
  pageIndexByTag: Map<string, number>;
  occurrencesByIndex: Map<number, PageOccurrence[]>;
  forbidden: Set<string>;
  renames: Renames;
  /** Source element ref tag → the output ref reserved for it. */
  elemRefs: Map<string, PDFRef>;
  /** Source namespace ref tag → the output ref reserved for it. */
  nsRefs: Map<string, PDFRef>;
  /** All actual semantic identities available to opaque payload edges. */
  payloadRefs: Map<string, PDFRef>;
  structureMap: ObjectMap;
}

const isText = (v: PDFObject | undefined): v is PDFString | PDFHexString =>
  v instanceof PDFString || v instanceof PDFHexString;

/** An optional entry's effective value: absent, directly null, indirectly
 * null and a reference to a nonexistent object are ALL absence (ISO 32000-2
 * 7.3.9), for every field alike. Anything else present is returned resolved
 * so the caller decides whether its shape is acceptable. */
function optional(doc: PDFDocument, dict: PDFDict, key: string): PDFObject | undefined {
  const raw = dict.get(N(key), true);
  if (raw === undefined) return undefined;
  const value = doc.context.lookup(raw);
  return value === undefined || value === PDFNull ? undefined : value;
}

/** Normalize a /K value to an array of kid entries, charging each edge.
 * An absent, null or dangling /K yields no kids — not one null kid, which
 * would make a valid empty element look like content that disappeared. */
function kidsOf(source: PDFDocument, container: PDFDict, budget: Budget): PDFObject[] {
  spend(budget);
  const resolved = optional(source, container, 'K');
  if (resolved === undefined) return [];
  if (!(resolved instanceof PDFArray)) return [container.get(N('K'), true)!];
  const out: PDFObject[] = [];
  for (let i = 0, n = resolved.size(); i < n; i++) {
    // Charged per entry, before the array is materialized into a copy.
    spend(budget);
    const el = resolved.get(i);
    const value = source.context.lookup(el);
    if (value !== undefined && value !== PDFNull) out.push(el);
  }
  return out;
}

// ── name analysis ──────────────────────────────────────────────────────────

/** The chain a role name resolves through in one source's map, stopping when
 * it repeats — 14.7.3 permits circular chains explicitly. The chain, not just
 * its endpoint, is the meaning: two sources agree only if they walk the same
 * names in the same order. */
function roleChain(map: Map<string, string>, start: string, budget: Budget): string[] {
  const chain = [start];
  const seen = new Set([start]);
  let current = start;
  for (;;) {
    spend(budget);
    const next = map.get(current);
    if (next === undefined || seen.has(next)) {
      if (next !== undefined) chain.push(next);
      return chain;
    }
    seen.add(next);
    chain.push(next);
    current = next;
  }
}

/** Walk one source's tree for the role and class names its elements use, and
 * read its two maps. Bounded, and it never builds anything. */
function analyseSource(doc: PDFDocument, budget: Budget): SourceNames {
  const names: SourceNames = {
    roleMap: new Map(),
    classValues: new Map(),
    usedRoles: new Set(),
    usedClasses: new Set(),
  };
  const root = doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict);
  if (!root) return names;

  const sourceRoleMap = root.lookupMaybe(N('RoleMap'), PDFDict);
  if (sourceRoleMap) {
    for (const [key, value] of sourceRoleMap.entries()) {
      spend(budget);
      const target = doc.context.lookup(value);
      if (!(target instanceof PDFName)) throw refuse();
      names.roleMap.set(key.asString(), target.asString());
    }
  }
  const sourceClassMap = root.lookupMaybe(N('ClassMap'), PDFDict);
  if (sourceClassMap) {
    for (const [key, value] of sourceClassMap.entries()) {
      spend(budget);
      const resolved = doc.context.lookup(value);
      if (resolved === undefined || resolved === PDFNull) continue;
      // The RAW edge is retained: the copier needs the reference to recognise
      // a payload this class shares with an element or root field.
      names.classValues.set(key.asString(), value);
    }
  }

  const seen = new Set<string>();
  const walk = (elem: PDFDict, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) throw refuse();
    spend(budget);
    const s = doc.context.lookup(elem.get(N('S')));
    if (s instanceof PDFName) names.usedRoles.add(s.asString());
    for (const className of classNamesOf(doc, elem, budget)) names.usedClasses.add(className);
    for (const kid of kidsOf(doc, elem, budget)) {
      const tag = kid instanceof PDFRef ? kid.tag : null;
      if (tag) {
        if (seen.has(tag)) throw refuse();
        seen.add(tag);
      }
      const resolved = kid instanceof PDFRef ? doc.context.lookup(kid) : kid;
      if (!(resolved instanceof PDFDict)) continue;
      const type = doc.context.lookup(resolved.get(N('Type')));
      const typeName = type instanceof PDFName ? type.asString() : null;
      if (typeName === '/MCR' || typeName === '/OBJR') continue;
      walk(resolved, depth + 1);
    }
  };
  for (const kid of kidsOf(doc, root, budget)) {
    const resolved = kid instanceof PDFRef ? doc.context.lookup(kid) : kid;
    if (resolved instanceof PDFDict) {
      if (kid instanceof PDFRef) seen.add(kid.tag);
      walk(resolved, 0);
    }
  }
  return names;
}

/** The class names a /C value mentions. /C is a name, or an array of names
 * each optionally followed by a revision integer (Table 355). */
function classNamesOf(doc: PDFDocument, container: PDFDict, budget: Budget): string[] {
  spend(budget);
  const value = optional(doc, container, 'C');
  if (value instanceof PDFName) return [value.asString()];
  if (value instanceof PDFArray) {
    const out: string[] = [];
    for (let i = 0, n = value.size(); i < n; i++) {
      // Charged per entry including the revision integers, which are entries
      // this pass reads even though it collects no name from them.
      spend(budget);
      const entry = doc.context.lookup(value.get(i));
      if (entry instanceof PDFName) out.push(entry.asString());
    }
    return out;
  }
  return [];
}

/** Decide, per source, which names must become source-local.
 *
 * A role name is contentious when two sources that use or define it resolve
 * it through different chains — including the case where one source maps it
 * and another leaves it alone, since an absent key is not permission to
 * retarget that source's elements. A class name is contentious when two such
 * sources give it different attribute values. Everything else keeps the
 * spelling it had, so an ordinary single-source document is untouched. */
function decideRenames(analyses: SourceNames[], budget: Budget): Renames[] {
  const roleSignatures = new Map<string, Set<string>>();
  const classSignatures = new Map<string, Set<string>>();

  analyses.forEach((names, index) => {
    const roleNames = new Set([...names.usedRoles, ...names.roleMap.keys(), ...names.roleMap.values()]);
    for (const name of roleNames) {
      const signature = JSON.stringify(roleChain(names.roleMap, name, budget));
      let set = roleSignatures.get(name);
      if (!set) roleSignatures.set(name, (set = new Set()));
      set.add(signature);
    }
    // A class name is isolated whenever more than one source has a stake in
    // it. Comparing definitions is NOT attempted: an attribute payload is a
    // graph whose serialization carries source-local reference numbers, so
    // two unrelated payloads can spell alike and one payload can spell two
    // ways. Isolating conservatively costs a rename where sources happen to
    // agree; proving equality wrongly changes an element's attributes
    // silently, which is the defect this replaces.
    const classNames = new Set([...names.usedClasses, ...names.classValues.keys()]);
    for (const name of classNames) {
      let set = classSignatures.get(name);
      if (!set) classSignatures.set(name, (set = new Set()));
      set.add(names.classValues.has(name) ? `defined-by-${index}` : 'used-undefined');
    }
  });

  const contentiousRoles = new Set(
    [...roleSignatures.entries()].filter(([, set]) => set.size > 1).map(([name]) => name),
  );
  const contentiousClasses = new Set(
    [...classSignatures.entries()].filter(([, set]) => set.size > 1).map(([name]) => name),
  );
  const takenRoles = new Set(roleSignatures.keys());
  const takenClasses = new Set(classSignatures.keys());

  return analyses.map((names, index) => {
    const renames: Renames = { role: new Map(), class: new Map() };
    const localise = (name: string, taken: Set<string>): string => {
      // Deterministic in source order, and extended until it collides with
      // nothing any source already spells.
      const base = `${name.slice(1)}_s${index}`;
      let candidate = `/${base}`;
      let suffix = 0;
      while (taken.has(candidate)) candidate = `/${base}_${++suffix}`;
      taken.add(candidate);
      return candidate;
    };
    // Only a name this source DEFINES moves. A source that merely uses a name
    // it never mapped keeps the spelling it had: every source that defines the
    // name has moved off it, so the merged map holds no entry under the bare
    // name and the unmapped element stays unmapped — which is what it meant.
    for (const name of names.roleMap.keys()) {
      if (contentiousRoles.has(name)) renames.role.set(name, localise(name, takenRoles));
    }
    for (const name of names.classValues.keys()) {
      if (contentiousClasses.has(name)) renames.class.set(name, localise(name, takenClasses));
    }
    return renames;
  });
}

const localRole = (source: CarrySource, name: string): string => source.renames.role.get(name) ?? name;
const localClass = (source: CarrySource, name: string): string => source.renames.class.get(name) ?? name;

// ── namespaces ─────────────────────────────────────────────────────────────

// ── element rebuild ────────────────────────────────────────────────────────

interface RebuildCtx {
  output: PDFDocument;
  source: CarrySource;
  payloadMap: Map<string, PDFRef>;
  emittedRefs: PDFRef[];
  registrations: Registration[];
  annotParents: AnnotParent[];
  idEntries: Map<string, { ref: PDFRef; raw: PDFString | PDFHexString }>;
  budget: Budget;
  visited: Set<string>;
}

/** Every source element another element's /Ref names. Collected before any
 * rebuild, because whether a node may be pruned depends on it. */
function collectRefTargets(doc: PDFDocument, budget: Budget): Set<string> {
  const targets = new Set<string>();
  const root = doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict);
  if (!root) return targets;
  const seen = new Set<string>();
  const walk = (raw: PDFObject, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) throw refuse();
    spend(budget);
    const tag = raw instanceof PDFRef ? raw.tag : null;
    if (tag) {
      if (seen.has(tag)) return;
      seen.add(tag);
    }
    const elem = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    if (!(elem instanceof PDFDict)) return;
    const refs = doc.context.lookup(elem.get(N('Ref')));
    if (refs instanceof PDFArray) {
      for (let i = 0, n = refs.size(); i < n; i++) {
        spend(budget);
        const target = refs.get(i);
        if (target instanceof PDFRef) targets.add(target.tag);
      }
    }
    for (const kid of kidsOf(doc, elem, budget)) {
      const resolved = kid instanceof PDFRef ? doc.context.lookup(kid) : kid;
      if (!(resolved instanceof PDFDict)) continue;
      const type = doc.context.lookup(resolved.get(N('Type')));
      const typeName = type instanceof PDFName ? type.asString() : null;
      if (typeName === '/MCR' || typeName === '/OBJR') continue;
      walk(kid, depth + 1);
    }
  };
  for (const kid of kidsOf(doc, root, budget)) walk(kid, 0);
  return targets;
}

/** Reserve an output reference for every structure element of a source, so a
 * /Ref relationship between elements — in either direction — resolves to a
 * real output object rather than being dropped. */
function reserveElements(ctx: RebuildCtx): void {
  const root = ctx.source.doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict);
  if (!root) return;
  const doc = ctx.source.doc;
  const budget = ctx.budget;
  const walk = (raw: PDFObject, depth: number): void => {
    // The edge is charged before the reservation cache is consulted, so a
    // graph that revisits one element cannot buy free traversal.
    spend(budget);
    if (depth > MAX_TREE_DEPTH) throw refuse();
    const tag = raw instanceof PDFRef ? raw.tag : null;
    if (tag) {
      if (ctx.source.elemRefs.has(tag)) return;
      ctx.source.elemRefs.set(tag, ctx.output.context.nextRef());
    }
    const elem = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    if (!(elem instanceof PDFDict)) return;
    for (const kid of kidsOf(doc, elem, budget)) {
      spend(budget);
      const resolved = kid instanceof PDFRef ? doc.context.lookup(kid) : kid;
      if (!(resolved instanceof PDFDict)) continue;
      const type = doc.context.lookup(resolved.get(N('Type')));
      const typeName = type instanceof PDFName ? type.asString() : null;
      if (typeName === '/MCR' || typeName === '/OBJR') continue;
      walk(kid, depth + 1);
    }
  };
  for (const kid of kidsOf(doc, root, budget)) walk(kid, 0);
}

function rebuildElem(
  ctx: RebuildCtx,
  srcElem: PDFDict,
  srcTag: string | null,
  parentRef: PDFRef,
  inheritedPgIndex: number | null,
  depth: number,
): PDFRef | null {
  if (depth > MAX_TREE_DEPTH) throw refuse();
  if (srcTag) {
    // A tree that revisits an element is malformed. Refusing beats publishing
    // a silently truncated hierarchy.
    if (ctx.visited.has(srcTag)) throw refuse();
    ctx.visited.add(srcTag);
  }
  spend(ctx.budget);
  const doc = ctx.source.doc;

  const srcPgRef = srcElem.get(N('Pg'));
  const ownPgIndex = pageIndexOf(ctx.source, srcPgRef);
  const effectivePgIndex = ownPgIndex ?? inheritedPgIndex;

  const outRef = srcTag ? ctx.source.elemRefs.get(srcTag) ?? ctx.output.context.nextRef()
    : ctx.output.context.nextRef();
  const out = PDFDict.withContext(ctx.output.context);

  // Type is OPTIONAL on a structure element (Table 355): carry it when the
  // source wrote one and invent nothing when it did not.
  const typeRaw = srcElem.get(N('Type'), true);
  const type = doc.context.lookup(typeRaw);
  if (typeRaw !== undefined && type !== undefined && type !== PDFNull) {
    // Optional, but when written it shall be StructElem.
    if (!(type instanceof PDFName) || type.asString() !== '/StructElem') throw refuse();
    out.set(N('Type'), type.clone());
  }
  out.set(N('P'), parentRef);

  // The structure type is required. Its meaning is source-local only inside
  // the DEFAULT namespace: an element carrying an NS names a type in that
  // namespace, whose spelling the default role map has no authority over.
  const s = doc.context.lookup(srcElem.get(N('S')));
  if (!(s instanceof PDFName)) throw refuse();
  const namespaceRaw = srcElem.get(N('NS'), true);
  const inDefaultNamespace = optional(doc, srcElem, 'NS') === undefined;
  out.set(N('S'), inDefaultNamespace ? N(localRole(ctx.source, s.asString()).slice(1)) : s.clone());

  for (const key of RAW_STRING_FIELDS) {
    const raw = srcElem.get(N(key), true);
    if (raw === undefined) continue;
    const value = doc.context.lookup(raw);
    // Null and a reference to nothing are absence; anything else present that
    // is not a text string is malformed and refuses rather than vanishing.
    if (value === undefined || value === PDFNull) continue;
    if (!isText(value)) throw refuse();
    spendBytes(ctx.budget, value.asString().length);
    out.set(N(key), value.clone());
  }
  const phoneticRaw = srcElem.get(N('PhoneticAlphabet'), true);
  if (phoneticRaw !== undefined) {
    const phonetic = doc.context.lookup(phoneticRaw);
    if (phonetic !== undefined && phonetic !== PDFNull) {
      if (!(phonetic instanceof PDFName)) throw refuse();
      out.set(N('PhoneticAlphabet'), phonetic.clone());
    }
  }

  // The element identifier is a BYTE string: its exact bytes are its identity.
  const idRaw = srcElem.get(N('ID'), true);
  const rawId = doc.context.lookup(idRaw);
  let id: PDFString | PDFHexString | null = null;
  if (idRaw !== undefined && rawId !== undefined && rawId !== PDFNull) {
    if (!isText(rawId)) throw refuse();
    id = rawId;
  }

  const revisionRaw = srcElem.get(N('R'), true);
  if (revisionRaw !== undefined) {
    const revision = doc.context.lookup(revisionRaw);
    if (revision !== undefined && revision !== PDFNull) {
      // Table 355: a non-negative integer.
      if (!(revision instanceof PDFNumber) || !Number.isSafeInteger(revision.asNumber()) || revision.asNumber() < 0) {
        throw refuse();
      }
      out.set(N('R'), revision.clone());
    }
  }

  // Attribute payload: a dictionary, a stream, or an array of those with
  // revision integers interleaved. Copied through the guarded copier.
  // The RAW edge goes to the copier, not the dereferenced value: an indirect
  // attribute object shared by two elements is only recognisable as shared
  // while it is still a reference. Resolving here produced two direct copies.
  const attrsRaw = srcElem.get(N('A'), true);
  if (attrsRaw !== undefined && optional(doc, srcElem, 'A') !== undefined) {
    out.set(N('A'), copyPayload(ctx.output, doc, attrsRaw, ctx.source.payloadRefs, ctx.source.forbidden, ctx.budget, ctx.payloadMap));
  }
  const classes = renameClasses(ctx, srcElem.get(N('C')));
  if (classes) out.set(N('C'), classes);

  if (!inDefaultNamespace) {
    // Table 355: NS shall be an indirect reference to a namespace dictionary.
    if (!(namespaceRaw instanceof PDFRef)) throw refuse();
    const mapped = ctx.source.nsRefs.get(namespaceRaw.tag);
    if (!mapped) throw refuse();
    out.set(N('NS'), mapped);
  }

  // Ref points at other structure elements; every target is reserved, so a
  // forward or backward relationship resolves. A target outside this source's
  // tree cannot be proven and refuses.
  const refsRaw = srcElem.get(N('Ref'), true);
  const refs = doc.context.lookup(refsRaw);
  if (refsRaw !== undefined && refs !== undefined && refs !== PDFNull && !(refs instanceof PDFArray)) {
    throw refuse();
  }
  if (refs instanceof PDFArray) {
    const outRefs = PDFArray.withContext(ctx.output.context);
    for (let i = 0, n = refs.size(); i < n; i++) {
      spend(ctx.budget);
      const target = refs.get(i);
      if (!(target instanceof PDFRef)) throw refuse();
      const mapped = ctx.source.elemRefs.get(target.tag);
      if (!mapped) throw refuse();
      outRefs.push(mapped);
      ctx.emittedRefs.push(mapped);
    }
    out.set(N('Ref'), outRefs);
  }

  // Associated files and any extension payload the source carried.
  for (const [key, value] of srcElem.entries()) {
    if (REBUILT_FIELDS.has(key.asString())) continue;
    if (key.asString() === '/R' || key.asString() === '/A' || key.asString() === '/PhoneticAlphabet') continue;
    if ((RAW_STRING_FIELDS as readonly string[]).includes(key.asString().slice(1))) continue;
    if (out.has(key)) continue;
    spendBytes(ctx.budget, key.asString().length);
    const resolved = doc.context.lookup(value);
    if (resolved === undefined || resolved === PDFNull) continue;
    // Raw edge again, so an object shared between an unknown field and a
    // known one arrives as a single output object.
    out.set(key, copyPayload(ctx.output, doc, value, ctx.source.payloadRefs, ctx.source.forbidden, ctx.budget, ctx.payloadMap));
  }

  // ── kids ────────────────────────────────────────────────────────────────
  const pendingRegs: Registration[] = [];
  const pendingAnnots: AnnotParent[] = [];
  const outKids: PDFObject[] = [];
  const srcKids = kidsOf(doc, srcElem, ctx.budget);
  let firstPgRef: PDFRef | undefined;

  for (const kid of srcKids) {
    spend(ctx.budget);
    const kidTag = kid instanceof PDFRef ? kid.tag : null;
    const resolved = kid instanceof PDFRef ? doc.context.lookup(kid) : kid;
    if (resolved instanceof PDFNumber) {
      // A bare MCID belongs to the nearest /Pg up the chain. One integer plus
      // one /Pg can only name ONE rendering, so where the page was kept more
      // than once the forward tree gets an explicit marked-content reference
      // per occurrence; otherwise the integer shorthand is kept as written.
      if (effectivePgIndex === null) throw refuse();
      const occurrences = ctx.source.occurrencesByIndex.get(effectivePgIndex);
      if (!occurrences || occurrences.length === 0) continue;
      const mcid = boundedMcid(resolved);
      for (const occurrence of occurrences) {
        spend(ctx.budget);
        pendingRegs.push({ containerTag: occurrence.outPageRef.tag, mcid, elem: outRef });
      }
      firstPgRef ??= occurrences[0].outPageRef;
      if (occurrences.length === 1) {
        outKids.push(PDFNumber.of(mcid));
      } else {
        for (const occurrence of occurrences) {
          const outMcr = PDFDict.withContext(ctx.output.context);
          outMcr.set(N('Type'), N('MCR'));
          outMcr.set(N('MCID'), PDFNumber.of(mcid));
          outMcr.set(N('Pg'), occurrence.outPageRef);
          outKids.push(outMcr);
        }
      }
      continue;
    }
    if (!(resolved instanceof PDFDict)) throw refuse();
    const type = doc.context.lookup(resolved.get(N('Type')));
    const typeName = type instanceof PDFName ? type.asString() : null;

    if (typeName === '/MCR') {
      const mcidValue = doc.context.lookup(resolved.get(N('MCID')));
      if (!(mcidValue instanceof PDFNumber)) throw refuse();
      const mcid = boundedMcid(mcidValue);
      const mcrPgIndex = pageIndexOf(ctx.source, resolved.get(N('Pg'))) ?? effectivePgIndex;
      if (mcrPgIndex === null) throw refuse();
      const occurrences = ctx.source.occurrencesByIndex.get(mcrPgIndex);
      if (!occurrences || occurrences.length === 0) continue;
      const stm = optional(doc, resolved, 'Stm') === undefined ? undefined : resolved.get(N('Stm'), true);
      const stmOwn = optional(doc, resolved, 'StmOwn') === undefined ? undefined : resolved.get(N('StmOwn'), true);
      if (stm !== undefined && (!(stm instanceof PDFRef) || !(doc.context.lookup(stm) instanceof PDFStream))) throw refuse();
      if (stmOwn !== undefined && (!(stmOwn instanceof PDFRef) || stm === undefined)) throw refuse();
      // One marked-content reference per output occurrence: the same source
      // page copied twice is two renderings, each with its own stream.
      for (const occurrence of occurrences) {
        spend(ctx.budget);
        const mappedStm = stm instanceof PDFRef ? occurrence.objMap.get(stm.tag) : undefined;
        // The page IS in the output, so the content stream is too. Failing to
        // pair it means the correspondence was not proven — depth truncation,
        // an unexpected shape — and that is not the same as the content being
        // deleted, so it refuses instead of dropping a retained rendering.
        if (stm instanceof PDFRef && !mappedStm) throw refuse();
        const outMcr = PDFDict.withContext(ctx.output.context);
        outMcr.set(N('Type'), N('MCR'));
        outMcr.set(N('MCID'), PDFNumber.of(mcid));
        outMcr.set(N('Pg'), occurrence.outPageRef);
        if (mappedStm) outMcr.set(N('Stm'), mappedStm);
        if (stmOwn instanceof PDFRef) {
          const mappedOwn = ctx.source.pageIndexByTag.get(stmOwn.tag) === mcrPgIndex
            ? occurrence.outPageRef : occurrence.objMap.get(stmOwn.tag);
          if (!mappedOwn) throw refuse();
          outMcr.set(N('StmOwn'), mappedOwn);
        }
        copyContentExtras(ctx, resolved, outMcr, new Set(['/Type', '/MCID', '/Pg', '/Stm', '/StmOwn']));
        pendingRegs.push({
          containerTag: mappedStm ? mappedStm.tag : occurrence.outPageRef.tag,
          mcid,
          elem: outRef,
        });
        outKids.push(outMcr);
        firstPgRef ??= occurrence.outPageRef;
      }
      continue;
    }

    if (typeName === '/OBJR') {
      const obj = resolved.get(N('Obj'));
      if (!(obj instanceof PDFRef)) throw refuse();
      const objrPgIndex = pageIndexOf(ctx.source, resolved.get(N('Pg'))) ?? effectivePgIndex;
      const occurrences = objrPgIndex === null ? [] : ctx.source.occurrencesByIndex.get(objrPgIndex) ?? [];
      // Table 358 NOTE 2: an object rendered on several pages needs one
      // object reference per rendering.
      const candidates = occurrences.length > 0
        ? occurrences
        : [...ctx.source.occurrencesByIndex.values()].flat();
      let paired = 0;
      for (const occurrence of candidates) {
        spend(ctx.budget);
        const mapped = occurrence.objMap.get(obj.tag);
        if (!mapped) continue;
        const actual = ctx.output.context.lookup(mapped);
        const annots = occurrence.outPageNode.lookupMaybe(N('Annots'), PDFArray);
        const isAnnotation = actual instanceof PDFDict && annots?.asArray().some(ref => ref === mapped) === true;
        const isXObject = actual instanceof PDFStream && actual.dict.lookup(N('Type')) === N('XObject');
        if (!isAnnotation && !isXObject) throw refuse();
        paired++;
        const outObjr = PDFDict.withContext(ctx.output.context);
        outObjr.set(N('Type'), N('OBJR'));
        outObjr.set(N('Obj'), mapped);
        outObjr.set(N('Pg'), occurrence.outPageRef);
        copyContentExtras(ctx, resolved, outObjr, new Set(['/Type', '/Obj', '/Pg']));
        pendingAnnots.push({ annotRef: mapped, elem: outRef });
        outKids.push(outObjr);
        firstPgRef ??= occurrence.outPageRef;
      }
      // A referenced object whose page was RETAINED must have been paired. If
      // its page went away there is nothing to reference and the item is
      // genuinely gone; if the page is here, an unpaired object is a proof
      // failure, not a deletion.
      if (paired === 0 && occurrences.length > 0) throw refuse();
      continue;
    }

    const childRef = rebuildElem(ctx, resolved, kidTag, outRef, effectivePgIndex, depth + 1);
    if (childRef) outKids.push(childRef);
  }

  // A structural element whose source /K was absent or empty is a VALID empty
  // element and survives; one whose content all disappeared is pruned.
  // A structural element whose source /K was absent or empty is a VALID empty
  // element and survives. One whose content all disappeared is pruned —
  // UNLESS another element's /Ref names it, in which case the referenced
  // semantic node is retained, without the content that went away, so the
  // relationship keeps a real target and no reservation is left unassigned.
  const hadContent = srcKids.length > 0;
  const isRefTarget = srcTag !== null && ctx.source.refTargets.has(srcTag);
  if (hadContent && outKids.length === 0 && !isRefTarget) return null;

  if (ownPgIndex !== null) {
    const occurrences = ctx.source.occurrencesByIndex.get(ownPgIndex);
    if (occurrences && occurrences.length > 0) out.set(N('Pg'), occurrences[0].outPageRef);
  } else if (firstPgRef) {
    // Required when K holds integers (Table 355) — the element inherited its
    // page, but its own kids now name an output page directly.
    if (outKids.some((kid) => kid instanceof PDFNumber)) out.set(N('Pg'), firstPgRef);
  }
  if (outKids.length > 0) {
    out.set(N('K'), outKids.length === 1 ? outKids[0] : ctx.output.context.obj(outKids));
  }

  if (id) {
    // Table 355: the identifier shall be unique across the whole hierarchy,
    // so a collision between merged sources takes a source-local identity.
    // The element and the ID tree are written from the same value, so they
    // cannot disagree.
    const unique = uniqueId(ctx, id);
    out.set(N('ID'), unique);
    ctx.idEntries.set(idKey(unique), { ref: outRef, raw: unique });
  }
  ctx.output.context.assign(outRef, out);
  ctx.registrations.push(...pendingRegs);
  ctx.annotParents.push(...pendingAnnots);
  if (srcTag) ctx.source.structureMap.set(srcTag, outRef);
  return outRef;
}

function copyContentExtras(ctx: RebuildCtx, source: PDFDict, output: PDFDict, rebuilt: ReadonlySet<string>): void {
  for (const [key, value] of source.entries()) {
    spend(ctx.budget);
    if (rebuilt.has(key.asString())) continue;
    spendBytes(ctx.budget, key.asString().length);
    const resolved = ctx.source.doc.context.lookup(value);
    if (resolved === undefined || resolved === PDFNull) continue;
    output.set(key, copyPayload(ctx.output, ctx.source.doc, value, ctx.source.payloadRefs,
      ctx.source.forbidden, ctx.budget, ctx.payloadMap));
  }
}

/** The identifier this element will carry.
 *
 * Absent a collision the source object travels untouched, so its bytes, its
 * class and its spelling are all preserved. A collision is resolved on the
 * BYTES: the suffix is appended to the decoded sequence and the result is
 * emitted as a hex string, which represents any byte sequence exactly — no
 * literal escape has to be re-derived and no nibble is left unpaired. */
function uniqueId(ctx: RebuildCtx, id: PDFString | PDFHexString): PDFString | PDFHexString {
  spendBytes(ctx.budget, id.asString().length);
  if (!ctx.idEntries.has(idKey(id))) return id.clone();
  const base = id.asBytes();
  for (let n = 0; n < 4096; n++) {
    const suffix = new TextEncoder().encode(`_s${ctx.source.index}${n === 0 ? '' : `_${n}`}`);
    spend(ctx.budget); spendBytes(ctx.budget, base.length + suffix.length);
    const bytes = new Uint8Array(base.length + suffix.length);
    bytes.set(base, 0);
    bytes.set(suffix, base.length);
    const candidate = PDFHexString.of(hexOf(bytes).toUpperCase());
    if (!ctx.idEntries.has(idKey(candidate))) return candidate;
  }
  throw refuse();
}

function boundedMcid(value: PDFNumber): number {
  const mcid = value.asNumber();
  if (!Number.isInteger(mcid) || mcid < 0 || mcid > MAX_MCID) throw refuse();
  return mcid;
}

/** An element identifier is a BYTE string (Table 355), so its identity is the
 * byte sequence it decodes to — not the class it was serialized as, nor the
 * spelling of its escapes or hex case. A literal `(same)` and a hex
 * `<73616D65>` are the same identifier. */
const idKey = (value: PDFString | PDFHexString): string => hexOf(value.asBytes());

const hexOf = (bytes: Uint8Array): string => {
  const digits = '0123456789abcdef', encoded = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    encoded[i * 2] = digits.charCodeAt(bytes[i] >>> 4);
    encoded[i * 2 + 1] = digits.charCodeAt(bytes[i] & 15);
  }
  return new TextDecoder().decode(encoded);
};

/** A namespace name is a TEXT string (Table 356), not a byte string, so the
 * same URI written as an ASCII literal and as UTF-16 text is ONE namespace.
 * Exact decoded text: no case folding and no URI normalization, neither of
 * which the format defines. Element identifiers keep their byte identity. */
const uriKey = (value: PDFString | PDFHexString): string => value.decodeText();

function pageIndexOf(source: CarrySource, raw: PDFObject | undefined): number | null {
  const value = source.doc.context.lookup(raw);
  if (value === undefined || value === PDFNull) return null;
  if (!(raw instanceof PDFRef)) throw refuse();
  const index = source.pageIndexByTag.get(raw.tag);
  if (index === undefined) throw refuse();
  return index;
}

/** Rewrite a /C value through this source's class renames, keeping revision
 * integers exactly where they were (Table 355, 14.7.6.3). */
function renameClasses(ctx: RebuildCtx, raw: PDFObject | undefined): PDFObject | null {
  const doc = ctx.source.doc;
  const value = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  if (value === undefined || value === PDFNull) return null;
  if (value instanceof PDFName) return N(localClass(ctx.source, value.asString()).slice(1));
  if (value instanceof PDFArray) {
    const out = PDFArray.withContext(ctx.output.context);
    for (let i = 0, n = value.size(); i < n; i++) {
      spend(ctx.budget);
      const entry = doc.context.lookup(value.get(i));
      if (entry instanceof PDFName) out.push(N(localClass(ctx.source, entry.asString()).slice(1)));
      else if (entry instanceof PDFNumber && i > 0 && Number.isSafeInteger(entry.asNumber()) && entry.asNumber() >= 0
        && doc.context.lookup(value.get(i - 1)) instanceof PDFName) out.push(entry.clone());
      else throw refuse();
    }
    return out;
  }
  throw refuse();
}

/** Remove the stale structure keys the page copies drag along. Runs for EVERY
 * rebuild — with no carried tree, a lingering /StructParents integer points
 * into a ParentTree that does not exist. */
function sweepStaleKeys(output: PDFDocument, budget: Budget): void {
  for (const page of output.getPages()) {
    spend(budget);
    page.node.delete(N('StructParents'));
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (annots) {
      for (let i = 0; i < annots.size(); i++) {
        spend(budget);
        annots.lookupMaybe(i, PDFDict)?.delete(N('StructParent'));
      }
    }
    // A content STREAM is a marked-content container in its own right, so a
    // Form XObject carries its own /StructParents. Those go stale exactly
    // like a page's, and a lingering one points into a tree that is gone.
    // Annotation appearance streams are containers too, so the sweep starts
    // from the annotations as well as the page's own content and resources.
    const seen = new Set<string>();
    sweepStreamKeys(output, page.node.get(N('Resources')), seen, 0, budget);
    sweepStreamKeys(output, page.node.get(N('Contents')), seen, 0, budget);
    if (annots) {
      for (let i = 0; i < annots.size(); i++) {
        sweepStreamKeys(output, annots.get(i), seen, 0, budget);
      }
    }
  }
}

function sweepStreamKeys(
  output: PDFDocument,
  raw: PDFObject | undefined,
  seen: Set<string>,
  depth: number,
  budget: Budget,
): void {
  spend(budget);
  // Running out of depth is not permission to leave a stale key behind: the
  // sweep either reaches everything or says it could not.
  if (depth > MAX_STREAM_SWEEP_DEPTH) throw refuse();
  let value = raw;
  if (value instanceof PDFRef) {
    if (seen.has(value.tag)) return;
    seen.add(value.tag);
    value = output.context.lookup(value);
  }
  if (value instanceof PDFStream) {
    value.dict.delete(N('StructParents'));
    value.dict.delete(N('StructParent'));
    value = value.dict;
  }
  if (value instanceof PDFDict) {
    for (const [, entry] of value.entries()) sweepStreamKeys(output, entry, seen, depth + 1, budget);
    return;
  }
  if (value instanceof PDFArray) {
    for (let i = 0, n = value.size(); i < n; i++) {
      sweepStreamKeys(output, value.get(i), seen, depth + 1, budget);
    }
  }
}

/** Table 353. Marked asserts conformance to tagged PDF conventions, so it
 * holds only where EVERY contributing source asserted it; a partially tagged
 * combination states nothing. Suspects and UserProperties are presence flags
 * and carry if any source set them. */
function mergeMarkInfo(output: PDFDocument, sources: CarriedSourcePages[]): void {
  let marked = sources.length > 0;
  let suspects = false;
  let userProperties = false;
  for (const source of sources) {
    const info = source.doc.catalog.lookupMaybe(N('MarkInfo'), PDFDict);
    const flag = info ? source.doc.context.lookup(info.get(N('Marked'))) : undefined;
    if (!(flag !== undefined && String(flag) === 'true')) marked = false;
    const suspect = info ? source.doc.context.lookup(info.get(N('Suspects'))) : undefined;
    if (suspect !== undefined && String(suspect) === 'true') suspects = true;
    const userProps = info ? source.doc.context.lookup(info.get(N('UserProperties'))) : undefined;
    if (userProps !== undefined && String(userProps) === 'true') userProperties = true;
  }
  const info = output.context.obj({ Marked: marked });
  if (suspects) info.set(N('Suspects'), output.context.obj(true));
  if (userProperties) info.set(N('UserProperties'), output.context.obj(true));
  output.catalog.set(N('MarkInfo'), info);
}

/**
 * Rebuild the output /StructTreeRoot from every contributing source's
 * surviving tags. Call AFTER all pages are added, with the SAME loaded
 * source instances the builder copied from.
 */
export function carryStructTree(output: PDFDocument, sources: CarriedSourcePages[]): Map<PDFDocument, ObjectMap> {
  const structureMaps = new Map<PDFDocument, ObjectMap>();
  const budget: Budget = {
    objects: 0,
    bytes: 0,
    limitObjects: MAX_OBJECTS,
    limitBytes: MAX_BYTES,
    fail: refuse,
  };
  sweepStaleKeys(output, budget);

  const tagged = sources.filter((s) => s.doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict));
  if (tagged.length === 0) return structureMaps;

  // Analyse every source's names before building anything, so a rename
  // decision sees all of them.
  const analyses = tagged.map((s) => analyseSource(s.doc, budget));
  const renames = decideRenames(analyses, budget);

  const rootDict = PDFDict.withContext(output.context);
  rootDict.set(N('Type'), N('StructTreeRoot'));
  const rootRef = output.context.register(rootDict);
  const roleMap = PDFDict.withContext(output.context);
  const classMap = PDFDict.withContext(output.context);
  const namespaceRefs: PDFRef[] = [];
  // Namespace identity is its NAME, shared across sources.
  const namespacesByName = new Map<string, PDFRef>();
  const namespaceSignatures = new Map<string, string>();
  const topKids: PDFRef[] = [];
  const registrations: Registration[] = [];
  const annotParents: AnnotParent[] = [];
  const idEntries = new Map<string, { ref: PDFRef; raw: PDFString | PDFHexString }>();
  const emittedRefs: PDFRef[] = [];
  const rootExtras = new Map<string, { key: PDFName; value: PDFObject }>();
  const additive = new Map<string, { array: PDFArray; ref: PDFRef; initialized: boolean }>();

  tagged.forEach((source, index) => {
    const srcRoot = source.doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict)!;
    const structureMap: ObjectMap = new Map();
    structureMaps.set(source.doc, structureMap);

    const occurrences = buildOccurrences(source, output, budget);
    const occurrencesByIndex = new Map<number, PageOccurrence[]>();
    for (const occurrence of occurrences) {
      let list = occurrencesByIndex.get(occurrence.srcIndex);
      if (!list) occurrencesByIndex.set(occurrence.srcIndex, (list = []));
      list.push(occurrence);
    }

    const carry: CarrySource = {
      doc: source.doc,
      refTargets: collectRefTargets(source.doc, budget),
      index,
      pageIndexByTag: new Map(source.doc.getPages().map((page, i) => [page.ref.tag, i])),
      occurrencesByIndex,
      forbidden: forbiddenSourceRefs(source.doc, budget),
      renames: renames[index],
      elemRefs: new Map(),
      nsRefs: new Map(),
      payloadRefs: new Map(),
      structureMap,
    };
    // One payload identity map for the whole source: an object shared
    // between a root field, an element field and a namespace field must
    // arrive as ONE output object, not three copies.
    const payloadMap = new Map<string, PDFRef>();
    const ctx: RebuildCtx = {
      output,
      source: carry,
      payloadMap,
      emittedRefs,
      registrations,
      annotParents,
      idEntries,
      budget,
      visited: new Set(),
    };

    // Reserve identities first: /Ref between elements and RoleMapNS between
    // namespaces can point either way, including cyclically.
    reserveElements(ctx);
    const ordered = collectNamespaces(output, carry, budget, namespacesByName, namespaceSignatures);
    carry.payloadRefs = new Map([...carry.elemRefs, ...carry.nsRefs]);
    const sourceRootRef = source.doc.catalog.get(N('StructTreeRoot'));
    if (sourceRootRef instanceof PDFRef) carry.payloadRefs.set(sourceRootRef.tag, rootRef);
    // Root arrays are semantic objects too. Reserve the combined identity
    // before any element/namespace payload can reference a source array.
    for (const name of ['AF', 'PronunciationLexicon']) {
      if (optional(source.doc, srcRoot, name) === undefined) continue;
      if (!(optional(source.doc, srcRoot, name) instanceof PDFArray)) throw refuse();
      let target = additive.get(`/${name}`);
      if (!target) {
        const array = PDFArray.withContext(output.context);
        target = { array, ref: output.context.register(array), initialized: false };
        additive.set(`/${name}`, target);
      }
      const raw = srcRoot.get(N(name));
      if (raw instanceof PDFRef) carry.payloadRefs.set(raw.tag, target.ref);
    }
    for (const ref of ordered) namespaceRefs.push(ref);
    fillNamespaces(output, carry, budget, payloadMap);

    for (const kid of kidsOf(source.doc, srcRoot, budget)) {
      const kidTag = kid instanceof PDFRef ? kid.tag : null;
      const resolved = kid instanceof PDFRef ? source.doc.context.lookup(kid) : kid;
      if (!(resolved instanceof PDFDict)) throw refuse();
      const rebuilt = rebuildElem(ctx, resolved, kidTag, rootRef, null, 0);
      if (rebuilt) topKids.push(rebuilt);
    }

    // Merged maps, keyed by the identities this source's elements now use.
    for (const [key, target] of analyses[index].roleMap) {
      spend(budget);
      roleMap.set(N(localRole(carry, key).slice(1)), N(localRole(carry, target).slice(1)));
    }
    for (const [key, value] of analyses[index].classValues) {
      spend(budget);
      classMap.set(
        N(localClass(carry, key).slice(1)),
        copyPayload(output, source.doc, value, carry.payloadRefs, carry.forbidden, budget, payloadMap),
      );
    }
    // Root auxiliary data and extension fields.
    for (const [key, value] of srcRoot.entries()) {
      if (REBUILT_ROOT_FIELDS.has(key.asString())) continue;
      spendBytes(budget, key.asString().length);
      const resolved = source.doc.context.lookup(value);
      if (resolved === undefined || resolved === PDFNull) continue;
      const name = key.asString();
      if (name === '/AF' || name === '/PronunciationLexicon') {
        if (!(resolved instanceof PDFArray)) throw refuse();
        const target = additive.get(name)!;
        const list = target.array;
        const copiedEntries: PDFObject[] = [];
        for (let i = 0; i < resolved.size(); i++) {
          spend(budget);
          copiedEntries.push(copyPayload(output, source.doc, resolved.get(i), carry.payloadRefs, carry.forbidden, budget, payloadMap));
        }
        // Table 354: associated files are an unordered set of files that
        // belong to the structure tree. Every source's files belong to the
        // combined tree, so they accumulate; order carries no meaning here
        // beyond keeping each source's own sequence readable.
        if (name === '/AF' || !target.initialized) {
          for (const entry of copiedEntries) list.push(entry);
          target.initialized = true;
          continue;
        }
        // Table 354: where two lexicons apply to the same text, the FIRST by
        // array order is used. Concatenating two sources' lexicons therefore
        // changes how the later source's words are pronounced, so it is not
        // preservation and is not done.
        //
        // What can be preserved: one source contributing, or several
        // contributing the same lexicons — identical entries, which after the
        // shared payload map are the same output objects in the same order.
        // Anything else is a precedence this cannot derive from either
        // source, and it refuses rather than inventing one.
        if (list.size() !== copiedEntries.length) throw refuse();
        for (let i = 0; i < list.size(); i++) {
          spend(budget);
          if (!sameValue(output, list.get(i), copiedEntries[i], budget)) throw refuse();
        }
        continue;
      }
      const copied = copyPayload(output, source.doc, value, carry.payloadRefs, carry.forbidden, budget, payloadMap);
      const existing = rootExtras.get(name);
      if (existing === undefined) {
        rootExtras.set(name, { key, value: copied });
        continue;
      }
      // An unknown root entry two sources both wrote is only carried when
      // they wrote the same thing; choosing one silently would publish a
      // document claiming something neither source said.
      if (!sameValue(output, existing.value, copied, budget)) throw refuse();
    }
    for (const ref of payloadMap.values()) {
      spend(budget);
      emittedRefs.push(ref);
    }
  });

  if (topKids.length === 0) {
    output.context.delete(rootRef);
    return structureMaps;
  }

  // ── ParentTree, renumbered in output order ──────────────────────────────
  const byContainer = new Map<string, Registration[]>();
  for (const reg of registrations) {
    spend(budget);
    let list = byContainer.get(reg.containerTag);
    if (!list) byContainer.set(reg.containerTag, (list = []));
    list.push(reg);
  }
  const nums: PDFObject[] = [];
  let nextKey = 0;
  const containerOrder: { tag: string; node: PDFDict }[] = [];
  const orderedContainers = new Set<string>();
  for (const page of output.getPages()) {
    spend(budget);
    if (byContainer.has(page.ref.tag)) {
      containerOrder.push({ tag: page.ref.tag, node: page.node }); orderedContainers.add(page.ref.tag);
    }
  }
  for (const tag of byContainer.keys()) {
    spend(budget);
    if (orderedContainers.has(tag)) continue;
    const container = output.context.lookup(PDFRef.of(...tagParts(tag)));
    // A marked-content container is either a page dictionary or a content
    // stream; a stream keeps its /StructParents in its own dictionary.
    if (container instanceof PDFStream) containerOrder.push({ tag, node: container.dict });
    else throw refuse();
  }
  for (const { tag, node } of containerOrder) {
    const regs = byContainer.get(tag)!;
    const maxMcid = regs.reduce((m, r) => Math.max(m, r.mcid), 0);
    if (maxMcid > MAX_MCID) throw refuse();
    spend(budget, maxMcid + 1);
    const arr: PDFObject[] = new Array<PDFObject>(maxMcid + 1).fill(PDFNull);
    for (const r of regs) {
      const held = arr[r.mcid];
      // A marked-content sequence has ONE parent element. The same element
      // registering the same slot twice is one owner seen twice — a repeated
      // reference — but two different elements claiming it is a contradiction
      // the output cannot state, and picking the last one to arrive would let
      // iteration order decide who owns the content.
      if (held !== PDFNull && held !== r.elem) throw refuse();
      arr[r.mcid] = r.elem;
    }
    nums.push(PDFNumber.of(nextKey), output.context.obj(arr));
    node.set(N('StructParents'), PDFNumber.of(nextKey));
    nextKey++;
  }
  const annotOwners = new Map<string, PDFRef>();
  for (const { annotRef, elem } of annotParents) {
    spend(budget);
    const held = annotOwners.get(annotRef.tag);
    // Same rule for an object reference: one referenced object, one parent.
    if (held !== undefined) {
      if (held !== elem) throw refuse();
      continue;
    }
    // The referenced object has to actually be in the output, and be the kind
    // of object that can carry a structural parent key.
    const target = output.context.lookup(annotRef);
    // Table 358 permits an entire image/Form XObject as well as an
    // annotation. A stream stores its parent key in the stream dictionary.
    const annot = target instanceof PDFStream ? target.dict : target;
    if (!(annot instanceof PDFDict)) throw refuse();
    annotOwners.set(annotRef.tag, elem);
    nums.push(PDFNumber.of(nextKey), elem);
    annot.set(N('StructParent'), PDFNumber.of(nextKey));
    nextKey++;
  }

  // No relationship may point at a reservation nothing was assigned to. A
  // pruned Ref target is retained above, so this is the proof of it.
  for (const ref of emittedRefs) {
    if (output.context.lookup(ref) === undefined) throw refuse();
  }

  rootDict.set(N('K'), topKids.length === 1 ? topKids[0] : output.context.obj(topKids));
  rootDict.set(N('ParentTree'), output.context.obj({ Nums: nums }));
  rootDict.set(N('ParentTreeNextKey'), PDFNumber.of(nextKey));
  if (roleMap.entries().length > 0) rootDict.set(N('RoleMap'), roleMap);
  if (classMap.entries().length > 0) rootDict.set(N('ClassMap'), classMap);
  if (namespaceRefs.length > 0) rootDict.set(N('Namespaces'), output.context.obj(namespaceRefs));
  for (const { key, value } of rootExtras.values()) rootDict.set(key, value);
  // `name` is the qualified spelling, so the leading slash comes off.
  for (const [name, { ref }] of additive) rootDict.set(N(name.slice(1)), ref);
  if (idEntries.size > 0) {
    // The IDTree is rebuilt from the identifiers actually on output elements,
    // sorted so the name tree is ordered.
    const names: PDFObject[] = [];
    // idKey is the byte sequence in hex, so ordering by it orders by bytes.
    const sorted = [...idEntries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, { ref, raw }] of sorted) names.push(raw.clone(), ref);
    rootDict.set(N('IDTree'), output.context.obj({ Names: names }));
  }
  output.catalog.set(N('StructTreeRoot'), rootRef);
  mergeMarkInfo(output, sources);
  return structureMaps;
}

/** Reserve an output reference for every namespace a source declares or
 * reaches through a RoleMapNS edge, and return them in declaration order. */
function collectNamespaces(
  output: PDFDocument,
  source: CarrySource,
  budget: Budget,
  byName: Map<string, PDFRef>,
  signatures: Map<string, string>,
): PDFRef[] {
  const root = source.doc.catalog.lookupMaybe(N('StructTreeRoot'), PDFDict);
  if (!root) return [];
  const order: PDFRef[] = [];
  const pending: PDFObject[] = [];
  const declared = optional(source.doc, root, 'Namespaces');
  if (declared !== undefined && !(declared instanceof PDFArray)) throw refuse();
  if (declared instanceof PDFArray) {
    for (let i = 0, n = declared.size(); i < n; i++) {
      spend(budget);
      pending.push(declared.get(i));
    }
  }
  // An element may name a namespace the root never declared; the output root
  // must still declare it (Table 354 requires Namespaces when any element has
  // a namespace identifier).
  for (const tag of source.elemRefs.keys()) {
    spend(budget);
    const elem = source.doc.context.lookup(PDFRef.of(...tagParts(tag)));
    if (elem instanceof PDFDict) {
      // An indirect null or dangling NS is absence, exactly as for /K.
      if (optional(source.doc, elem, 'NS') !== undefined) pending.push(elem.get(N('NS'), true)!);
    }
  }
  for (let next = 0; next < pending.length; next++) {
    // Charged per queued entry, so the queue cannot grow before its bound.
    spend(budget);
    const raw = pending[next];
    if (!(raw instanceof PDFRef)) throw refuse();
    if (source.nsRefs.has(raw.tag)) continue;
    const dict = source.doc.context.lookup(raw);
    if (!(dict instanceof PDFDict)) throw refuse();
    spend(budget);
    const name = optional(source.doc, dict, 'NS');
    // Table 356: the namespace name is required, and it is the identity.
    if (!isText(name)) throw refuse();
    const key = uriKey(name);
    const signature = namespaceSignature(source, dict, budget);
    const existing = byName.get(key);
    if (existing) {
      // One namespace name, two dictionaries. Sharing them is only sound if
      // they say the same thing; two different meanings under one name would
      // publish a namespace no consumer can resolve unambiguously.
      if (signatures.get(key) !== signature) throw refuse();
      source.nsRefs.set(raw.tag, existing);
    } else {
      const reserved = output.context.nextRef();
      byName.set(key, reserved);
      signatures.set(key, signature);
      source.nsRefs.set(raw.tag, reserved);
      order.push(reserved);
    }
    // The outgoing declarations are walked either way. A coalesced parent
    // still names the namespaces its map targets, and those have to be
    // discovered and validated or an edge points at nothing.
    const roleMapNS = optional(source.doc, dict, 'RoleMapNS');
    if (roleMapNS instanceof PDFDict) {
      for (const [, value] of roleMapNS.entries()) {
        spend(budget);
        const target = source.doc.context.lookup(value);
        if (target instanceof PDFArray) {
          if (target.size() !== 2) throw refuse();
          pending.push(target.get(1));
        }
      }
    }
  }
  return order;
}

/** What a namespace declaration MEANS, independent of object numbers.
 *
 * Its name, every RoleMapNS edge written as the EFFECTIVE target — the
 * default-namespace name after this source's own role rename, or the type
 * plus the NAME of the namespace it belongs to — and every other entry,
 * including Schema, compared by its resolved value rather than by whether it
 * is present. Two declarations with equal signatures say the same thing and
 * may share one output dictionary; anything else is two meanings under one
 * name and refuses.
 *
 * Object numbers never enter the signature, so two unrelated graphs cannot
 * match by spelling and one graph cannot mismatch itself. */
function namespaceSignature(source: CarrySource, dict: PDFDict, budget: Budget): string {
  const doc = source.doc;
  const name = optional(doc, dict, 'NS');
  if (!isText(name)) throw refuse();
  spendBytes(budget, name.asString().length);
  const type = optional(doc, dict, 'Type');
  if (type !== undefined && type !== N('Namespace')) throw refuse();
  const edges: [string, string, string, string?][] = [];
  const roleMapNS = optional(doc, dict, 'RoleMapNS');
  if (roleMapNS !== undefined && !(roleMapNS instanceof PDFDict)) throw refuse();
  if (roleMapNS instanceof PDFDict) {
    for (const [key, value] of roleMapNS.entries()) {
      spend(budget);
      const target = doc.context.lookup(value);
      if (target instanceof PDFName) {
        // A single-name target lands in the default namespace and therefore
        // follows this source's default rename — which is part of what the
        // declaration will MEAN once written.
        edges.push([key.asString(), 'default', localRole(source, target.asString())]);
        continue;
      }
      if (target instanceof PDFArray) {
        if (target.size() !== 2) throw refuse();
        const targetName = doc.context.lookup(target.get(0));
        const targetNs = doc.context.lookup(target.get(1));
        if (!(targetName instanceof PDFName) || !(targetNs instanceof PDFDict)) throw refuse();
        const targetNsName = optional(doc, targetNs, 'NS');
        if (!isText(targetNsName)) throw refuse();
        spendBytes(budget, targetNsName.asString().length);
        edges.push([key.asString(), 'namespace', uriKey(targetNsName), targetName.asString()]);
        continue;
      }
      throw refuse();
    }
  }
  // Every other entry, Schema included, by VALUE. An opaque field two
  // sources wrote differently is two meanings, not one with a detail
  // dropped.
  const extras = PDFDict.withContext(doc.context);
  for (const [key, value] of dict.entries()) {
    const name2 = key.asString();
    if (name2 === '/NS' || name2 === '/RoleMapNS') continue;
    spend(budget);
    if (optional(doc, dict, key.decodeText()) !== undefined) extras.set(key, value);
  }
  edges.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  // Typed arrays, not delimiter-joined user strings. The entire extras graph
  // is traversed together, so sharing across Schema/extension fields matters.
  return JSON.stringify([uriKey(name), edges, valueSignature(doc, extras, budget)]);
}

/** Canonical bounded graph encoding. Each indirect object gets a traversal
 * ordinal, and a repeated edge names THAT ordinal, never a generic cycle
 * marker. Sort dictionaries before walking, not after assigning identities.
 * Serialize once so nested strings cannot grow by repeated JSON escaping. */
function valueSignature(
  doc: PDFDocument,
  value: PDFObject | undefined,
  budget: Budget,
): string {
  const seen = new Map<string, number>();
  const walk = (raw: PDFObject | undefined, depth: number): unknown => {
    spend(budget);
    if (depth > MAX_SIGNATURE_DEPTH) throw refuse();
    if (raw instanceof PDFRef) {
      const target = doc.context.lookup(raw);
      if (target === undefined || target === PDFNull) return ['null'];
      const prior = seen.get(raw.tag);
      if (prior !== undefined) return ['ref', prior];
      const id = seen.size; seen.set(raw.tag, id);
      return ['object', id, walk(target, depth + 1)];
    }
    if (raw === undefined || raw === PDFNull) return ['null'];
    if (raw instanceof PDFName) { spendBytes(budget, raw.asString().length); return ['name', raw.asString()]; }
    if (raw instanceof PDFNumber) {
      if (!Number.isFinite(raw.asNumber())) throw refuse();
      return ['number', raw.asNumber()];
    }
    if (raw instanceof PDFBool) return ['boolean', raw.asBoolean()];
    if (isText(raw)) { spendBytes(budget, raw.asString().length); return ['string', hexOf(raw.asBytes())]; }
    if (raw instanceof PDFRawStream) {
      spendBytes(budget, raw.contents.length);
      return ['stream', hexOf(raw.contents), walk(raw.dict, depth + 1)];
    }
    if (raw instanceof PDFStream) throw refuse();
    if (raw instanceof PDFArray) {
      const entries: unknown[] = [];
      for (let i = 0; i < raw.size(); i++) entries.push(walk(raw.get(i), depth + 1));
      return ['array', entries];
    }
    if (raw instanceof PDFDict) {
      const entries: unknown[] = [];
      for (const [key, child] of raw.entries().sort(([a], [b]) => a.asString() < b.asString() ? -1 : a.asString() > b.asString() ? 1 : 0)) {
        spendBytes(budget, key.asString().length);
        entries.push([key.asString(), walk(child, depth + 1)]);
      }
      return ['dictionary', entries];
    }
    throw refuse();
  };
  return JSON.stringify(walk(value, 0));
}

/** Fill each reserved namespace dictionary: the required namespace name, the
 * schema file specification as data, and RoleMapNS with its cross-namespace
 * edges pointing at the reserved output namespaces. Nothing is fetched. */
function fillNamespaces(output: PDFDocument, source: CarrySource, budget: Budget, payloadMap: Map<string, PDFRef>): void {
  const roleMaps = new Map<string, { dict: PDFDict; ref: PDFRef }>();
  const pin = (raw: PDFObject, carried: PDFObject): PDFObject => {
    if (!(raw instanceof PDFRef)) return carried;
    const known = source.payloadRefs.get(raw.tag);
    if (known) {
      if (!sameValue(output, known, carried, budget)) throw refuse();
      return known;
    }
    const ref = carried instanceof PDFRef ? carried : output.context.register(carried);
    source.payloadRefs.set(raw.tag, ref);
    return ref;
  };
  // Establish every rebuilt role-map identity before any Schema/extension
  // payload is copied. Maps and their indirect values can themselves be shared.
  for (const [srcTag, outRef] of source.nsRefs) {
    spend(budget);
    const dict = source.doc.context.lookup(PDFRef.of(...tagParts(srcTag)), PDFDict);
    const raw = dict.get(N('RoleMapNS'));
    const map = optional(source.doc, dict, 'RoleMapNS');
    if (map === undefined) continue;
    if (!(map instanceof PDFDict) || raw === undefined) throw refuse();
    let target = roleMaps.get(outRef.tag);
    if (!target) {
      const existing = output.context.lookup(outRef);
      const priorRaw = existing instanceof PDFDict ? existing.get(N('RoleMapNS')) : undefined;
      const prior = output.context.lookup(priorRaw);
      if (prior !== undefined && !(prior instanceof PDFDict)) throw refuse();
      const targetDict = prior ?? PDFDict.withContext(output.context);
      const ref = priorRaw instanceof PDFRef ? priorRaw : output.context.register(targetDict);
      target = { dict: targetDict, ref };
      roleMaps.set(outRef.tag, target);
      if (existing instanceof PDFDict) existing.set(N('RoleMapNS'), ref);
    }
    if (raw instanceof PDFRef) source.payloadRefs.set(raw.tag, target.ref);
    for (const [key, value] of map.entries()) {
      spend(budget);
      const resolved = source.doc.context.lookup(value);
      let mapped = target.dict.get(key);
      if (resolved instanceof PDFName) {
        mapped ??= N(localRole(source, resolved.asString()).slice(1));
      } else if (resolved instanceof PDFArray) {
        if (resolved.size() !== 2) throw refuse();
        const name = source.doc.context.lookup(resolved.get(0));
        const ns = resolved.get(1);
        if (!(name instanceof PDFName) || !(ns instanceof PDFRef)) throw refuse();
        const nsRef = source.nsRefs.get(ns.tag);
        if (!nsRef) throw refuse();
        mapped ??= output.context.obj([name.clone(), nsRef]);
        const pair = output.context.lookup(mapped);
        if (!(pair instanceof PDFArray)) throw refuse();
        pair.set(0, pin(resolved.get(0), pair.get(0)));
      } else throw refuse();
      target.dict.set(key, pin(value, mapped));
    }
  }
  for (const [srcTag, outRef] of source.nsRefs) {
    spend(budget);
    const dict = source.doc.context.lookup(PDFRef.of(...tagParts(srcTag)));
    if (!(dict instanceof PDFDict)) throw refuse();
    const existing = output.context.lookup(outRef);
    if (existing !== undefined) {
      if (!(existing instanceof PDFDict)) throw refuse();
      // The compatibility proof covers all these fields together. Bind their
      // source identities to the already-carried graph before element/class
      // payloads use them, or coalescing forks a source's shared Schema/extras.
      for (const [key, raw] of dict.entries()) {
        if (['/Type', '/NS', '/RoleMapNS'].includes(key.asString())) continue;
        bindCoalescedPayload(output, source, raw, existing.get(key), budget, payloadMap);
      }
      continue;
    }
    const out = PDFDict.withContext(output.context);
    const type = source.doc.context.lookup(dict.get(N('Type')));
    if (type instanceof PDFName) out.set(N('Type'), type.clone());
    const name = source.doc.context.lookup(dict.get(N('NS')));
    // Table 356: the namespace name is required.
    if (!isText(name)) throw refuse();
    spendBytes(budget, name.asString().length);
    out.set(N('NS'), name.clone());
    if (optional(source.doc, dict, 'Schema') !== undefined) {
      out.set(
        N('Schema'),
        copyPayload(output, source.doc, dict.get(N('Schema'), true)!, source.payloadRefs, source.forbidden, budget, payloadMap),
      );
    }
    const roleMap = roleMaps.get(outRef.tag);
    if (roleMap) out.set(N('RoleMapNS'), roleMap.ref);
    for (const [key, value] of dict.entries()) {
      if (['/Type', '/NS', '/Schema', '/RoleMapNS'].includes(key.asString())) continue;
      spendBytes(budget, key.asString().length);
      const resolved = source.doc.context.lookup(value);
      if (resolved === undefined || resolved === PDFNull) continue;
      out.set(key, copyPayload(output, source.doc, value, source.payloadRefs, source.forbidden, budget, payloadMap));
    }
    output.context.assign(outRef, out);
  }
}

function bindCoalescedPayload(output: PDFDocument, source: CarrySource, raw: PDFObject | undefined,
  carried: PDFObject | undefined, budget: Budget, payloadMap: Map<string, PDFRef>, depth = 0): void {
  spend(budget);
  if (depth > MAX_SIGNATURE_DEPTH) throw refuse();
  let left = source.doc.context.lookup(raw), right = output.context.lookup(carried);
  if (left === undefined || left === PDFNull) {
    if (right !== undefined && right !== PDFNull) throw refuse();
    return;
  }
  if (raw instanceof PDFRef) {
    if (!(carried instanceof PDFRef)) throw refuse();
    const prior = source.payloadRefs.get(raw.tag) ?? payloadMap.get(raw.tag);
    if (prior !== undefined) { if (prior !== carried) throw refuse(); return; }
    payloadMap.set(raw.tag, carried);
  }
  if (left instanceof PDFStream && right instanceof PDFStream) { left = left.dict; right = right.dict; }
  if (left instanceof PDFDict && right instanceof PDFDict) {
    for (const [key, value] of left.entries()) bindCoalescedPayload(output, source, value, right.get(key), budget, payloadMap, depth + 1);
  } else if (left instanceof PDFArray && right instanceof PDFArray) {
    if (left.size() !== right.size()) throw refuse();
    for (let i = 0; i < left.size(); i++) bindCoalescedPayload(output, source, left.get(i), right.get(i), budget, payloadMap, depth + 1);
  }
}

/** Whether two already-copied output values say the same thing. Identity
 * covers a shared object; otherwise the two graphs are compared structurally,
 * because two sources can write one meaning as two objects. Object numbers
 * never enter the comparison. */
function sameValue(output: PDFDocument, a: PDFObject, b: PDFObject, budget: Budget): boolean {
  if (a === b) return true;
  return (
    valueSignature(output, a, budget) === valueSignature(output, b, budget)
  );
}

/** "obj gen R"-style tag back to its numbers — PDFRef.tag is `${obj} ${gen} R`. */
function tagParts(tag: string): [number, number] {
  const [obj, gen] = tag.split(' ');
  return [Number(obj), Number(gen)];
}
