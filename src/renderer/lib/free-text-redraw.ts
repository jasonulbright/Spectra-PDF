// How the text of an imported free text annotation is drawn again.
//
// ISO 32000-2 12.5.6.6 Table 177: /DA is the default appearance string that
// formats the text, /Q its alignment, /RC the rich text that generates the
// appearance and /DS its default style. The text is drawn in the font the
// original appearance drew it in: the same font object, with the codes and
// the advances that object gives (`annotation-font.ts`). A text the user
// changed that the font cannot draw is drawn in the bundled face that matches
// the font. A text that cannot be drawn as the original showed it refuses.
import { PDFArray, PDFContext, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { charactersWithoutCode, drawnCharacters, readFontDrawing } from './annotation-font';
import type { FontDrawing, OpenFontProgram } from './annotation-font';
import { entryOf } from './annotation-fingerprint';
import { DEFAULT_FACE_STYLE, bundledFaceStandsFor, bundledSubsetStem, charactersWithoutFace, coverageText, faceStyleOf, isScriptFace } from './text-box-faces';
import type { FaceStyle } from './text-box-faces';

const SOFT_HYPHEN = '\u00ad';

/** The glyphs a text may show. A soft hyphen is a break marker, so it needs
 *  no code of its own; if the text has one, the chosen face must hold the
 *  hyphen-minus that a taken break draws. */
export function textForGlyphCoverage(text: string): string {
  const visible = text.split(SOFT_HYPHEN).join('');
  return visible + (visible === text ? '' : '-');
}

const N = PDFName.of;

/** A font as an appearance stream shows text in it. */
export interface TextFace {
  /** The resource name the appearance selects it by. */
  name: string;
  font: PDFObject;
  /** The string operand that shows `text`. */
  show: (text: string) => string;
  /** The advance of `text` at `size`, in points. */
  width: (text: string, size: number) => number;
  /** The standard Helvetica face every /DA of this builder names `Helv`. */
  standard?: boolean;
}

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const DELIMITER = '\\s/\\[\\]()<>{}%';
const SELECT = new RegExp(`/([^${DELIMITER}]+)\\s+(${NUMBER})\\s+Tf(?=[${DELIMITER}]|$)`, 'g');
const COLOR = new RegExp(`(?:^|[${DELIMITER}])((?:${NUMBER}\\s+){3}rg|${NUMBER}\\s+g|(?:${NUMBER}\\s+){4}k)(?=[${DELIMITER}]|$)`);
const LEADING = new RegExp(`(?:^|[${DELIMITER}])(${NUMBER})\\s+TL(?=[${DELIMITER}]|$)`, 'g');

function stringOf(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFStream) {
    try {
      const bytes = value instanceof PDFRawStream ? decodePDFRawStream(value).decode() : value.getContents();
      let out = '';
      for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return out;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Content stream text with its string operands emptied, so an operator
 *  inside a shown string is not read as one. */
function withoutStrings(content: string): string {
  return content.replace(/\((?:\\[\s\S]|[^\\()])*\)/g, '()').replace(/<[0-9A-Fa-f\s]*>/g, '<>');
}

interface CssStyle { size?: number; color?: string; align?: 0 | 1 | 2; lineHeight?: { points?: number; factor?: number }; face: string }

const fixed = (value: number): string => String(Math.round(value * 10000) / 10000);

function cssColor(value: string): string | undefined {
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    const part = (i: number): string => fixed(parseInt(digits.slice(i, i + 2), 16) / 255);
    return `${part(0)} ${part(2)} ${part(4)} rg`;
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value.trim());
  return rgb ? `${fixed(Math.min(255, Number(rgb[1])) / 255)} ${fixed(Math.min(255, Number(rgb[2])) / 255)} ${fixed(Math.min(255, Number(rgb[3])) / 255)} rg` : undefined;
}

/** The properties of a style string of 12.5.6.6 (/DS, and the style
 *  attributes of /RC) that place and size text. `face` names every property
 *  that selects the look of a run, for comparing two runs. */
export function parseTextStyle(style: string): CssStyle {
  const out: CssStyle = { face: '' };
  const look: string[] = [];
  for (const declaration of style.split(';')) {
    const at = declaration.indexOf(':');
    if (at < 0) continue;
    const property = declaration.slice(0, at).trim().toLowerCase();
    const value = declaration.slice(at + 1).trim();
    const points = (text: string): number | undefined => {
      const match = /(\d+\.?\d*|\.\d+)\s*pt\b/i.exec(text);
      return match ? Number(match[1]) : undefined;
    };
    if (property === 'font-size' || property === 'font') {
      const size = points(value);
      if (size !== undefined && size > 0) out.size = size;
    }
    if (property === 'color') out.color = cssColor(value) ?? out.color;
    if (property === 'text-align') {
      const align = value.toLowerCase();
      out.align = align === 'center' ? 1 : align === 'right' ? 2 : 0;
    }
    if (property === 'line-height') {
      const size = points(value);
      const percent = /^(\d+\.?\d*)\s*%$/.exec(value);
      const factor = /^(\d+\.?\d*|\.\d+)$/.exec(value);
      if (size !== undefined) out.lineHeight = { points: size };
      else if (percent) out.lineHeight = { factor: Number(percent[1]) / 100 };
      else if (factor) out.lineHeight = { factor: Number(factor[1]) };
    }
    if (['font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'color', 'text-decoration', 'vertical-align'].includes(property)) {
      look.push(`${property}:${value.toLowerCase().replace(/\s+/g, ' ')}`);
    }
  }
  out.face = look.sort().join(';');
  return out;
}

interface RichStyle { body: CssStyle; mixed: boolean }

/** The look an element gives its text by its tag alone. */
const TAG_LOOK: Record<string, string> = {
  b: 'font-weight:bold', strong: 'font-weight:bold', i: 'font-style:italic', em: 'font-style:italic',
  u: 'text-decoration:underline', s: 'text-decoration:line-through', strike: 'text-decoration:line-through',
  sup: 'vertical-align:super', sub: 'vertical-align:sub',
};

/** The style of a rich text string: the style its text runs share, each run
 *  with the declarations of the elements around it, the inner over the
 *  outer. `mixed`: two runs differ in look; the style is then the style of
 *  the first run. */
export function parseRichText(rich: string): RichStyle {
  const stack: Map<string, string>[] = [new Map()];
  const runs: CssStyle[] = [];
  for (const match of rich.matchAll(/<(\/?)([A-Za-z][\w:-]*)\b([^>]*?)(\/?)>|<[?!][^>]*>|([^<]+)/g)) {
    if (match[5] !== undefined) {
      if (match[5].replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').trim() === '' || stack.length < 2) continue;
      runs.push(parseTextStyle([...stack[stack.length - 1]].map(([property, value]) => `${property}:${value}`).join(';')));
      continue;
    }
    if (match[2] === undefined) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (match[4]) continue;
    const own = new Map(stack[stack.length - 1]);
    const attribute = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[3]);
    for (const declaration of [TAG_LOOK[tag] ?? '', ...(attribute ? (attribute[1] ?? attribute[2] ?? '').split(';') : [])]) {
      const at = declaration.indexOf(':');
      if (at < 0) continue;
      const property = declaration.slice(0, at).trim().toLowerCase();
      // The last declaration wins, so an inner one stands after an outer one.
      own.delete(property);
      own.set(property, declaration.slice(at + 1).trim());
    }
    stack.push(own);
  }
  return { body: runs[0] ?? { face: '' }, mixed: new Set(runs.map((run) => run.face)).size > 1 };
}

interface OriginalText {
  size?: number;
  leading?: number;
  align: 0 | 1 | 2;
  textColor?: string;
  borderWidth?: number;
  /** The font the text is in, with its resource name. */
  font?: { name: string; object: PDFObject };
  /** Every font the appearance selects that its resources hold; with none,
   *  the font /DA names. */
  fonts: PDFObject[];
  /** The original writes an alignment (/Q, or a style). */
  aligned: boolean;
  /** The original names no font object and its appearance selects none: the
   *  file defines no face for the text. */
  faceless: boolean;
  /** The /DA as written, when its font name selects a font. */
  da?: PDFObject;
  /** The text is in more than one style. */
  mixed: boolean;
}

/** Reads how the original shows its text. `sourceFont` gives the font the
 *  original's document holds under a name of its default resources, as an
 *  object of the output. */
export function originalText(
  context: PDFContext, original: PDFDict, sourceFont: (name: string) => PDFObject | undefined,
): OriginalText {
  const daObject = entryOf(original, 'DA');
  const da = daObject instanceof PDFString || daObject instanceof PDFHexString ? String.fromCharCode(...daObject.asBytes()) : '';
  const selections = [...da.matchAll(SELECT)];
  const selected = selections.length > 0 ? selections[selections.length - 1] : undefined;
  const daSize = selected && Number(selected[2]) > 0 ? Number(selected[2]) : undefined;
  const daLeading = [...da.matchAll(LEADING)].map((match) => Number(match[1])).filter((value) => value > 0).pop();

  const appearance = entryOf(original, 'AP');
  let normal = appearance instanceof PDFDict ? entryOf(appearance, 'N') : undefined;
  if (normal instanceof PDFDict && !(normal instanceof PDFStream)) {
    const state = entryOf(original, 'AS');
    normal = state instanceof PDFName ? entryOf(normal, state.decodeText()) : undefined;
  }
  const resources = normal instanceof PDFStream ? normal.dict.lookup(N('Resources')) : undefined;
  const fonts = resources instanceof PDFDict ? resources.lookup(N('Font')) : undefined;
  const drawn = normal instanceof PDFStream ? withoutStrings(stringOf(normal) ?? '') : '';
  const drawnFonts = [...drawn.matchAll(SELECT)].map((match) => ({ name: match[1], size: Number(match[2]) }));
  const drawnNames = new Set(drawnFonts.map((entry) => entry.name));
  const drawnSizes = new Set(drawnFonts.map((entry) => entry.size));
  const drawnLeadings = new Set([...drawn.matchAll(LEADING)].map((match) => Number(match[1])).filter((value) => value > 0));
  const held = (name: string | undefined): PDFObject | undefined =>
    (name !== undefined && fonts instanceof PDFDict ? fonts.get(N(name)) : undefined);

  const rc = stringOf(entryOf(original, 'RC'));
  const rich = rc !== undefined ? parseRichText(rc) : undefined;
  const ds = stringOf(entryOf(original, 'DS'));
  const style = ds !== undefined ? parseTextStyle(ds) : undefined;

  const size = rich?.body.size ?? style?.size ?? daSize ?? (drawnSizes.size === 1 && [...drawnSizes][0] > 0 ? [...drawnSizes][0] : undefined);
  const lineHeight = rich?.body.lineHeight ?? style?.lineHeight;
  const leading = lineHeight?.points ?? (lineHeight?.factor !== undefined && size !== undefined ? lineHeight.factor * size : undefined)
    ?? daLeading ?? (drawnLeadings.size === 1 ? [...drawnLeadings][0] : undefined);

  const q = entryOf(original, 'Q');
  const quadding = q instanceof PDFNumber && (q.asNumber() === 1 || q.asNumber() === 2) ? (q.asNumber() as 1 | 2) : 0;
  const border = entryOf(original, 'BS');
  const width = border instanceof PDFDict ? border.lookup(N('W')) : undefined;
  const array = entryOf(original, 'Border');
  const third = array instanceof PDFArray && array.size() >= 3 ? array.lookup(2) : undefined;
  const borderWidth = width instanceof PDFNumber ? width.asNumber() : border instanceof PDFDict ? undefined
    : third instanceof PDFNumber ? third.asNumber() : undefined;

  // The font the appearance shows the text in. An appearance that selects
  // one font shows all its text in it; otherwise the font /DA names, from
  // the appearance's resources or the document's default resources.
  const only = drawnNames.size === 1 ? [...drawnNames][0] : undefined;
  const daFont = selected?.[1];
  const font = held(only) !== undefined ? { name: only!, object: held(only)! }
    : held(daFont) !== undefined ? { name: daFont!, object: held(daFont)! }
      : daFont !== undefined && sourceFont(daFont) !== undefined ? { name: daFont, object: sourceFont(daFont)! }
        : undefined;
  const color = COLOR.exec(da);
  const drawnObjects = [...drawnNames].map((name) => held(name)).filter((entry): entry is PDFObject => entry !== undefined);
  const shown = drawnObjects.length > 0 ? drawnObjects : font ? [font.object] : [];
  // Faces of one style that differ only by script are one style: the
  // subsets of bundled faces a text in several scripts is drawn in.
  const oneLook = shown.length > 1 && shown.every((entry) => bundledSubsetStem(context, entry) !== undefined)
    && new Set(shown.map((entry) => {
      const look = faceStyleOf(context, entry);
      return `${look.bold === true}/${look.italic === true}`;
    })).size === 1;
  return {
    ...(size !== undefined ? { size } : {}),
    ...(leading !== undefined ? { leading } : {}),
    align: rich?.body.align ?? style?.align ?? quadding,
    ...(rich?.body.color ?? style?.color ?? color?.[1] ? { textColor: (rich?.body.color ?? style?.color ?? color![1]).replace(/\s+/g, ' ') } : {}),
    ...(borderWidth !== undefined && borderWidth >= 0 ? { borderWidth } : {}),
    ...(font ? { font } : {}),
    fonts: shown,
    aligned: rich?.body.align !== undefined || style?.align !== undefined || q instanceof PDFNumber,
    // A /DA whose font name selects no font is not written again.
    ...(daObject !== undefined && daFont !== undefined && (held(daFont) !== undefined || sourceFont(daFont) !== undefined)
      ? { da: original.get(N('DA')) ?? daObject } : {}),
    faceless: !font && drawnNames.size === 0,
    mixed: (rich?.mixed ?? false) || (drawnNames.size > 1 && !oneLook) || drawnSizes.size > 1,
  };
}

/** A default appearance string with its non-stroking colour set to `color`,
 *  a colour operator with its operands. */
export function defaultAppearanceWithColor(da: string, color: string): string {
  const match = COLOR.exec(da);
  if (!match) return `${color} ${da}`.trim();
  const at = match.index + match[0].indexOf(match[1]);
  return da.slice(0, at) + color + da.slice(at + match[1].length);
}

/** Scripts whose text is not one glyph per character from left to right: the
 *  right-to-left and the joining scripts, the scripts of South and Southeast
 *  Asia that reorder or stack, conjoining Hangul jamo, and the bidirectional
 *  controls. Drawing them needs a shaper and a line reordered for display. */
const SHAPED: [number, number][] = [
  [0x0590, 0x08ff], [0x0900, 0x109f], [0x1100, 0x11ff], [0x1780, 0x18af], [0x1900, 0x1cff], [0x200e, 0x200f],
  [0x202a, 0x202e], [0x2066, 0x2069], [0xa800, 0xabff], [0xd7b0, 0xd7ff], [0xfb1d, 0xfdff], [0xfe70, 0xfefe],
  [0x10800, 0x10fff], [0x11000, 0x11fff], [0x1e800, 0x1efff],
];

export function needsShaping(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x0590) continue;
    if (SHAPED.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

/** The face of a font object: every character is one code. */
export function faceOf(name: string, font: PDFObject, drawing: FontDrawing): TextFace {
  const digits = drawing.codeBytes * 2;
  return {
    name,
    font,
    show: (text) => {
      let hex = '';
      for (const character of drawnCharacters(text)) hex += (drawing.codeOf(character) ?? 0).toString(16).padStart(digits, '0');
      return `<${hex}>`;
    },
    width: (text, size) => {
      let total = 0;
      for (const character of drawnCharacters(text)) total += drawing.widthOf(drawing.codeOf(character) ?? 0);
      return (total * size) / 1000;
    },
  };
}

/** A text as the build draws it. */
export interface DrawnText {
  /** A text object. Its origin is the top left corner of the text; the first
   *  baseline is one `size` below it. Empty when the text has no glyph. */
  content: string;
  /** The fonts the content selects, by resource name. The first is the font
   *  of the first character: the one a /DA names. */
  fonts: [string, PDFObject][];
  /** The lines in logical order, and the advance of each in points. */
  lines: string[];
  widths: number[];
  size: number;
  /** Baseline to baseline, in points. */
  leading: number;
  /** 0 left, 1 centred, 2 right. */
  align: 0 | 1 | 2;
  /** The base direction of the text is right to left. */
  rtl: boolean;
  /** The first font is the standard Helvetica every /DA of this builder
   *  names `Helv`. */
  standard: boolean;
  /** The fonts are subsets of bundled faces this build embedded. */
  bundled: boolean;
  /** The indexes of the lines that end with a drawn soft hyphen. */
  hyphens?: number[];
}

/** What the original of an imported text box gives its redraw. */
export interface CarriedStyle {
  /** The non-stroking colour operator of the text as the original set it. */
  textColor?: string;
  /** /BS /W, or the third entry of /Border. */
  borderWidth?: number;
  /** The /DA as written, when it stays: the text is in the original's font. */
  da?: PDFObject;
}

/** How a text is drawn: in a font object by its own codes, or by the engine
 *  in bundled faces; or why it is not drawn. */
export type TextPlan =
  | ({ via: 'font'; face: TextFace; size: number; leading: number; align: 0 | 1 | 2 } & CarriedStyle)
  | ({ via: 'engine'; style: FaceStyle; size: number; leading: number; align?: 0 | 1 | 2 } & CarriedStyle)
  | { refusal: 'font' | 'styled' }
  | { refusal: 'script'; characters: string[] };

export type RedrawRefusal = 'font' | 'styled' | 'script';

/** The size and the leading of a text box this editor creates. */
export const OWN_TEXT_SIZE = 12;
export const LEADING_FACTOR = 1.2;

const STANDARD_FONT = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } as const;

/** The standard Helvetica face over `font`, a font object with the entries
 *  of `STANDARD_FONT`. */
export function standardFace(context: PDFContext, font: PDFObject): TextFace {
  const reading = readFontDrawing(context, font);
  if (!('drawing' in reading)) throw new Error('the standard Helvetica font gives no drawing');
  return { ...faceOf('Helv', font, reading.drawing), standard: true };
}

let standardCodes: FontDrawing | undefined;

function standardDrawing(): FontDrawing {
  if (!standardCodes) {
    const context = PDFContext.create();
    const reading = readFontDrawing(context, context.obj(STANDARD_FONT));
    if (!('drawing' in reading)) throw new Error('the standard Helvetica font gives no drawing');
    standardCodes = reading.drawing;
  }
  return standardCodes;
}

/** Whether the standard Helvetica font holds a code for every character of
 *  `text`: every character is in WinAnsiEncoding (ISO 32000-2 Annex D). */
export function standardTextHolds(text: string): boolean {
  return charactersWithoutCode(standardDrawing(), text).length === 0;
}

/** The advance of `text` in the standard Helvetica at `size`, in points. */
export function standardAdvance(text: string, size: number): number {
  const codes = standardDrawing();
  let total = 0;
  for (const character of drawnCharacters(text)) total += codes.widthOf(codes.codeOf(character) ?? 0);
  return (total * size) / 1000;
}

/** The string operand that shows `text` in a font with WinAnsiEncoding. A
 *  character with no code is never replaced by another: it throws. */
export function standardShow(text: string): string {
  const codes = standardDrawing();
  let hex = '';
  for (const character of drawnCharacters(text)) {
    const code = codes.codeOf(character);
    if (code === undefined) throw new Error('a character has no code in WinAnsiEncoding');
    hex += code.toString(16).padStart(2, '0');
  }
  return `<${hex}>`;
}

/** How a text this editor authors is drawn: the standard Helvetica when it
 *  holds every character, else the bundled faces. `standard` gives the
 *  font object of the output. */
export function planOwnText(
  context: PDFContext, text: string, standard: () => PDFObject, size = OWN_TEXT_SIZE, style: FaceStyle = DEFAULT_FACE_STYLE,
): TextPlan {
  const leading = size * LEADING_FACTOR;
  if (style === DEFAULT_FACE_STYLE && !needsShaping(text) && standardTextHolds(text)) {
    return { via: 'font', face: standardFace(context, standard()), size, leading, align: 0 };
  }
  const missing = charactersWithoutFace(textForGlyphCoverage(text), style);
  if (missing.length > 0) return { refusal: 'script', characters: missing };
  return { via: 'engine', style, size, leading };
}

export interface RedrawJob {
  original: PDFDict;
  /** The text the build writes. */
  text: string;
  /** The user changed the text. */
  textChanged: boolean;
  sourceFont: (name: string) => PDFObject | undefined;
}

/** The family and style a redraw in bundled faces asks for: those of the
 *  first font that is not itself a face of another script. */
function styleOfFonts(context: PDFContext, fonts: PDFObject[]): FaceStyle {
  const scriptFace = (font: PDFObject): boolean => isScriptFace(bundledSubsetStem(context, font));
  return faceStyleOf(context, fonts.find((font) => !scriptFace(font)) ?? fonts[0]);
}

/**
 * How one edited free text is drawn again, or why it is not.
 *
 * The text is drawn in the original's font when the appearance is in one
 * font, that font gives a code and an advance for every character, and no
 * character needs shaping or a right-to-left line. A file that defines no
 * face for the text gets the standard Helvetica when it holds the text.
 *
 * Otherwise the engine draws the text in bundled faces when the user changed
 * the text, when a character needs shaping, or when the bundled faces stand
 * for the fonts of the original (`bundledFaceStandsFor`). Any other edit
 * refuses: `styled` for an unchanged text in more than one style, `font`
 * for an unchanged text in a font that cannot be read, `script` for a
 * character no bundled face holds.
 *
 * `standard` gives the standard Helvetica font of the output; with none the
 * plan is read only for its refusal.
 */
export function planFreeTextRedraw(
  context: PDFContext, job: RedrawJob, open: OpenFontProgram | undefined, standard?: () => PDFObject,
): TextPlan {
  const read = originalText(context, job.original, job.sourceFont);
  if (!job.textChanged && read.mixed) return { refusal: 'styled' };
  const shaped = needsShaping(job.text);
  const replaceable = read.faceless || (read.fonts.length > 0 && read.fonts.every((font) => bundledFaceStandsFor(context, font)));
  const size = read.size ?? (job.textChanged || replaceable ? OWN_TEXT_SIZE : undefined);
  if (size === undefined) return { refusal: 'font' };
  const carried: CarriedStyle = {
    ...(read.textColor ? { textColor: read.textColor } : {}),
    ...(read.borderWidth !== undefined ? { borderWidth: read.borderWidth } : {}),
  };
  const leading = read.leading ?? size * LEADING_FACTOR;
  if (!shaped && read.font && read.fonts.length <= 1) {
    const reading = readFontDrawing(context, read.font.object, open);
    if ('drawing' in reading && charactersWithoutCode(reading.drawing, textForGlyphCoverage(job.text)).length === 0) {
      return {
        via: 'font', face: faceOf(read.font.name, read.font.object, reading.drawing), size, leading, align: read.align,
        ...carried, ...(read.da ? { da: read.da } : {}),
      };
    }
  }
  // A file that defines no face for the text: a reader shows it in a face of
  // its own choice. The build shows it in its standard face.
  if (!shaped && read.faceless && standardTextHolds(textForGlyphCoverage(job.text))) {
    const font = standard ? standard() : context.obj(STANDARD_FONT);
    return { via: 'font', face: standardFace(context, font), size, leading, align: read.align, ...carried };
  }
  if (job.textChanged || replaceable || shaped) {
    const style = styleOfFonts(context, read.font ? [...read.fonts, read.font.object] : read.fonts);
    const missing = charactersWithoutFace(textForGlyphCoverage(job.text), style);
    if (missing.length > 0) return { refusal: 'script', characters: missing };
    return { via: 'engine', style, size, leading, ...(read.aligned ? { align: read.align } : {}), ...carried };
  }
  return { refusal: 'font' };
}

/** What the import records of a free text for its later edits. */
export interface TextRedrawRecord {
  /** Why a redraw with the text unchanged refuses. */
  refusal?: RedrawRefusal;
  /** The family and style a changed text is drawn in. */
  style: FaceStyle;
  /** The characters the original's font draws, when a changed text can stay
   *  in it: code point ranges (`coverageText`). */
  holds?: string;
  /** The size the original states for its text, in points. */
  size?: number;
  /** The original's font is the standard Helvetica with WinAnsiEncoding. */
  standard?: true;
  /** The file defines no face for the text. */
  faceless?: true;
  /** The alignment the original states (/Q, /DS or /RC): 0 left, 1 centred,
   *  2 right. With none stated a text takes the alignment of its direction. */
  align?: 0 | 1 | 2;
}

const heldTexts = new WeakMap<object, string>();
const nameText = (value: PDFObject | undefined): string | undefined => (value instanceof PDFName ? value.decodeText() : undefined);

/** Reads the record of `original`, whose text is `contents`. */
export function textRedrawRecord(
  context: PDFContext, original: PDFDict, contents: string, sourceFont: (name: string) => PDFObject | undefined,
  open: OpenFontProgram | undefined,
): TextRedrawRecord {
  const plan = planFreeTextRedraw(context, { original, text: contents, textChanged: false, sourceFont }, open);
  const read = originalText(context, original, sourceFont);
  const style = styleOfFonts(context, read.font ? [...read.fonts, read.font.object] : read.fonts);
  let holds: string | undefined;
  if (read.font && read.fonts.length <= 1) {
    const dict = context.lookup(read.font.object);
    const reading = readFontDrawing(context, read.font.object, open);
    if ('drawing' in reading && dict !== undefined) {
      holds = heldTexts.get(dict);
      if (holds === undefined) {
        holds = coverageText(reading.drawing.held());
        heldTexts.set(dict, holds);
      }
    }
  }
  const fontDict = read.font ? context.lookup(read.font.object) : undefined;
  const standard = fontDict instanceof PDFDict && read.fonts.length <= 1
    && nameText(fontDict.lookup(N('Subtype'))) === 'Type1' && nameText(fontDict.lookup(N('BaseFont'))) === 'Helvetica'
    && nameText(fontDict.lookup(N('Encoding'))) === 'WinAnsiEncoding' && !fontDict.has(N('FontDescriptor'));
  return {
    ...('refusal' in plan ? { refusal: plan.refusal } : {}),
    style,
    ...(holds !== undefined ? { holds } : {}),
    ...(read.size !== undefined ? { size: read.size } : {}),
    ...(standard ? { standard: true as const } : {}),
    ...(read.faceless ? { faceless: true as const } : {}),
    ...(read.aligned ? { align: read.align } : {}),
  };
}

/** What a line draws of its text. A soft hyphen draws nothing inside a
 *  line; a line that ends at its break (`hyphen`) draws a hyphen-minus. */
export function shownLine(line: string, hyphen: boolean): string {
  const inside = line.includes(SOFT_HYPHEN) ? line.split(SOFT_HYPHEN).join('') : line;
  return hyphen ? inside + '-' : inside;
}

export interface WrappedText {
  /** The lines in logical order, soft hyphens kept. */
  lines: string[];
  /** The indexes of the lines that end with a drawn soft hyphen. */
  hyphens: number[];
}

/**
 * Greedy line breaking by the face's own advances. A paragraph ends at a
 * line end; a line breaks at a space, after a soft hyphen inside a word, and
 * inside a word wider than the line. With no width a line ends only where
 * the text ends one.
 *
 * `measure` is given what a line draws (`shownLine`). A line that breaks
 * after a soft hyphen draws the hyphen, so it breaks there only when the
 * hyphen fits. A word cut by character after a soft hyphen draws the hyphen
 * past the width. `text_box._wrap` of the engine holds the same rule.
 */
export function wrapLines(text: string, width: number | undefined, measure: (line: string) => number): WrappedText {
  const lines: string[] = [];
  const hyphens: number[] = [];
  const push = (line: string, hyphen: boolean): void => {
    if (hyphen) hyphens.push(lines.length);
    lines.push(line);
  };
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (width === undefined) {
      push(paragraph, false);
      continue;
    }
    const fits = (line: string, hyphen = false): boolean => measure(shownLine(line, hyphen)) <= width;
    // The length of the longest head of `word` that ends at a soft hyphen
    // inside the word and fits after `lead` with its hyphen drawn; 0 for none.
    const softCut = (lead: string, word: string): number => {
      for (let at = word.length - 2; at >= 0; at--) {
        if (word[at] === SOFT_HYPHEN && fits(lead + word.slice(0, at + 1), true)) return at + 1;
      }
      return 0;
    };
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate) || !line) line = candidate;
      else {
        const cut = softCut(`${line} `, word);
        if (cut > 0) {
          push(`${line} ${word.slice(0, cut)}`, true);
          line = word.slice(cut);
        } else {
          push(line, false);
          line = word;
        }
      }
      while (!fits(line) && [...line].length > 1) {
        const cut = softCut('', line);
        if (cut > 0) {
          push(line.slice(0, cut), true);
          line = line.slice(cut);
          continue;
        }
        const forced = line.lastIndexOf(SOFT_HYPHEN, line.length - 2);
        if (forced > line.lastIndexOf(' ') && fits(line.slice(0, forced))) {
          // Match the engine: when this word has no earlier break that fits,
          // take its last soft-hyphen break and let the hyphen exceed width.
          // If the prefix itself is too wide, character splitting gets the
          // first chance, as it does for the engine's wide-word path.
          push(line.slice(0, forced + 1), true);
          line = line.slice(forced + 1);
          continue;
        }
        const characters = [...line];
        let count = characters.length - 1;
        while (count > 1 && !fits(characters.slice(0, count).join(''))) count--;
        const head = characters.slice(0, count).join('');
        // A cut that falls after a soft hyphen is the break of that hyphen.
        push(head, head.endsWith(SOFT_HYPHEN));
        line = characters.slice(count).join('');
      }
    }
    push(line, false);
  }
  return { lines, hyphens };
}

