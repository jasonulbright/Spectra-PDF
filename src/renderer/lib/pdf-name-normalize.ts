// pdf-lib's parser decodes a name's `#` escapes (ISO 32000-2 7.3.5) only when
// the pair is decimal digits or uppercase hex letters, keeps a pair holding a
// lowercase a-f as the three characters, and reads a `#` that starts no
// escape the same way. pdf.js decodes every pair, and reads a `#` before one
// hex digit and another character as a failed escape that also swallows an
// escape after it. pdf-lib's writer then writes every `#` it holds as `#23`.
// So a parsed name holding `#` can read differently in pdf.js, and whatever
// the file meant, the next save writes pdf-lib's reading.
//
// `normalizeEscapedNames` settles each such name from evidence: the name
// tokens the file itself wrote, read off its bytes and its object streams. A
// parsed name is rewritten to pdf.js's reading only when every token that
// parses to it reads the same in pdf.js; a name written `#236f` reads `#6f`
// in pdf.js too and is never decoded. A name the evidence cannot settle (two
// tokens with different readings, or no token found) is left as parsed and
// recorded as unresolved, which the annotation fingerprint treats as
// ambiguous. A key whose rewrite would meet another key of its dictionary
// (`/Border` beside `/B#6frder`) is replaced by a name that is written as the
// file's own token (`writtenName`), in its place in the dictionary, so the
// save keeps both keys as pdf.js read them; that key is unresolved too.
// Remaining limit: a parsed name does not say which token wrote it, so a name
// whose tokens read two ways, and a name with no token, is saved with
// pdf-lib's `#23` spelling.
import { PDFArray, PDFDict, PDFName, PDFObjectParser, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';
import { charactersOf, pdfNameKey } from './pdf-text-string';

/** What a load may rewrite: `all` is every object, indirect names included,
 *  for a document that is saved; `annotations` is the annotation
 *  dictionaries of every page with their /AP, /AP /N, /AP /R, /AP /D, /BS and
 *  /BE, for a read that looks at nothing else. */
export type NameScope = 'annotations' | 'all';

const DELIMITERS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/** A name token's text (after the `/`) as pdf.js's lexer reads it. A `#`
 *  that starts no escape stays with the one or two characters after it, so
 *  everything between two decoded escapes is a run of the token itself and is
 *  copied as one slice: the work is one step per `#`, never one string per
 *  character. */
export function pdfjsNameReading(raw: string): string {
  let at = raw.indexOf('#');
  if (at === -1) return raw;
  const parts: string[] = [];
  let from = 0;
  while (at !== -1 && at + 1 < raw.length) {
    const high = hexValue(raw.charCodeAt(at + 1));
    if (high === -1) {
      at = raw.indexOf('#', at + 2);
      continue;
    }
    if (at + 2 >= raw.length) break;
    const low = hexValue(raw.charCodeAt(at + 2));
    if (low === -1) {
      at = raw.indexOf('#', at + 3);
      continue;
    }
    if (at > from) parts.push(raw.slice(from, at));
    parts.push(String.fromCharCode((high << 4) | low));
    from = at + 3;
    at = raw.indexOf('#', from);
  }
  if (from < raw.length) parts.push(raw.slice(from));
  return parts.join('');
}

/** A name token's text as pdf-lib's parser stores it. */
export function pdflibNameReading(raw: string): string {
  return raw.replace(/#([\dABCDEF]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Every name token holding a `#`, as written (without its `/`). A `#` in
 *  stream data or a string can yield a token that is not a name; it only
 *  adds a reading. A token has no length limit: each run of regular
 *  characters ends at a delimiter and is walked once, so the scan is linear
 *  in the bytes. */
export function scanNameTokens(bytes: Uint8Array, into: Set<string>): void {
  let at = bytes.indexOf(0x23);
  let scannedTo = 0;
  while (at !== -1) {
    if (at >= scannedTo) {
      let start = at;
      while (start > 0 && !DELIMITERS.has(bytes[start - 1])) start--;
      let end = at + 1;
      while (end < bytes.length && !DELIMITERS.has(bytes[end])) end++;
      if (start > 0 && bytes[start - 1] === 0x2f) into.add(charactersOf(bytes, start, end));
      scannedTo = end;
    }
    at = bytes.indexOf(0x23, at + 1);
  }
}

/** The object streams' decoded contents: names inside them are not in the
 *  file bytes as written. pdf-lib unpacks these streams at load without
 *  keeping them, so each is parsed again from the bytes. */
function objectStreamContents(bytes: Uint8Array, context: PDFContext): Uint8Array[] {
  const out: Uint8Array[] = [];
  const marker = [0x4f, 0x62, 0x6a, 0x53, 0x74, 0x6d]; // ObjStm
  // `header` is the offset just after the last `obj` keyword before `at`.
  // Both offsets only move forward and each object is parsed once, so the
  // search is linear in the bytes however far a marker is from its keyword.
  let header = -1;
  let next = objectHeaderEnd(bytes, 0);
  let parsed = -1;
  let at = bytes.indexOf(marker[0]);
  while (at !== -1) {
    if (marker.every((code, k) => bytes[at + k] === code)) {
      while (next !== -1 && next <= at) {
        header = next;
        next = objectHeaderEnd(bytes, next);
      }
      if (header !== -1 && header !== parsed) {
        parsed = header;
        try {
          const object = PDFObjectParser.forBytes(bytes.subarray(header), context).parseObject();
          if (object instanceof PDFRawStream) out.push(decodePDFRawStream(object).decode());
        } catch {
          // An object stream that does not parse adds no evidence.
        }
      }
    }
    at = bytes.indexOf(marker[0], at + 1);
  }
  return out;
}

/** The offset just after the first `obj` keyword at or after `from`, or -1. */
function objectHeaderEnd(bytes: Uint8Array, from: number): number {
  let i = bytes.indexOf(0x6f, from);
  while (i !== -1) {
    if (bytes[i + 1] === 0x62 && bytes[i + 2] === 0x6a && (i === 0 || DELIMITERS.has(bytes[i - 1]))) return i + 3;
    i = bytes.indexOf(0x6f, i + 1);
  }
  return -1;
}

interface Evidence {
  /** The pdf.js readings of the tokens that parse to one spelling. */
  readings: Set<string>;
  /** The first of those tokens in the file. */
  token: string;
}

/** Parsed spelling → what the tokens that parse to it say. */
function nameEvidence(bytes: Uint8Array, context: PDFContext): Map<string, Evidence> {
  const tokens = new Set<string>();
  scanNameTokens(bytes, tokens);
  for (const contents of objectStreamContents(bytes, context)) scanNameTokens(contents, tokens);
  const evidence = new Map<string, Evidence>();
  for (const token of tokens) {
    const parsed = pdflibNameReading(token);
    const reading = pdfjsNameReading(token);
    if (!parsed.includes('#') && parsed === reading) continue;
    let known = evidence.get(parsed);
    if (!known) evidence.set(parsed, (known = { readings: new Set(), token }));
    known.readings.add(reading);
  }
  return evidence;
}

const unresolvedByContext = new WeakMap<PDFContext, Set<string>>();

const writtenNames = new WeakMap<PDFContext, Map<string, PDFName>>();
const parsedOfWritten = new WeakMap<PDFName, string>();

/** A name that is written as `token`, the bytes a file wrote after the `/`,
 *  and reads as `parsed`, the parsed spelling of that token; one object per
 *  token in each context, held no longer than the context and the
 *  dictionaries that use it. It is not the pooled name of any spelling, so it
 *  is a key of its own beside the name its token reads as. A copy of its
 *  dictionary into another document holds the same object, which carries its
 *  token and its reading itself: nothing is looked up in the context it came
 *  from. It is unresolved in every context. */
function writtenName(context: PDFContext, token: string, parsed: string): PDFName {
  let names = writtenNames.get(context);
  if (!names) writtenNames.set(context, (names = new Map()));
  let name = names.get(token);
  if (!name) {
    name = Object.create(PDFName.prototype) as PDFName;
    Object.defineProperty(name, 'encodedName', { value: `/${token}` });
    names.set(token, name);
    parsedOfWritten.set(name, parsed);
  }
  return name;
}

/** Marks `target` as holding names copied from normalised documents: a name
 *  copied from one already holds pdf.js's reading there. The names a source
 *  left unresolved are not carried: a spelling unresolved in one source says
 *  nothing about another source that wrote it, so whether a copied object
 *  holds an unresolved name is asked of the object it was copied from. */
export function inheritNameReadings(target: PDFContext, sources: readonly PDFContext[]): void {
  if (!sources.every((source) => unresolvedByContext.has(source))) return;
  if (!unresolvedByContext.has(target)) unresolvedByContext.set(target, new Set());
}

/** How pdf.js spells a parsed name of this context. After the normaliser ran,
 *  each name it could settle already holds pdf.js's reading and is taken as
 *  written; otherwise an undecoded lowercase escape is decoded
 *  (`pdfNameKey`), the reading of a file that wrote it bare. */
export function nameReading(name: PDFName, context: PDFContext): string {
  const kept = parsedOfWritten.get(name);
  if (kept !== undefined) return kept;
  const written = name.asString();
  if (!written.includes('#')) return written.slice(1);
  if (!holdsHash(name)) return parsedText(name);
  return unresolvedByContext.has(context) ? parsedText(name) : pdfNameKey(name);
}

/** Whether the parsed name holds a `#` character. pdf-lib writes every
 *  irregular byte as `#xx` (a space as `#20`), and a `#` itself always as
 *  `#23`, so only that spelling says the name holds one. */
const holdsHash = (name: PDFName): boolean => parsedOfWritten.has(name) || name.asString().includes('#23');

const parsedText = (name: PDFName): string => parsedOfWritten.get(name) ?? charactersOf(name.asBytes());

/** Whether the load left this name as parsed because the file's tokens could
 *  not settle how pdf.js reads it. Undefined when no load of this context
 *  ran the normaliser. */
export function nameIsUnresolved(name: PDFName, context: PDFContext): boolean | undefined {
  if (parsedOfWritten.has(name)) return true;
  const unresolved = unresolvedByContext.get(context);
  if (!unresolved) return undefined;
  return holdsHash(name) && unresolved.has(parsedText(name));
}

class Settler {
  private readonly cache = new Map<PDFName, PDFName>();
  constructor(
    private readonly context: PDFContext,
    private readonly evidence: Map<string, Evidence>,
    private readonly unresolved: Set<string>,
  ) {}

  /** The name pdf.js reads for a parsed one, or the name itself. */
  settle(name: PDFName): PDFName {
    if (parsedOfWritten.has(name) || !holdsHash(name)) return name;
    const known = this.cache.get(name);
    if (known) return known;
    const parsed = parsedText(name);
    let settled = name;
    if (parsed.includes('#')) {
      const readings = this.evidence.get(parsed)?.readings;
      if (!readings || readings.size !== 1) this.unresolved.add(parsed);
      else {
        const [reading] = readings;
        // `PDFName.of` decodes `#` pairs in the text it is given, so each `#`
        // pdf.js keeps is handed over as `#23`.
        if (reading !== parsed) settled = PDFName.of(reading.replace(/#/g, '#23'));
      }
    }
    this.cache.set(name, settled);
    return settled;
  }

  /** Rewrites a dictionary's keys and name values; nested objects are left
   *  to `deep` when given. Two keys that settle to one name are a collision:
   *  pdf.js keeps the one written later, and one dictionary cannot hold both
   *  under one name. Only the keys of a collision are held back, each as a
   *  token the file wrote (a rewritten key has one reading, so every token
   *  of it reads the same). Every key keeps its place: the order of two keys
   *  with one reading decides which of them pdf.js keeps. */
  dict(dict: PDFDict, deep?: (value: PDFObject) => void): void {
    const entries = dict.entries();
    const values: PDFObject[] = [];
    const keys: PDFName[] = [];
    let rename = false;
    for (const [key, value] of entries) {
      let kept = value;
      if (value instanceof PDFName) kept = this.settle(value);
      else if (value instanceof PDFArray) this.array(value, deep);
      else if (deep) deep(value);
      values.push(kept);
      if (kept !== value) dict.set(key, kept);
      const settled = this.settle(key);
      keys.push(settled);
      if (settled !== key) rename = true;
    }
    if (!rename) return;
    const uses = new Map<PDFName, number>();
    for (const key of keys) uses.set(key, (uses.get(key) ?? 0) + 1);
    const collides = keys.map((key) => uses.get(key)! > 1);
    for (let i = 0; i < keys.length; i++) {
      const [key] = entries[i];
      if (!collides[i] || keys[i] === key) continue;
      const parsed = parsedText(key);
      keys[i] = writtenName(this.context, this.evidence.get(parsed)!.token, parsed);
    }
    for (const [key] of entries) dict.delete(key);
    for (let i = 0; i < keys.length; i++) dict.set(keys[i], values[i]);
  }

  array(array: PDFArray, deep?: (value: PDFObject) => void): void {
    for (let i = 0; i < array.size(); i++) {
      const value = array.get(i);
      if (value instanceof PDFName) {
        const next = this.settle(value);
        if (next !== value) array.set(i, next);
      } else if (deep) deep(value);
    }
  }
}

/** Whether any parsed name in scope holds a `#`: the fast path for a
 *  document that needs no evidence. */
function anyEscapedName(doc: PDFDocument, scope: NameScope): boolean {
  // The annotations pass follows references one level at a time, as it
  // settles them; the `all` pass meets every indirect object anyway.
  // `probed` holds the greatest depth each reference was followed with. A
  // reference met again with no greater depth reaches nothing new, so each
  // indirect object is examined at most once per depth: references that form
  // a cycle or fan in on one object cost no more than the objects they name.
  // The depth bound keeps /P and /Parent from reaching the whole file.
  let probed: Map<PDFRef, number> | undefined;
  const hasHash = (raw: PDFObject | undefined, depth: number): boolean => {
    let value = raw;
    if (scope === 'annotations' && raw instanceof PDFRef) {
      const before = probed?.get(raw);
      if (before !== undefined && before >= depth) return false;
      (probed ??= new Map()).set(raw, depth);
      value = doc.context.lookup(raw);
    }
    if (value instanceof PDFName) return holdsHash(value);
    if (depth < 0) return false;
    if (value instanceof PDFDict) {
      for (const [key, inner] of value.entries()) if (holdsHash(key) || hasHash(inner, depth - 1)) return true;
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) if (hasHash(value.get(i), depth - 1)) return true;
    } else if (value instanceof PDFStream) return hasHash(value.dict, depth - 1);
    return false;
  };
  if (scope === 'all') {
    for (const [, object] of doc.context.enumerateIndirectObjects()) if (hasHash(object, Infinity)) return true;
    return false;
  }
  return annotationDicts(doc).some((dict) => hasHash(dict, 3));
}

function annotationDicts(doc: PDFDocument): PDFDict[] {
  const out: PDFDict[] = [];
  for (const page of doc.getPages()) {
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = doc.context.lookup(annots.get(i));
      if (dict instanceof PDFDict) out.push(dict);
    }
  }
  return out;
}

/**
 * Rewrites the parsed names in `scope` to the reading pdf.js gives the
 * file's own tokens (see the module comment). `bytes` are the bytes the
 * document was loaded from. A document with no `#` in a name in scope is
 * walked once and reads nothing more.
 */
export function normalizeEscapedNames(doc: PDFDocument, bytes: Uint8Array, scope: NameScope): void {
  const unresolved = new Set<string>();
  unresolvedByContext.set(doc.context, unresolved);
  if (!anyEscapedName(doc, scope)) return;
  const settler = new Settler(doc.context, nameEvidence(bytes, doc.context), unresolved);
  if (scope === 'all') {
    const deep = (value: PDFObject): void => {
      if (value instanceof PDFDict) settler.dict(value, deep);
      else if (value instanceof PDFArray) settler.array(value, deep);
      else if (value instanceof PDFStream) settler.dict(value.dict, deep);
    };
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
      if (object instanceof PDFName) {
        const next = settler.settle(object);
        if (next !== object) doc.context.assign(ref, next);
      } else deep(object);
    }
    const trailer = doc.context.trailerInfo;
    for (const value of [trailer.Root, trailer.Info, trailer.Encrypt, trailer.ID]) if (value) deep(value);
    return;
  }
  // A name or an array held by reference (`/AS 9 0 R`, an indirect /LE) is
  // settled where it lives, or the sidecar would read it unsettled while the
  // build's `all` pass rewrites it.
  // Each reference is handled once: an array may hold itself, or two arrays
  // each other.
  const seen = new Set<PDFRef>();
  const indirect = (value: PDFObject): void => {
    if (!(value instanceof PDFRef) || seen.has(value)) return;
    seen.add(value);
    const target = doc.context.lookup(value);
    if (target instanceof PDFName) {
      const next = settler.settle(target);
      if (next !== target) doc.context.assign(value, next);
    } else if (target instanceof PDFArray) settler.array(target, indirect);
  };
  for (const annot of annotationDicts(doc)) {
    settler.dict(annot, indirect);
    for (const key of ['AP', 'BS', 'BE']) {
      const inner = doc.context.lookup(annot.get(PDFName.of(key)));
      if (!(inner instanceof PDFDict)) continue;
      settler.dict(inner, indirect);
      if (key !== 'AP') continue;
      for (const state of ['N', 'R', 'D']) {
        const states = doc.context.lookup(inner.get(PDFName.of(state)));
        if (states instanceof PDFDict) settler.dict(states, indirect);
      }
    }
  }
}
