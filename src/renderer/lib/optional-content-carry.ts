// Carries optional content (layers) through the from-scratch rebuild.
//
// A layer is not a property of a page: the marked-content operators inside a
// copied content stream name a group by resource name, and what that group
// MEANS — whether it starts visible, which alternate presentations exist,
// which usage events drive it — lives in the catalog's /OCProperties. Copy the
// pages without it and every layered document loses its layers; copy it
// carelessly and a donor page the donor had hidden becomes visible.
//
// Three things this module does that the shape of the problem forces:
//
//   1. REACH THE REAL GROUPS. A group is reached through the copied page
//      graph — resource /Properties, an XObject's own /OC, an annotation's
//      /OC, appearance streams, and Form streams nested inside Form streams.
//      Those are STREAMS with dictionaries, at arbitrary depth. A group is
//      mapped to the object the page copy actually references; it is never
//      re-copied into a catalog clone nothing renders.
//
//   2. COMPOSE THE DEFAULT STATE, NEVER PICK ONE. Each source's default
//      configuration decides its own groups' initial visibility, and
//      ISO 32000-2 Table 99 requires a default configuration's /BaseState to
//      be ON. So every source's effective per-group state is recomputed and
//      expressed as an explicit /OFF list under an ON base: a source whose
//      base was OFF keeps its groups off, and the owner's base never silently
//      turns a donor's hidden layer on. A single layer-owning source needs
//      no composition and keeps its original declarations after validation.
//
//   3. KEEP EVERY ALTERNATE, WITHOUT MULTIPLYING THEM. Each source alternate
//      becomes one output alternate that applies that source's alternate to
//      its own groups while holding every other source at its default — one
//      output configuration per source configuration, never a product.
//
// What cannot be represented refuses with the shared catalog-preservation
// message rather than publishing a document that misstates its own layers.
// Nothing here runs an action, resolves a URI or decodes a payload.
//
// This function returns what it composed and NEVER writes the output catalog;
// where /OCProperties belongs is the caller's decision.

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
import type { CarriedSourcePages } from './catalog-carry';

const N = PDFName.of.bind(PDFName);

// Bounds, not predictions. Discovery, mapping, validation and copying all
// spend from one pair of counters; no phase runs unbounded ahead of another.
const MAX_OBJECTS = 200_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 64;

/** Table 96: an optional content group. */
const OCG_TYPE = '/OCG';
/** Table 97: an optional content membership dictionary. */
const OCMD_TYPE = '/OCMD';

/** Table 99 /BaseState. */
const BASE_ON = '/ON';
const BASE_OFF = '/OFF';
const BASE_UNCHANGED = '/Unchanged';

/** Table 97 /P visibility policies. */
const POLICIES = new Set(['/AllOn', '/AnyOn', '/AnyOff', '/AllOff']);

/** Visibility-expression operators, 8.11.2.2. */
const VE_OPERATORS = new Set(['/And', '/Or', '/Not']);

/** Table 101 /Event values. */
const EVENTS = new Set(['/View', '/Print', '/Export']);

/** Configuration entries this module recomposes rather than copies. */
const REBUILT_CONFIG_KEYS = new Set(['/BaseState', '/ON', '/OFF', '/Order', '/AS', '/RBGroups', '/Locked']);

/** Dictionary types that are a document graph, never layer payload. */
const FORBIDDEN_TYPES = new Set([
  '/Catalog', '/Page', '/Pages', '/StructTreeRoot', '/StructElem', '/OBJR', '/MCR', '/Annot', '/Action',
]);

/** Standard action subtypes, Table 201. An action's /Type is optional and its
 * /S required, so the subtype identifies one that left its type out. */
const ACTION_TYPES = new Set([
  '/GoTo', '/GoToR', '/GoToE', '/GoToDp', '/Launch', '/Thread', '/URI', '/Sound', '/Movie',
  '/Hide', '/Named', '/SubmitForm', '/ResetForm', '/ImportData', '/SetOCGState', '/Rendition',
  '/Trans', '/GoTo3DView', '/JavaScript', '/RichMediaExecute',
]);

const refuse = (): Error => new Error(tChrome('app.operation.unverified'));

interface Budget {
  objects: number;
  bytes: number;
}

function spend(budget: Budget, count = 1): void {
  budget.objects += count;
  if (budget.objects > MAX_OBJECTS) throw refuse();
}

function spendBytes(budget: Budget, count: number): void {
  budget.bytes += count;
  if (budget.bytes > MAX_BYTES) throw refuse();
}

const isText = (v: PDFObject | undefined): v is PDFString | PDFHexString =>
  v instanceof PDFString || v instanceof PDFHexString;

/** An optional entry's effective value. Absent, direct null, indirect null
 * and a reference to a nonexistent object are all absence (7.3.9); anything
 * else comes back resolved so the caller judges its shape. */
function optional(doc: PDFDocument, dict: PDFDict, key: string): PDFObject | undefined {
  const raw = dict.get(N(key), true);
  if (raw === undefined) return undefined;
  const value = doc.context.lookup(raw);
  return value === undefined || value === PDFNull ? undefined : value;
}

/** What the carrier produced. */
export interface OptionalContentCarry {
  /** The composed optional content properties dictionary, already built in
   * the OUTPUT context and ready to install as the catalog's /OCProperties.
   * Undefined when no contributing source had any optional content. The
   * catalog is deliberately not written here. */
  properties: PDFDict | undefined;
  /** Per source document: source group/membership reference to its actual
   * output identity. Copies of one source layer are rebound to that one
   * identity: separate radio-group members would change future state edits.
   * Registry-only groups are included. */
  identities: Map<PDFDocument, Map<string, PDFRef[]>>;
  /** How many registered groups no kept page renders. Those groups are
   * preserved, because a document's layer configuration is part of what it
   * says about itself; this reports how many were kept for that alone. */
  registryOnly: number;
}

/** One kept page of one source, paired with the copy made for it. */
interface Occurrence {
  srcIndex: number;
  outPageRef: PDFRef;
  /** Source object tag → the object THIS copy of the page references. */
  objMap: Map<string, PDFRef>;
}

/** A source's optional content, read and validated before anything is built. */
interface SourceContent {
  doc: PDFDocument;
  /** The source's own properties root, so its unknown fields travel. */
  properties: PDFDict;
  /** Every registered group, in registry order, with its output objects. */
  groups: { srcTag: string; outRefs: PDFRef[] }[];
  byTag: Map<string, PDFRef[]>;
  /** Source tag → the ONE output object for it, when unambiguous. An opaque
   * reference to a pinned object points AT it instead of cloning it. */
  pinned: Map<string, PDFRef>;
  /** Provisional duplicate page-copy identities. Coalescing clears these
   * before any opaque reference is copied or any caller receives the map. */
  ambiguous: Set<string>;
  /** One identity map for every payload this source contributes. */
  payloadMap: Map<string, PDFRef>;
  /** A resolved object back to the tag it is stored under, so a semantic
   * object can be pinned by identity rather than by guessing its key. */
  refOf: Map<PDFObject, string>;
  /** Registered groups no kept page renders, not yet materialized. */
  registryOnlyTags: string[];
  /** Every optional-content dictionary the pages render — groups AND
   * membership dictionaries — mapped to all of its output occurrences. This
   * is what lets a caller bind an action or an opaque edge to the actual
   * object rather than guessing. */
  occurrenceRefs: Map<string, PDFRef[]>;
  /** Source tags whose default state is OFF. */
  defaultOff: Set<string>;
  defaultConfig: PDFDict;
  configs: PDFDict[];
}

/**
 * Compose the output's optional content from every contributing source.
 *
 * `sources` are the SAME loaded instances the builder copied pages from,
 * paired with the actual output pages. `ownSource` names the document that
 * owns the rebuild; pass it when the own document contributes no surviving
 * page, so its layer configuration still travels.
 *
 * Returns the composed dictionary and the source-to-output group identities.
 * It installs nothing: the caller decides where the result belongs.
 */
