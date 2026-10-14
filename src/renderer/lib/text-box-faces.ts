// Which bundled faces draw a text of an annotation, by the engine's rule for
// edited page text (`font_fallback.resolve_fallback_font`): the family and
// the style of the font the text was in, then the CJK face, then the
// right-to-left faces. The engine chooses and embeds the faces; this module
// answers what the engine will be asked for and whether it can answer.
import { PDFArray, PDFDict, PDFName, PDFNumber } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { BUNDLED_FACES, FACE_COVERAGE, FACE_HINTS, FACE_UNSHAPED } from './bundled-faces';

const N = PDFName.of;

export type FaceFamily = 'sans' | 'serif' | 'mono';

/** The family and style the engine is asked to draw a text in. */
export interface FaceStyle {
  family: FaceFamily;
  bold?: true;
  italic?: true;
}

export const DEFAULT_FACE_STYLE: FaceStyle = { family: 'sans' };

function descriptorsOf(context: PDFContext, font: PDFDict): PDFDict[] {
  const out: PDFDict[] = [];
  const own = font.lookup(N('FontDescriptor'));
  if (own instanceof PDFDict) out.push(own);
  const descendants = font.lookup(N('DescendantFonts'));
  if (descendants instanceof PDFArray) {
    for (let i = 0; i < descendants.size(); i++) {
      const descendant = context.lookup(descendants.get(i));
      const descriptor = descendant instanceof PDFDict ? descendant.lookup(N('FontDescriptor')) : undefined;
      if (descriptor instanceof PDFDict) out.push(descriptor);
    }
  }
  return out;
}

function baseNameOf(font: PDFDict): string {
  const base = font.lookup(N('BaseFont'));
  return base instanceof PDFName ? base.decodeText() : '';
}

/** The family and style of a font object: the descriptor flags, the italic
 *  angle, then the parts of the font name. With no font: the sans face. */
export function faceStyleOf(context: PDFContext, font: PDFObject | undefined): FaceStyle {
  const dict = context.lookup(font);
  if (!(dict instanceof PDFDict)) return DEFAULT_FACE_STYLE;
  let flags = 0;
  let bold = false;
  let italic = false;
  for (const descriptor of descriptorsOf(context, dict)) {
    const own = descriptor.lookup(N('Flags'));
    const value = own instanceof PDFNumber ? own.asNumber() : 0;
    flags |= value;
    if (value & (1 << 18)) bold = true;
    if (value & (1 << 6)) italic = true;
    const angle = descriptor.lookup(N('ItalicAngle'));
    if (angle instanceof PDFNumber && Math.abs(angle.asNumber()) > 0.1) italic = true;
  }
  const name = baseNameOf(dict).toLowerCase();
  const family: FaceFamily = flags & 1 ? 'mono' : flags & 2 ? 'serif'
    : FACE_HINTS.mono.some((hint) => name.includes(hint)) ? 'mono' : FACE_HINTS.serif.some((hint) => name.includes(hint)) ? 'serif' : 'sans';
  if (FACE_HINTS.bold.some((hint) => name.includes(hint))) bold = true;
  if (FACE_HINTS.italic.some((hint) => name.includes(hint))) italic = true;
  return { family, ...(bold ? { bold: true as const } : {}), ...(italic ? { italic: true as const } : {}) };
}

const STEMS: ReadonlySet<string> = new Set(
  Object.values(BUNDLED_FACES).flatMap((table) => Object.values(table)).flatMap((file) => {
    const stem = file.replace(/\.[^.]+$/, '');
    return [stem, stem.replace(/-Regular$/, '')];
  }),
);

/** The face a font object is a subset of, by the name after its tag (ISO
 *  32000-2 9.9.2); undefined for any other font. */
export function bundledSubsetStem(context: PDFContext, font: PDFObject | undefined): string | undefined {
  const dict = context.lookup(font);
  const name = dict instanceof PDFDict ? baseNameOf(dict) : '';
  const stem = name.includes('+') ? name.slice(name.indexOf('+') + 1) : '';
  return STEMS.has(stem) ? stem : undefined;
}

const SCRIPT_STEMS: ReadonlySet<string> = new Set(
  [BUNDLED_FACES.cjk, BUNDLED_FACES.arabic, BUNDLED_FACES.hebrew].flatMap((table) => Object.values(table)).flatMap((file) => {
    const stem = file.replace(/\.[^.]+$/, '');
    return [stem, stem.replace(/-Regular$/, '')];
  }),
);

/** Whether a face stem is a face of one script: it stands in for any family. */
export function isScriptFace(stem: string | undefined): boolean {
  return stem !== undefined && SCRIPT_STEMS.has(stem);
}

const PROGRAM_KEYS = ['FontFile', 'FontFile2', 'FontFile3'];

/** Whether a reader shows the same glyphs when the engine draws the text of
 *  `font` in its bundled faces: the font is a subset of a bundled face, or it
 *  embeds no program, so every reader already substitutes a face for it. */
export function bundledFaceStandsFor(context: PDFContext, font: PDFObject | undefined): boolean {
  const dict = context.lookup(font);
  if (!(dict instanceof PDFDict)) return false;
  const subtype = dict.lookup(N('Subtype'));
  if (subtype instanceof PDFName && subtype.decodeText() === 'Type3') return false;
  const name = baseNameOf(dict);
  if (STEMS.has(name.includes('+') ? name.slice(name.indexOf('+') + 1) : name)) return true;
  return !descriptorsOf(context, dict).some((descriptor) => PROGRAM_KEYS.some((key) => descriptor.has(N(key))));
}

