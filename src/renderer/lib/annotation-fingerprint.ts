// The rectangle the importer's pdf.js reading reports for an annotation, read
// off the file's own dictionary. The import fingerprint holds that rectangle,
// so the commit compares against the same value or never strips the original
// and adds a copy beside it on every commit.
//
// pdf.js keeps /Rect (normalised, or [0 0 0 0] when it is not four numbers)
// except where it draws an appearance of its own for an annotation that has
// none: there the rectangle becomes the box of what it draws.
import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFStream, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { nameIsUnresolved, nameReading } from './pdf-name-normalize';
import { charactersOf, pdfStringCodes } from './pdf-text-string';
import { maxOf, minOf } from './coordinate-bounds';

export type Rect = [number, number, number, number];

const N = (name: string): PDFName => PDFName.of(name);

/** The value stored under the key spelt `name`, unresolved, null included.
 *  pdf.js decodes a key's `#xx` escapes in either case (7.3.5); pdf-lib's
 *  parser keeps a key such as `/B#6frder` under that literal spelling, so a
 *  dictionary holding any key with a `#` is read by pdf.js's spelling
 *  (`nameReading`). Two
 *  spellings of one key are two entries here and one in pdf.js, where the
 *  one written later replaces the other; the entries keep file order, so the
 *  last match is taken. A dictionary with no `#` key is read by exact key.
 *  One spelling written twice keeps its first position with its last value,
 *  so `/Border [0 0 1] /B#6frder [0 0 3] /Border [0 0 5]` reads [0 0 3] here
 *  and [0 0 5] in pdf.js: the parsed dictionary no longer holds the order. */
export function rawEntry(dict: PDFDict, name: string): PDFObject | undefined {
  const entries = dict.entries();
  // `PDFName.of` decodes `#` pairs in the text it is given, so a decoded name
  // holding one (`A#41`) would look up another key (`AA`) by exact key.
  if (!name.includes('#') && !entries.some(([key]) => key.asString().includes('#'))) return dict.get(N(name), true);
  let found: PDFObject | undefined;
  for (const [key, value] of entries) {
    if (nameReading(key, dict.context) === name) found = value;
  }
  return found;
}

/** The value under the key spelt `name`, resolved; null reads as absent, as
 *  pdf-lib's own `lookup` reads it. */
export function entryOf(dict: PDFDict, name: string): PDFObject | undefined {
  const raw = rawEntry(dict, name);
  if (raw === undefined || raw === PDFNull) return undefined;
  const value = dict.context.lookup(raw);
  return value === PDFNull ? undefined : value;
}

/** Whether the key is in the dictionary, as pdf.js asks it: a key whose value
 *  is null is present. pdf-lib's own `has` reports such a key absent. */
function hasKey(dict: PDFDict, name: string): boolean {
  return rawEntry(dict, name) !== undefined;
}

/** The values of an array of numbers, or null when it is not one (or not of
 *  `length` when a length is given). */
function numberArray(value: unknown, length: number | null): number[] | null {
  if (!(value instanceof PDFArray)) return null;
  if (length !== null && value.size() !== length) return null;
  const out: number[] = [];
  for (let i = 0; i < value.size(); i++) {
    const item = value.lookup(i);
    if (!(item instanceof PDFNumber)) return null;
    out.push(item.asNumber());
  }
  return out;
}

function normalized([x0, y0, x1, y1]: readonly number[]): Rect {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function intersects(a: Rect, b: Rect): boolean {
  const xLow = Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2]));
  const xHigh = Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]));
  if (xLow > xHigh) return false;
  const yLow = Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3]));
  const yHigh = Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]));
  return !(yLow > yHigh);
}

function grow(box: Rect, x0: number, y0: number, x1: number, y1: number): void {
  box[0] = Math.min(box[0], x0, x1);
  box[1] = Math.min(box[1], y0, y1);
  box[2] = Math.max(box[2], x0, x1);
  box[3] = Math.max(box[3], y0, y1);
}

const empty = (): Rect => [Infinity, Infinity, -Infinity, -Infinity];

/** Whether pdf.js finds a normal appearance (12.5.5): /AP /N as a stream, or
 *  as a dictionary holding a stream under the name in /AS. */