export function carryOptionalContent(
  output: PDFDocument,
  sources: CarriedSourcePages[],
  ownSource?: CarriedSourcePages,
): OptionalContentCarry {
  const budget: Budget = { objects: 0, bytes: 0 };
  const identities = new Map<PDFDocument, Map<string, PDFRef[]>>();

  // The own document contributes its configuration even with no page kept.
  const contributing: CarriedSourcePages[] = [...sources];
  if (ownSource && !contributing.some((s) => s.doc === ownSource.doc)) contributing.push(ownSource);

  // PASS ONE: read every source's registry and configurations. Nothing is
  // copied yet, because an extension alias naming the root, the default
  // configuration, an alternate or the registry array has to reach the OBJECT
  // this rebuild will publish — and those do not exist until they are
  // reserved.
  const read: SourceContent[] = [];
  for (const source of contributing) {
    spend(budget);
    const properties = optional(source.doc, source.doc.catalog, 'OCProperties');
    const occurrences = mapOccurrences(source, output, budget);
    const referenced = referencedOptionalContent(source, budget);
    if (properties === undefined) {
      // 8.11.4.2: a document with optional content shall have this
      // dictionary. Pages that render groups without one leave the carrier
      // with nothing to prove their configuration from, and skipping the
      // source would turn that missing proof into a success.
      if (referenced.byTag.size > 0 || referenced.direct.length > 0) throw refuse();
      continue;
    }
    // Table 98: present means a properties dictionary.
    if (!(properties instanceof PDFDict)) throw refuse();
    read.push(readSource(output, source, properties, occurrences, referenced, budget));
  }
  if (read.length === 0) return { properties: undefined, identities, registryOnly: 0 };
  coalesceCopiedLayers(output, read, budget);

  // PASS TWO: reserve the objects this rebuild will publish, and bind each
  // source's corresponding object to them. An alias to a source's own root,
  // default configuration, alternate or registry array then resolves to the
  // real recomposed one instead of an unconnected copy of it.
  const rootRef = output.context.nextRef();
  const registryRef = output.context.nextRef();
  const defaultRef = output.context.nextRef();
  const alternates: { source: SourceContent; config: PDFDict; ref: PDFRef }[] = [];
  for (const source of read) {
    for (const config of source.configs) {
      spend(budget);
      alternates.push({ source, config, ref: output.context.nextRef() });
    }
  }
  const configsRef = alternates.length > 0 ? output.context.nextRef() : undefined;
  const defaultArrays = reserveConfigArrays(output, budget);
  const alternateArrays = alternates.map(() => reserveConfigArrays(output, budget));

  for (const source of read) {
    const doc = source.doc;
    pinSemantic(doc, source, source.properties, rootRef);
    pinSemantic(doc, source, optional(doc, source.properties, 'OCGs'), registryRef);
    pinSemantic(doc, source, source.defaultConfig, defaultRef);
    if (configsRef) pinSemantic(doc, source, optional(doc, source.properties, 'Configs'), configsRef);
    pinConfigArrays(source, source.defaultConfig, defaultArrays, budget, read, [defaultArrays, ...alternateArrays]);
    alternates.forEach((alternate, index) => {
      if (alternate.source !== source) return;
      pinSemantic(doc, source, alternate.config, alternate.ref);
      pinConfigArrays(source, alternate.config, alternateArrays[index], budget, read, [defaultArrays, ...alternateArrays]);
    });
  }

  // PASS THREE: registry-only groups, now that every semantic pin is in place.
  let registryOnly = 0;
  for (const source of read) {
    registryOnly += fillRegistryOnly(output, source, budget);
    // Groups first, then every rendered dictionary — which adds the
    // membership dictionaries and keeps each group's occurrence list.
    const mapped = new Map<string, PDFRef[]>(source.groups.map((g) => [g.srcTag, g.outRefs]));
    for (const [srcTag, refs] of source.occurrenceRefs) mapped.set(srcTag, refs);
    identities.set(source.doc, mapped);
  }

  const properties = compose(output, read, budget, {
    rootRef, registryRef, defaultRef, configsRef, alternates, defaultArrays, alternateArrays,
  });
  // Composition proves every configuration first. With only one layer-owning
  // source there is nothing to combine: retain its exact declarations and
  // graph sharing, not merely equivalent visibility. In particular, adding
  // inherited defaults or changing OFF to ON makes a signed page edit look
  // like an unrelated catalog change to the incremental writer.
  if (read.length === 1) {
    return { properties: preserveSingleSource(output, read[0], rootRef, budget), identities, registryOnly };
  }
  return { properties, identities, registryOnly };
}

function preserveSingleSource(output: PDFDocument, source: SourceContent, rootRef: PDFRef, budget: Budget): PDFDict {
  const pins = new Map<string, PDFRef>();
  for (const [tag, refs] of source.occurrenceRefs) {
    if (refs.length !== 1) throw refuse();
    pins.set(tag, refs[0]);
  }
  const sourceRoot = source.doc.catalog.get(N('OCProperties'));
  if (sourceRoot instanceof PDFRef) pins.set(sourceRoot.tag, rootRef);
  const copied = new Map<string, PDFRef>();
  const ambiguous = new Set<string>();
  const properties = copyPayload(output, source.doc, source.properties, pins, ambiguous, copied, budget, 0);
  if (!(properties instanceof PDFDict)) throw refuse();
  output.context.assign(rootRef, properties);
  // Page copies already point at these canonical identities. Refresh their
  // payloads through the SAME map so a private edge back into a configuration
  // reaches the retained configuration, not the discarded composition.
  for (const [tag, refs] of source.occurrenceRefs) {
    const original = source.doc.context.lookup(PDFRef.of(...tagParts(tag)));
    if (!(original instanceof PDFDict)) throw refuse();
    const value = copyPayload(output, source.doc, original, pins, ambiguous, copied, budget, 0);
    if (!(value instanceof PDFDict)) throw refuse();
    output.context.assign(refs[0], value);
  }
  return properties;
}

/** copyPages has one identity cache per invocation, not per source document.
 * A repeated page can therefore clone an OCG that the source declared once.
 * Merely putting both clones into OFF/ON is insufficient: radio relationships
 * and later layer actions then treat those clones as different logical layers.
 * Rebind every output edge before configuration/payload assembly instead.
 * Distinct source dictionaries, even byte-identical ones, never coalesce. */
function coalesceCopiedLayers(output: PDFDocument, sources: SourceContent[], budget: Budget): void {
  const replacements = new Map<string, PDFRef>();
  for (const source of sources) {
    for (const [tag, refs] of source.occurrenceRefs) {
      spend(budget);
      if (refs.length === 0) throw refuse();
      const canonical = refs[0];
      for (const ref of refs.slice(1)) { spend(budget); replacements.set(ref.tag, canonical); }
      source.occurrenceRefs.set(tag, [canonical]);
      source.pinned.set(tag, canonical); source.ambiguous.delete(tag);
      if (source.byTag.has(tag)) source.byTag.set(tag, [canonical]);
    }
    for (const group of source.groups) {
      spend(budget);
      const refs = source.occurrenceRefs.get(group.srcTag);
      if (refs) group.outRefs = refs;
    }
  }
  if (replacements.size === 0) return;
  const seen = new Set<PDFObject>();
  const rewrite = (value: PDFObject, depth = 0): PDFObject => {
    spend(budget); if (depth > MAX_DEPTH) throw refuse();
    if (value instanceof PDFRef) return replacements.get(value.tag) ?? value;
    if (seen.has(value)) return value; seen.add(value);
    if (value instanceof PDFStream) rewrite(value.dict, depth + 1);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) value.set(key, rewrite(child, depth + 1));
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) value.set(i, rewrite(value.get(i), depth + 1));
    }
    return value;
  };
  // Each indirect object is visited once; reference edges are replaced, never
  // traversed. Thus page backpointers and valid indirect cycles terminate.
  for (const [ref, object] of output.context.enumerateIndirectObjects()) {
    output.context.assign(ref, rewrite(object));
  }
}

/** Bind a source object to the output object that will replace it. Only an
 * INDIRECT source object has an identity an alias can name. */
function pinSemantic(
  doc: PDFDocument,
  source: SourceContent,
  value: PDFObject | undefined,
  outRef: PDFRef,
): void {
  void doc;
  if (value === undefined) return;
  const ref = source.refOf.get(value);
  if (!ref) return;
  const held = source.pinned.get(ref);
  if (held === undefined) {
    source.pinned.set(ref, outRef);
    return;
  }
  // The same source object occupying two roles is fine when both roles
  // become the same output object; when they become different ones, one
  // object cannot be both and choosing would make an alias point at a role
  // its source never gave it.
  if (held !== outRef) throw refuse();
}

/** The semantic arrays of a configuration (Table 99). Each gets its own
 * reserved output object, so an alias naming a source's state array reaches
 * the rebuilt one rather than a detached copy of the old contents. */
const CONFIG_ARRAY_KEYS = ['ON', 'OFF', 'Order', 'AS', 'RBGroups', 'Locked'] as const;

type ConfigArrays = Record<(typeof CONFIG_ARRAY_KEYS)[number], PDFRef>;

function reserveConfigArrays(output: PDFDocument, budget: Budget): ConfigArrays {
  const reserved = {} as ConfigArrays;
  for (const key of CONFIG_ARRAY_KEYS) {
    spend(budget);
    reserved[key] = output.context.nextRef();
  }
  return reserved;
}

/** Bind the arrays a configuration EXPLICITLY wrote. An inherited value is
 * not pinned: the configuration did not name that object, and pinning it
 * would collide with the configuration it was inherited from. */
