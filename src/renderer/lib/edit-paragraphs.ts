// Paragraph-box editing (Phase 7.5): the engine's combined run+paragraph
// listing projected into display space, the prefix/suffix diff that maps an
// edited text back onto style-source spans (caret inheritance — typed text
// takes the style of the character before the change), and the per-span
// live validation the paragraph editor runs each keystroke.
//
// INDEX DOMAIN: span indexes are CODE POINTS, not UTF-16 units — the engine
// slices Python strings, where "𝄞" is one character. Every function here
// works in the Array.from domain so an astral character can never shear the
// span mapping (a UTF-16 index handed to Python retargets the edit).
import { pdfRectToDisplay } from './pdfx-build';
import type { PageGeometry } from './redaction';
import type { EditTextRun } from './edit-text';
import { walkMissing } from './edit-text';

export interface EditSpan {
  start: number;
  end: number;
  /** Style-source run (engine DFS index). */
  run: number;
  /** 9.A5a: the run's fill colour (#rrggbb) — seeds the editor's per-span
   * colour overlay so a paragraph opened with mixed colours shows them. */
  color?: string;
}

export interface EditParagraph {
  /** Engine paragraph id (listing order). */
  index: number;
  /** Member run indexes — half the apply fingerprint. */
  runs: number[];
  /** Display-normalized box. */
  rect: { x: number; y: number; w: number; h: number };
  /** Logical text — the other half of the fingerprint. */
  text: string;
  /** Style spans over `text` (code-point ranges → style-source run). */
  spans: EditSpan[];
  alignment: string;
  lineCount: number;
  /** run index → its encodable inventory (live validation). */
  encodableByRun: Map<number, string>;
  /** 9.B5: run index → its ligature sequences (longest-match validation). */
  sequencesByRun: Map<number, string[]>;
  /** A1 restyle seeds: the paragraph's dominant size (points) + fill
   * colour (#rrggbb). The editor sends an override only when the user
   * changes these from the seed. */
  fontSize: number;
  color: string;
  /** A3b style seeds: the dominant member's own weight/slant (engine
   * classification — descriptor flags/angle + name hints). */
  bold: boolean;
  italic: boolean;
  /** 9.B4b: writing mode. Vertical paragraphs reflow (transposed layout)
   * but REFUSE substitution restyles and convert — the bundled faces are
   * horizontal — so the editor disables those controls. */
  vertical: boolean;
  /** 9.A5c: the distinct font sizes among the paragraph's member runs
   * (rounded points) — a per-span size bump surfaces here (a mixed-size
   * paragraph lists more than one). */
  runSizes: number[];
}

/** A1/A3 restyle overrides carried on a paragraph commit. */
export interface ParagraphEditOpts {
  convert?: boolean;
  /** New uniform font size in points (undefined = keep). */
  size?: number;
  /** New uniform fill colour as [r,g,b] 0-1 (undefined = keep). */
  color?: [number, number, number];
  /** A3a: substitute the WHOLE paragraph into this bundled Liberation
   * family (an honest face replacement; undefined = keep the original
   * fonts). With any substitution the members' own coverage is
   * irrelevant — every character re-renders in the chosen face. */
  family?: 'serif' | 'sans' | 'mono';
  /** A3b: absolute weight/slant of the substituted face. Sent as a PAIR
   * whenever a substitution happens (family picked or a toggle changed
   * from its seed); undefined = no style substitution. */
  bold?: boolean;
  italic?: boolean;
  /** A4: split the paragraph at this CODE-POINT offset (strictly inside
   * the text) — the engine lays the halves out as two paragraphs. */
  split_at?: number;
  /** A5a/A5b: per-span overrides over CODE-POINT ranges of the new text.
   * An entry carries a `color` (A5a) and/or a face (`bold`/`italic`/
   * `family`, A5b); the engine folds each field independently, so colour
   * entries and face entries can be sent together with unaligned ranges. */
  span_styles?: Array<{
    start: number;
    end: number;
    color?: [number, number, number];
    bold?: boolean;
    italic?: boolean;
    family?: 'serif' | 'sans' | 'mono';
    size?: number;
  }>;
}

/** UTF-16 index (textarea selectionStart) → code-point index (the engine's
 * span domain — the Array.from rule; an astral char is ONE unit there). */
