// The font an annotation's /DA names.
//
// /DA of a free text annotation is a variable-text default appearance string
// (ISO 32000-2 12.5.6.6, Table 177), and so is /DA of a redaction annotation
// that has /OverlayText (12.5.6.23, Table 195). The font its Tf operator
// names is a resource name in /Font of the interactive form's default
// resources, /DR (12.7.4.3, Table 224): the annotation has no resource
// dictionary of its own for /DA, and its appearance stream's resources serve
// the stream only. A file that holds such an annotation therefore holds
// /AcroForm /DR /Font with that name, form fields or not; /Fields is the
// dictionary's one required entry and is then empty.
//
// One name is one font. Two documents can hold different fonts under one
// name, so an annotation that travels into another document keeps its font
// under a new name when the name is taken by another font.
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObjectCopier, PDFRawStream, PDFRef, PDFStream, PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import type { PDFContext, PDFObject, PDFPage } from 'pdf-lib';

const N = PDFName.of;

/** A default appearance string as a PDF string object. Its content is
 *  content-stream syntax, read byte by byte: one byte per character, so no
 *  UTF-16 form and no byte order mark. A text with a character past one byte
 *  has no such form and is written as a text string. */
export function defaultAppearanceString(text: string): PDFHexString {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return PDFHexString.fromText(text);
    hex += code.toString(16).padStart(2, '0');
  }
  return PDFHexString.of(hex);
}

const DELIMITER = '\\s/\\[\\]()<>{}%';
const FONT_SELECTION = new RegExp(`/([^${DELIMITER}]+)\\s+[-+]?(?:\\d+\\.?\\d*|\\.\\d+)\\s+Tf(?=[${DELIMITER}]|$)`, 'g');

/** The font resource names the Tf operators of a default appearance string
 *  select, as PDF names. */
export function defaultAppearanceFonts(text: string): PDFName[] {
  return [...text.matchAll(FONT_SELECTION)].map((match) => N(match[1]));
}

const NAME_TOKEN = new RegExp(`/([^${DELIMITER}]+)(?=[${DELIMITER}]|$)`, 'g');

/**
 * Replaces the renamed font names of a default appearance string. `renames`
 * maps a name to a name, each as `PDFName.decodeText` gives it.
 *
 * A name is its bytes (ISO 32000-2 7.3.5): a token is compared by the name
 * it decodes to, so `/F#E9` and the same name written with its byte are one
 * name, and the new name is written as pdf-lib writes that name. A token
 * ends at white space or a delimiter: `/Helv` is not part of `/HelvB`. The
 * string is read once, so a new name that is itself an old name is not
 * replaced again.
 */
export function rewriteDaFonts(da: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) return da;
  return da.replace(NAME_TOKEN, (written, token: string) => {
    const to = renames.get(N(token).decodeText());
    return to === undefined ? written : N(to).asString();
  });
}

// Font subtypes that MAY be treated as interchangeable when everything else
// agrees — the simple, metadata-describable kinds. An ALLOW-list, not a
// deny-list (regression): rendering-defining data hides in
// subtype-specific places a top-level check can't see — Type0/CID fonts
// carry /FontDescriptor nested under /DescendantFonts (two different
// embedded CJK fonts deduped to one entry produce GARBLED index-based
// glyphs, not just a wrong face), and Type3 fonts have no descriptor at all
// (their rendering IS their /CharProcs streams). Any subtype not listed —
// including future/unknown ones — defaults to "never equivalent": a
// duplicate /DR entry is bloat; a false merge corrupts a field's glyphs.
const SIMPLE_FONT_SUBTYPES = new Set([N('Type1'), N('TrueType'), N('MMType1')]);

/** What makes two /DR font entries interchangeable, as one text: both are
 *  simple fonts with no font program, and their subtype, base font and
 *  encoding name agree. Null for a font that is interchangeable with no
 *  other: an embedded program, a dictionary encoding (a /Differences remap is
 *  another glyph map), a composite or Type 3 font. `value` is read in `doc`. */