function pinConfigArrays(
  source: SourceContent,
  config: PDFDict,
  reserved: ConfigArrays,
  budget: Budget,
  sources: SourceContent[],
  allArrays: ConfigArrays[],
): void {
  for (const key of CONFIG_ARRAY_KEYS) {
    spend(budget);
    const raw = config.get(N(key), true);
    if (raw === undefined) continue;
    const value = source.doc.context.lookup(raw);
    const tag = value && source.refOf.get(value), held = tag && source.pinned.get(tag);
    if (held && held !== reserved[key]) {
      // An array can genuinely fill two roles (for example identical OFF
      // lists in default/alternate configurations). Reserve one identity;
      // publication below proves both roles produce the same actual array.
      // Lowest allocated reference keeps earlier registry identities stable.
      const other = reserved[key];
      const canonical = held.objectNumber < other.objectNumber ? held : other;
      const replaced = canonical === held ? other : held;
      for (const s of sources) for (const [name, ref] of s.pinned) {
        spend(budget); if (ref === replaced) s.pinned.set(name, canonical);
      }
      for (const arrays of allArrays) for (const field of CONFIG_ARRAY_KEYS) {
        spend(budget); if (arrays[field] === replaced) arrays[field] = canonical;
      }
    }
    pinSemantic(source.doc, source, source.doc.context.lookup(raw), reserved[key]);
  }
}

// ── reaching the real groups ───────────────────────────────────────────────

/** Walk a source page and its copy in step, recording what each source object
 * became FOR THIS OCCURRENCE. copyPages preserves shape, so the graphs pair
 * node for node. Streams are followed through their dictionaries, which is
 * where a Form XObject keeps the resources that name its groups. */
function mapOccurrences(source: CarriedSourcePages, output: PDFDocument, budget: Budget): Occurrence[] {
  const occurrences: Occurrence[] = [];
  source.pairs.forEach(({ srcIndex, outPage }) => {
    spend(budget);
    const srcPage = source.doc.getPage(srcIndex);
    const objMap = new Map<string, PDFRef>();
    // A fresh visited set per occurrence: the same source object becomes a
    // DIFFERENT output object in each copy of the page.
    const seen = new Set<string>();
    for (const key of ['Resources', 'Annots', 'Contents'] as const) {
      pair(srcPage.node.get(N(key), true), outPage.node.get(N(key), true), source.doc, output, objMap, seen, 0, budget);
    }
    occurrences.push({ srcIndex, outPageRef: outPage.ref, objMap });
  });
  return occurrences;
}

function pair(
  srcValue: PDFObject | undefined,
  outValue: PDFObject | undefined,
  source: PDFDocument,
  output: PDFDocument,
  map: Map<string, PDFRef>,
  seen: Set<string>,
  depth: number,
  budget: Budget,
): void {
  // Every traversed edge is charged, new or repeated, direct or indirect.
  spend(budget);
  // A cutoff is not permission to leave a group unreachable: an unprovable
  // graph refuses rather than quietly losing the layer it holds.
  if (depth > MAX_DEPTH) throw refuse();
  let src = srcValue;
  let out = outValue;
  if (src instanceof PDFRef) {
    if (!(out instanceof PDFRef)) return;
    if (seen.has(src.tag)) return;
    seen.add(src.tag);
    map.set(src.tag, out);
    src = source.context.lookup(src);
    out = output.context.lookup(out);
  }
  if (src instanceof PDFStream && out instanceof PDFStream) {
    src = src.dict;
    out = out.dict;
  }
  if (src instanceof PDFDict && out instanceof PDFDict) {
    for (const [key, value] of src.entries()) {
      // /Parent and /P climb out of the page; following them would walk the
      // whole document. (/P here is a page backpointer, never a policy name:
      // an OCMD's /P is a name, which this never descends into.)
      if (key === N('Parent') || key === N('P')) continue;
      pair(value, out.get(key, true), source, output, map, seen, depth + 1, budget);
    }
    return;
  }
  if (src instanceof PDFArray && out instanceof PDFArray) {
    if (src.size() !== out.size()) return;
    for (let i = 0, n = src.size(); i < n; i++) {
      pair(src.get(i), out.get(i), source, output, map, seen, depth + 1, budget);
    }
  }
}

/** Every optional content dictionary the kept pages actually reference:
 * resource /Properties values, an XObject's own /OC, an annotation's /OC, and
 * the same through appearance and Form streams at depth.
 *
 * Both forms are collected. An INDIRECT one is recorded by tag, which is what
 * can be mapped to a copied object; a DIRECT one has no identity to map but is
 * still a real dictionary whose shape has to hold. */
interface Referenced {
  byTag: Map<string, PDFDict>;
  direct: PDFDict[];
}

function referencedOptionalContent(
  source: CarriedSourcePages,
  budget: Budget,
): Referenced {
  const doc = source.doc;
  const found: Referenced = { byTag: new Map(), direct: [] };
  const seen = new Set<string>();

  /** `strict` is for an /OC edge, whose value SHALL be a group or a
   * membership dictionary (8.11.3.3). A /Properties entry is a generic
   * marked-content property list (14.6.2) — a plain language or replacement-
   * text dictionary is perfectly legitimate there — so only an entry that
   * says it is a group or a membership dictionary is optional content. */
  const record = (raw: PDFObject | undefined, strict: boolean): void => {
    spend(budget);
    const resolved = doc.context.lookup(raw);
    if (resolved === undefined || resolved === PDFNull) return;
    if (!(resolved instanceof PDFDict)) {
      if (strict) throw refuse();
      return;
    }
    const type = optional(doc, resolved, 'Type');
    const named = type instanceof PDFName ? type.asString() : undefined;
    const isOptionalContent = named === OCG_TYPE || named === OCMD_TYPE;
    if (!isOptionalContent) {
      // An /OC edge that names neither cannot be honoured; an ordinary
      // property list simply is not optional content.
      if (strict) throw refuse();
      return;
    }
    if (raw instanceof PDFRef) found.byTag.set(raw.tag, resolved);
    else found.direct.push(resolved);
  };

  const walk = (raw: PDFObject | undefined, depth: number): void => {
    spend(budget);
    // A cutoff cannot silently leave part of the page unexamined: an
    // unprovable resource graph refuses.
    if (depth > MAX_DEPTH) throw refuse();
    if (raw instanceof PDFRef) {
      if (seen.has(raw.tag)) return;
      seen.add(raw.tag);
    }
    let value = doc.context.lookup(raw);
    if (value instanceof PDFStream) {
      // A stream can carry its own /OC and its own resources.
      record(value.dict.get(N('OC'), true), true);
      value = value.dict;
    }
    if (value instanceof PDFDict) {
      const properties = optional(doc, value, 'Properties');
      if (properties instanceof PDFDict) {
        for (const [, entry] of properties.entries()) record(entry, false);
      }
      for (const [key, entry] of value.entries()) {
        const name = key.asString();
        if (name === '/Parent' || name === '/P' || name === '/Properties') continue;
        if (name === '/OC') {
          record(entry, true);
          continue;
        }
        walk(entry, depth + 1);
      }
      return;
    }
    if (value instanceof PDFArray) {
      for (let i = 0, n = value.size(); i < n; i++) walk(value.get(i), depth + 1);
    }
  };

  for (const { srcIndex } of source.pairs) {
    const page = doc.getPage(srcIndex);
    for (const key of ['Resources', 'Annots', 'Contents'] as const) {
      walk(page.node.get(N(key), true), 0);
    }
  }
  return found;
}

// ── reading one source ─────────────────────────────────────────────────────

