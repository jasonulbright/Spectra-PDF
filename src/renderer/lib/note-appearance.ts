import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { entryOf } from './annotation-fingerprint';
import { nameReading } from './pdf-name-normalize';

const N = PDFName.of;

type Rgb = readonly [number, number, number];

/** Two colour components that an 8-bit channel cannot tell apart. */
const SAME = 0.5 / 255;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= SAME;

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

interface Token { start: number; end: number; text: string; number: boolean }

/** The operators that set a device colour, by the count of their operands. */
const DEVICE_COLOUR: Record<string, { count: 1 | 3 | 4; stroke: boolean }> = {
  g: { count: 1, stroke: false }, G: { count: 1, stroke: true },
  rg: { count: 3, stroke: false }, RG: { count: 3, stroke: true },
  k: { count: 4, stroke: false }, K: { count: 4, stroke: true },
};

function matches(operands: number[], from: readonly number[]): boolean {
  if (operands.length === from.length) return operands.every((value, i) => near(value, from[i]));
  // A gray and an RGB colour with three equal components are one colour.
  if (operands.length === 1 && from.length === 3) return from.every((value) => near(value, operands[0]));
  if (operands.length === 3 && from.length === 1) return operands.every((value) => near(value, from[0]));
  return false;
}

const fixed = (value: number): string => String(Math.round(value * 10000) / 10000);

/**
 * The content stream with every device colour equal to `from` set to `to`,
 * or null when it sets no such colour. Strings, dictionaries and inline image
 * data pass through as written (ISO 32000-2 7.8.2, 8.9.7).
 */
export function recolouredContent(bytes: Uint8Array, from: readonly number[], to: Rgb): Uint8Array | null {
  if (from.length !== 1 && from.length !== 3 && from.length !== 4) return null;
  const at = (i: number): number => bytes[i];
  const text = (start: number, end: number): string => {
    let out = '';
    for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
  };
  const pieces: (Uint8Array | string)[] = [];
  let copied = 0;
  let operands: Token[] = [];
  let changed = false;
  let i = 0;
  const length = bytes.length;
  while (i < length) {
    const c = at(i);
    if (WHITE.has(c)) { i++; continue; }
    if (c === 0x25) { // comment
      while (i < length && at(i) !== 10 && at(i) !== 13) i++;
      continue;
    }
    if (c === 0x28) { // literal string
      let depth = 0;
      for (; i < length; i++) {
        if (at(i) === 0x5c) i++;
        else if (at(i) === 0x28) depth++;
        else if (at(i) === 0x29 && --depth === 0) { i++; break; }
      }
      operands = [];
      continue;
    }
    if (c === 0x3c && at(i + 1) !== 0x3c) { // hex string
      while (i < length && at(i) !== 0x3e) i++;
      i++;
      operands = [];
      continue;
    }
    if (c === 0x3c || c === 0x3e) { i += 2; operands = []; continue; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) { i++; operands = []; continue; }
    const start = i;
    if (c === 0x2f) i++;
    while (i < length && !WHITE.has(at(i)) && !DELIMITERS.has(at(i))) i++;
    if (i === start) { i++; continue; }
    const word = text(start, i);
    if (c === 0x2f) { operands = []; continue; }
    if (NUMBER.test(word)) {
      operands.push({ start, end: i, text: word, number: true });
      continue;
    }
    if (word === 'ID') {
      // Inline image data ends at EI between white space.
      let j = i;
      for (; j < length; j++) {
        if (at(j) === 0x45 && at(j + 1) === 0x49 && WHITE.has(at(j - 1)) && (j + 2 >= length || WHITE.has(at(j + 2)))) break;
      }
      i = Math.min(length, j + 2);
      operands = [];
      continue;
    }
    const colour = DEVICE_COLOUR[word];
    if (colour && operands.length >= colour.count) {
      const own = operands.slice(-colour.count);
      if (matches(own.map((token) => Number(token.text)), from)) {
        pieces.push(bytes.subarray(copied, own[0].start));
        pieces.push(`${fixed(to[0])} ${fixed(to[1])} ${fixed(to[2])} ${colour.stroke ? 'RG' : 'rg'}`);
        copied = i;
        changed = true;
      }
    }
    operands = [];
  }
  if (!changed) return null;
  pieces.push(bytes.subarray(copied));
  const size = pieces.reduce((total, piece) => total + piece.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) {
    if (typeof piece === 'string') for (let k = 0; k < piece.length; k++) out[offset++] = piece.charCodeAt(k);
    else { out.set(piece, offset); offset += piece.length; }
  }
  return out;
}

const K = 0.5523;
const circle = (cx: number, cy: number, r: number): string =>
  `${cx + r} ${cy} m ${cx + r} ${fixed(cy + r * K)} ${fixed(cx + r * K)} ${cy + r} ${cx} ${cy + r} c `
  + `${fixed(cx - r * K)} ${cy + r} ${cx - r} ${fixed(cy + r * K)} ${cx - r} ${cy} c `
  + `${cx - r} ${fixed(cy - r * K)} ${fixed(cx - r * K)} ${cy - r} ${cx} ${cy - r} c `
  + `${fixed(cx + r * K)} ${cy - r} ${cx + r} ${fixed(cy - r * K)} ${cx + r} ${cy} c h `;