export function interchangeableFontKey(doc: PDFDocument, value: unknown): string | null {
  const font = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!(font instanceof PDFDict)) return null;
  const subtype = font.get(N('Subtype'));
  if (!(subtype instanceof PDFName) || !SIMPLE_FONT_SUBTYPES.has(subtype)) return null;
  if (font.get(N('FontDescriptor')) !== undefined) return null;
  const rawEncoding = font.get(N('Encoding'));
  const encoding = rawEncoding instanceof PDFRef ? doc.context.lookup(rawEncoding) : rawEncoding;
  if (encoding !== undefined && !(encoding instanceof PDFName)) return null;
  const base = font.get(N('BaseFont'));
  if (!(base instanceof PDFName)) return null;
  return `${subtype.asString()} ${base.asString()} ${encoding instanceof PDFName ? encoding.asString() : ''}`;
}

/** The font this builder means by `Helv` in a /DA it writes. */
const STANDARD_FONT = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } as const;
const STANDARD_KEY = '/Type1 /Helvetica /WinAnsiEncoding';
const STANDARD_NAME = 'Helv';

interface Use {
  annotation: PDFDict;
  text: string;
  names: string[];
}

/** Whether the annotation's /DA is a default appearance string a reader
 *  formats text with. */
function formatsText(annotation: PDFDict): boolean {
  const subtype = annotation.lookup(N('Subtype'));
  if (subtype === N('FreeText')) return true;
  return subtype === N('Redact') && annotation.lookup(N('OverlayText')) !== undefined;
}

function usesOf(page: PDFPage): Use[] {
  const annots = page.node.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) return [];
  const uses: Use[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const annotation = annots.lookup(i);
    if (!(annotation instanceof PDFDict) || !formatsText(annotation)) continue;
    const da = annotation.lookup(N('DA'));
    if (!(da instanceof PDFString || da instanceof PDFHexString)) continue;
    const text = da.decodeText();
    const names = defaultAppearanceFonts(text).map((name) => name.decodeText());
    if (names.length > 0) uses.push({ annotation, text, names });
  }
  return uses;
}

function defaultFonts(doc: PDFDocument): PDFDict | undefined {
  const form = doc.catalog.lookup(N('AcroForm'));
  const resources = form instanceof PDFDict ? form.lookup(N('DR')) : undefined;
  const fonts = resources instanceof PDFDict ? resources.lookup(N('Font')) : undefined;
  return fonts instanceof PDFDict ? fonts : undefined;
}

export interface DefaultResourceSource {
  /** A source the build copied pages from. */
  source: PDFDocument;
  /** Its pages as they sit in the output. */
  copiedPages: PDFPage[];
}

export interface DefaultResourceContext {
  /** Annotation dictionaries this build wrote. Their /DA names this
   *  builder's own font, whatever the page's source holds under the name. */
  authored?: ReadonlySet<PDFDict>;
  /** Per source, by position: the output name of each font name of that
   *  source's /DR, as the form carry placed it. */
  bindings?: ReadonlyMap<number, ReadonlyMap<string, string>>;
  /** Annotation dictionaries this build wrote whose /DA names the given
   *  font: the font of their appearance, an object of the output. */
  ownFonts?: ReadonlyMap<PDFDict, PDFObject>;
  /** Tells a font an earlier build embedded for the text of one annotation.
   *  Such an entry of the default resources leaves when this build draws
   *  again the annotation whose /DA named it (`redrawn`), no default
   *  appearance of the output names it any more, no appearance stream draws
   *  from it through the default resources, and the output holds no
   *  signature: a revision appended to signed bytes adds entries and takes
   *  none away. */
  released?: (font: PDFObject) => boolean;
  /** Per copied page: the annotations of the source this build draws
   *  again, as the source wrote them. */
  redrawn?: ReadonlyMap<PDFPage, readonly PDFDict[]>;
  /** Every annotation dictionary this build wrote with an appearance of
   *  its own making: a font of such an appearance that equals a font the
   *  default resources hold is replaced by the held object. */
  emitted?: ReadonlySet<PDFDict>;
  /** What the font comparisons of this build read; made when none is given. */
  comparison?: FontComparison;
}

