import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import type { ExportAnnotation } from './pdfx-format';
import { contentsHolder, entryOf } from './annotation-fingerprint';
import { nameReading } from './pdf-name-normalize';
import { pdfNameText } from './pdf-text-string';
import { noteAppearance } from './note-appearance';
import { COMMENT_KINDS } from './imported-edit';

const N = PDFName.of;


/**
 * Whether the appearance of the annotation draws /Contents.
 *
 * ISO 32000-2 12.5.6.2: a free text shows /Contents on the page; text, line,
 * square, circle, polygon, polyline, text markup, stamp, caret, ink and file
 * attachment annotations show it in a popup. 12.5.6.7 Table 178: a line with
 * /Cap true shows /Contents or /RC as a caption in its appearance.
 */
export function appearanceDrawsContents(annotation: PDFDict): boolean {
  const type = entryOf(annotation, 'Subtype');
  const subtype = type instanceof PDFName ? nameReading(type, annotation.context) : undefined;
  if (subtype === 'FreeText') return true;
  return subtype === 'Line' && entryOf(annotation, 'Cap') === PDFBool.True;
}

/** Coordinates in default user space, as flat number arrays and as arrays of
 *  such arrays (ISO 32000-2 Tables 166, 177, 178, 181, 182, 185). */
const FLAT_COORDINATES = ['QuadPoints', 'L', 'Vertices', 'CL'];
const NESTED_COORDINATES = ['InkList', 'Path'];

/**
 * The entries a redrawn annotation does not take from its original: the ones
 * a Spectra emit writes, and the ones that describe the geometry or the look
 * the emit replaces. Every other entry of the original travels: the markup
 * entries of Table 172 (/T, /Popup, /CreationDate, /IRT, /Subj, /RT, /ExData),
 * /NM, /M, /P, /StructParent, /AF and /Lang of Table 166, a note's /State,
 * /StateModel and /Open, and the private entries of any other producer.
 */
const REDRAWN = new Set([
  'Type', 'Subtype', 'Rect', 'Contents', 'C', 'F', 'AP', 'AS', 'Border', 'BS', 'BE', 'IC', 'CA', 'ca', 'BM',
  'DA', 'Q', 'LE', 'L', 'LL', 'LLE', 'LLO', 'Cap', 'CP', 'CO', 'Vertices', 'Path', 'InkList', 'QuadPoints',
  'CL', 'RD', 'IT', 'Measure', 'Rotate', 'OC',
]);

/** What the user changed that a carried entry can contradict. */
export interface CarriedChange { text: boolean; color: boolean }

export function changeOf(authored: ExportAnnotation): CarriedChange {
  const edit = authored.importedEdit;
  if (edit) return { text: edit.text, color: edit.color };
  const original = authored.importedOriginal;
  return {
    text: (authored.note ?? '') !== (original?.contents ?? ''),
    color: original?.color !== undefined && authored.color !== original.color,
  };
}

function shiftedNumbers(context: PDFContext, value: PDFObject | undefined, [dx, dy]: readonly [number, number]): PDFArray | undefined {
  const array = context.lookup(value);
  if (!(array instanceof PDFArray) || array.size() % 2 !== 0) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const entry = array.lookup(i);
    if (!(entry instanceof PDFNumber)) return undefined;
    out.push(entry.asNumber() + (i % 2 === 0 ? dx : dy));
  }
  return context.obj(out);
}

function writeModified(annot: PDFDict, modified: string | undefined): void {
  if (modified !== undefined && annot.has(N('M'))) annot.set(N('M'), PDFString.of(modified));
}

/**
 * The original with only the entries the edit changed, or undefined when the
 * edit needs the annotation drawn again.
 *
 * A move changes /Rect and every coordinate entry by one distance; a viewer
 * maps the appearance box onto /Rect (ISO 32000-2 12.5.5), so the appearance
 * stream stays as written. A new text is written to /Contents where the
 * appearance does not draw it (`appearanceDrawsContents`), and the rich text
 * that held the old text leaves. A note's colour is /C, and a note that has
 * an appearance gets one in the new colour (`noteAppearance`).
 *
 * `delta` is the move in default user space. `a` is the annotation with the
 * note the build writes.
 */