function readSource(
  output: PDFDocument,
  source: CarriedSourcePages,
  properties: PDFDict,
  occurrences: Occurrence[],
  referenced: Referenced,
  budget: Budget,
): SourceContent {
  const doc = source.doc;
  const registry = optional(doc, properties, 'OCGs');
  // Table 98: /OCGs is required and lists every group in the document.
  if (!(registry instanceof PDFArray)) throw refuse();

  // ONE identity map for this whole source, so an object shared between a
  // root field, a configuration field, a usage extra and a registry-only
  // group arrives as ONE output object.
  const payloadMap = new Map<string, PDFRef>();
  const pinned = new Map<string, PDFRef>();
  const ambiguous = new Set<string>();

  // Rendered dictionaries are pinned to the object the page copy made, so
  // nothing downstream can clone a group the pages already reference.
  const occurrenceRefs = new Map<string, PDFRef[]>();
  for (const [srcTag] of referenced.byTag) {
    spend(budget);
    const outRefs = outputsFor(srcTag, occurrences, budget);
    occurrenceRefs.set(srcTag, outRefs);
    // The page IS in the output, so its optional-content dictionary is too.
    // Failing to pair one is a correspondence this cannot prove — never
    // evidence that the group is unused.
    if (outRefs.length === 0) throw refuse();
    if (outRefs.length === 1) pinned.set(srcTag, outRefs[0]);
    else ambiguous.add(srcTag);
  }

  const groups: { srcTag: string; outRefs: PDFRef[] }[] = [];
  const byTag = new Map<string, PDFRef[]>();
  const registryOnlyTags: string[] = [];
  for (let i = 0, n = registry.size(); i < n; i++) {
    spend(budget);
    const entry = registry.get(i);
    const resolved = doc.context.lookup(entry);
    // Null and dangling registry entries are absence, not a group.
    if (resolved === undefined || resolved === PDFNull) continue;
    if (!(entry instanceof PDFRef)) throw refuse();
    if (!(resolved instanceof PDFDict)) throw refuse();
    requireType(doc, resolved, OCG_TYPE);
    if (byTag.has(entry.tag)) continue;
    const outRefs = outputsFor(entry.tag, occurrences, budget);
    if (outRefs.length === 0) {
      // Registry-only is decided by whether the PAGES reference it, counted
      // before any reference is filled in.
      if (referenced.byTag.has(entry.tag)) throw refuse();
      registryOnlyTags.push(entry.tag);
    } else if (outRefs.length === 1) {
      pinned.set(entry.tag, outRefs[0]);
    } else {
      ambiguous.add(entry.tag);
    }
    byTag.set(entry.tag, outRefs);
    groups.push({ srcTag: entry.tag, outRefs });
  }

  // A rendered group the registry never declared cannot be configured, and
  // Table 98 requires every group in the document to be listed.
  for (const [srcTag, dict] of referenced.byTag) {
    spend(budget);
    const type = optional(doc, dict, 'Type');
    // Classification already proved this is one of the two kinds.
    if (!(type instanceof PDFName)) throw refuse();
    if (type.asString() === OCG_TYPE && !byTag.has(srcTag)) throw refuse();
  }

  const defaultConfig = optional(doc, properties, 'D');
  // Table 98: /D is required.
  if (!(defaultConfig instanceof PDFDict)) throw refuse();
  const defaultOff = effectiveOff(doc, defaultConfig, groups, byTag, budget, true).off;

  const configsRaw = optional(doc, properties, 'Configs');
  const configs: PDFDict[] = [];
  if (configsRaw !== undefined) {
    if (!(configsRaw instanceof PDFArray)) throw refuse();
    for (let i = 0, n = configsRaw.size(); i < n; i++) {
      spend(budget);
      const config = doc.context.lookup(configsRaw.get(i));
      if (config === undefined || config === PDFNull) continue;
      if (!(config instanceof PDFDict)) throw refuse();
      configs.push(config);
    }
  }
  // Every membership dictionary the pages use, indirect and direct alike.
  for (const dict of [...referenced.byTag.values(), ...referenced.direct]) {
    validateMembership(doc, dict, byTag, budget);
  }
  // Which indirect objects the semantic pins will name.
  const refOf = new Map<PDFObject, string>();
  const index = (raw: PDFObject | undefined) => {
    if (!(raw instanceof PDFRef)) return;
    spend(budget);
    const resolved = doc.context.lookup(raw);
    if (resolved !== undefined && resolved !== PDFNull) refOf.set(resolved, raw.tag);
  };
  index(doc.catalog.get(N('OCProperties'), true));
  index(properties.get(N('OCGs'), true));
  index(properties.get(N('D'), true));
  index(properties.get(N('Configs'), true));
  const configsArray = optional(doc, properties, 'Configs');
  if (configsArray instanceof PDFArray) {
    for (let i = 0, n = configsArray.size(); i < n; i++) index(configsArray.get(i));
  }
  // Every configuration's semantic arrays, so an alias to one of them can be
  // bound to the array this rebuild will actually publish.
  for (const config of [defaultConfig, ...configs]) {
    for (const key of CONFIG_ARRAY_KEYS) index(config.get(N(key), true));
  }

  return {
    doc, properties, groups, byTag, pinned, ambiguous, payloadMap,
    refOf, registryOnlyTags, occurrenceRefs, defaultOff, defaultConfig, configs,
  };
}

/** Materialize the groups no kept page renders. Runs after every semantic pin
 * exists, so a payload naming the root or a configuration reaches the real
 * one. A document's layer list is part of what it says about itself, so these
 * are preserved rather than deleted on the assumption they are unused. */
function fillRegistryOnly(output: PDFDocument, source: SourceContent, budget: Budget): number {
  for (const srcTag of source.registryOnlyTags) {
    spend(budget);
    const copied = copyPayload(
      output, source.doc, PDFRef.of(...tagParts(srcTag)),
      source.pinned, source.ambiguous, source.payloadMap, budget, 0,
    );
    if (!(copied instanceof PDFRef)) throw refuse();
    const entry = source.groups.find((g) => g.srcTag === srcTag)!;
    entry.outRefs.push(copied);
    source.byTag.set(srcTag, entry.outRefs);
    source.pinned.set(srcTag, copied);
    source.occurrenceRefs.set(srcTag, entry.outRefs);
  }
  return source.registryOnlyTags.length;
}

function requireType(doc: PDFDocument, dict: PDFDict, expected: string): void {
  const type = optional(doc, dict, 'Type');
  if (type === undefined) {
    // Table 96 and Table 97 both make /Type required; a group that omits it
    // cannot be told from arbitrary data.
    throw refuse();
  }
  if (!(type instanceof PDFName) || type.asString() !== expected) throw refuse();
}

/** Every output object a source group became. A page kept twice was copied
 * twice, so its groups exist twice and both renderings need configuring. */
function outputsFor(srcTag: string, occurrences: Occurrence[], budget: Budget): PDFRef[] {
  const seen = new Set<string>();
  const refs: PDFRef[] = [];
  for (const occurrence of occurrences) {
    spend(budget);
    const mapped = occurrence.objMap.get(srcTag);
    if (!mapped || seen.has(mapped.tag)) continue;
    seen.add(mapped.tag);
    refs.push(mapped);
  }
  return refs;
}

/** A membership dictionary names groups; every one must be registered and
 * mapped, or the visibility policy the content declares cannot be stated in
 * the output. Runs on direct dictionaries as well as indirect ones — a policy
 * written inline is just as real as one written as an object. */
function validateMembership(
  doc: PDFDocument,
  dict: PDFDict,
  byTag: Map<string, PDFRef[]>,
  budget: Budget,
): void {
  spend(budget);
  const type = optional(doc, dict, 'Type');
  if (!(type instanceof PDFName)) throw refuse();
  if (type.asString() !== OCMD_TYPE) return;

  const policy = optional(doc, dict, 'P');
  if (policy !== undefined && (!(policy instanceof PDFName) || !POLICIES.has(policy.asString()))) {
    throw refuse();
  }
  const members = optional(doc, dict, 'OCGs');
  if (members !== undefined) {
    // Table 97: a dictionary or an array of dictionaries.
    if (members instanceof PDFArray) {
      for (let i = 0, n = members.size(); i < n; i++) {
        spend(budget);
        requireRegistered(doc, members.get(i), byTag);
      }
    } else if (members instanceof PDFDict) {
      requireRegistered(doc, dict.get(N('OCGs'), true), byTag);
    } else {
      throw refuse();
    }
  }
  const expression = optional(doc, dict, 'VE');
  if (expression !== undefined) {
    if (!(expression instanceof PDFArray)) throw refuse();
    validateExpression(doc, expression, byTag, budget, 0);
  }
}

function requireRegistered(doc: PDFDocument, entry: PDFObject | undefined, byTag: Map<string, PDFRef[]>): void {
  const resolved = doc.context.lookup(entry);
  // Table 97: null values and references to deleted objects are ignored.
  if (resolved === undefined || resolved === PDFNull) return;
  if (!(entry instanceof PDFRef)) throw refuse();
  if (!byTag.has(entry.tag)) throw refuse();
}

/** 8.11.2.2: the first element is And, Or or Not; Not takes exactly one
 * operand, And and Or take one or more; operands are groups or expressions. */
function validateExpression(
  doc: PDFDocument,
  expression: PDFArray,
  byTag: Map<string, PDFRef[]>,
  budget: Budget,
  depth: number,
): void {
  spend(budget);
  if (depth > MAX_DEPTH) throw refuse();
  const operator = doc.context.lookup(expression.get(0));
  if (!(operator instanceof PDFName) || !VE_OPERATORS.has(operator.asString())) throw refuse();
  const operands = expression.size() - 1;
  if (operands < 1) throw refuse();
  if (operator.asString() === '/Not' && operands !== 1) throw refuse();
  for (let i = 1; i <= operands; i++) {
    spend(budget);
    const operand = doc.context.lookup(expression.get(i));
    if (operand instanceof PDFArray) {
      validateExpression(doc, operand, byTag, budget, depth + 1);
      continue;
    }
    requireRegistered(doc, expression.get(i), byTag);
  }
}

// ── effective state ────────────────────────────────────────────────────────

/** Which of a source's groups a configuration leaves OFF.
 *
 * Table 99: /BaseState initialises every group, then /ON and /OFF override
 * it. A group in both arrays is invalid. In a DEFAULT configuration the base
 * shall be ON — a source that wrote OFF there is still readable and its
 * groups are simply all off unless listed ON, but Unchanged names a state no
 * document records, so it cannot be preserved and refuses. */