export function hasNormalAppearance(dict: PDFDict): boolean {
  const ap = entryOf(dict, 'AP');
  if (!(ap instanceof PDFDict)) return false;
  const normal = entryOf(ap, 'N');
  if (normal instanceof PDFStream) return true;
  if (!(normal instanceof PDFDict)) return false;
  const state = entryOf(dict, 'AS');
  if (!(state instanceof PDFName)) return false;
  return entryOf(normal, nameReading(state, dict.context)) instanceof PDFStream;
}

/** A border width as pdf.js takes it: a name is 0, a positive number wider
 *  than half the rectangle is 1, a number is itself, anything else is 1. */
function widthOf(value: unknown, rect: Rect): number {
  if (value instanceof PDFName) return 0;
  if (!(value instanceof PDFNumber)) return 1;
  const width = value.asNumber();
  if (width > 0) {
    const maxWidth = (rect[2] - rect[0]) / 2;
    const maxHeight = (rect[3] - rect[1]) / 2;
    if (maxWidth > 0 && maxHeight > 0 && (width > maxWidth || width > maxHeight)) return 1;
  }
  return width;
}

/** An object as pdf.js holds it, spelt the way a JavaScript string
 *  conversion spells that value: a string is its characters, a number its
 *  digits, an array its elements joined by commas (null as nothing), and a
 *  name, dictionary, stream or reference never a number. */
function jsText(value: unknown): string {
  if (value instanceof PDFNumber) return String(value.asNumber());
  if (value instanceof PDFBool) return String(value.asBoolean());
  if (value instanceof PDFString || value instanceof PDFHexString) return charactersOf(pdfStringCodes(value));
  if (value === PDFNull) return '';
  if (value instanceof PDFArray) return value.asArray().map(jsText).join(',');
  return '[object]';
}

/** `+value` for an object as pdf.js holds it. A reference to an object the
 *  file does not hold resolves to null there (7.3.10), which is 0. */
function jsNumber(value: unknown): number {
  if (value instanceof PDFNumber) return value.asNumber();
  if (value instanceof PDFBool) return value.asBoolean() ? 1 : 0;
  if (value === PDFNull || value === undefined) return 0;
  return Number(jsText(value));
}

function jsTruthy(value: unknown): boolean {
  if (value === undefined || value === PDFNull) return false;
  if (value instanceof PDFNumber) return value.asNumber() !== 0 && !Number.isNaN(value.asNumber());
  if (value instanceof PDFBool) return value.asBoolean();
  if (value instanceof PDFString || value instanceof PDFHexString) return pdfStringCodes(value).length > 0;
  return true;
}

/** Whether a dash pattern (12.5.4, Table 168 /D) sets the border width to 0
 *  in pdf.js: an array with an entry that is not a number at least 0, or a
 *  non-empty array of zeros; or any other value that is not falsy.
 *  `resolved` says whether the array's own entries were resolved, which pdf.js
 *  does for /BS /D and not inside /Border. */
function dashVoidsWidth(dash: unknown, resolved: boolean): boolean {
  if (dash instanceof PDFArray) {
    if (dash.size() === 0) return false;
    let allZeros = true;
    for (let i = 0; i < dash.size(); i++) {
      const value = jsNumber(resolved ? dash.lookup(i) : dash.get(i));
      if (!(value >= 0)) return true;
      if (value > 0) allZeros = false;
    }
    return allZeros;
  }
  return jsTruthy(dash);
}

/** The border width (12.5.4): /BS /W, else the third /Border entry, else 0;
 *  a dash pattern pdf.js rejects (/BS /D, or a fourth /Border entry) makes it
 *  0. */
