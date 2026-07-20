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
  /** A5a: per-span colour overrides — recolour just these CODE-POINT
   * ranges (over the new text), leaving the rest the paragraph's own /
   * the A1 `color`. Disjoint sorted ranges; the engine folds overlaps. */
  span_styles?: Array<{ start: number; end: number; color: [number, number, number] }>;
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

/** Flatten span-colour ranges into DISJOINT, coalesced runs. On an overlap
 * the later-starting range wins each shared position (a boundary sweep) —
 * the SAME rule the engine's per-position fold uses, so the live preview
 * (`backdropSegments`) and the commit (`spanColorsToStyles`) can never
 * disagree even when `remapRanges` leaves two different colours overlapping
 * (round-32 HIGH). Empties drop; adjacent same-colour runs merge. */
export function mergeSpanColors(ranges: SpanColor[]): SpanColor[] {
  const valid = ranges.filter((r) => r.end > r.start);
  if (valid.length === 0) return [];
  // Preserve array order for the tiebreak, then sort so the sweep reads the
  // last-covering range deterministically: a later `start`, or (equal start)
  // a later array position, wins.
  const ordered = valid.map((r, i) => ({ ...r, i }));
  const cuts = Array.from(new Set(ordered.flatMap((r) => [r.start, r.end]))).sort((a, b) => a - b);
  const out: SpanColor[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    let win: { color: string; start: number; i: number } | null = null;
    for (const r of ordered) {
      if (r.start <= a && r.end >= b) {
        if (!win || r.start > win.start || (r.start === win.start && r.i > win.i)) {
          win = { color: r.color, start: r.start, i: r.i };
        }
      }
    }
    if (win) {
      const last = out[out.length - 1];
      if (last && last.color.toLowerCase() === win.color.toLowerCase() && last.end === a) {
        last.end = b;
      } else {
        out.push({ start: a, end: b, color: win.color });
      }
    }
  }
  return out;
}

/** Paint [start, end) a colour: clip any overlapping range (keeping its
 * outside remainders), drop the covered middle, add the new range, coalesce.
 * The selection→swatch action. */
export function applySpanColor(
  existing: SpanColor[],
  start: number,
  end: number,
  color: string,
): SpanColor[] {
  if (end <= start) return existing;
  const out: SpanColor[] = [];
  for (const r of existing) {
    if (r.end <= start || r.start >= end) {
      out.push(r); // no overlap
      continue;
    }
    if (r.start < start) out.push({ start: r.start, end: start, color: r.color });
    if (r.end > end) out.push({ start: end, end: r.end, color: r.color });
  }
  out.push({ start, end, color });
  return mergeSpanColors(out);
}

/** Seed the editor's per-span colours from a listing's spans: keep only the
 * ranges whose colour DIFFERS from the paragraph-dominant colour (those are
 * the already-mixed ranges the user should see; an all-one-colour paragraph
 * seeds nothing). */
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

/** Split `text` into consecutive coloured segments for the backdrop render
 * (color null = the base editing colour). Code-point indexed. */
export function backdropSegments(
  text: string,
  ranges: SpanColor[],
): Array<{ text: string; color: string | null }> {
  const chars = Array.from(text);
  const sorted = mergeSpanColors(ranges);
  const segs: Array<{ text: string; color: string | null }> = [];
  let pos = 0;
  for (const r of sorted) {
    const s = Math.max(r.start, pos);
    if (s >= chars.length) break;
    if (s > pos) segs.push({ text: chars.slice(pos, s).join(''), color: null });
    const e = Math.min(r.end, chars.length);
    if (e > s) segs.push({ text: chars.slice(s, e).join(''), color: r.color });
    pos = e;
  }
  if (pos < chars.length) segs.push({ text: chars.slice(pos).join(''), color: null });
  return segs;
}

/** Convert per-span colours to the engine's `span_styles` shape (hex →
 * [r,g,b] 0-1); ranges whose hex won't parse are dropped. */
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