function effectiveOff(
  doc: PDFDocument,
  config: PDFDict,
  groups: { srcTag: string; outRefs: PDFRef[] }[],
  byTag: Map<string, PDFRef[]>,
  budget: Budget,
  isDefault: boolean,
): { base: string; off: Set<string>; on: Set<string> } {
  const base = optional(doc, config, 'BaseState');
  let baseName = BASE_ON;
  if (base !== undefined) {
    if (!(base instanceof PDFName)) throw refuse();
    baseName = base.asString();
    if (baseName !== BASE_ON && baseName !== BASE_OFF && baseName !== BASE_UNCHANGED) throw refuse();
    // Table 99 lists all three. A DEFAULT configuration's base shall be ON,
    // and the composed output default is written that way — but a source that
    // wrote OFF there is still read, and its groups' effective states become
    // explicit list entries, which is what preserves their visibility.
    // Unchanged in a default names a state no document records, since nothing
    // precedes the document opening, so that one cannot be preserved.
    if (isDefault && baseName === BASE_UNCHANGED) throw refuse();
  }
  const on = stateList(doc, config, 'ON', byTag, budget);
  const off = stateList(doc, config, 'OFF', byTag, budget);
  for (const tag of on) {
    // Table 99: a group in /ON shall not also be in /OFF.
    if (off.has(tag)) throw refuse();
  }
  if (isDefault) {
    const intent = optional(doc, config, 'Intent');
    if (intent !== undefined && !isViewIntent(doc, intent)) {
      // Table 99: a default configuration's /Intent shall be View.
      throw refuse();
    }
  }
  if (baseName === BASE_UNCHANGED) {
    // A relative operation: only the groups the configuration names change.
    return { base: baseName, off, on };
  }
  const resolvedOff = new Set<string>();
  for (const group of groups) {
    spend(budget);
    const offByBase = baseName === BASE_OFF;
    if (off.has(group.srcTag) || (offByBase && !on.has(group.srcTag))) resolvedOff.add(group.srcTag);
  }
  return { base: baseName, off: resolvedOff, on };
}

function stateList(
  doc: PDFDocument,
  config: PDFDict,
  key: string,
  byTag: Map<string, PDFRef[]>,
  budget: Budget,
): Set<string> {
  const tags = new Set<string>();
  const list = optional(doc, config, key);
  if (list === undefined) return tags;
  if (!(list instanceof PDFArray)) throw refuse();
  for (let i = 0, n = list.size(); i < n; i++) {
    spend(budget);
    const entry = list.get(i);
    const resolved = doc.context.lookup(entry);
    if (resolved === undefined || resolved === PDFNull) continue;
    if (!(entry instanceof PDFRef)) throw refuse();
    // A state list naming a group the registry never declared cannot be
    // proven to be about this document's optional content.
    if (!byTag.has(entry.tag)) throw refuse();
    tags.add(entry.tag);
  }
  return tags;
}

function isViewIntent(doc: PDFDocument, intent: PDFObject): boolean {
  if (intent instanceof PDFName) return intent.asString() === '/View';
  if (intent instanceof PDFArray) {
    if (intent.size() !== 1) return false;
    const only = doc.context.lookup(intent.get(0));
    return only instanceof PDFName && only.asString() === '/View';
  }
  return false;
}

// ── composition ────────────────────────────────────────────────────────────

interface Reserved {
  rootRef: PDFRef;
  registryRef: PDFRef;
  defaultRef: PDFRef;
  configsRef: PDFRef | undefined;
  alternates: { source: SourceContent; config: PDFDict; ref: PDFRef }[];
  defaultArrays: ConfigArrays;
  alternateArrays: ConfigArrays[];
}

function compose(
  output: PDFDocument,
  read: SourceContent[],
  budget: Budget,
  reserved: Reserved,
): PDFDict {
  const registry = PDFArray.withContext(output.context);
  for (const source of read) {
    for (const group of source.groups) {
      for (const ref of group.outRefs) {
        spend(budget);
        registry.push(ref);
      }
    }
  }
  // Each reserved identity is filled with the object it was reserved for, so
  // an alias that resolved to it during copying now reaches the real thing.
  output.context.assign(reserved.registryRef, registry);

  const properties = PDFDict.withContext(output.context);
  output.context.assign(reserved.rootRef, properties);
  properties.set(N('OCGs'), reserved.registryRef);

  const defaultConfig = composeDefault(output, read, budget, reserved.defaultArrays);
  output.context.assign(reserved.defaultRef, defaultConfig);
  properties.set(N('D'), reserved.defaultRef);

  if (reserved.configsRef) {
    const configs = PDFArray.withContext(output.context);
    for (const alternate of reserved.alternates) {
      spend(budget);
      const built = composeAlternate(
        output, read, alternate.source, alternate.config, budget, reserved.alternateArrays[
          reserved.alternates.indexOf(alternate)
        ],
      );
      output.context.assign(alternate.ref, built);
      configs.push(alternate.ref);
    }
    output.context.assign(reserved.configsRef, configs);
    properties.set(N('Configs'), reserved.configsRef);
  }

  // Table 98 names three entries, but a properties ROOT can carry more, and
  // an extension that put something there said something about this
  // document's optional content. It travels through the same identity map, so
  // a payload it shares with a configuration field stays one object.
  const extras = new Map<string, { value: PDFObject; signature: string; conflict: boolean }>();
  for (const source of read) {
    for (const [key, value] of source.properties.entries()) {
      const name = key.asString();
      if (name === '/OCGs' || name === '/D' || name === '/Configs') continue;
      spendBytes(budget, name.length);
      const resolved = source.doc.context.lookup(value);
      if (resolved === undefined || resolved === PDFNull) continue;
      const signature = signatureOf(source.doc, value, budget, source.pinned);
      const held = extras.get(name);
      if (held === undefined) {
        extras.set(name, {
          value: copyPayload(
            output, source.doc, value, source.pinned, source.ambiguous, source.payloadMap, budget, 0,
          ),
          signature,
          conflict: false,
        });
        continue;
      }
      if (held.signature !== signature) held.conflict = true;
    }
  }
  for (const [name, held] of extras) {
    // Two sources putting different things under one root key is a meaning
    // this cannot choose between.
    if (held.conflict) throw refuse();
    properties.set(N(name.slice(1)), held.value);
  }
  return properties;
}

/** The composed default configuration: an ON base with every group whose
 * composed effective state is OFF listed explicitly. Each source's own
 * default decides its own groups, so no source's base changes another's
 * visibility. */
function composeDefault(
  output: PDFDocument,
  read: SourceContent[],
  budget: Budget,
  arrays: ConfigArrays,
): PDFDict {
  const config = PDFDict.withContext(output.context);
  config.set(N('BaseState'), N('ON'));
  const off = PDFArray.withContext(output.context);
  const on = PDFArray.withContext(output.context);
  for (const source of read) {
    const explicitOn = stateList(source.doc, source.defaultConfig, 'ON', source.byTag, budget);
    for (const group of source.groups) if (explicitOn.has(group.srcTag)) {
      for (const ref of group.outRefs) { spend(budget); on.push(ref); }
    }
    for (const group of source.groups) {
      if (!source.defaultOff.has(group.srcTag)) continue;
      for (const ref of group.outRefs) {
        spend(budget);
        off.push(ref);
      }
    }
  }
  publishArray(output, config, 'OFF', off, arrays, off.size() > 0);
  publishArray(output, config, 'ON', on, arrays, on.size() > 0 || read.some(s => optional(s.doc, s.defaultConfig, 'ON') !== undefined));
  applyPresentation(output, config, read, read.map((s) => s.defaultConfig), budget, true, undefined, arrays);
  return config;
}

/** Assign the reserved object and, when the configuration states the entry,
 * point the entry at that reserved reference. Assigning unconditionally is
 * what keeps an alias to an empty array pointing at a real array. */
function publishArray(
  output: PDFDocument,
  config: PDFDict,
  key: string,
  value: PDFArray,
  arrays: ConfigArrays,
  write: boolean,
): void {
  const ref = arrays[key as keyof ConfigArrays];
  const prior = output.context.lookup(ref);
  if (prior !== undefined) {
    if (!(prior instanceof PDFArray) || prior.toString() !== value.toString()) throw refuse();
  } else output.context.assign(ref, value);
  if (write) config.set(N(key), ref);
}

