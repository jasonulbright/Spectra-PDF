// What a font object of a document can draw, read from the object itself:
// the code of each character and the advance of each code.
//
// ISO 32000-2 9.6.2 (Type 1 and the standard 14 fonts), 9.6.3 (TrueType),
// 9.6.5 (character encoding, Table 112), 9.7.4 and 9.7.5.2 (CIDFonts and
// Identity-H), 9.7.4.3 (glyph metrics in CIDFonts), 9.10 (extraction of text
// content: /ToUnicode and the glyph names of the Adobe Glyph List).
import { Font as StandardFont, FontNames } from '@pdf-lib/standard-fonts';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { DINGBATS_GLYPH_LIST, ENCODING_NAMES, GLYPH_LIST } from './font-encodings';

const N = PDFName.of;

export interface FontDrawing {
  /** Bytes of one character code in a string the font shows. */
  codeBytes: 1 | 2;
  /** The code that draws one character, or undefined when the font holds
   *  none for it. */
  codeOf: (character: string) => number | undefined;
  /** The advance of a code in thousandths of the text size. */
  widthOf: (code: number) => number;
  /** The code points the font holds a code for. */
  held: () => number[];
}

/** Why a font gives no drawing. */
export type FontUnreadable =
  | 'missing'      // no font dictionary
  | 'type3'        // glyphs are content streams; no character identity
  | 'encoding'     // a composite font whose codes are not CIDs (not Identity-H)
  | 'unmapped'     // no code of the font has a known character
  | 'widths';      // no /Widths and not one of the standard 14 fonts

export type FontReading = { drawing: FontDrawing } | { unreadable: FontUnreadable };

/** The part of fontkit this module uses. */
export interface FontProgram {
  hasGlyphForCodePoint: (codePoint: number) => boolean;
  glyphForCodePoint: (codePoint: number) => { id: number };
  characterSet?: number[];
}
export type OpenFontProgram = (bytes: Uint8Array) => FontProgram;

function parseList(list: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of list.split(',')) {
    const at = pair.indexOf('=');
    out.set(pair.slice(0, at), parseInt(pair.slice(at + 1), 16));
  }
  return out;
}

let glyphList: Map<string, number> | undefined;
let dingbatsList: Map<string, number> | undefined;

/** The character a glyph name stands for (9.10.2): a name of the Adobe Glyph
 *  List, or `uniXXXX` / `uXXXX[XX]`. A suffix after a period is no part of
 *  the name. Undefined for any other name. */
export function glyphNameCharacter(name: string, dingbats = false): string | undefined {
  const base = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  if (!base) return undefined;
  if (dingbats) {
    dingbatsList ??= parseList(DINGBATS_GLYPH_LIST);
    const code = dingbatsList.get(base);
    if (code !== undefined) return String.fromCodePoint(code);
  }
  glyphList ??= parseList(GLYPH_LIST);
  const listed = glyphList.get(base);
  if (listed !== undefined) return String.fromCodePoint(listed);
  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (uni) {
    let out = '';
    for (let i = 0; i < uni[1].length; i += 4) out += String.fromCharCode(parseInt(uni[1].slice(i, i + 4), 16));
    return out;
  }
  const u = /^u([0-9A-F]{4,6})$/.exec(base);
  if (u) {
    const code = parseInt(u[1], 16);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : undefined;
  }
  return undefined;
}

const tables = new Map<string, string[]>();
function encodingTable(name: keyof typeof ENCODING_NAMES): string[] {
  let table = tables.get(name);
  if (!table) {
    table = ENCODING_NAMES[name].split(',');
    // Annex D.2: of the codes WinAnsiEncoding leaves unused, a reader shows
    // a bullet; the bullet's own code is 0x95.
    if (name === 'WinAnsiEncoding') table = table.map((glyph, code) => (glyph === 'bullet' && code !== 0x95 ? '' : glyph));
    tables.set(name, table);
  }
  return table;
}

const STANDARD_14: Record<string, FontNames> = {
  'Courier': FontNames.Courier, 'Courier-Bold': FontNames.CourierBold, 'Courier-Oblique': FontNames.CourierOblique,
  'Courier-BoldOblique': FontNames.CourierBoldOblique, 'Helvetica': FontNames.Helvetica, 'Helvetica-Bold': FontNames.HelveticaBold,
  'Helvetica-Oblique': FontNames.HelveticaOblique, 'Helvetica-BoldOblique': FontNames.HelveticaBoldOblique,
  'Times-Roman': FontNames.TimesRoman, 'Times-Bold': FontNames.TimesRomanBold, 'Times-Italic': FontNames.TimesRomanItalic,
  'Times-BoldItalic': FontNames.TimesRomanBoldItalic, 'Symbol': FontNames.Symbol, 'ZapfDingbats': FontNames.ZapfDingbats,
};

