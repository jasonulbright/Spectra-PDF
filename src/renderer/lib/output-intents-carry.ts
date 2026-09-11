// Copy a document's output intents into a rebuild's context.
//
// An output intent names the production condition a document's colours were
// prepared for and carries the ICC profile that defines it (ISO 32000-2
// 14.11.5, Tables 401 and 402). None of that can be regenerated from the
// rebuilt pages, so the whole graph travels as opaque data: profile bytes and
// their filter dictionaries verbatim, unknown subtypes and extension fields
// intact, internal sharing and cycles preserved.
//
// Nothing here decodes, validates or interprets a profile, and nothing reaches
// the network or parses embedded XML. Referenced-profile descriptions, file
// specifications, mixing hints and spectral characterisation streams are
// copied as the data they are, never followed.
//
// What is refused is a PROVEN role, never a guessed one. A key's spelling
// carries no meaning here: a spectral dictionary's keys are arbitrary
// colourant names, so `A`, `Next` and `JS` are ordinary names in one, and an
// extension field `A 7` is a number. A dictionary is rejected when it proves
// itself a page, a page-tree node, a catalog, a structure node or an action —
// by its type, by its identity in the source, or by an action subtype from
// Table 201, which is what makes a typeless action detectable.
//
// This function returns the copied array and NEVER installs a catalog or page
// root; where the value belongs is the caller's decision.
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

const N = PDFName.of.bind(PDFName);

// Bounds, not predictions. Every stage — identity discovery, shape validation
// and the copy itself — spends from the same two counters, so no phase can do
// unbounded work ahead of the others.
const MAX_OBJECTS = 5_000;
const MAX_DEPTH = 64;
const MAX_BYTES = 32 * 1024 * 1024;

/** These explicit types prove a non-data role. Some are optional (notably
 * StructElem and Action); their absence alone never proves a data role. */
const FORBIDDEN_TYPES = new Set([
  '/Catalog',
  '/Page',
  '/Pages',
  '/StructTreeRoot',
  '/StructElem',
  '/OBJR',
  '/Action',
]);

/** Standard action subtypes, ISO 32000-2 Table 201. An action dictionary's
 * /Type is optional but its /S is required, so this set is what identifies an
 * action that omitted its type. */
const ACTION_TYPES = new Set([
  '/GoTo',
  '/GoToR',
  '/GoToE',
  '/GoToDp',
  '/Launch',
  '/Thread',
  '/URI',
  '/Sound',
  '/Movie',
  '/Hide',
  '/Named',
  '/SubmitForm',
  '/ResetForm',
  '/ImportData',
  '/SetOCGState',
  '/Rendition',
  '/Trans',
  '/GoTo3DView',
  '/JavaScript',
  '/RichMediaExecute',
]);

/** Catalog entries that are a document, structural or action root. Reaching
 * one from an intent means the graph has left the intent. The catalog's other
 * entries are data — a Metadata packet, viewer preferences, page labels,
 * optional-content configuration — and an intent may legitimately share one,
 * so they are not listed here. */
const FORBIDDEN_CATALOG_ENTRIES = [
  'Pages',
  'StructTreeRoot',
  'AcroForm',
  'Outlines',
  'Threads',
  'Names',
  'Dests',
  'OpenAction',
  'AA',
];

/** Table 401 entries whose value is a text string. */
const TEXT_FIELDS = ['OutputCondition', 'OutputConditionIdentifier', 'RegistryName', 'Info'];

/** Table 401 entries whose value is a dictionary. */
const DICT_FIELDS = ['DestOutputProfileRef', 'MixingHints', 'SpectralData'];

/** Table 402 entries whose value is a string. */
const PROFILE_REF_TEXT_FIELDS = ['CheckSum', 'ICCVersion', 'ProfileCS', 'ProfileName'];

const refuse = (): Error => new Error(tChrome('app.operation.unverified'));

const isText = (value: PDFObject | undefined): boolean =>
  value instanceof PDFString || value instanceof PDFHexString;

/** Copy `raw` — a catalog or page /OutputIntents value from `source` — into
 * `output`'s context and return the copied array.
 *
 * Returns undefined when there are no output intents to carry: an absent
 * value, a null one, or a reference to a nonexistent object, which
 * ISO 32000-2 7.3.9 makes equivalent to omitting the entry. A value that is
 * present but not a well-shaped array of output intent dictionaries refuses
 * with the unverified-operation message.
 *
 * The supplied root keeps its identity: a valid cycle back to it resolves to
 * the array returned here, not to a second copy. Where an output reference for
 * that array already exists, `output.context.getObjectRef` finds it.
 *
 * On refusal some objects may already be allocated in `output`'s context; they
 * are unreachable because no root is published, which is the caller's step. */