function borderWidth(dict: PDFDict, rect: Rect): number {
  if (hasKey(dict, 'BS')) {
    const bs = entryOf(dict, 'BS');
    if (!(bs instanceof PDFDict)) return 1;
    // A /Type that is falsy as pdf.js holds it (absent, null, 0, false, an
    // empty string) counts as no type at all.
    const type = entryOf(bs, 'Type');
    const typed = !jsTruthy(type) || (type instanceof PDFName && nameReading(type, dict.context) === 'Border');
    if (!typed) return 1;
    return dashVoidsWidth(entryOf(bs, 'D'), true) ? 0 : widthOf(entryOf(bs, 'W'), rect);
  }
  if (hasKey(dict, 'Border')) {
    const border = entryOf(dict, 'Border');
    if (!(border instanceof PDFArray)) return 1;
    if (border.size() >= 3) {
      if (border.size() === 4 && dashVoidsWidth(border.lookup(3), false)) return 0;
      return widthOf(border.lookup(2), rect);
    }
    return border.size() === 0 ? 0 : 1;
  }
  return 0;
}

/** Each quadrilateral's box (12.5.6.10), or null when /QuadPoints is not a
 *  non-empty list of whole quadrilaterals. */
function quadBoxes(dict: PDFDict): Rect[] | null {
  const raw = numberArray(entryOf(dict, 'QuadPoints'), null);
  if (!raw || raw.length === 0 || raw.length % 8 > 0) return null;
  const points = raw.map(Math.fround);
  const boxes: Rect[] = [];
  for (let i = 0; i < points.length; i += 8) {
    const xs = [points[i], points[i + 2], points[i + 4], points[i + 6]];
    const ys = [points[i + 1], points[i + 3], points[i + 5], points[i + 7]];
    boxes.push([minOf(xs), minOf(ys), maxOf(xs), maxOf(ys)]);
  }
  return boxes;
}

/** The points of a path, each widened by twice the stroke, and the rectangle
 *  pdf.js keeps: /Rect when it meets that box, the box when it does not. */
function pathRect(rect: Rect, points: ArrayLike<number>[], width: number): Rect {
  const adjust = 2 * width;
  const box = empty();
  for (const list of points) {
    for (let i = 0; i < list.length; i += 2) {
      grow(box, list[i] - adjust, list[i + 1] - adjust, list[i] + adjust, list[i + 1] + adjust);
    }
  }
  return intersects(rect, box) ? rect : box;
}

/** The dictionary whose /Contents pdf.js reads for a markup annotation: a
 *  group reply (12.5.6.2, /IRT with /RT /Group) shows its parent's. */
export function contentsHolder(dict: PDFDict): PDFDict {
  if (!hasKey(dict, 'IRT')) return dict;
  const type = entryOf(dict, 'RT');
  if (!(type instanceof PDFName) || nameReading(type, dict.context) !== 'Group') return dict;
  const parent = entryOf(dict, 'IRT');
  return parent instanceof PDFDict ? parent : dict;
}

/** The file's /Rect normalised (7.9.5), or null when it is not four numbers. */
export function readableRect(dict: PDFDict): Rect | null {
  const raw = numberArray(entryOf(dict, 'Rect'), 4);
  return raw ? normalized(raw) : null;
}

/** The rectangle pdf.js reports for one annotation of `subtype`. */
export function importedRect(dict: PDFDict, subtype: string): Rect {
  const rect: Rect = readableRect(dict) ?? [0, 0, 0, 0];
  if (hasNormalAppearance(dict)) return rect;
  switch (subtype) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut': {
      const boxes = quadBoxes(dict);
      if (!boxes) return rect;
      const box = empty();
      for (const [x0, y0, x1, y1] of boxes) grow(box, x0, y0, x1, y1);
      return box;
    }
    case 'Squiggly': {
      const boxes = quadBoxes(dict);
      if (!boxes) return rect;
      const box = empty();
      for (const [x0, y0, x1, y1] of boxes) {
        const dy = (y1 - y0) / 6;
        grow(box, x0, y0 - 2 * dy, x1, y0 + 2 * dy);
      }
      return box;
    }
    case 'Line': {
      const width = borderWidth(dict, rect) || 1;
      const line = normalized(numberArray(entryOf(dict, 'L'), 4) ?? [0, 0, 0, 0]);
      const adjust = 2 * width;
      const lineBox: Rect = [line[0] - adjust, line[1] - adjust, line[2] + adjust, line[3] + adjust];
      const kept = intersects(rect, lineBox) ? rect : lineBox;
      return [kept[0] - width, kept[1] - width, kept[2] + width, kept[3] + width];
    }
    case 'PolyLine':
    case 'Polygon': {
      const vertices = numberArray(entryOf(dict, 'Vertices'), null);
      if (!vertices) return rect;
      return pathRect(rect, [Float32Array.from(vertices)], borderWidth(dict, rect) || 1);
    }
    case 'Ink': {
      const lists = entryOf(dict, 'InkList');
      if (!(lists instanceof PDFArray)) return rect;
      const points: Float32Array[] = [];
      for (let i = 0; i < lists.size(); i++) {
        const list = lists.lookup(i);
        if (!(list instanceof PDFArray)) continue;
        const values = new Float32Array(list.size());
        for (let j = 0; j < list.size(); j += 2) {
          const x = list.lookup(j);
          const y = j + 1 < list.size() ? list.lookup(j + 1) : undefined;
          if (x instanceof PDFNumber && y instanceof PDFNumber) {
            values[j] = x.asNumber();
            values[j + 1] = y.asNumber();
          }
        }
        points.push(values);
      }
      return pathRect(rect, points, borderWidth(dict, rect) || 1);
    }
    default:
      return rect;
  }
}