/** Characters that order or join text and draw nothing; the engine's
 *  `text_box._UNDRAWN`. */
export function isUndrawn(code: number): boolean {
  return code === 0x00ad || code === 0x061c || code === 0xfeff || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2069);
}

const parsed = new Map<string, [number, number][]>();

function parseRanges(text: string): [number, number][] {
  let ranges = parsed.get(text);
  if (!ranges) {
    ranges = text === '' ? [] : text.split(',').map((part): [number, number] => {
      const at = part.indexOf('-');
      return at < 0 ? [parseInt(part, 16), parseInt(part, 16)] : [parseInt(part.slice(0, at), 16), parseInt(part.slice(at + 1), 16)];
    });
    parsed.set(text, ranges);
  }
  return ranges;
}

function holds(ranges: [number, number][], code: number): boolean {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (code < ranges[mid][0]) high = mid - 1;
    else if (code > ranges[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
}

let present: ReadonlySet<string> | undefined;

/** Gives this module the face files the fonts folder holds, as the engine
 *  answers them. Until it is given, every face of the tables counts as held. */
export function provideBundledFaces(names: readonly string[] | undefined): void {
  present = names ? new Set(names) : undefined;
}

/** Whether the face files of the fonts folder are known. */
export function bundledFacesKnown(): boolean {
  return present !== undefined;
}

/** The faces the engine tries for one character of a text of `style`, in
 *  its order (`text_box._Faces.face_for` over `resolve_fallback_font`): the
 *  first held face of the family, each held CJK face, and the first held
 *  face of each right-to-left family. */
interface Ladder {
  family: string | undefined;
  cjk: string[];
  rtl: string[];
}

function ladderOf(style: FaceStyle, faces: ReadonlySet<string> | null): Ladder {
  const key = style.bold && style.italic ? 'bolditalic' : style.bold ? 'bold' : style.italic ? 'italic' : 'regular';
  const held = (file: string): boolean => faces === null || faces.has(file);
  return {
    family: [BUNDLED_FACES[style.family][key], BUNDLED_FACES[style.family].regular, BUNDLED_FACES.sans.regular].find(held),
    cjk: [...new Set([BUNDLED_FACES.cjk[key], BUNDLED_FACES.cjk.regular])].filter(held),
    rtl: [BUNDLED_FACES.hebrew, BUNDLED_FACES.arabic]
      .map((table) => [table[key], table.regular].find(held))
      .filter((file): file is NonNullable<typeof file> => file !== undefined),
  };
}

const covers = (file: string, code: number): boolean => holds(parseRanges(FACE_COVERAGE[file] ?? ''), code);
/** The engine's `text_box.face_draws` for one character. */
const draws = (file: string, code: number): boolean => covers(file, code) && !holds(parseRanges(FACE_UNSHAPED[file] ?? ''), code);

function drawnBy(ladder: Ladder, code: number): boolean {
  if (ladder.family === undefined) return false;
  // The space is drawn from every face.
  if (code === 0x20) return true;
  if (covers(ladder.family, code)) return draws(ladder.family, code);
  for (const file of ladder.cjk) if (covers(file, code)) return draws(file, code);
  return ladder.rtl.some((file) => draws(file, code));
}

/** The characters of `text` the engine refuses for a text of `style`, each
 *  once, in text order: the characters `text_box_appearance` answers as
 *  `refused`. Line ends are not drawn as glyphs; a tab is drawn as a space.
 *  `faces` is the set of face files held; with none stated, the files of the
 *  fonts folder (`provideBundledFaces`); null stands for every face of the
 *  tables. */
export function charactersWithoutFace(
  text: string, style: FaceStyle = DEFAULT_FACE_STYLE, faces: ReadonlySet<string> | null | undefined = present,
): string[] {
  const ladder = ladderOf(style, faces ?? null);
  const missing = new Set<string>();
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === '\n' || character === '\r' || isUndrawn(code)) continue;
    if (!drawnBy(ladder, character === '\t' ? 0x20 : code)) missing.add(character);
  }
  return [...missing];
}

/** Code point ranges as `FACE_COVERAGE` writes them. */
export function coverageText(codes: Iterable<number>): string {
  const sorted = [...new Set(codes)].sort((a, b) => a - b);
  const out: string[] = [];
  let start = -1, last = -1;
  const flush = (): void => {
    if (start >= 0) out.push(start === last ? start.toString(16) : `${start.toString(16)}-${last.toString(16)}`);
  };
  for (const code of sorted) {
    if (start >= 0 && code === last + 1) last = code;
    else {
      flush();
      start = last = code;
    }
  }
  flush();
  return out.join(',');
}

/** Whether every drawn character of `text` is in `coverage`. */
export function coverageHolds(coverage: string, text: string): boolean {
  const ranges = parseRanges(coverage);
  for (const character of text) {
    if (character === '\n' || character === '\r') continue;
    const code = (character === '\t' ? ' ' : character).codePointAt(0)!;
    if (code === 0x00ad) continue;
    if (!holds(ranges, code)) return false;
  }
  return true;
}