/** The lines of `wrapLines`. */
export function wrapText(text: string, width: number | undefined, measure: (line: string) => number): string[] {
  return wrapLines(text, width, measure).lines;
}

/** `text` drawn in one font object, wrapped at `width` points. */
export function drawInFace(
  face: TextFace, text: string, size: number, leading: number, align: 0 | 1 | 2, width: number | undefined,
): DrawnText {
  const { lines, hyphens } = wrapLines(text, width, (line) => face.width(line, size));
  const marked = new Set(hyphens);
  const shown = lines.map((line, index) => shownLine(line, marked.has(index)));
  const widths = shown.map((line) => face.width(line, size));
  const extent = width ?? Math.max(0, ...widths);
  let out = '';
  shown.forEach((line, index) => {
    if (drawnCharacters(line).length === 0) return;
    const slack = Math.max(0, extent - widths[index]);
    const x = align === 1 ? slack / 2 : align === 2 ? slack : 0;
    out += ` 1 0 0 1 ${fixed(x)} ${fixed(-size - index * leading)} Tm ${face.show(line)} Tj`;
  });
  return {
    content: out ? `BT /${face.name} ${fixed(size)} Tf${out} ET` : '',
    fonts: [[face.name, face.font]],
    lines, widths, size, leading, align, rtl: false, standard: face.standard === true, bundled: false,
    ...(hyphens.length > 0 ? { hyphens } : {}),
  };
}

/** The operators that show `drawn` with the top left corner of its text at
 *  (`left`, `top`). `color` is the non-stroking colour operator. */
export function placedText(drawn: DrawnText, left: number, top: number, color: string): string {
  return drawn.content ? `q ${color} ${fixed(drawn.leading)} TL 1 0 0 1 ${fixed(left)} ${fixed(top)} cm ${drawn.content} Q` : '';
}