function bytesOf(stream: PDFObject | undefined): Uint8Array | null {
  if (!(stream instanceof PDFStream)) return null;
  try {
    return stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  } catch {
    return null;
  }
}

function hexText(hex: string): string {
  let out = '';
  for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/** Code to text of a /ToUnicode CMap (9.10.3): its bfchar and bfrange
 *  sections. */
export function parseToUnicode(bytes: Uint8Array): Map<number, string> {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const out = new Map<number, string>();
  const hex = (token: string): string => token.replace(/[^0-9A-Fa-f]/g, '');
  for (const section of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const tokens = [...section[1].matchAll(/<([^>]*)>/g)].map((m) => hex(m[1]));
    for (let i = 0; i + 1 < tokens.length; i += 2) out.set(parseInt(tokens[i], 16), hexText(tokens[i + 1]));
  }
  for (const section of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const tokens = [...section[1].matchAll(/<([^>]*)>|(\[)|(\])/g)];
    for (let i = 0; i + 2 < tokens.length;) {
      const low = parseInt(hex(tokens[i][1] ?? ''), 16);
      const high = parseInt(hex(tokens[i + 1][1] ?? ''), 16);
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low || high - low > 0xffff) break;
      if (tokens[i + 2][2]) {
        let k = i + 3;
        for (let code = low; k < tokens.length && !tokens[k][3]; k++, code++) {
          if (code <= high) out.set(code, hexText(hex(tokens[k][1] ?? '')));
        }
        i = k + 1;
      } else {
        const first = hexText(hex(tokens[i + 2][1] ?? ''));
        if (first) {
          const head = first.slice(0, -1);
          const last = first.charCodeAt(first.length - 1);
          for (let code = low; code <= high; code++) out.set(code, head + String.fromCharCode(last + code - low));
        }
        i += 3;
      }
    }
  }
  return out;
}

const nameOf = (value: PDFObject | undefined): string | undefined => (value instanceof PDFName ? value.decodeText() : undefined);
const numberOf = (value: PDFObject | undefined): number | undefined => (value instanceof PDFNumber ? value.asNumber() : undefined);

/** /BaseFont without a subset tag (9.9.2). */
function baseFontOf(font: PDFDict): string {
  const name = nameOf(font.lookup(N('BaseFont'))) ?? '';
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}

function hasProgram(descriptor: PDFObject | undefined): boolean {
  return descriptor instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor.get(N(key)) !== undefined);
}

/** The glyph name of each code of a simple font (9.6.5, Table 112), or
 *  undefined where the encoding is the font program's own. */
function simpleGlyphNames(font: PDFDict): (string | undefined)[] {
  const descriptor = font.lookup(N('FontDescriptor'));
  const base = baseFontOf(font);
  const embedded = hasProgram(descriptor);
  const flags = descriptor instanceof PDFDict ? numberOf(descriptor.lookup(N('Flags'))) ?? 0 : 0;
  const implicit = (): (string | undefined)[] => {
    if (embedded) return new Array<string | undefined>(256).fill(undefined);
    if (base === 'Symbol') return encodingTable('Symbol');
    if (base === 'ZapfDingbats') return encodingTable('ZapfDingbats');
    // A font with no program that is not symbolic: StandardEncoding.
    if (base in STANDARD_14 || (flags & 32) !== 0) return encodingTable('StandardEncoding');
    return new Array<string | undefined>(256).fill(undefined);
  };
  const named = (name: string | undefined): (string | undefined)[] | undefined =>
    name === 'StandardEncoding' || name === 'MacRomanEncoding' || name === 'WinAnsiEncoding' || name === 'MacExpertEncoding'
      ? encodingTable(name) : undefined;
  const encoding = font.lookup(N('Encoding'));
  if (encoding instanceof PDFName) return (named(encoding.decodeText()) ?? implicit()).slice();
  const names = (encoding instanceof PDFDict ? named(nameOf(encoding.lookup(N('BaseEncoding')))) : undefined) ?? implicit();
  const out = names.slice();
  const differences = encoding instanceof PDFDict ? encoding.lookup(N('Differences')) : undefined;
  if (differences instanceof PDFArray) {
    let code = 0;
    for (let i = 0; i < differences.size(); i++) {
      const entry = differences.lookup(i);
      if (entry instanceof PDFNumber) code = entry.asNumber();
      else if (entry instanceof PDFName) {
        if (code >= 0 && code < 256) out[code] = entry.decodeText();
        code++;
      }
    }
  }
  return out;
}