/** One source's alternate, with every other source held at its default. */
function composeAlternate(
  output: PDFDocument,
  read: SourceContent[],
  owner: SourceContent,
  source: PDFDict,
  budget: Budget,
  arrays: ConfigArrays,
): PDFDict {
  const state = effectiveOff(owner.doc, source, owner.groups, owner.byTag, budget, false);
  const config = PDFDict.withContext(output.context);

  if (state.base === BASE_UNCHANGED) {
    // Table 99: Unchanged initialises nothing, so the configuration is a set
    // of relative changes. It stays relative: only the groups this alternate
    // names move, and no other source's groups are reset to anything.
    config.set(N('BaseState'), N('Unchanged'));
    const on = PDFArray.withContext(output.context);
    const off = PDFArray.withContext(output.context);
    for (const group of owner.groups) {
      for (const ref of group.outRefs) {
        spend(budget);
        if (state.on.has(group.srcTag)) on.push(ref);
        else if (state.off.has(group.srcTag)) off.push(ref);
      }
    }
    publishArray(output, config, 'ON', on, arrays, on.size() > 0);
    publishArray(output, config, 'OFF', off, arrays, off.size() > 0);
  } else {
    config.set(N('BaseState'), N('ON'));
    const off = PDFArray.withContext(output.context);
    const on = PDFArray.withContext(output.context);
    for (const other of read) {
      // The alternate speaks for its own source; every other source keeps the
      // default it published, so exposing one presentation never hides or
      // reveals another document's layers.
      const hidden = other === owner ? state.off : other.defaultOff;
      const explicitOn = other === owner ? state.on : stateList(other.doc, other.defaultConfig, 'ON', other.byTag, budget);
      for (const group of other.groups) {
        if (explicitOn.has(group.srcTag)) for (const ref of group.outRefs) { spend(budget); on.push(ref); }
        if (!hidden.has(group.srcTag)) continue;
        for (const ref of group.outRefs) {
          spend(budget);
          off.push(ref);
        }
      }
    }
    publishArray(output, config, 'OFF', off, arrays, off.size() > 0);
    publishArray(output, config, 'ON', on, arrays, on.size() > 0 || optional(owner.doc, source, 'ON') !== undefined);
  }

  // An intent set that changes another source's group effectiveness changes
  // that document's visibility, which this alternate was never given
  // authority to do.
  if (read.length > 1) {
    const declared = optional(owner.doc, source, 'Intent');
    if (declared !== undefined) {
      const intents = new Set<string>();
      if (declared instanceof PDFName) intents.add(declared.asString());
      else if (declared instanceof PDFArray) {
        for (let i = 0, n = declared.size(); i < n; i++) {
          const name = owner.doc.context.lookup(declared.get(i));
          if (!(name instanceof PDFName)) throw refuse();
          intents.add(name.asString());
        }
      } else throw refuse();
      proveIntentFaithful(read, owner, intents, budget);
    }
  }

  // Presentation: the alternate's own label and filters belong to it alone;
  // Order, AS, RBGroups and Locked accumulate across the sources that have
  // something to say about their own groups.
  applyPresentation(
    output,
    config,
    read,
    read.map((s) => (s === owner ? source : s.defaultConfig)),
    budget,
    false,
    owner,
    arrays,
  );
  return config;
}

/** Order, AS, RBGroups, Locked and the scalar presentation fields.
 *
 * Order, AS, RBGroups and Locked ACCUMULATE: each source contributes its own
 * hierarchy, usage applications, radio sets and locks for its own groups, and
 * Table 101 explicitly permits repeated Event entries so combined documents
 * keep their behaviour.
 *
 * The scalar fields — Name, Creator, ListMode, Intent — are metadata of the
 * configuration they name, so for an alternate they come from THAT alternate
 * alone: an alternate that states no Intent does not inherit another source's.
 * For the composed default, which is a new configuration no source named, an
 * agreed value carries and a disagreement is simply not asserted. */
function applyPresentation(
  output: PDFDocument,
  config: PDFDict,
  read: SourceContent[],
  perSource: (PDFDict | undefined)[],
  budget: Budget,
  isDefault: boolean,
  owner: SourceContent | undefined,
  arrays: ConfigArrays,
): void {
  const order = PDFArray.withContext(output.context);
  const as = PDFArray.withContext(output.context);
  const rbGroups = PDFArray.withContext(output.context);
  const locked = PDFArray.withContext(output.context);
  const scalars = new Map<string, { value: PDFObject; signature: string; conflict: boolean }>();
  const extras = new Map<string, { value: PDFObject; signature: string; conflict: boolean }>();
  // Whether any source STATED the field, which is what decides an empty
  // array being written rather than left to inherit.
  let rbStated = false;
  let lockedStated = false;
  let listModeStated = false;

  read.forEach((source, index) => {
    const from = perSource[index];
    if (!from) return;
    spend(budget);

    // Table 99: in a configuration other than the default, Order's default is
    // the Order value from THAT SOURCE's default configuration — not the
    // recomposed combined one, which no source wrote.
    const sourceOrder = inheritedField(source, from, 'Order', isDefault);
    if (sourceOrder !== undefined) {
      if (!(sourceOrder instanceof PDFArray)) throw refuse();
      appendOrder(output, source, sourceOrder, order, budget, 0);
    }
    const sourceAs = optional(source.doc, from, 'AS');
    if (sourceAs !== undefined) {
      if (!(sourceAs instanceof PDFArray)) throw refuse();
      appendUsageApplications(output, source, sourceAs, as, budget);
    }
    // Table 99: RBGroups follows the same inheritance as Order, and an empty
    // array explicitly states that no radio collections exist.
    const sourceRb = inheritedField(source, from, 'RBGroups', isDefault);
    if (sourceRb !== undefined) {
      if (!(sourceRb instanceof PDFArray)) throw refuse();
      rbStated = true;
      for (let i = 0, n = sourceRb.size(); i < n; i++) {
        spend(budget);
        const set = source.doc.context.lookup(sourceRb.get(i));
        if (set === undefined || set === PDFNull) continue;
        if (!(set instanceof PDFArray)) throw refuse();
        rbGroups.push(mapGroupArray(output, source, set, budget));
      }
    }
    // Table 99: Locked's default is an empty array, with no inheritance, so
    // an alternate that says nothing locks nothing.
    const sourceLocked = optional(source.doc, from, 'Locked');
    if (sourceLocked !== undefined) {
      if (!(sourceLocked instanceof PDFArray)) throw refuse();
      lockedStated = true;
      const mapped = mapGroupArray(output, source, sourceLocked, budget);
      for (let i = 0, n = mapped.size(); i < n; i++) locked.push(mapped.get(i));
    }

    // A label belongs to the configuration that carries it, so for an
    // alternate only the alternate itself supplies one.
    const labelSource = isDefault || owner === undefined || source === owner;

    for (const [key, value] of from.entries()) {
      const name = key.asString();
      if (REBUILT_CONFIG_KEYS.has(name) || name === '/ListMode') continue;
      spendBytes(budget, name.length);
      const resolved = source.doc.context.lookup(value);
      if (resolved === undefined || resolved === PDFNull) continue;
      const isLabel = LABEL_CONFIG_KEYS.has(name);
      if (isLabel) {
        if (!labelSource) continue;
        validateScalar(source.doc, name, resolved, isDefault);
      }
      const bucket = isLabel ? scalars : extras;
      const signature = signatureOf(source.doc, value, budget, source.pinned);
      const held = bucket.get(name);
      if (held === undefined) {
        bucket.set(name, {
          value: copyPayload(output, source.doc, value, source.pinned, source.ambiguous, source.payloadMap, budget, 0),
          signature,
          conflict: false,
        });
        continue;
      }
      if (held.signature !== signature) held.conflict = true;
    }
  });

  // ListMode decides which groups an interface LISTS, so it is behaviour, not
  // a caption. Its default is AllPages, which means an explicit VisiblePages
  // conflicts with a source that simply omitted the entry. Equivalent
  // effective values compose; a genuine difference cannot be stated once.
  const modes = new Set<string>();
  read.forEach((source, index) => {
    const from = perSource[index];
    if (!from) return;
    spend(budget);
    const mode = optional(source.doc, from, 'ListMode');
    if (mode === undefined) {
      // The effective value of an absent entry, which is what a stated
      // VisiblePages actually conflicts with.
      modes.add('/AllPages');
      return;
    }
    validateScalar(source.doc, '/ListMode', mode, isDefault);
    listModeStated = true;
    modes.add((mode as PDFName).asString());
  });
  if (modes.size > 1) throw refuse();
  const [mode] = [...modes];
  if (mode !== undefined && listModeStated) config.set(N('ListMode'), N(mode.slice(1)));

  // Table 99: an empty Order explicitly presents nothing, and in the default
  // configuration an absent Order defaults to empty, so it is always written.
  publishArray(output, config, 'Order', order, arrays, true);
  publishArray(output, config, 'AS', as, arrays, as.size() > 0);
  // An empty array that a source actually wrote is a statement — Table 99
  // makes it mean "no such collections" and it overrides the inheritance an
  // absent entry would take.
  publishArray(output, config, 'RBGroups', rbGroups, arrays, rbGroups.size() > 0 || rbStated);
  publishArray(output, config, 'Locked', locked, arrays, locked.size() > 0 || lockedStated);
  // A label two sources spelled differently describes neither composition, so
  // it is left unstated rather than picked. An opaque root/config extra that
  // two sources disagree about IS a semantic conflict: nothing here can tell
  // which meaning the combined document has.
  for (const [name, held] of scalars) {
    if (!held.conflict) config.set(N(name.slice(1)), held.value);
  }
  for (const [name, held] of extras) {
    if (held.conflict) throw refuse();
    config.set(N(name.slice(1)), held.value);
  }
}

