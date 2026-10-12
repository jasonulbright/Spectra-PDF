// Text strings (ISO 32000-2 7.9.2.2) read the way the importer's pdf.js
// reading reads them: the same string bytes (7.3.4) and the same decoding.
// A fingerprint taken on import and re-read from the file at commit must
// compare equal, or the original is never stripped and a re-authored copy
// lands beside it on every commit.
import { PDFHexString, PDFName, PDFString } from 'pdf-lib';

/** Bytes the importer's PDFDocEncoding decoder maps away from their Latin-1
 *  value. A byte Annex D leaves undefined keeps its Latin-1 value there, so it
 *  keeps it here too. */
export const PDF_DOC_DIFFERENCES: ReadonlyMap<number, number> = new Map([
  [0x18, 0x2d8], [0x19, 0x2c7], [0x1a, 0x2c6], [0x1b, 0x2d9], [0x1c, 0x2dd], [0x1d, 0x2db],
  [0x1e, 0x2da], [0x1f, 0x2dc], [0x80, 0x2022], [0x81, 0x2020], [0x82, 0x2021], [0x83, 0x2026],
  [0x84, 0x2014], [0x85, 0x2013], [0x86, 0x192], [0x87, 0x2044], [0x88, 0x2039], [0x89, 0x203a],
  [0x8a, 0x2212], [0x8b, 0x2030], [0x8c, 0x201e], [0x8d, 0x201c], [0x8e, 0x201d], [0x8f, 0x2018],
  [0x90, 0x2019], [0x91, 0x201a], [0x92, 0x2122], [0x93, 0xfb01], [0x94, 0xfb02], [0x95, 0x141],
  [0x96, 0x152], [0x97, 0x160], [0x98, 0x178], [0x99, 0x17d], [0x9a, 0x131], [0x9b, 0x142],
  [0x9c, 0x153], [0x9d, 0x161], [0x9e, 0x17e], [0xa0, 0x20ac],
]);

const ESCAPE = 0x1b;

/** A string of character codes. Spreading a long run of codes into one call
 *  overflows the stack, so the codes go in slices. */
export function charactersOf(codes: readonly number[]): string {
  const SLICE = 8192;
  let out = '';
  for (let i = 0; i < codes.length; i += SLICE) out += String.fromCharCode(...codes.slice(i, i + SLICE));
  return out;
}
const BACKSLASH = 0x5c;
const CR = 0x0d;
const LF = 0x0a;

/** Literal-string escapes that stand for one code (7.3.4.2, Table 3). */
const SIMPLE_ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x6e, LF], [0x72, CR], [0x74, 0x09], [0x62, 0x08], [0x66, 0x0c],
  [BACKSLASH, BACKSLASH], [0x28, 0x28], [0x29, 0x29],
]);

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

const isOctal = (code: number | undefined): code is number => code !== undefined && code >= 0x30 && code <= 0x37;

/** A hex string's codes: every non-digit is skipped and an odd final digit is
 *  read as if followed by 0 (7.3.4.3). */
function hexStringCodes(raw: string): number[] {
  const out: number[] = [];
  let high = -1;
  for (let i = 0; i < raw.length; i++) {
    const digit = hexDigit(raw.charCodeAt(i));
    if (digit === -1) continue;
    if (high === -1) high = digit;
    else {
      out.push((high << 4) | digit);
      high = -1;
    }
  }
  if (high !== -1) out.push(high << 4);
  return out;
}

/** A literal string's codes from its text as written (7.3.4.2): the escapes
 *  of Table 3, a backslash before an end of line drops both, and one to
 *  three octal digits make one code. Three digits can exceed 255; the
 *  importer keeps that code whole, so this does too. */