/** Characters with a canonical twin (Unicode canonical equivalence): the
 *  Adobe Glyph List names the glyphs Omega, mu and Delta by the sign, and a
 *  text holds the letter. One glyph draws both. */
const TWINS: [string, string][] = [['\u2126', '\u03a9'], ['\u00b5', '\u03bc'], ['\u2206', '\u0394']];

function reverse(codes: Map<number, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const code of [...codes.keys()].sort((a, b) => a - b)) {
    const text = codes.get(code)!;
    if (text && !out.has(text)) out.set(text, code);
  }
  for (const [sign, letter] of TWINS) {
    const a = out.get(sign), b = out.get(letter);
    if (a !== undefined && b === undefined) out.set(letter, a);
    if (b !== undefined && a === undefined) out.set(sign, b);
  }
  return out;
}

function heldBy(byCharacter: Map<string, number>): number[] {
  const out: number[] = [];
  for (const character of byCharacter.keys()) {
    const code = character.codePointAt(0);
    if (code !== undefined && character.length === String.fromCodePoint(code).length) out.push(code);
  }
  return out;
}

function readSimple(font: PDFDict): FontReading {
  const base = baseFontOf(font);
  const names = simpleGlyphNames(font);
  const dingbats = base === 'ZapfDingbats';
  const codes = new Map<number, string>();
  names.forEach((name, code) => {
    const character = name ? glyphNameCharacter(name, dingbats) : undefined;
    if (character !== undefined) codes.set(code, character);
  });
  const toUnicode = bytesOf(font.lookup(N('ToUnicode')));
  if (toUnicode) for (const [code, text] of parseToUnicode(toUnicode)) if (code < 256 && text) codes.set(code, text);
  if (codes.size === 0) return { unreadable: 'unmapped' };
  const byCharacter = reverse(codes);

  const widths = font.lookup(N('Widths'));
  const descriptor = font.lookup(N('FontDescriptor'));
  let widthOf: (code: number) => number;
  if (widths instanceof PDFArray) {
    const first = numberOf(font.lookup(N('FirstChar'))) ?? 0;
    const missing = descriptor instanceof PDFDict ? numberOf(descriptor.lookup(N('MissingWidth'))) ?? 0 : 0;
    widthOf = (code) => {
      const index = code - first;
      const width = index >= 0 && index < widths.size() ? numberOf(widths.lookup(index)) : undefined;
      return width ?? missing;
    };
  } else if (base in STANDARD_14) {
    const metrics = StandardFont.load(STANDARD_14[base]);
    widthOf = (code) => {
      const name = names[code];
      return (name ? metrics.getWidthOfGlyph(name) : undefined) ?? 0;
    };
  } else {
    return { unreadable: 'widths' };
  }
  return { drawing: { codeBytes: 1, codeOf: (character) => byCharacter.get(character), widthOf, held: () => heldBy(byCharacter) } };
}

/** The advance of each CID from /W, and /DW (9.7.4.3). */
function cidWidths(descendant: PDFDict): (cid: number) => number {
  const fallback = numberOf(descendant.lookup(N('DW'))) ?? 1000;
  const widths = new Map<number, number>();
  const ranges: [number, number, number][] = [];
  const w = descendant.lookup(N('W'));
  if (w instanceof PDFArray) {
    for (let i = 0; i < w.size();) {
      const first = numberOf(w.lookup(i));
      const next = w.lookup(i + 1);
      if (first === undefined) break;
      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k++) {
          const width = numberOf(next.lookup(k));
          if (width !== undefined) widths.set(first + k, width);
        }
        i += 2;
      } else {
        const last = numberOf(next);
        const width = numberOf(w.lookup(i + 2));
        if (last === undefined || width === undefined) break;
        ranges.push([first, last, width]);
        i += 3;
      }
    }
  }
  return (cid) => {
    const own = widths.get(cid);
    if (own !== undefined) return own;
    for (const [first, last, width] of ranges) if (cid >= first && cid <= last) return width;
    return fallback;
  };
}