export function copyOutputIntents(
  output: PDFDocument,
  source: PDFDocument,
  raw: PDFObject | undefined,
): PDFArray | undefined {
  if (raw === undefined) return undefined;
  const root = source.context.lookup(raw);
  if (root === undefined || root === PDFNull) return undefined;
  if (!(root instanceof PDFArray)) throw refuse();

  const budget = { objects: 0, bytes: 0 };
  const forbidden = forbiddenRefs(source, budget);
  if (raw instanceof PDFRef && forbidden.has(raw.tag)) throw refuse();

  // Every intent's shape is checked before anything is copied, so a malformed
  // later entry refuses on the source rather than part way through a graph.
  // The intent dictionaries are remembered: their /S is the intent subtype and
  // may be any name, so the action-subtype proof must not be applied to them.
  const roots = new Set<PDFDict>();
  for (let i = 0, n = root.size(); i < n; i++) {
    spend(budget);
    const intent = source.context.lookup(root.get(i));
    if (!(intent instanceof PDFDict)) throw refuse();
    validateIntent(source, intent, budget);
    roots.add(intent);
  }

  const copied = copyGraph(output, source, raw, root, forbidden, roots, budget);
  if (!(copied instanceof PDFArray) || copied.size() !== root.size()) throw refuse();
  return copied;
}

function spend(budget: { objects: number; bytes: number }): void {
  if (++budget.objects > MAX_OBJECTS) throw refuse();
}

function spendBytes(budget: { objects: number; bytes: number }, count: number): void {
  budget.bytes += count;
  if (budget.bytes > MAX_BYTES) throw refuse();
}

/** One reader for every known field. An entry that is absent, directly null,
 * or an indirect reference resolving to null or to nothing are all the same
 * thing: the entry is not there. ISO 32000-2 7.3.9 makes a null dictionary
 * value equivalent to omitting the entry, and a reference to a nonexistent
 * object equivalent to null. */
function field(
  source: PDFDocument,
  dict: PDFDict,
  key: string,
  budget: { objects: number; bytes: number },
): PDFObject | undefined {
  spend(budget);
  const declared = dict.get(N(key), true);
  if (declared === undefined) return undefined;
  const value = source.context.lookup(declared);
  return value === undefined || value === PDFNull ? undefined : value;
}

/** Table 401. The subtype is required and may be any name: the three
 * registered subtypes are not the whole set and an extension's own subtype is
 * as valid as they are, so the name is checked for being a name and nothing
 * more. Info and DestOutputProfile are required only when the condition
 * identifier does not name a standard production condition — which cannot be
 * decided without consulting an external registry, so both are treated as
 * optional here rather than asserting a conformance this cannot know. */
function validateIntent(
  source: PDFDocument,
  intent: PDFDict,
  budget: { objects: number; bytes: number },
): void {
  const read = (key: string) => field(source, intent, key, budget);

  const type = read('Type');
  if (type !== undefined && !(type instanceof PDFName && type.asString() === '/OutputIntent')) throw refuse();
  if (!(read('S') instanceof PDFName)) throw refuse();
  if (!isText(read('OutputConditionIdentifier'))) throw refuse();

  for (const key of TEXT_FIELDS) {
    const value = read(key);
    if (value !== undefined && !isText(value)) throw refuse();
  }
  const profile = read('DestOutputProfile');
  if (profile !== undefined && !(profile instanceof PDFRawStream)) throw refuse();
  for (const key of DICT_FIELDS) {
    const value = read(key);
    if (value !== undefined && !(value instanceof PDFDict)) throw refuse();
  }

  // Each key of SpectralData is a colourant name — any name at all — and each
  // value a characterisation stream. The stream's contents are never read.
  const spectral = read('SpectralData');
  if (spectral instanceof PDFDict) {
    for (const [, value] of spectral.entries()) {
      spend(budget);
      const resolved = source.context.lookup(value);
      if (!(resolved instanceof PDFRawStream)) throw refuse();
    }
  }
  const profileRef = read('DestOutputProfileRef');
  if (profileRef instanceof PDFDict) validateProfileRef(source, profileRef, budget);
}

/** Table 402. URLs, when present, holds at least one file specification —
 * embedded or URL — and a file specification is either a dictionary or a
 * string. No URL is resolved or fetched. */
function validateProfileRef(
  source: PDFDocument,
  profileRef: PDFDict,
  budget: { objects: number; bytes: number },
): void {
  const read = (key: string) => field(source, profileRef, key, budget);

  for (const key of PROFILE_REF_TEXT_FIELDS) {
    const value = read(key);
    if (value !== undefined && !isText(value)) throw refuse();
  }
  const colorants = read('ColorantTable');
  if (colorants !== undefined) {
    if (!(colorants instanceof PDFArray)) throw refuse();
    for (let i = 0, n = colorants.size(); i < n; i++) {
      spend(budget);
      if (!(source.context.lookup(colorants.get(i)) instanceof PDFName)) throw refuse();
    }
  }
  const urls = read('URLs');
  if (urls !== undefined) {
    if (!(urls instanceof PDFArray) || urls.size() === 0) throw refuse();
    for (let i = 0, n = urls.size(); i < n; i++) {
      spend(budget);
      const spec = source.context.lookup(urls.get(i));
      if (!(spec instanceof PDFDict) && !isText(spec)) throw refuse();
    }
  }
}