function literalStringCodes(raw: string): number[] {
  const codes = Array.from({ length: raw.length }, (_, i) => raw.charCodeAt(i));
  const out: number[] = [];
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] !== BACKSLASH) {
      out.push(codes[i]);
      continue;
    }
    const next = codes[++i];
    if (next === undefined) break;
    const simple = SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) out.push(simple);
    else if (isOctal(next)) {
      let value = next - 0x30;
      for (let n = 0; n < 2 && isOctal(codes[i + 1]); n++) value = (value << 3) + (codes[++i] - 0x30);
      out.push(value);
    } else if (next === CR) {
      if (codes[i + 1] === LF) i++;
    } else if (next !== LF) out.push(next);
  }
  return out;
}

/** The codes a string object stands for. The string's own `asBytes` keeps
 *  hex whitespace as digits, keeps an escaped end of line, and truncates a
 *  three-digit octal escape above 255, so it is not used. */
export function pdfStringCodes(value: PDFString | PDFHexString): number[] {
  return value instanceof PDFHexString ? hexStringCodes(value.asString()) : literalStringCodes(value.asString());
}

/** Drops every escape sequence: an ESCAPE code, the codes after it, and the
 *  closing ESCAPE when one exists. Maps every code it keeps. */
function withoutEscapes(codes: ArrayLike<number>, map: (code: number) => number): string {
  let out = '';
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === ESCAPE) {
      while (++i < codes.length && codes[i] !== ESCAPE) { /* inside an escape */ }
      continue;
    }
    out += String.fromCharCode(map(codes[i]));
  }
  return out;
}

/** Decodes a text string's codes: a UTF-16BE, UTF-16LE or UTF-8 byte order
 *  mark selects that encoding, anything else (or a BOM'd run that fails to
 *  decode) is PDFDocEncoding. Language escape sequences (7.9.2.2.2) are
 *  dropped in every form. A UTF-16 run of odd length loses its last code
 *  before either reading. */
export function decodePdfTextString(codes: ArrayLike<number>): string {
  let encoding: 'utf-16be' | 'utf-16le' | 'utf-8' | undefined;
  let body: ArrayLike<number> = codes;
  if (codes[0] === 0xfe && codes[1] === 0xff) encoding = 'utf-16be';
  else if (codes[0] === 0xff && codes[1] === 0xfe) encoding = 'utf-16le';
  else if (codes[0] === 0xef && codes[1] === 0xbb && codes[2] === 0xbf) encoding = 'utf-8';
  if (encoding) {
    if (encoding !== 'utf-8' && body.length % 2 === 1) body = Array.from(body).slice(0, -1);
    try {
      const bytes = Uint8Array.from(body, (code) => code & 0xff);
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      const units = Array.from({ length: decoded.length }, (_, i) => decoded.charCodeAt(i));
      return withoutEscapes(units, (code) => code);
    } catch {
      // A malformed run under a BOM falls through to PDFDocEncoding.
    }
  }
  return withoutEscapes(body, (code) => PDF_DOC_DIFFERENCES.get(code) ?? code);
}

/** A name's bytes (7.3.5). The parser decodes only uppercase `#XX` escapes
 *  and keeps a lowercase one as the three characters, so those are decoded
 *  here. A name written with `#23` before two hex digits reads as one escaped
 *  byte: the parsed name keeps no trace of which form the file used. */
export function pdfNameBytes(name: PDFName): number[] {
  const parsed = name.asBytes();
  const bytes: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const high = parsed[i] === 0x23 ? hexDigit(parsed[i + 1] ?? -1) : -1;
    const low = high === -1 ? -1 : hexDigit(parsed[i + 2] ?? -1);
    if (low === -1) bytes.push(parsed[i]);
    else {
      bytes.push((high << 4) | low);
      i += 2;
    }
  }
  return bytes;
}

/** A name as the importer's pdf.js reading spells it: one character per
 *  byte, so a subtype or key compares equal on both sides. */
export function pdfNameKey(name: PDFName): string {
  return charactersOf(pdfNameBytes(name));
}

/** A name's text: its bytes read as UTF-8 (7.3.5), else byte for byte. */
export function pdfNameText(name: PDFName): string {
  const bytes = pdfNameBytes(name);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return charactersOf(bytes);
  }
}