/** Whether a field of the output holds a signature value. */
function holdsSignature(output: PDFDocument): boolean {
  const seen = new Set<PDFDict>();
  const walk = (value: PDFObject | undefined): boolean => {
    const dict = output.context.lookup(value);
    if (!(dict instanceof PDFDict) || seen.has(dict)) return false;
    seen.add(dict);
    const held = dict.lookup(N('V'));
    if (held instanceof PDFDict && held.has(N('ByteRange'))) return true;
    const kids = dict.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) if (walk(kids.get(i))) return true;
    return false;
  };
  const form = output.catalog.lookup(N('AcroForm'));
  const fields = form instanceof PDFDict ? form.lookup(N('Fields')) : undefined;
  if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) if (walk(fields.get(i))) return true;
  return false;
}

const PLAIN_NAME = /^[A-Za-z0-9_.+-]+$/;

// How a stream is stored, not what it holds.
const STORAGE_KEYS: ReadonlySet<string> = new Set(['Length', 'Filter', 'DecodeParms']);
const NO_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * What one build read while it compared fonts: the decoded bytes of each
 * stream and the answer for each pair of font objects. The objects compared
 * do not change while the build holds it.
 */
export class FontComparison {
  private readonly bytes = new Map<PDFRawStream, Uint8Array | null>();
  private readonly answers = new Map<PDFDict, Map<PDFDict, boolean>>();
  /** How many streams were decoded. */
  decodes = 0;

  /** The decoded bytes of `stream`, or null for a stream that does not decode. */
  decoded(stream: PDFRawStream): Uint8Array | null {
    let held = this.bytes.get(stream);
    if (held === undefined) {
      this.decodes++;
      try {
        held = decodePDFRawStream(stream).decode();
      } catch {
        held = null;
      }
      this.bytes.set(stream, held);
    }
    return held;
  }

  /** The answer `compare` gives for the pair, asked once. */
  pair(a: PDFDict, b: PDFDict, compare: () => boolean): boolean {
    const known = this.answers.get(a)?.get(b);
    if (known !== undefined) return known;
    const answer = compare();
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let row = this.answers.get(x);
      if (!row) {
        row = new Map();
        this.answers.set(x, row);
      }
      row.set(y, answer);
    }
    return answer;
  }
}

function equalDicts(
  context: PDFContext, a: PDFDict, b: PDFDict, depth: number, skipped: ReadonlySet<string>, memo: FontComparison,
): boolean {
  const keys = (dict: PDFDict): PDFName[] => dict.keys().filter((key) => !skipped.has(key.decodeText()));
  const [own, other] = [keys(a), keys(b)];
  return own.length === other.length
    && own.every((key) => b.has(key) && equalObjects(context, a.get(key), b.get(key), memo, depth + 1));
}

/** Whether two objects of one document hold the same entries and, for a
 *  stream, the same decoded bytes. */
function equalObjects(
  context: PDFContext, a: PDFObject | undefined, b: PDFObject | undefined, memo: FontComparison, depth = 0,
): boolean {
  if (a === b) return true;
  const [x, y] = [context.lookup(a), context.lookup(b)];
  if (x === y) return true;
  if (x === undefined || y === undefined || depth > 12) return false;
  if (x instanceof PDFStream || y instanceof PDFStream) {
    if (!(x instanceof PDFRawStream && y instanceof PDFRawStream)) return false;
    if (!equalDicts(context, x.dict, y.dict, depth, STORAGE_KEYS, memo)) return false;
    const [p, q] = [memo.decoded(x), memo.decoded(y)];
    return p !== null && q !== null && p.length === q.length && p.every((byte, index) => byte === q[index]);
  }
  if (x instanceof PDFDict || y instanceof PDFDict) {
    return x instanceof PDFDict && y instanceof PDFDict && equalDicts(context, x, y, depth, NO_KEYS, memo);
  }
  if (x instanceof PDFArray || y instanceof PDFArray) {
    if (!(x instanceof PDFArray && y instanceof PDFArray) || x.size() !== y.size()) return false;
    for (let i = 0; i < x.size(); i++) if (!equalObjects(context, x.get(i), y.get(i), memo, depth + 1)) return false;
    return true;
  }
  if (x instanceof PDFNumber || y instanceof PDFNumber) {
    return x instanceof PDFNumber && y instanceof PDFNumber && x.asNumber() === y.asNumber();
  }
  const text = (value: PDFObject): Uint8Array | undefined =>
    (value instanceof PDFString || value instanceof PDFHexString ? value.asBytes() : undefined);
  const [s, t] = [text(x), text(y)];
  if (s || t) return !!s && !!t && s.length === t.length && s.every((byte, index) => byte === t[index]);
  return x.constructor === y.constructor && x.toString() === y.toString();
}