/** The icons of ISO 32000-2 12.5.6.4 Table 175, in a box of 20 by 20. Each is
 *  drawn after the fill colour and a dark outline are set. */
const ICONS: Record<string, string> = {
  Note: '3 2 m 17 2 l 17 18 l 7 18 l 3 14 l h B 7 18 m 7 14 l 3 14 l S 6 6 m 14 6 l S 6 9 m 14 9 l S 9 12 m 14 12 l S',
  Comment: '2 8 m 2 16 l 4 18 l 16 18 l 18 16 l 18 8 l 16 6 l 9 6 l 5 2 l 6 6 l 4 6 l h B 5 14 m 15 14 l S 5 11 m 15 11 l S',
  Key: `${circle(6, 14, 4)}${circle(6, 14, 1.5)}B* 8.5 12.5 m 16.5 4.5 l 18 6 l 16.6 7.4 l 15.4 6.2 l 14.2 7.4 l 15.4 8.6 l 14 10 l 12.8 8.8 l 10 11.6 l h B`,
  Help: `${circle(10, 10, 8)}B 1 J 1.6 w 7.5 12.5 m 7.5 15.5 12.5 15.5 12.5 12.5 c 12.5 10.5 10 10.5 10 8 c S 10 5.2 m 10 5.2 l S`,
  NewParagraph: '10 18 m 15 10 l 5 10 l h B 4 3 12 4 re B',
  Paragraph: '11 18 m 7 18 l 3 18 3 11 7 11 c 11 11 l h B 10.5 2 1.6 16 re B 13.5 2 1.6 16 re B 10.5 16.4 6 1.6 re B',
  Insert: '10 16 m 16 4 l 4 4 l h B',
};

/** The appearance stream of a text annotation's icon in `rgb`. A name the
 *  table does not list draws the default icon, Note. */
export function noteIconAppearance(context: PDFContext, name: string | undefined, rgb: Rgb): PDFObject {
  const icon = ICONS[name ?? 'Note'] ?? ICONS.Note;
  const content = `${fixed(rgb[0])} ${fixed(rgb[1])} ${fixed(rgb[2])} rg 0.2 G 0.8 w 1 j ${icon}`;
  return context.register(context.stream(content, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 20, 20] }));
}

function contentOf(stream: PDFStream): Uint8Array | null {
  try {
    return stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  } catch {
    return null;
  }
}

function recolouredStream(context: PDFContext, stream: PDFStream, from: readonly number[], to: Rgb): PDFObject | null {
  const content = contentOf(stream);
  const recoloured = content ? recolouredContent(content, from, to) : null;
  if (!recoloured) return null;
  const copy = context.stream(recoloured, {});
  for (const [key, value] of stream.dict.entries()) {
    const name = nameReading(key, context);
    if (name !== 'Length' && name !== 'Filter' && name !== 'DecodeParms') copy.dict.set(key, value);
  }
  return context.register(copy);
}

function colourOf(annotation: PDFDict): number[] | null {
  const c = entryOf(annotation, 'C');
  if (!(c instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < c.size(); i++) {
    const entry = c.lookup(i);
    if (!(entry instanceof PDFNumber)) return null;
    out.push(entry.asNumber());
  }
  return out;
}

/**
 * The /AP of a text annotation that had an appearance, for the colour `rgb`;
 * undefined for one that had none.
 *
 * With the colour as written the appearance is the original's. With a new
 * colour it is a copy of the original's normal appearance in which every
 * device colour equal to /C is the new colour, so the icon keeps the shape
 * its producer drew. An appearance that sets no such colour, or that cannot
 * be decoded, gives way to the icon /Name selects. The rollover and down
 * appearances hold the old colour and leave: a viewer then uses the normal
 * one (ISO 32000-2 12.5.5, Table 170).
 */
export function noteAppearance(context: PDFContext, original: PDFDict, rgb: Rgb, recoloured: boolean): PDFObject | undefined {
  const ap = entryOf(original, 'AP');
  if (!(ap instanceof PDFDict)) return undefined;
  const normal = entryOf(ap, 'N');
  if (!(normal instanceof PDFStream) && !(normal instanceof PDFDict)) return undefined;
  if (!recoloured) return original.get(N('AP')) ?? ap;
  const from = colourOf(original);
  const written = entryOf(original, 'Name');
  const own = (): PDFObject => noteIconAppearance(context, written instanceof PDFName ? nameReading(written, context) : undefined, rgb);
  if (normal instanceof PDFStream) {
    return context.obj({ N: (from && recolouredStream(context, normal, from, rgb)) ?? own() });
  }
  const states = context.obj({});
  for (const [key, value] of normal.entries()) {
    const stream = context.lookup(value);
    states.set(key, stream instanceof PDFStream ? (from && recolouredStream(context, stream, from, rgb)) ?? own() : value);
  }
  return context.obj({ N: states });
}