export function patchedOriginal(
  context: PDFContext,
  original: PDFDict,
  a: ExportAnnotation,
  delta: readonly [number, number],
  rgb: readonly [number, number, number],
): PDFDict | undefined {
  const edit = a.importedEdit;
  if (!edit || !keepsAppearance(original, a)) return undefined;
  const patched = original.clone(context);
  if (edit.geometry === 'moved') {
    const rect = shiftedNumbers(context, original.get(N('Rect')), delta);
    if (!rect || rect.size() !== 4) return undefined;
    patched.set(N('Rect'), rect);
    for (const key of FLAT_COORDINATES) {
      if (!original.has(N(key))) continue;
      const moved = shiftedNumbers(context, original.get(N(key)), delta);
      if (!moved) return undefined;
      patched.set(N(key), moved);
    }
    for (const key of NESTED_COORDINATES) {
      if (!original.has(N(key))) continue;
      const lists = context.lookup(original.get(N(key)));
      if (!(lists instanceof PDFArray)) return undefined;
      const moved: PDFArray[] = [];
      for (const list of lists.asArray()) {
        const one = shiftedNumbers(context, list, delta);
        if (!one) return undefined;
        moved.push(one);
      }
      patched.set(N(key), context.obj(moved));
    }
  }
  if (edit.text) {
    if (a.note || a.kind === 'note') patched.set(N('Contents'), PDFHexString.fromText(a.note ?? ''));
    else patched.delete(N('Contents'));
    patched.delete(N('RC'));
  } else if (contentsHolder(original) === original) {
    // A name is no text string (ISO 32000-2 Table 166). A written annotation
    // holds the text its name spells as a text string.
    const written = entryOf(original, 'Contents');
    if (written instanceof PDFName) {
      patched.delete(N('Contents'));
      for (const [key] of original.entries()) if (nameReading(key, context) === 'Contents') patched.delete(key);
      patched.set(N('Contents'), PDFHexString.fromText(pdfNameText(written)));
    }
  }
  if (edit.color) {
    patched.set(N('C'), context.obj([...rgb]));
    const appearance = noteAppearance(context, original, rgb, true);
    if (appearance) patched.set(N('AP'), appearance);
  }
  if (patched.get(N('OC'), true) === PDFNull) patched.delete(N('OC'));
  writeModified(patched, a.modified);
  return patched;
}

/** The original of a free text whose size changed and whose text the build
 *  cannot draw again as it was: the dictionary as written with /Rect set to
 *  `rect`. A viewer maps the appearance box onto /Rect (12.5.5, algorithm
 *  8.1), so the appearance shows scaled. /RD grows with the rectangle. */
export function scaledOriginal(
  context: PDFContext, original: PDFDict, a: ExportAnnotation, rect: readonly [number, number, number, number],
): PDFDict {
  const patched = original.clone(context);
  const from = context.lookup(original.get(N('Rect')));
  const inner = context.lookup(original.get(N('RD')));
  if (from instanceof PDFArray && from.size() === 4 && inner instanceof PDFArray && inner.size() === 4) {
    const number = (array: PDFArray, index: number): number => {
      const value = array.lookup(index);
      return value instanceof PDFNumber ? value.asNumber() : NaN;
    };
    const width = Math.abs(number(from, 2) - number(from, 0));
    const height = Math.abs(number(from, 3) - number(from, 1));
    const sx = (rect[2] - rect[0]) / width, sy = (rect[3] - rect[1]) / height;
    const scaled = [number(inner, 0) * sx, number(inner, 1) * sy, number(inner, 2) * sx, number(inner, 3) * sy];
    if (scaled.every((value) => Number.isFinite(value))) patched.set(N('RD'), context.obj(scaled));
  }
  patched.set(N('Rect'), context.obj([...rect]));
  if (patched.get(N('OC'), true) === PDFNull) patched.delete(N('OC'));
  writeModified(patched, a.modified);
  return patched;
}

/** Whether the build may keep the appearance of `original` scaled: the
 *  build's side of the model's `keepsScaledAppearance`. */
export function mayScaleAppearance(original: PDFDict, a: ExportAnnotation): boolean {
  const edit = a.importedEdit;
  if (!edit || a.kind !== 'freetext' || edit.geometry !== 'reshaped' || edit.text || edit.color || edit.style) return false;
  const appearance = entryOf(original, 'AP');
  return appearance instanceof PDFDict && entryOf(appearance, 'N') !== undefined;
}

/** Whether the edit of `a` leaves the appearance of its original valid: the
 *  build then writes the original with its changed entries, and draws
 *  nothing. A note's appearance stays valid in another colour as a copy in
 *  that colour. */
export function keepsAppearance(original: PDFDict, a: ExportAnnotation): boolean {
  const edit = a.importedEdit;
  if (!edit || a.kind === 'stamp' || edit.style || edit.geometry === 'reshaped') return false;
  if (edit.color && a.kind !== 'note') return false;
  if (edit.text && (!COMMENT_KINDS.has(a.kind) || appearanceDrawsContents(original))) return false;
  // A member of a group shows its primary's text and colour (12.5.6.2).
  if ((edit.text || edit.color) && contentsHolder(original) !== original) return false;
  return true;
}

/** Gives a redrawn annotation every entry of its original that the emit did
 *  not write and that is not in `REDRAWN`. The rich text leaves with a
 *  changed text or colour, the default style with a changed colour, and the
 *  reply link of a group member whose text or colour changed. */
export function carryOriginalEntries(annot: PDFDict, original: PDFDict, authored: ExportAnnotation): void {
  const change = changeOf(authored);
  const detached = (change.text || change.color) && contentsHolder(original) !== original;
  for (const [key, value] of original.entries()) {
    const name = nameReading(key, original.context);
    if (annot.has(key) || annot.has(N(name))) continue;
    if (REDRAWN.has(name) || name.startsWith('Spectra')) continue;
    if (name === 'RC' && (change.text || change.color)) continue;
    if (name === 'DS' && change.color) continue;
    if ((name === 'IRT' || name === 'RT') && detached) continue;
    annot.set(key, value);
  }
  writeModified(annot, authored.modified);
}