function readComposite(font: PDFDict, open: OpenFontProgram | undefined): FontReading {
  // Identity-H: a code is two bytes and is the CID (9.7.5.2).
  if (nameOf(font.lookup(N('Encoding'))) !== 'Identity-H') return { unreadable: 'encoding' };
  const descendants = font.lookup(N('DescendantFonts'));
  const descendant = descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
  if (!(descendant instanceof PDFDict)) return { unreadable: 'missing' };
  const widthOf = cidWidths(descendant);
  const toUnicode = bytesOf(font.lookup(N('ToUnicode')));
  if (toUnicode) {
    const codes = parseToUnicode(toUnicode);
    if (codes.size === 0) return { unreadable: 'unmapped' };
    const byCharacter = reverse(codes);
    return { drawing: { codeBytes: 2, codeOf: (character) => byCharacter.get(character), widthOf, held: () => heldBy(byCharacter) } };
  }
  // No /ToUnicode: a TrueType CIDFont names its glyphs through /CIDToGIDMap,
  // and the program's own character map gives the glyph of a character.
  const descriptor = descendant.lookup(N('FontDescriptor'));
  const program = descriptor instanceof PDFDict ? bytesOf(descriptor.lookup(N('FontFile2'))) : null;
  if (!open || !program || nameOf(descendant.lookup(N('Subtype'))) !== 'CIDFontType2') return { unreadable: 'unmapped' };
  let face: FontProgram;
  try {
    face = open(program);
    face.hasGlyphForCodePoint(0x20);
  } catch {
    return { unreadable: 'unmapped' };
  }
  const map = descendant.lookup(N('CIDToGIDMap'));
  let cidOfGlyph: (glyph: number) => number | undefined = (glyph) => glyph;
  if (map instanceof PDFStream) {
    const bytes = bytesOf(map);
    if (!bytes) return { unreadable: 'unmapped' };
    const cids = new Map<number, number>();
    for (let cid = 0; cid * 2 + 1 < bytes.length; cid++) {
      const glyph = (bytes[cid * 2] << 8) | bytes[cid * 2 + 1];
      if (glyph !== 0 && !cids.has(glyph)) cids.set(glyph, cid);
    }
    cidOfGlyph = (glyph) => cids.get(glyph);
  } else if (map !== undefined && nameOf(map) !== 'Identity') {
    return { unreadable: 'unmapped' };
  }
  const codeOf = (character: string): number | undefined => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || character.length !== String.fromCodePoint(codePoint).length) return undefined;
    try {
      if (!face.hasGlyphForCodePoint(codePoint)) return undefined;
      const glyph = face.glyphForCodePoint(codePoint).id;
      return glyph > 0 ? cidOfGlyph(glyph) : undefined;
    } catch {
      return undefined;
    }
  };
  const held = (): number[] => {
    try {
      return (face.characterSet ?? []).filter((code) => codeOf(String.fromCodePoint(code)) !== undefined);
    } catch {
      return [];
    }
  };
  return { drawing: { codeBytes: 2, codeOf, widthOf, held } };
}

/** Reads what `font` draws. `open` parses an embedded TrueType program; with
 *  none, a composite font with no /ToUnicode is unreadable. */
export function readFontDrawing(context: PDFContext, font: PDFObject | undefined, open?: OpenFontProgram): FontReading {
  const dict = context.lookup(font);
  if (!(dict instanceof PDFDict)) return { unreadable: 'missing' };
  const subtype = nameOf(dict.lookup(N('Subtype')));
  if (subtype === 'Type3') return { unreadable: 'type3' };
  if (subtype === 'Type0') return readComposite(dict, open);
  if (subtype === 'Type1' || subtype === 'MMType1' || subtype === 'TrueType') return readSimple(dict);
  return { unreadable: 'missing' };
}

/** The characters of `text` that are drawn: every code point but the line
 *  ends. A tab is drawn as a space. */
export function drawnCharacters(text: string): string[] {
  const out: string[] = [];
  for (const character of text) {
    if (character === '\n' || character === '\r') continue;
    out.push(character === '\t' ? ' ' : character);
  }
  return out;
}

/** The characters of `text` the font holds no code for, each once. */
export function charactersWithoutCode(drawing: FontDrawing, text: string): string[] {
  const missing = new Set<string>();
  for (const character of drawnCharacters(text)) if (drawing.codeOf(character) === undefined) missing.add(character);
  return [...missing];
}
