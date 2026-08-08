// Search & Redact: the panel's model.
//
// THE ARCHITECTURAL DECISION, in one line: **Search & Redact produces MARKS,
// it does not produce a redaction.** Every checked hit becomes an ordinary
// `RedactionMark` in exactly the shape the canvas band already produces, and
// from there the SHIPPED path takes over — the status bar's apply / save
// marks / clear, `buildRedactionRegions`, the commit gate, `performOperation`'s
// snapshot/undo chain and the `/Redact` persistence. No second destructive
// path is created, the transient-marks invariant is untouched, and the user
// gets the review step for free: marks are visible, movable, removable and
// undoable before anything is destroyed, which is how a redaction job is
// actually done.
//
// This module is the PURE half — hit identity, the selection model, the
// already-marked comparison and the word-list parser. Everything geometric
// lives on the canvas (`CanvasServices.redaction`), because the conversion
// from a page-space rect to a display-normalized mark is the seed's own
// conversion and there must be exactly one of it.
import type { SearchOptions } from '../search/normalize';

/** One rectangle of one hit — the engine's `rects` entry (rule 3: one per
 * RUN, never a bounding box across runs). */
export interface HitRect {
  run: number;
  rect: [number, number, number, number];
  codes: [number, number];
  /** The hit covers only part of its run. */
  partial: boolean;
  /** The run's font could not be measured, so this is the run's FULL box —
   * over-covering rather than a guessed slice. Surfaced in the row so the
   * user knows the mark is wider than the words. */
  imprecise: boolean;
}

/** Where a hit came from. `query` and `terms` are the user's own input; any
 * other value is a built-in pattern id, so a false positive is attributable
 * to the pattern that produced it. */
export type HitSource = 'query' | 'terms' | 'ocr' | string;

export interface SearchHit {
  page: number;
  index: number;
  text: string;
  source: HitSource;
  context: string;
  rects: HitRect[];
  runs: number[];
}

export interface FileSearchResult {
  path: string;
  name: string;
  hits: SearchHit[];
  /** Pages that carry no searchable text at all — reported PER PAGE rather
   * than silently searched-and-missed. The panel offers Scan & OCR for them.
   * A page covered by the in-memory OCR arm is removed from this list. */
  pagesWithoutText: number[];
  truncated: boolean;
  /** An invalid regex, reported rather than raised (the user is typing it). */
  error: string | null;
}

/** A hit's stable identity across renders. Path + page + the engine's own
 * per-page hit index — never the rect, whose floats are not an identity. */
export function hitKey(path: string, hit: SearchHit): string {
  return `${path}\u0000${hit.page}\u0000${hit.index}`;
}

export type TriState = 'none' | 'some' | 'all';

/** A group header's checkbox state over the keys it covers. */
export function groupState(keys: string[], selected: ReadonlySet<string>): TriState {
  if (keys.length === 0) return 'none';
  let count = 0;
  for (const key of keys) if (selected.has(key)) count++;
  if (count === 0) return 'none';
  return count === keys.length ? 'all' : 'some';
}

/** Toggle a whole group: a group that is not fully selected becomes fully
 * selected; a fully selected one clears. (The "some" state resolving to
 * "select the rest" is the standard tri-state contract and the one that
 * matches what a user reaching for a half-ticked box wants.) */