const isHexCode = (code: number | undefined): boolean => code !== undefined
  && ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66));

/** Whether pdf.js's reading of a parsed name is unknown (7.3.5). After a load
 *  that ran `normalizeEscapedNames`, that is a name the file's own tokens
 *  could not settle. Without one, a `#` before one hex digit and another
 *  character is counted: pdf.js may have read a failed escape there, which
 *  also swallows an escape after it (`/#6#41` parses as `#6A`, pdf.js reads
 *  `#6#41`). A `#` and one hex digit at the end of a name read the same on
 *  both sides. */
export function nameSpellingIsLost(name: PDFName, context?: PDFContext): boolean {
  const settled = context ? nameIsUnresolved(name, context) : undefined;
  if (settled !== undefined) return settled;
  const bytes = name.asBytes();
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x23 || !isHexCode(bytes[i + 1])) continue;
    if (i + 2 < bytes.length && !isHexCode(bytes[i + 2])) return true;
  }
  return false;
}

function keysAreAmbiguous(dict: PDFDict): boolean {
  const seen = new Set<string>();
  for (const key of dict.keys()) {
    if (nameSpellingIsLost(key, dict.context)) return true;
    const decoded = nameReading(key, dict.context);
    if (seen.has(decoded)) return true;
    seen.add(decoded);
  }
  return false;
}

/**
 * Whether this annotation reads differently in pdf.js and in its parsed
 * dictionary, so no fingerprint taken from one can be compared with the
 * other: a key of the annotation, of its /BS, /BE, /AP or /AP /N, or a name
 * the fingerprint and the sidecar read (/Subtype, /AS, /RT, /IT, /LE,
 * /BS /Type, /BE /S, a name-typed /Contents, the /AP /N keys) holds a spelling
 * the parse has lost (`nameSpellingIsLost`), or two keys of one dictionary
 * decode to one name, which leaves which of them pdf.js keeps to file order
 * the parse has also lost. Such an annotation is left as it is: not imported,
 * so never stripped or re-authored.
 */
export function annotationDictionaryIsAmbiguous(dict: PDFDict): boolean {
  if (keysAreAmbiguous(dict)) return true;
  const names: unknown[] = ['Subtype', 'AS', 'RT', 'IT', 'Contents'].map((key) => entryOf(dict, key));
  const le = entryOf(dict, 'LE');
  if (le instanceof PDFArray) {
    for (let i = 0; i < le.size(); i++) names.push(le.lookup(i));
  } else names.push(le);
  for (const key of ['BS', 'BE', 'AP']) {
    const inner = entryOf(dict, key);
    if (!(inner instanceof PDFDict)) continue;
    if (keysAreAmbiguous(inner)) return true;
    if (key === 'BS') names.push(entryOf(inner, 'Type'));
    if (key === 'BE') names.push(entryOf(inner, 'S'));
    if (key === 'AP') {
      const normal = entryOf(inner, 'N');
      if (normal instanceof PDFDict && keysAreAmbiguous(normal)) return true;
    }
  }
  return names.some((value) => value instanceof PDFName && nameSpellingIsLost(value, dict.context));
}