const SUBSET_TAG = /^[A-Z]{6}\+/;

/**
 * Whether two font objects are one subset: the same tagged name (ISO
 * 32000-2 9.9.2) and the same content, entry by entry. The engine derives
 * the tag of a subset from its face and what it holds and builds the same
 * bytes for the same request, so a text box drawn again with the same text
 * gives a font equal to the one an earlier build embedded. `memo` keeps what
 * the comparisons of one build read.
 */
export function sameSubsetFont(
  context: PDFContext, a: PDFObject | undefined, b: PDFObject | undefined, memo: FontComparison = new FontComparison(),
): boolean {
  const [x, y] = [context.lookup(a), context.lookup(b)];
  if (!(x instanceof PDFDict) || !(y instanceof PDFDict)) return false;
  if (x === y) return true;
  const [name, other] = [x.lookup(N('BaseFont')), y.lookup(N('BaseFont'))];
  if (!(name instanceof PDFName) || name !== other || !SUBSET_TAG.test(name.decodeText())) return false;
  return memo.pair(x, y, () => equalObjects(context, x, y, memo));
}

/** The /Font dictionary of the resources of an annotation's normal appearance. */
function appearanceFonts(annotation: PDFDict): PDFDict | undefined {
  const appearance = annotation.lookup(N('AP'));
  const normal = appearance instanceof PDFDict ? appearance.lookup(N('N')) : undefined;
  const resources = normal instanceof PDFStream ? normal.dict.lookup(N('Resources')) : undefined;
  const fonts = resources instanceof PDFDict ? resources.lookup(N('Font')) : undefined;
  return fonts instanceof PDFDict ? fonts : undefined;
}

/** The names of `names` that an appearance stream of an annotation of the
 *  output selects without holding them in its own resources: a reader takes
 *  such a font from the default resources of the form. A stream that cannot
 *  be read counts as selecting every name it does not hold. */
function drawnFromDefaults(output: PDFDocument, names: ReadonlySet<string>): Set<string> {
  const drawn = new Set<string>();
  const seen = new Set<PDFObject>();
  const read = (stream: PDFStream): void => {
    if (seen.has(stream)) return;
    seen.add(stream);
    const resources = stream.dict.lookup(N('Resources'));
    const own = resources instanceof PDFDict ? resources.lookup(N('Font')) : undefined;
    const open = [...names].filter((name) => !drawn.has(name) && !(own instanceof PDFDict && own.has(N(name))));
    if (open.length === 0) return;
    let content: string | undefined;
    try {
      const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
      content = new TextDecoder('latin1').decode(bytes);
    } catch {
      content = undefined;
    }
    for (const name of open) {
      if (content === undefined || !PLAIN_NAME.test(name)
        || new RegExp(`/${name.replace(/[.+]/g, '\\$&')}\\s+[-+.\\d]+\\s+Tf`).test(content)) drawn.add(name);
    }
  };
  const states = (value: PDFObject | undefined): void => {
    const held = output.context.lookup(value);
    if (held instanceof PDFStream) read(held);
    else if (held instanceof PDFDict) for (const [, state] of held.entries()) {
      const stream = output.context.lookup(state);
      if (stream instanceof PDFStream) read(stream);
    }
  };
  for (const page of output.getPages()) {
    const annots = page.node.lookup(N('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annotation = annots.lookup(i);
      const appearance = annotation instanceof PDFDict ? annotation.lookup(N('AP')) : undefined;
      if (appearance instanceof PDFDict) for (const key of ['N', 'R', 'D']) states(appearance.get(N(key)));
    }
  }
  return drawn;
}

/** Every font name a default appearance of the output selects: of the form,
 *  of each field, and of each annotation but those in `except`. */
function namedByDefaults(output: PDFDocument, except: ReadonlySet<PDFDict>): Set<string> {
  const named = new Set<string>();
  const seen = new Set<PDFDict>();
  const take = (dict: PDFDict): void => {
    const da = dict.lookup(N('DA'));
    if (da instanceof PDFString || da instanceof PDFHexString) {
      for (const name of defaultAppearanceFonts(da.decodeText())) named.add(name.decodeText());
    }
  };
  const walk = (value: PDFObject | undefined): void => {
    const dict = output.context.lookup(value);
    if (!(dict instanceof PDFDict) || seen.has(dict)) return;
    seen.add(dict);
    if (!except.has(dict)) take(dict);
    const kids = dict.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i));
  };
  const form = output.catalog.lookup(N('AcroForm'));
  if (form instanceof PDFDict) {
    take(form);
    const fields = form.lookup(N('Fields'));
    if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) walk(fields.get(i));
  }
  for (const page of output.getPages()) {
    const annots = page.node.lookup(N('Annots'));
    if (annots instanceof PDFArray) for (let i = 0; i < annots.size(); i++) walk(annots.get(i));
  }
  return named;
}