/** The intents a group declares. Table 96: a name or an array of names,
 * defaulting to View. */
function groupIntents(doc: PDFDocument, srcTag: string, budget: Budget): Set<string> {
  spend(budget);
  const dict = doc.context.lookup(PDFRef.of(...tagParts(srcTag)));
  const intents = new Set<string>();
  if (!(dict instanceof PDFDict)) return intents.add('/View'), intents;
  const declared = optional(doc, dict, 'Intent');
  if (declared === undefined) return intents.add('/View'), intents;
  if (declared instanceof PDFName) return intents.add(declared.asString()), intents;
  if (!(declared instanceof PDFArray)) throw refuse();
  for (let i = 0, n = declared.size(); i < n; i++) {
    spend(budget);
    const name = doc.context.lookup(declared.get(i));
    if (!(name instanceof PDFName)) throw refuse();
    intents.add(name.asString());
  }
  return intents;
}

/** 8.11.2.3: a group affects visibility only when one of its intents is in
 * the configuration's intent set, and the special name All stands for every
 * intent. An empty set means no group affects visibility. */
function affectsVisibility(intents: Set<string>, configIntents: Set<string>): boolean {
  if (configIntents.has('/All')) return true;
  for (const intent of intents) if (configIntents.has(intent)) return true;
  return false;
}

/** An alternate's intent set is only carryable if it leaves every OTHER
 * source's groups affecting visibility exactly as that source's own default
 * did. Otherwise applying the alternate would silently reveal or hide another
 * document's content, and no single intent set states both meanings. */
function proveIntentFaithful(
  read: SourceContent[],
  owner: SourceContent,
  configIntents: Set<string>,
  budget: Budget,
): void {
  const viewOnly = new Set(['/View']);
  for (const other of read) {
    if (other === owner) continue;
    for (const group of other.groups) {
      spend(budget);
      const intents = groupIntents(other.doc, group.srcTag, budget);
      const before = affectsVisibility(intents, defaultIntents(other, budget));
      const after = affectsVisibility(intents, configIntents);
      if (before !== after) throw refuse();
    }
  }
  void viewOnly;
}

/** A source default configuration's intent set. Table 99 requires View there,
 * which effectiveOff already proved, so an absent entry is View too. */
function defaultIntents(source: SourceContent, budget: Budget): Set<string> {
  spend(budget);
  const declared = optional(source.doc, source.defaultConfig, 'Intent');
  if (declared === undefined) return new Set(['/View']);
  if (declared instanceof PDFName) return new Set([declared.asString()]);
  if (!(declared instanceof PDFArray)) throw refuse();
  const intents = new Set<string>();
  for (let i = 0, n = declared.size(); i < n; i++) {
    const name = source.doc.context.lookup(declared.get(i));
    if (!(name instanceof PDFName)) throw refuse();
    intents.add(name.asString());
  }
  return intents;
}

/** A field whose default, in a configuration other than the default one, is
 * that source's own default configuration value (Table 99: Order, RBGroups).
 * An explicit value — including an explicit empty array — overrides it. */
function inheritedField(
  source: SourceContent,
  from: PDFDict,
  key: string,
  isDefault: boolean,
): PDFObject | undefined {
  const own = optional(source.doc, from, key);
  if (own !== undefined) return own;
  if (isDefault || from === source.defaultConfig) return undefined;
  return optional(source.doc, source.defaultConfig, key);
}

/** Fields selected from the configuration owner. Name/Creator are captions;
 * Intent is behavioural and separately proved against every contributing
 * source before selection. ListMode must agree across all sources. */
const LABEL_CONFIG_KEYS = new Set(['/Name', '/Creator', '/Intent']);

/** Table 99 shapes for the scalar fields. */
function validateScalar(doc: PDFDocument, name: string, value: PDFObject, isDefault: boolean): void {
  if (name === '/Name' || name === '/Creator') {
    if (!isText(value)) throw refuse();
    return;
  }
  if (name === '/ListMode') {
    if (!(value instanceof PDFName)) throw refuse();
    if (value.asString() !== '/AllPages' && value.asString() !== '/VisiblePages') throw refuse();
    return;
  }
  // Intent is a single name or an array of names; the default's must be View,
  // which effectiveOff already proved.
  if (value instanceof PDFName) return;
  if (value instanceof PDFArray) {
    for (let i = 0, n = value.size(); i < n; i++) {
      if (!(doc.context.lookup(value.get(i)) instanceof PDFName)) throw refuse();
    }
    if (isDefault && !isViewIntent(doc, value)) throw refuse();
    return;
  }
  throw refuse();
}

/** Order is a tree: groups, nested arrays of groups, and a nested array may
 * begin with a text label. The hierarchy and its labels travel as written,
 * with group references mapped to the objects the pages actually use. */
function appendOrder(
  output: PDFDocument,
  source: SourceContent,
  from: PDFArray,
  into: PDFArray,
  budget: Budget,
  depth: number,
): void {
  const doc = source.doc;
  spend(budget);
  if (depth > MAX_DEPTH) throw refuse();
  for (let i = 0, n = from.size(); i < n; i++) {
    spend(budget);
    const entry = from.get(i);
    const resolved = doc.context.lookup(entry);
    if (resolved === undefined || resolved === PDFNull) continue;
    if (isText(resolved)) {
      // A label's raw bytes travel, so a UTF-16 layer name stays itself.
      spendBytes(budget, resolved.asString().length);
      into.push(resolved.clone());
      continue;
    }
    if (resolved instanceof PDFArray) {
      const nested = PDFArray.withContext(output.context);
      appendOrder(output, source, resolved, nested, budget, depth + 1);
      into.push(nested);
      continue;
    }
    if (!(entry instanceof PDFRef)) throw refuse();
    const mapped = source.byTag.get(entry.tag);
    // An Order entry naming an unregistered object is not a group this
    // document declared.
    if (!mapped) throw refuse();
    for (const ref of mapped) into.push(ref);
  }
}

function appendUsageApplications(
  output: PDFDocument,
  source: SourceContent,
  from: PDFArray,
  into: PDFArray,
  budget: Budget,
): void {
  const doc = source.doc;
  for (let i = 0, n = from.size(); i < n; i++) {
    spend(budget);
    const entry = doc.context.lookup(from.get(i));
    if (entry === undefined || entry === PDFNull) continue;
    if (!(entry instanceof PDFDict)) throw refuse();
    const event = optional(doc, entry, 'Event');
    // Table 101: Event and Category are required.
    if (!(event instanceof PDFName) || !EVENTS.has(event.asString())) throw refuse();
    const category = optional(doc, entry, 'Category');
    if (!(category instanceof PDFArray)) throw refuse();
    const out = PDFDict.withContext(output.context);
    out.set(N('Event'), event.clone());
    const categories = PDFArray.withContext(output.context);
    // Category order is the order the categories are consulted in.
    for (let c = 0, m = category.size(); c < m; c++) {
      spend(budget);
      const name = doc.context.lookup(category.get(c));
      if (!(name instanceof PDFName)) throw refuse();
      categories.push(name.clone());
    }
    out.set(N('Category'), categories);

    const groups = optional(doc, entry, 'OCGs');
    if (groups !== undefined) {
      // An explicit array maps exactly the groups it names, and an explicitly
      // empty one stays empty.
      if (!(groups instanceof PDFArray)) throw refuse();
      out.set(N('OCGs'), mapGroupArray(output, source, groups, budget));
    }
    // Table 101: an absent OCGs defaults to an empty array — no groups have
    // their state managed. Absence is carried as absence; manufacturing a
    // scope here would invent automatic state changes no source asked for.

    for (const [key, value] of entry.entries()) {
      const name = key.asString();
      if (name === '/Event' || name === '/Category' || name === '/OCGs') continue;
      spendBytes(budget, name.length);
      const resolved = doc.context.lookup(value);
      if (resolved === undefined || resolved === PDFNull) continue;
      out.set(key, copyPayload(output, doc, value, source.pinned, source.ambiguous, source.payloadMap, budget, 0));
    }
    into.push(out);
  }
}

function mapGroupArray(
  output: PDFDocument,
  source: SourceContent,
  from: PDFArray,
  budget: Budget,
): PDFArray {
  const doc = source.doc;
  const out = PDFArray.withContext(output.context);
  for (let i = 0, n = from.size(); i < n; i++) {
    spend(budget);
    const entry = from.get(i);
    const resolved = doc.context.lookup(entry);
    if (resolved === undefined || resolved === PDFNull) continue;
    if (!(entry instanceof PDFRef)) throw refuse();
    const mapped = source.byTag.get(entry.tag);
    if (!mapped) throw refuse();
    for (const ref of mapped) { spend(budget); out.push(ref); }
  }
  return out;
}