export function toggleGroup(
  keys: string[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (groupState(keys, selected) === 'all') {
    for (const key of keys) next.delete(key);
  } else {
    for (const key of keys) next.add(key);
  }
  return next;
}

export function toggleOne(key: string, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Two page-space rects naming the same region.
 *
 * Half a point, the brief's tolerance: a mark the user already has and a hit
 * the search just produced are "the same" when every edge agrees to within
 * half a point. Tighter and a re-run of the same search offers to mark
 * everything again (float noise through two coordinate conversions); looser
 * and two adjacent words on a tight line read as one mark.
 */
export const SAME_MARK_TOLERANCE_PT = 0.5;

export function sameRegion(
  a: readonly number[],
  b: readonly number[],
  tolerance: number = SAME_MARK_TOLERANCE_PT,
): boolean {
  if (a.length !== 4 || b.length !== 4) return false;
  const na = [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
  const nb = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(na[i] - nb[i]) > tolerance) return false;
  }
  return true;
}

/** Existing marks, as the canvas reports them: page-space rects per page. */
export interface ExistingMark {
  page: number;
  rect: [number, number, number, number];
}

/**
 * Is every rectangle of this hit already carried by a mark?
 *
 * ALL of them, not any: a phrase broken across a line wrap has one rect per
 * run, and marking half of it is not marking it. Reporting such a hit as
 * "already marked" would disable the checkbox that would have covered the
 * other half — the exact shape of a redaction that reports success over
 * surviving content.
 */
export function hitIsMarked(hit: SearchHit, marks: ExistingMark[]): boolean {
  if (hit.rects.length === 0) return false;
  return hit.rects.every((entry) =>
    marks.some((mark) => mark.page === hit.page && sameRegion(mark.rect, entry.rect)),
  );
}

/** One line per term, blanks dropped. A pasted list ends with a newline and
 * an empty term would OR "match everything" into the search. */
export function parseWordList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The page range syntax the app already uses ("1,3,5-9" / "all"), resolved
 * against a page count. Returns null for "all" — the engine's own default —
 * and throws with the offending token so the panel can say which one. */
export function parsePageRange(input: string, pageCount: number): number[] | null {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return null;
  const pages = new Set<number>();
  for (const token of trimmed.split(',')) {
    const part = token.trim();
    if (part === '') continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to < from || to > pageCount) throw new Error(part);
      for (let p = from; p <= to; p++) pages.add(p);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(part);
    const page = Number(part);
    if (page < 1 || page > pageCount) throw new Error(part);
    pages.add(page);
  }
  if (pages.size === 0) throw new Error(trimmed);
  return [...pages].sort((a, b) => a - b);
}

/** The engine's expand values — what a hit's mark COVERS. Spelled out in the
 * panel rather than chosen for the user: "does searching 55 inside 1955 black
 * out the year or the two digits" is a question we may not answer silently. */
export const EXPAND_MODES = ['match', 'word', 'line'] as const;
export type ExpandMode = (typeof EXPAND_MODES)[number];

/** The built-in pattern ids the engine carries, in the order the panel lists
 * them. Mirrors `engine/text_match.PATTERN_IDS`; a totality test pins the two
 * against each other so a pattern added on one side cannot go unlisted on the
 * other. */
export const PATTERN_IDS = [
  'phone',
  'email',
  'credit_card',
  'ssn',
  'date',
  'iban',
  'nhs_uk',
  'sin_ca',
  'url',
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

/** The search request one panel run sends per file. */
export interface SearchRequest {
  query: string;
  terms: string[];
  patterns: string[];
  options: SearchOptions;
  expand: ExpandMode;
  pages: number[] | null;
  maxHits: number;
}

/** True when the request would search for nothing — the panel refuses before
 * the engine does, so the user gets the message next to the box they left
 * empty rather than in a queue notice. */
export function requestIsEmpty(request: SearchRequest): boolean {
  return (
    request.query.trim() === '' &&
    request.terms.length === 0 &&
    request.patterns.length === 0
  );
}

/** Group hits by page, preserving the engine's own order within each page. */
export function groupByPage(hits: SearchHit[]): { page: number; hits: SearchHit[] }[] {
  const byPage = new Map<number, SearchHit[]>();
  for (const hit of hits) {
    const list = byPage.get(hit.page);
    if (list) list.push(hit);
    else byPage.set(hit.page, [hit]);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, pageHits]) => ({ page, hits: pageHits }));
}

/** Every rect of every selected hit, as the mark requests the canvas takes. */
export function markRequests(
  results: FileSearchResult[],
  selected: ReadonlySet<string>,
): { path: string; page: number; rect: [number, number, number, number] }[] {
  const out: { path: string; page: number; rect: [number, number, number, number] }[] = [];
  for (const file of results) {
    for (const hit of file.hits) {
      if (!selected.has(hitKey(file.path, hit))) continue;
      for (const entry of hit.rects) {
        out.push({ path: file.path, page: hit.page, rect: entry.rect });
      }
    }
  }
  return out;
}