/** Objects in `source` that are document, structural or action roots rather
 * than data. Discovery is a single pass over the catalog's own entries —
 * no page-tree walk. Required page/catalog types identify descendants, while
 * a typeless structure element's parent chain reaches this known root. */
function forbiddenRefs(source: PDFDocument, budget: { objects: number; bytes: number }): Set<string> {
  const refs = new Set<string>();
  const add = (value: PDFObject | undefined) => {
    spend(budget);
    if (value instanceof PDFRef) refs.add(value.tag);
  };
  add(source.context.trailerInfo.Root as PDFObject | undefined);
  for (const key of FORBIDDEN_CATALOG_ENTRIES) add(source.catalog.get(N(key), true));
  return refs;
}

/** A bounded pure-data copy. References are followed once and remembered, so
 * a shared profile stays one object in the output and a cycle resolves to the
 * reference already allocated for it instead of copying forever. */
function copyGraph(
  output: PDFDocument,
  source: PDFDocument,
  raw: PDFObject,
  root: PDFArray,
  forbidden: Set<string>,
  roots: Set<PDFDict>,
  budget: { objects: number; bytes: number },
): PDFObject {
  const mapped = new Map<string, PDFRef>();

  // The supplied root is mapped before any traversal, so a valid extension
  // cycle back to the /OutputIntents array lands on the array this returns
  // rather than forking a second copy of it.
  let rootRef: PDFRef | undefined;
  if (raw instanceof PDFRef) {
    rootRef = output.context.nextRef();
    mapped.set(raw.tag, rootRef);
  }

  const copy = (value: PDFObject, depth: number): PDFObject => {
    if (depth > MAX_DEPTH) throw refuse();
    // Charge every edge, including a reference already copied. Otherwise an
    // arbitrarily wide array of one shared reference bypasses the work bound.
    spend(budget);

    if (value instanceof PDFRef) {
      const seen = mapped.get(value.tag);
      if (seen) return seen;
      if (forbidden.has(value.tag)) throw refuse();
      const resolved = source.context.lookup(value);
      // Match the validator and PDF null semantics (7.3.9). Required fields
      // already refused during validation; optional missing references stay
      // semantically absent instead of failing only at the copy boundary.
      if (resolved === undefined) return PDFNull;
      const placeholder = output.context.nextRef();
      // Recorded before the recursion: that is what makes a cycle terminate
      // and what keeps a shared object shared.
      mapped.set(value.tag, placeholder);
      output.context.assign(placeholder, copy(resolved, depth + 1));
      return placeholder;
    }

    if (value instanceof PDFRawStream) {
      spendBytes(budget, value.contents.length);
      const dict = copy(value.dict, depth + 1);
      if (!(dict instanceof PDFDict)) throw refuse();
      // Encoded bytes and the filter dictionary travel exactly as they are:
      // no decode, no re-encode, no profile interpretation.
      return PDFRawStream.of(dict, value.contents.slice());
    }
    // Any other stream kind holds its contents as something other than bytes,
    // so it cannot be carried across byte for byte.
    if (value instanceof PDFStream) throw refuse();

    if (value instanceof PDFDict) {
      guardDict(source, value, roots.has(value));
      const out = PDFDict.withContext(output.context);
      for (const [key, entry] of value.entries()) {
        spendBytes(budget, key.asString().length);
        out.set(key, copy(entry, depth + 1));
      }
      return out;
    }

    if (value instanceof PDFArray) {
      const out = PDFArray.withContext(output.context);
      for (let i = 0, n = value.size(); i < n; i++) out.push(copy(value.get(i), depth + 1));
      return out;
    }

    if (value instanceof PDFString || value instanceof PDFHexString) {
      spendBytes(budget, value.asString().length);
      // Clones keep the raw bytes a string was written with, literal or hex.
      return value.clone();
    }
    if (value instanceof PDFName) {
      spendBytes(budget, value.asString().length);
      return value.clone();
    }
    if (value instanceof PDFNumber || value instanceof PDFBool) {
      return value.clone();
    }
    if (value === PDFNull) {
      return PDFNull;
    }
    throw refuse();
  };

  const copied = copy(root, 0);
  if (rootRef) output.context.assign(rootRef, copied);
  return copied;
}

/** Refuse a dictionary that proves itself something other than intent data.
 *
 * /Type is resolved rather than read directly: an indirect type name would
 * otherwise walk straight past the guard. The action-subtype proof is skipped
 * for the intent dictionaries themselves, whose /S is the output intent
 * subtype and may be any name including one an extension defines. */
function guardDict(source: PDFDocument, dict: PDFDict, isIntentRoot: boolean): void {
  const type = source.context.lookup(dict.get(N('Type')));
  if (type instanceof PDFName && FORBIDDEN_TYPES.has(type.asString())) throw refuse();
  if (isIntentRoot) return;
  const subtype = source.context.lookup(dict.get(N('S')));
  if (subtype instanceof PDFName && ACTION_TYPES.has(subtype.asString())) throw refuse();
}