// ── payload copying ────────────────────────────────────────────────────────

/** Copy layer data — a group dictionary, a usage dictionary, an unknown
 * extension field — into the output context.
 *
 * References are followed once and remembered, so shared data stays shared
 * and a cycle terminates. Anything that proves itself a page, an annotation,
 * a structure node or an action refuses: a key that merely SPELLS S, P or
 * Type is data, but a dictionary whose resolved type or action subtype says
 * what it is has proven it. */
function copyPayload(
  output: PDFDocument,
  doc: PDFDocument,
  value: PDFObject,
  pinned: ReadonlyMap<string, PDFRef>,
  ambiguous: ReadonlySet<string>,
  mapped: Map<string, PDFRef>,
  budget: Budget,
  depth: number,
): PDFObject {
  if (depth > MAX_DEPTH) throw refuse();

  if (value instanceof PDFRef) {
    // The edge is charged before any cache or pin is consulted, so repeated
    // mapped fanout is not free work.
    spend(budget);
    // A reference to something already rebuilt points AT it: an extension
    // edge naming a rendered group must reach the rendered group, never a
    // clone of it sitting beside it in the catalog.
    const pin = pinned.get(value.tag);
    if (pin) return pin;
    // A group the pages render more than once became more than one output
    // object. A semantic group ARRAY expands to all of them, but an opaque
    // scalar edge names exactly one thing, and there is no way to choose
    // which rendering it meant — nor to invent an unrendered clone for it.
    if (ambiguous.has(value.tag)) throw refuse();
    const seen = mapped.get(value.tag);
    if (seen) return seen;
    const resolved = doc.context.lookup(value);
    if (resolved === undefined) return PDFNull;
    const placeholder = output.context.nextRef();
    mapped.set(value.tag, placeholder);
    output.context.assign(placeholder, copyPayload(output, doc, resolved, pinned, ambiguous, mapped, budget, depth + 1));
    return placeholder;
  }
  if (value instanceof PDFRawStream) {
    spend(budget);
    spendBytes(budget, value.contents.length);
    guard(doc, value.dict);
    const dict = copyPayload(output, doc, value.dict, pinned, ambiguous, mapped, budget, depth + 1);
    if (!(dict instanceof PDFDict)) throw refuse();
    return PDFRawStream.of(dict, value.contents.slice());
  }
  if (value instanceof PDFStream) throw refuse();
  if (value instanceof PDFDict) {
    spend(budget);
    guard(doc, value);
    const out = PDFDict.withContext(output.context);
    for (const [key, entry] of value.entries()) {
      spendBytes(budget, key.asString().length);
      out.set(key, copyPayload(output, doc, entry, pinned, ambiguous, mapped, budget, depth + 1));
    }
    return out;
  }
  if (value instanceof PDFArray) {
    spend(budget);
    const out = PDFArray.withContext(output.context);
    for (let i = 0, n = value.size(); i < n; i++) {
      // Assembling each element is work, whether or not it resolves to
      // something already mapped.
      spend(budget);
      out.push(copyPayload(output, doc, value.get(i), pinned, ambiguous, mapped, budget, depth + 1));
    }
    return out;
  }
  if (isText(value)) {
    spend(budget);
    spendBytes(budget, value.asString().length);
    // Cloning keeps the raw bytes, so a hex-encoded label stays hex.
    return value.clone();
  }
  if (value instanceof PDFName) {
    spend(budget);
    spendBytes(budget, value.asString().length);
    return value.clone();
  }
  if (value instanceof PDFNumber) {
    spend(budget);
    // Enforced on every copy path, not only where values are compared: a
    // non-finite number has no legal spelling in a PDF file.
    if (!Number.isFinite(value.asNumber())) throw refuse();
    return value.clone();
  }
  if (value instanceof PDFBool) {
    spend(budget);
    return value.clone();
  }
  if (value === PDFNull) {
    spend(budget);
    return PDFNull;
  }
  throw refuse();
}

function guard(doc: PDFDocument, dict: PDFDict): void {
  const type = doc.context.lookup(dict.get(N('Type')));
  if (type instanceof PDFName && FORBIDDEN_TYPES.has(type.asString())) throw refuse();
  const subtype = doc.context.lookup(dict.get(N('S')));
  if (subtype instanceof PDFName && ACTION_TYPES.has(subtype.asString())) throw refuse();
}

/** A value's meaning, with no object numbers in it, so two sources writing
 * the same configuration field agree and two writing different ones do not.
 *
 * Every distinct referenced node gets its own identity, allocated in a
 * deterministic order: dictionary keys are sorted BEFORE anything descends,
 * so sibling objects can never share a token the way a depth-only marker let
 * them. Each piece is length-prefixed, so no concatenation of parts can spell
 * the same string as a different shape. The parts are joined once at the end.
 *
 * This compares; it never copies. */
function signatureOf(doc: PDFDocument, value: PDFObject | undefined, budget: Budget,
  pinned: ReadonlyMap<string, PDFRef>): string {
  const identities = new Map<string, number>();
  const parts: string[] = [];
  emitSignature(doc, value, budget, identities, parts, 0, pinned);
  return parts.join('');
}

/** Length-prefixed so `a` + `bc` cannot read as `ab` + `c`. */
function emit(parts: string[], tag: string, body: string): void {
  parts.push(tag, ':', String(body.length), ':', body, ';');
}

function emitSignature(
  doc: PDFDocument,
  value: PDFObject | undefined,
  budget: Budget,
  identities: Map<string, number>,
  parts: string[],
  depth: number,
  pinned: ReadonlyMap<string, PDFRef>,
): void {
  spend(budget);
  if (depth > MAX_DEPTH) throw refuse();
  let resolved = value;
  if (resolved instanceof PDFRef) {
    // Equal group dictionaries do not mean the same layer. Compare known
    // semantic edges by their actual output identity, not a re-serialized
    // dictionary that erases which source's group the extension names.
    const target = pinned.get(resolved.tag);
    if (target) { emit(parts, 'output', target.tag); return; }
    const seen = identities.get(resolved.tag);
    if (seen !== undefined) {
      // A revisit names the node it revisits, so two references to two
      // different earlier objects cannot collapse into one token.
      emit(parts, 'back', String(seen));
      return;
    }
    identities.set(resolved.tag, identities.size);
    emit(parts, 'node', String(identities.size - 1));
    resolved = doc.context.lookup(resolved);
  }
  if (resolved === undefined || resolved === PDFNull) {
    emit(parts, 'null', '');
    return;
  }
  if (resolved instanceof PDFName) {
    spendBytes(budget, resolved.asString().length);
    emit(parts, 'name', resolved.asString());
    return;
  }
  if (resolved instanceof PDFNumber) {
    const n = resolved.asNumber();
    // A non-finite number has no comparable value and no legal spelling.
    if (!Number.isFinite(n)) throw refuse();
    emit(parts, 'num', String(n));
    return;
  }
  if (resolved instanceof PDFBool) {
    emit(parts, 'bool', String(resolved.asBoolean()));
    return;
  }
  if (isText(resolved)) {
    const bytes = resolved.asBytes();
    spendBytes(budget, bytes.length);
    emit(parts, 'text', hexOf(bytes));
    return;
  }
  if (resolved instanceof PDFRawStream) {
    spendBytes(budget, resolved.contents.length);
    emit(parts, 'streambytes', hexOf(resolved.contents));
    emitSignature(doc, resolved.dict, budget, identities, parts, depth + 1, pinned);
    return;
  }
  if (resolved instanceof PDFStream) throw refuse();
  if (resolved instanceof PDFArray) {
    const size = resolved.size();
    emit(parts, 'arr', String(size));
    for (let i = 0; i < size; i++) {
      emitSignature(doc, resolved.get(i), budget, identities, parts, depth + 1, pinned);
    }
    return;
  }
  if (resolved instanceof PDFDict) {
    const entries = resolved.entries();
    // Sorted BEFORE descending: identity allocation order is then a function
    // of the value alone, not of the order pdf-lib happens to hold keys in.
    const keys = entries.map(([key]) => key.asString()).sort();
    emit(parts, 'dict', String(keys.length));
    for (const key of keys) {
      spendBytes(budget, key.length);
      emit(parts, 'key', key);
      emitSignature(doc, resolved.get(N(key.slice(1)), true), budget, identities, parts, depth + 1, pinned);
    }
    return;
  }
  throw refuse();
}

/** Exact hex, built in chunks. A per-byte array of strings for a multi-
 * megabyte stream is the allocation this avoids. */
function hexOf(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i++) {
    chunk += (bytes[i] >>> 4).toString(16) + (bytes[i] & 0x0f).toString(16);
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.join('');
}

/** "obj gen R"-style tag back to its numbers — PDFRef.tag is `${obj} ${gen} R`. */
function tagParts(tag: string): [number, number] {
  const [obj, gen] = tag.split(' ');
  return [Number(obj), Number(gen)];
}
