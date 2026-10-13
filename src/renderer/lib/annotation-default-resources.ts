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
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier, PDFRef, PDFString } from 'pdf-lib';
import type { PDFObject, PDFPage } from 'pdf-lib';

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace /oldName tokens in a /DA appearance string. A PDF name token ends
// at whitespace or a delimiter, so "/Helv" must not rewrite "/HelvB".
// ONE pass over the original string, all renames as a single alternation
// with a replacer FUNCTION (regression, both verified live):
// (1) sequential per-rename .replace() passes feed each other — when a
//     rename's TARGET equals another rename's OLD name (the natural shape of
//     a document that already went through one merge, e.g. F1→F1_1 alongside
//     a pre-existing F1_1→F1_1_1), the second pass re-matches the first
//     pass's output and a field silently lands on a DIFFERENT field's font;
//     a single pass can never re-match its own substitutions.
// (2) a plain replacement STRING treats $$ / $& as patterns — a legal PDF
//     name containing '$' mangled the rewrite; a function's return value is
//     always literal.
export function rewriteDaFonts(da: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) return da;
  const alternation = [...renames.keys()]
    .sort((a, b) => b.length - a.length) // longest-first; belt to the lookahead's braces
    .map(escapeRegExp)
    .join('|');
  return da.replace(
    new RegExp(`/(${alternation})(?=[\\s/\\[\\]()<>{}%]|$)`, 'g'),
    (_m, name: string) => `/${renames.get(name)!}`,
  );
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
  sources.forEach(({ source, copiedPages }, index) => {
    const uses: Use[] = [];
    for (const page of copiedPages) {
      for (const use of usesOf(page)) {
        if (!authored.has(use.annotation)) uses.push(use);
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
