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

export interface EditSpan {
  start: number;
  end: number;
  /** Style-source run (engine DFS index). */
  run: number;
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
  /** A1 restyle seeds: the paragraph's dominant size (points) + fill
   * colour (#rrggbb). The editor sends an override only when the user
   * changes these from the seed. */
  fontSize: number;
  color: string;
}

/** A1 restyle overrides carried on a paragraph commit. */
export interface ParagraphEditOpts {
  convert?: boolean;
  /** New uniform font size in points (undefined = keep). */
  size?: number;
  /** New uniform fill colour as [r,g,b] 0-1 (undefined = keep). */
  color?: [number, number, number];
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
  }[];
  paragraphs: {
    index: number;
    runs: number[];
    box: [number, number, number, number];
    text: string;
    spans: { start: number; end: number; run: number }[];
    alignment: string;
    line_count: number;
    editable: boolean;
    reason: string | null;
    font_size: number;
    color: string;
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
      spans: (p.spans ?? []).map((s) => ({ start: s.start, end: s.end, run: s.run })),
      alignment: p.alignment,
      lineCount: p.line_count,
      rect: pdfRectToDisplay(p.box, geometry.box, geometry.bakedRotate),
      encodableByRun: new Map(p.runs.map((r) => [r, rawRuns[r]?.encodable ?? ''])),
      fontSize: p.font_size ?? 12,
      color: p.color ?? '#000000',
    });
  }
  return { runBoxes: runs.filter((r) => !covered.has(r.index)), paragraphs };
}

/** Pasted newlines become spaces — Enter is the COMMIT key (7.2 parity),
 * and a paragraph is one flowing block; splitting is a stated non-goal. */
export function sanitizeParagraphInput(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
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
  let p = 0;
  const shorter = Math.min(oldA.length, newA.length);
  while (p < shorter && oldA[p] === newA[p]) p++;
  let s = 0;
  while (s < shorter - p && oldA[oldA.length - 1 - s] === newA[newA.length - 1 - s]) s++;
  const oldTail = oldA.length - s;
  const newTail = newA.length - s;
  const delta = newA.length - oldA.length;

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
    for (let i = sp.start; i < sp.end && i < newA.length; i++) {
      const ch = newA[i];
      if (ch === ' ') continue;
      if (!inv.has(ch) && !missing.includes(ch)) missing.push(ch);
    }
  }
  return missing;
}