export function utf16ToCodePointIndex(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

export interface EditTextListing {
  /** Runs NOT covered by an editable paragraph — the 7.2 boxes (refused
   * paragraphs decompose here; rotated text never groups at all). */
  runBoxes: EditTextRun[];
  paragraphs: EditParagraph[];
}

interface EngineParagraphListing {
  runs: {
    index: number;
    text: string;
    rect: [number, number, number, number];
    nested: boolean;
    editable: boolean;
    reason: string | null;
    encodable: string;
    sequences?: string[];
    vertical?: boolean;
    font_size?: number;
  }[];
  paragraphs: {
    index: number;
    runs: number[];
    box: [number, number, number, number];
    text: string;
    spans: { start: number; end: number; run: number; color?: string }[];
    alignment: string;
    line_count: number;
    editable: boolean;
    reason: string | null;
    font_size: number;
    color: string;
    bold: boolean;
    italic: boolean;
    vertical?: boolean;
  }[];
}

/** Parse #rrggbb → [r,g,b] in 0-1, or null if not a valid hex colour. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export async function fetchEditTextListing(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  workingPath: string,
  pageNumber: number,
  geometry: PageGeometry,
): Promise<EditTextListing> {
  const listing = (await call('list_text_paragraphs', {
    file: workingPath,
    page: pageNumber,
  })) as unknown as EngineParagraphListing;
  const rawRuns = listing.runs ?? [];
  const runs: EditTextRun[] = rawRuns.map((run) => ({
    index: run.index,
    text: run.text,
    nested: Boolean(run.nested),
    editable: Boolean(run.editable),
    reason: run.reason ?? null,
    encodable: run.encodable ?? '',
    sequences: Array.isArray(run.sequences) ? run.sequences : [],
    vertical: Boolean(run.vertical),
    fontSize: typeof run.font_size === 'number' ? run.font_size : 0,
    rect: pdfRectToDisplay(run.rect, geometry.box, geometry.bakedRotate),
  }));
  const covered = new Set<number>();
  const paragraphs: EditParagraph[] = [];
  for (const p of listing.paragraphs ?? []) {
    if (!p.editable) continue; // refused paragraphs decompose to run boxes
    for (const r of p.runs) covered.add(r);
    paragraphs.push({
      index: p.index,
      runs: p.runs,
      text: p.text,
      spans: (p.spans ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        run: s.run,
        ...(typeof s.color === 'string' ? { color: s.color } : {}),
      })),
      alignment: p.alignment,
      lineCount: p.line_count,
      rect: pdfRectToDisplay(p.box, geometry.box, geometry.bakedRotate),
      encodableByRun: new Map(p.runs.map((r) => [r, rawRuns[r]?.encodable ?? ''])),
      sequencesByRun: new Map(
        p.runs.map((r) => [r, (rawRuns[r] as { sequences?: string[] })?.sequences ?? []]),
      ),
      fontSize: p.font_size ?? 12,
      color: p.color ?? '#000000',
      bold: Boolean(p.bold),
      italic: Boolean(p.italic),
      vertical: Boolean(p.vertical),
      runSizes: Array.from(
        new Set(
          p.runs
            .map((r) => rawRuns[r]?.font_size)
            .filter((s): s is number => typeof s === 'number')
            .map((s) => Math.round(s)),
        ),
      ),
    });
  }
  return { runBoxes: runs.filter((r) => !covered.has(r.index)), paragraphs };
}

/** Pasted newlines become spaces — Enter is the COMMIT key (7.2 parity),
 * and a paragraph is one flowing block; splitting is a stated non-goal. */
export function sanitizeParagraphInput(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/** The common prefix / suffix boundaries of an edit, in CODE POINTS: the
 * unchanged prefix ends at `p`, the changed region is old[p, oldTail) →
 * new[p, newTail), everything from oldTail on shifts by `delta`. Shared by
 * `computeEditSpans` and `remapRanges` so the style-source spans and the
 * per-span override ranges can never drift under the same edit. */
function diffBounds(
  oldA: string[],
  newA: string[],
): { p: number; oldTail: number; newTail: number; delta: number } {
  let p = 0;
  const shorter = Math.min(oldA.length, newA.length);
  while (p < shorter && oldA[p] === newA[p]) p++;
  let s = 0;
  while (s < shorter - p && oldA[oldA.length - 1 - s] === newA[newA.length - 1 - s]) s++;
  return { p, oldTail: oldA.length - s, newTail: newA.length - s, delta: newA.length - oldA.length };
}

/** Remap a list of code-point ranges through an edit (9.A5a per-span
 * override ranges follow the text). A range wholly before the change stays;
 * wholly after shifts by `delta`; one that overlaps the changed region
 * absorbs it (its start clamps to the change start, its end to the change
 * end) — typing inside a coloured range keeps it coloured. Empty/inverted
 * results drop. Preserves each range's extra fields (e.g. colour). */
export function remapRanges<T extends { start: number; end: number }>(
  oldText: string,
  newText: string,
  ranges: T[],
): T[] {
  const { p, oldTail, newTail, delta } = diffBounds(Array.from(oldText), Array.from(newText));
  const mapStart = (x: number): number => (x <= p ? x : x >= oldTail ? x + delta : p);
  const mapEnd = (x: number): number => (x <= p ? x : x >= oldTail ? x + delta : newTail);
  const out: T[] = [];
  for (const r of ranges) {
    const start = mapStart(r.start);
    const end = mapEnd(r.end);
    if (end > start) out.push({ ...r, start, end });
  }
  return out;
}

/** 9.A5a: one per-span colour override — a CODE-POINT range painted a hex
 * colour. Disjoint + sorted once through `mergeSpanColors`. */
export interface SpanColor {
  start: number;
  end: number;
  color: string;
}

/** 9.A5b: one per-span FACE override — a CODE-POINT range substituted into
 * a bundled Liberation weight/slant/family. `family` undefined = keep the
 * char's own family, apply the weight/slant (the A3b style-only swap). */
export interface SpanFace {
  start: number;
  end: number;
  bold: boolean;
  italic: boolean;
  family?: 'serif' | 'sans' | 'mono';
}

/** Flatten CODE-POINT ranges into DISJOINT, coalesced runs. On an overlap
 * the later-starting range (equal start → later array position) wins each
 * shared position — the SAME rule the engine's per-position fold uses, so
 * the live preview and the commit can never disagree even when `remapRanges`
 * leaves two ranges overlapping (round-32 HIGH). `key` identifies a range's
 * style (adjacent same-key runs merge). Generic over colour + face. */
export function flattenIntervals<T extends { start: number; end: number }>(
  ranges: T[],
  key: (r: T) => string,
): T[] {
  const valid = ranges.filter((r) => r.end > r.start);
  if (valid.length === 0) return [];
  const ordered = valid.map((r, i) => ({ r, i }));
  const cuts = Array.from(new Set(valid.flatMap((r) => [r.start, r.end]))).sort((a, b) => a - b);
  const out: T[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    let win: { r: T; i: number } | null = null;
    for (const o of ordered) {
      if (o.r.start <= a && o.r.end >= b) {
        if (!win || o.r.start > win.r.start || (o.r.start === win.r.start && o.i > win.i)) {
          win = o;
        }
      }
    }
    if (win) {
      const last = out[out.length - 1];
      if (last && key(last) === key(win.r) && last.end === a) {
        last.end = b;
      } else {
        out.push({ ...win.r, start: a, end: b });
      }
    }
  }
  return out;
}

/** Clip [start, end) out of every existing range (keeping outside
 * remainders), append `added`, and flatten. The selection→control action,
 * generic over colour + face. */
export function applyInterval<T extends { start: number; end: number }>(
  existing: T[],
  added: T,
  key: (r: T) => string,
): T[] {
  if (added.end <= added.start) return existing;
  const out: T[] = [];
  for (const r of existing) {
    if (r.end <= added.start || r.start >= added.end) {
      out.push(r);
      continue;
    }
    if (r.start < added.start) out.push({ ...r, end: added.start });
    if (r.end > added.end) out.push({ ...r, start: added.end });
  }
  out.push(added);
  return flattenIntervals(out, key);
}

const colorKey = (r: SpanColor): string => r.color.toLowerCase();
const faceKey = (r: SpanFace): string => `${r.bold}|${r.italic}|${r.family ?? ''}`;

export const mergeSpanColors = (ranges: SpanColor[]): SpanColor[] =>
  flattenIntervals(ranges, colorKey);
export const mergeSpanFaces = (ranges: SpanFace[]): SpanFace[] => flattenIntervals(ranges, faceKey);

export const applySpanColor = (
  existing: SpanColor[],
  start: number,
  end: number,
  color: string,
): SpanColor[] => applyInterval(existing, { start, end, color }, colorKey);

export const applySpanFace = (
  existing: SpanFace[],
  start: number,
  end: number,
  face: { bold: boolean; italic: boolean; family?: 'serif' | 'sans' | 'mono' },
): SpanFace[] => applyInterval(existing, { start, end, ...face }, faceKey);

/** Seed per-span colours from a listing's spans (only ranges DIFFERING from
 * the paragraph-dominant colour — an all-one-colour paragraph seeds
 * nothing). Faces have no listing seed in v1 (the listing carries per-span
 * colour, not per-span weight/slant). */
export function seedSpanColors(spans: EditSpan[], paragraphColor: string): SpanColor[] {
  const base = paragraphColor.toLowerCase();
  const out: SpanColor[] = [];
  for (const sp of spans) {
    if (sp.color && sp.color.toLowerCase() !== base) {
      out.push({ start: sp.start, end: sp.end, color: sp.color });
    }
  }
  return mergeSpanColors(out);
}

/** 9.A5c: one per-span SIZE override — a CODE-POINT range set to a point
 * size. */
export interface SpanSize {
  start: number;
  end: number;
  size: number;
}

const sizeKey = (r: SpanSize): string => String(r.size);
export const mergeSpanSizes = (ranges: SpanSize[]): SpanSize[] => flattenIntervals(ranges, sizeKey);
export const applySpanSize = (
  existing: SpanSize[],
  start: number,
  end: number,
  size: number,
): SpanSize[] => applyInterval(existing, { start, end, size }, sizeKey);

/** Split `text` into consecutive backdrop segments carrying the resolved
 * colour, weight/slant, AND a `sized` flag per code point (all folded
 * independently, segmented where ANY changes). `color null` = base editing
 * colour. Family and SIZE are NOT rendered as actual metrics — the
 * transparent textarea has one uniform metric for caret positioning, so a
 * bigger/substituted glyph would desync it. `sized` lets the component mark
 * per-span-sized ranges (an underline) without changing their width. */
export function backdropSegments(
  text: string,
  colors: SpanColor[],
  faces: SpanFace[] = [],
  sizes: SpanSize[] = [],
): Array<{ text: string; color: string | null; bold: boolean; italic: boolean; sized: boolean }> {
  const chars = Array.from(text);
  const n = chars.length;
  const colorAt: (string | null)[] = new Array(n).fill(null);
  for (const r of mergeSpanColors(colors)) {
    for (let k = Math.max(0, r.start); k < Math.min(r.end, n); k++) colorAt[k] = r.color;
  }
  const boldAt: boolean[] = new Array(n).fill(false);
  const italicAt: boolean[] = new Array(n).fill(false);
  for (const r of mergeSpanFaces(faces)) {
    for (let k = Math.max(0, r.start); k < Math.min(r.end, n); k++) {
      boldAt[k] = r.bold;
      italicAt[k] = r.italic;
    }
  }
  const sizedAt: boolean[] = new Array(n).fill(false);
  for (const r of mergeSpanSizes(sizes)) {
    for (let k = Math.max(0, r.start); k < Math.min(r.end, n); k++) sizedAt[k] = true;
  }
  const segs: Array<{
    text: string;
    color: string | null;
    bold: boolean;
    italic: boolean;
    sized: boolean;
  }> = [];
  for (let k = 0; k < n; k++) {
    const last = segs[segs.length - 1];
    if (
      last &&
      last.color === colorAt[k] &&
      last.bold === boldAt[k] &&
      last.italic === italicAt[k] &&
      last.sized === sizedAt[k]
    ) {
      last.text += chars[k];
    } else {
      segs.push({
        text: chars[k],
        color: colorAt[k],
        bold: boldAt[k],
        italic: italicAt[k],
        sized: sizedAt[k],
      });
    }
  }
  return segs;
}

/** Convert per-span colours to `span_styles` colour entries (hex → [r,g,b];
 * unparseable dropped). */
export function spanColorsToStyles(
  ranges: SpanColor[],
): Array<{ start: number; end: number; color: [number, number, number] }> {
  const out: Array<{ start: number; end: number; color: [number, number, number] }> = [];
  for (const r of mergeSpanColors(ranges)) {
    const rgb = hexToRgb(r.color);
    if (rgb) out.push({ start: r.start, end: r.end, color: rgb });
  }
  return out;
}

/** Convert per-span faces to `span_styles` face entries. */
export function spanFacesToStyles(
  ranges: SpanFace[],
): Array<{
  start: number;
  end: number;
  bold: boolean;
  italic: boolean;
  family?: 'serif' | 'sans' | 'mono';
}> {
  return mergeSpanFaces(ranges).map((r) => ({
    start: r.start,
    end: r.end,
    bold: r.bold,
    italic: r.italic,
    ...(r.family ? { family: r.family } : {}),
  }));
}

/** Convert per-span sizes to `span_styles` size entries. */
export function spanSizesToStyles(
  ranges: SpanSize[],
): Array<{ start: number; end: number; size: number }> {
  return mergeSpanSizes(ranges).map((r) => ({ start: r.start, end: r.end, size: r.size }));
}

/** Map an edited text back onto style spans: common prefix/suffix keep
 * their original span styles; the changed middle inherits the style of the
 * character just before the change (the caret-inheritance rule). All
 * indexes are code points. */
export function computeEditSpans(
  oldText: string,
  newText: string,
  oldSpans: EditSpan[],
  fallbackRun?: number,
): EditSpan[] {
  const oldA = Array.from(oldText);
  const newA = Array.from(newText);
  if (newA.length === 0) return [];
  const { p, oldTail, newTail, delta } = diffBounds(oldA, newA);

  const inheritAt = Math.max(p - 1, 0);
  // `fallbackRun` (the paragraph's first member) covers the empty-spans
  // edge: listed paragraphs always carry spans today, but a span-less
  // call must still produce covering spans, not a silently-empty mapping
  // the engine would reject on every retry (review-caught).
  const inherit =
    oldSpans.find((sp) => inheritAt >= sp.start && inheritAt < sp.end)?.run ??
    oldSpans[0]?.run ??
    fallbackRun;
  if (inherit === undefined) return [];

  const out: EditSpan[] = [];
  const push = (start: number, end: number, run: number): void => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (last && last.run === run && last.end === start) last.end = end;
    else out.push({ start, end, run });
  };
  for (const sp of oldSpans) {
    if (sp.start >= p) break;
    push(sp.start, Math.min(sp.end, p), sp.run);
  }
  push(p, newTail, inherit);
  for (const sp of oldSpans) {
    const cs = Math.max(sp.start, oldTail);
    if (cs < sp.end) push(cs + delta, sp.end + delta, sp.run);
  }
  return out;
}

/** Characters the mapped fonts cannot encode, deduplicated in order —
 * empty means the whole edit is expressible. Spaces always pass (the
 * engine emits synthetic gaps for space-less fonts). */
export function paragraphUnencodable(
  newText: string,
  spans: EditSpan[],
  encodableByRun: Map<number, string>,
  sequencesByRun?: Map<number, string[]>,
): string[] {
  const newA = Array.from(newText);
  const missing: string[] = [];
  const cache = new Map<number, Set<string>>();
  for (const sp of spans) {
    let inv = cache.get(sp.run);
    if (!inv) {
      inv = new Set(encodableByRun.get(sp.run) ?? '');
      cache.set(sp.run, inv);
    }
    // 9.B5: per-span longest-match — a ligature sequence never crosses a
    // span boundary (spans are style-source boundaries, and the engine's
    // encode operates per styled segment the same way).
    const slice = newA.slice(sp.start, Math.min(sp.end, newA.length));
    for (const ch of walkMissing(slice, inv, sequencesByRun?.get(sp.run) ?? [], true)) {
      if (!missing.includes(ch)) missing.push(ch);
    }
  }
  return missing;
}