/** Binds every font name a free text or redaction /DA selects to the font it
 *  selected in its own document, in the output's /AcroForm /DR /Font.
 *
 *  A carried annotation keeps the font its source held under the name. A
 *  source whose /DR the form carry merged takes the carry's name for it. For
 *  any other source the entry is copied under the name when the name is
 *  free; shared when the output's entry is interchangeable with it; and
 *  otherwise placed under a new name, with the /DA of that source's
 *  annotations rewritten. A name the source did not hold stays as written.
 *
 *  An annotation this build wrote names `Helv`, the standard Helvetica face,
 *  by the same rule; so does a carried one whose own document holds no
 *  `Helv`.
 *
 *  The form dictionary is created when a name needs it and the output has
 *  none. */
export function completeAnnotationDefaultResources(
  output: PDFDocument,
  sources: readonly DefaultResourceSource[],
  context: DefaultResourceContext = {},
): void {
  const authored = context.authored ?? new Set<PDFDict>();
  const standing = defaultFonts(output);
  if (standing && context.released && context.redrawn && !holdsSignature(output)) {
    // The names the /DA of each annotation drawn again selected, as the
    // output's default resources hold them.
    const candidates = new Set<string>();
    sources.forEach(({ copiedPages }, index) => {
      const bound = context.bindings?.get(index);
      for (const page of copiedPages) {
        for (const original of context.redrawn!.get(page) ?? []) {
          const da = original.lookup(N('DA'));
          if (!(da instanceof PDFString || da instanceof PDFHexString)) continue;
          for (const selected of defaultAppearanceFonts(da.decodeText())) {
            const name = selected.decodeText();
            candidates.add(bound?.get(name) ?? name);
          }
        }
      }
    });
    if (candidates.size > 0) {
      const named = namedByDefaults(output, authored);
      const drawn = drawnFromDefaults(output, candidates);
      for (const [key, value] of standing.entries()) {
        const name = key.decodeText();
        if (candidates.has(name) && !named.has(name) && !drawn.has(name) && context.released(value)) standing.delete(key);
      }
    }
  }
  const added = new Map<string, PDFObject>();
  const held = (name: string): PDFObject | undefined => added.get(name) ?? standing?.get(N(name));
  /** The first name of the family `base`, `base_1`, ... that `accepts`. */
  const nameFor = (base: string, accepts: (entry: PDFObject) => boolean): string => {
    const first = held(base);
    if (first === undefined || accepts(first)) return base;
    for (let n = 1; ; n++) {
      const candidate = `${base}_${n}`;
      const entry = held(candidate);
      if (entry === undefined || accepts(entry)) return candidate;
    }
  };
  const rewrite = (uses: Use[], renames: Map<string, string>): void => {
    for (const [from, to] of [...renames]) if (from === to) renames.delete(from);
    if (renames.size === 0) return;
    for (const use of uses) {
      const text = rewriteDaFonts(use.text, renames);
      if (text === use.text) continue;
      use.annotation.set(N('DA'), defaultAppearanceString(text));
      use.text = text;
    }
  };

  // Uses of `Helv` that mean this builder's own font.
  const own: Use[] = [];
  // Uses whose one name means the font the build gives with the annotation.
  const named: Use[] = [];
  sources.forEach(({ source, copiedPages }, index) => {
    const uses: Use[] = [];
    for (const page of copiedPages) {
      for (const use of usesOf(page)) {
        if (!authored.has(use.annotation)) uses.push(use);
        else if (context.ownFonts?.has(use.annotation)) named.push(use);
        else if (use.names.includes(STANDARD_NAME)) own.push(use);
      }
    }
    if (uses.length === 0) return;
    const bound = context.bindings?.get(index);
    const sourceFonts = defaultFonts(source);
    let copier: PDFObjectCopier | undefined;
    const renames = new Map<string, string>();
    for (const name of new Set(uses.flatMap((use) => use.names))) {
      const carried = bound?.get(name);
      if (carried !== undefined) {
        renames.set(name, carried);
        continue;
      }
      const intended = sourceFonts?.get(N(name));
      if (intended === undefined) {
        // `Helv` with no entry in its own document reads as this builder's
        // own font: it is the name of every /DA this builder writes.
        if (name === STANDARD_NAME) own.push(...uses.filter((use) => use.names.includes(name)));
        continue;
      }
      const key = interchangeableFontKey(source, intended);
      copier ??= PDFObjectCopier.for(source.context, output.context);
      const copy = (): PDFObject => copier!.copy(intended);
      const existing = held(name);
      if (existing === undefined) {
        added.set(name, copy());
        continue;
      }
      if (key !== null && interchangeableFontKey(output, existing) === key) continue;
      // The name is another font's. A font with no interchangeable form is
      // told apart by the object the copy gives: one source object copies to
      // one output object.
      const copied = key === null ? copy() : undefined;
      const target = nameFor(name, (entry) =>
        (key !== null ? interchangeableFontKey(output, entry) === key : entry === copied));
      if (held(target) === undefined) added.set(target, copied ?? copy());
      renames.set(name, target);
    }
    rewrite(uses, renames);
  });

  if (own.length > 0) {
    const target = nameFor(STANDARD_NAME, (entry) => interchangeableFontKey(output, entry) === STANDARD_KEY);
    if (held(target) === undefined) added.set(target, output.context.register(output.context.obj(STANDARD_FONT)));
    rewrite(own, new Map([[STANDARD_NAME, target]]));
  }

  // A subset this build embedded, or copied again from its source, that
  // equals a font the default resources hold is that font: the name of the
  // held entry is the name /DA takes, the appearance selects the held
  // object, and the build adds no font for it. So a text box drawn again
  // with a text an entry already draws adds no entry and no font object,
  // with or without a signature.
  const compared = context.comparison ?? new FontComparison();
  const heldEqual = (font: PDFObject): PDFObject | undefined => {
    for (const entry of [...(standing?.values() ?? []), ...added.values()]) {
      if (entry !== font && sameSubsetFont(output.context, entry, font, compared)) return entry;
    }
    return undefined;
  };

  for (const use of named) {
    const given = context.ownFonts!.get(use.annotation)!;
    const font = heldEqual(given) ?? given;
    const name = use.names[0];
    // The family of names starts at the name without a number an earlier
    // build gave it.
    const target = nameFor(name.replace(/(?:_\d+)+$/, '') || name, (entry) => entry === font);
    if (held(target) === undefined) added.set(target, font);
    rewrite([use], new Map([[name, target]]));
  }

  for (const annotation of context.emitted ?? []) {
    const fonts = appearanceFonts(annotation);
    for (const [key, value] of fonts?.entries() ?? []) {
      const equal = heldEqual(value);
      if (equal !== undefined) fonts!.set(key, equal);
    }
  }

  if (added.size === 0) return;
  let form = output.catalog.lookup(N('AcroForm'));
  if (!(form instanceof PDFDict)) {
    form = output.context.obj({ Fields: [] });
    output.catalog.set(N('AcroForm'), output.context.register(form));
  }
  let resources = (form as PDFDict).lookup(N('DR'));
  if (!(resources instanceof PDFDict)) {
    resources = output.context.obj({});
    (form as PDFDict).set(N('DR'), resources);
  }
  let fonts = (resources as PDFDict).lookup(N('Font'));
  if (!(fonts instanceof PDFDict)) {
    fonts = output.context.obj({});
    (resources as PDFDict).set(N('Font'), fonts);
  }
  for (const [name, entry] of added) (fonts as PDFDict).set(N(name), entry);
}
