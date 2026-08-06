// Count & takeoff math: the symbol registry, group merging,
// sequence allocation, the derived tallies, and the legend table's layout.
//
// PURE — no DOM, no React, no storage (the `measure.ts` / `snap.ts`
// precedent). There is no DOM test environment in this repo, so the breakable
// part has to be the testable part; everything here is exercised directly by
// `tests/count-marks.test.ts`.
//
// Two rules that shape the whole module:
//
//   • **A tally is DERIVED, never stored.** Nothing carries a total — the
//     panel, the legend and the engine's CSV each COUNT the marks in front of
//     them. A stored total is a total that goes stale the next click.
//   • **A group's identity is its NAME, and the FILE is the authority on what
//     that group looks like.** Marks reconstitute from `/Subj` + `/C` +
//     `/SpectraSymbol` on import, so a document counted on another machine
//     opens with its groups intact — which means a locally-remembered group
//     of the same name must NOT re-colour the marks already in the file
//     (`mergeGroups` below).

import type { PageAnnotation } from '../state/types';

// ── The symbol registry ──────────────────────────────────────────────────
//
// Vector, deliberately: a count marker must print crisply at any scale and
// lands in the annotation's appearance stream as path operators. The parts
// are expressed in a UNIT square (0..1, y DOWN — display orientation), which
// both consumers draw without a translation table: the canvas overlay as an
// SVG in a `0 0 1 1` viewBox, and `pdfx-build` as `m`/`l`/`c` operators
// scaled by the appearance BBox. One geometry, two renderers, no drift.
//
// Slice D generalizes this into the stamp library's third (vector) species;
// the shape here is the shape that generalizes — an id plus parts.

export type SymbolPart =
  | { kind: 'poly'; points: readonly number[]; closed: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number };

export interface CountSymbol {
  id: string;
  parts: readonly SymbolPart[];
}

/** Inset from the unit square's edge: a stroked symbol drawn edge-to-edge
 * loses half its stroke width to the appearance BBox clip. */
const M = 0.12;
const L = M;
const R = 1 - M;
const C = 0.5;

export const COUNT_SYMBOLS: readonly CountSymbol[] = [
  { id: 'circle', parts: [{ kind: 'circle', cx: C, cy: C, r: C - M }] },
  {
    id: 'square',
    parts: [{ kind: 'poly', points: [L, L, R, L, R, R, L, R], closed: true }],
  },
  {
    id: 'triangle',
    parts: [{ kind: 'poly', points: [C, L, R, R, L, R], closed: true }],
  },
  {
    id: 'diamond',
    parts: [{ kind: 'poly', points: [C, L, R, C, C, R, L, C], closed: true }],
  },
  {
    id: 'cross',
    parts: [
      { kind: 'poly', points: [C, L, C, R], closed: false },
      { kind: 'poly', points: [L, C, R, C], closed: false },
    ],
  },
  {
    id: 'ex',
    parts: [
      { kind: 'poly', points: [L, L, R, R], closed: false },
      { kind: 'poly', points: [R, L, L, R], closed: false },
    ],
  },
  {
    id: 'hexagon',
    parts: [
      {
        kind: 'poly',
        points: [C, L, R, 0.29, R, 0.71, C, R, L, 0.71, L, 0.29],
        closed: true,
      },
    ],
  },
  {
    id: 'star',
    parts: [
      {
        kind: 'poly',
        // Five-pointed star: alternating outer (r = 0.38) and inner
        // (r = 0.15) radii about the centre, first point straight up.
        points: starPoints(C, C, 0.38, 0.15, 5),
        closed: true,
      },
    ],
  },
  {
    id: 'target',
    parts: [
      { kind: 'circle', cx: C, cy: C, r: C - M },
      { kind: 'circle', cx: C, cy: C, r: 0.14 },
    ],
  },
] as const;

function starPoints(cx: number, cy: number, outer: number, inner: number, tips: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < tips * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / tips;
    out.push(round4(cx + r * Math.cos(a)), round4(cy + r * Math.sin(a)));
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

export const DEFAULT_COUNT_SYMBOL = COUNT_SYMBOLS[0].id;

// ── The part-list schema ─────────────────────────────────────────────────
//
// A part list becomes PDF PATH OPERATORS (`pdfx-build`'s `symbolOps`) and SVG
// geometry, so every number that reaches either renderer must be proven a
// finite number in range FIRST. That is why the sanitizer lives here, in the
// pure module, rather than beside the importer that happens to call it: the
// artwork can arrive from an imported set file OR from a private key inside a
// PDF, and both roads must be gated by the same check. A string that slipped
// through would be concatenated straight into a content stream.
//
// The unit square is the whole coordinate space; a part outside it is refused
// rather than clamped, because clamping silently redraws someone's artwork.

/** Ceilings — a symbol is a marker, not a drawing. They bound what one
 * imported file can push into a content stream. */
export const SYMBOL_MAX_PARTS = 64;
export const SYMBOL_MAX_POINTS = 512;

function inUnit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Round to the authoring grid (1e-4) so a sanitized part list is byte-stable
 * through a JSON round trip. */
function q(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

/**
 * Validate + normalize an untrusted part list. Returns null when ANY part is
 * malformed — a partially-drawn symbol is a lie about what the file said, so
 * the caller falls back to a known symbol instead.
 */
export function sanitizeParts(raw: unknown): SymbolPart[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SYMBOL_MAX_PARTS) return null;
  const out: SymbolPart[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const p = entry as Record<string, unknown>;
    if (p.kind === 'circle') {
      if (!inUnit(p.cx) || !inUnit(p.cy)) return null;
      if (typeof p.r !== 'number' || !Number.isFinite(p.r) || p.r <= 0 || p.r > 0.5) return null;
      // A circle that leaves the unit square would be clipped by the
      // appearance BBox — refuse rather than draw a cropped ring.
      if (p.cx - p.r < 0 || p.cx + p.r > 1 || p.cy - p.r < 0 || p.cy + p.r > 1) return null;
      out.push({ kind: 'circle', cx: q(p.cx), cy: q(p.cy), r: q(p.r) });
      continue;
    }
    if (p.kind !== 'poly') return null;
    const pts = p.points;
    if (!Array.isArray(pts) || pts.length < 4 || pts.length % 2 !== 0) return null;
    if (pts.length > SYMBOL_MAX_POINTS) return null;
    const clean: number[] = [];
    for (const n of pts) {
      if (!inUnit(n)) return null;
      clean.push(q(n));
    }
    out.push({ kind: 'poly', points: clean, closed: p.closed === true });
  }
  return out;
}

/** A part list as compact JSON — what rides in the private
 * `/SpectraSymbolParts` so a symbol travels WITH the annotation and draws on a
 * machine that never imported the set it came from. */
export function partsToJson(parts: readonly SymbolPart[]): string {
  return JSON.stringify(parts);
}

/** The inverse, sanitized: bytes out of a file are untrusted exactly like
 * bytes out of an imported set file. */
export function partsFromJson(text: string | undefined): SymbolPart[] | null {
  if (!text) return null;
  try {
    return sanitizeParts(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The symbol with this id, or the default. Never throws: a file counted by a
 * later version can name a symbol this build has never heard of, and the
 * honest answer there is the default marker, not a dropped mark. */
export function symbolById(id: string | undefined): CountSymbol {
  return COUNT_SYMBOLS.find((s) => s.id === id) ?? COUNT_SYMBOLS[0];
}

/** Colours a new group cycles through — the annotation palette's spread, so a
 * takeoff's groups are distinguishable at a glance on a mono drawing. */
export const COUNT_GROUP_COLORS: readonly string[] = [
  '#e0393e',
  '#2f6fed',
  '#2fbf71',
  '#f5a623',
  '#9b51e0',
  '#00b8d9',
  '#e2529b',
  '#7f8c1f',
];

// ── Groups ───────────────────────────────────────────────────────────────

export interface CountGroup {
  /** The group's NAME is its identity — user data, never translated, and what
   * lands in `/Subj`. */
  name: string;
  color: string;
  symbol: string;
}

/** The count marks among a page tier's annotations. */
export function countMarksOf(annotations: readonly PageAnnotation[] | undefined): PageAnnotation[] {
  return (annotations ?? []).filter((a) => a.kind === 'count');
}

/** The group a mark belongs to. Empty/absent `countGroup` files under the
 * engine's own `Ungrouped`, so the app and the CSV agree on the total. */
export const UNGROUPED = 'Ungrouped';

export function groupOf(mark: PageAnnotation): string {
  return (mark.countGroup ?? '').trim() || UNGROUPED;
}

/**
 * The groups a document actually carries, derived from its marks in first-seen
 * order. Colour and symbol come from the first mark of the group — the FILE is
 * the authority on how a reconstituted group looks.
 */
export function derivedGroups(marks: readonly PageAnnotation[]): CountGroup[] {
  const out: CountGroup[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    const name = groupOf(m);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, color: m.color, symbol: m.countSymbol ?? DEFAULT_COUNT_SYMBOL });
  }
  return out;
}

/**
 * The list the panel shows: the document's own groups first, then the
 * remembered ones it does not already have.
 *
 * The precedence is the point. A group that EXISTS in the file keeps the
 * file's colour and symbol even when a group of the same name is remembered
 * locally with different ones — otherwise the next mark placed in "Doors"
 * would be blue while the forty already on the sheet stayed red, and one
 * group would be drawn two ways.
 */
export function mergeGroups(
  fromFile: readonly CountGroup[],
  remembered: readonly CountGroup[],
): CountGroup[] {
  const out = [...fromFile];
  const have = new Set(out.map((g) => g.name));
  for (const g of remembered) {
    if (have.has(g.name)) continue;
    have.add(g.name);
    out.push(g);
  }
  return out;
}

/** A fresh group name that collides with nothing in `existing`. */
export function uniqueGroupName(base: string, existing: readonly CountGroup[]): string {
  const taken = new Set(existing.map((g) => g.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The colour to give the next new group: the first palette entry no group is
 * already using, else the palette cycled by group count. */
export function nextGroupColor(existing: readonly CountGroup[]): string {
  const used = new Set(existing.map((g) => g.color.toLowerCase()));
  const free = COUNT_GROUP_COLORS.find((c) => !used.has(c.toLowerCase()));
  return free ?? COUNT_GROUP_COLORS[existing.length % COUNT_GROUP_COLORS.length];
}

// ── Sequence allocation ──────────────────────────────────────────────────

/**
 * The sequence number the next mark of `group` takes: one past the highest
 * ever used, NOT the count.
 *
 * Across deletes is the case that matters. Counting 1..3 and deleting #2
 * leaves {1, 3}; the next mark is 4, because a sequence number is a LABEL
 * (it lands in `/Contents` as "<group> <seq>" and a user reads it off the
 * sheet), and reusing 3 would put two marks in the document claiming to be
 * the same one.
 */
export function nextSequence(marks: readonly PageAnnotation[], group: string): number {
  let max = 0;
  for (const m of marks) {
    if (groupOf(m) !== group) continue;
    const seq = m.countSeq ?? 0;
    if (seq > max) max = seq;
  }
  return max + 1;
}

/** `/Contents` for a mark: the group's own text, then its sequence number.
 * The group name is USER data and passes through verbatim — the value written
 * into a document is never translated (the measure.ts format-string rule). */
export function countContents(group: string, seq: number): string {
  return `${group} ${seq}`;
}

// ── Derived tallies ──────────────────────────────────────────────────────

export interface CountSummaryRow {
  group: string;
  symbol: string;
  color: string;
  page: number; // 1-based, as the CSV and the panel both show it
  count: number;
}

/**
 * Group × page rows over a whole document, ordered by group name then page —
 * the same shape and the same order the engine's `export_count_summary`
 * produces from the file, so the panel's live numbers and the exported CSV
 * cannot disagree about anything but timing.
 */
export function summaryRows(pages: readonly (readonly PageAnnotation[])[]): CountSummaryRow[] {
  const buckets = new Map<string, CountSummaryRow>();
  pages.forEach((annotations, index) => {
    for (const m of countMarksOf(annotations)) {
      const group = groupOf(m);
      const key = `${group}\u0000${index}`;
      const row = buckets.get(key);
      if (row) {
        row.count += 1;
      } else {
        buckets.set(key, {
          group,
          symbol: m.countSymbol ?? DEFAULT_COUNT_SYMBOL,
          color: m.color,
          page: index + 1,
          count: 1,
        });
      }
    }
  });
  return [...buckets.values()].sort((a, b) =>
    a.group === b.group ? a.page - b.page : a.group < b.group ? -1 : 1,
  );
}

/** Per-group totals across every page, in the same order. */
export function groupTotals(rows: readonly CountSummaryRow[]): CountSummaryRow[] {
  const out: CountSummaryRow[] = [];
  for (const r of rows) {
    const existing = out.find((o) => o.group === r.group);
    if (existing) existing.count += r.count;
    else out.push({ ...r, page: 0 });
  }
  return out;
}

export function grandTotal(rows: readonly CountSummaryRow[]): number {
  return rows.reduce((n, r) => n + r.count, 0);
}

// ── The placeable legend ─────────────────────────────────────────────────
//
// A placed legend is a SNAPSHOT, like a stamp: it records the tallies at the
// moment it was placed, and it carries its own rows so a re-commit reproduces
// exactly what was placed rather than re-deriving numbers that have since
// moved. Re-place it when the counts change — which is what a drafter does
// with a paper legend too.

/**
 * The legend's fixed words, ENGLISH by rule.
 *
 * They are written INTO the document — the /Contents table and the appearance
 * stream both carry them — and a value written into a file follows the
 * `measure.ts` format-string precedent: it stays English so a drawing does not
 * change what it says depending on who saved it last. The PANEL's own "Total"
 * line is chrome and localizes; these two are not chrome.
 */
export const LEGEND_TITLE = 'Takeoff';
export const LEGEND_TOTAL_WORD = 'Total';

export interface CountLegendRow {
  symbol: string;
  group: string;
  color: string;
  count: number;
}

/** The legend's own typography, in PDF points. Shared by the appearance
 * emitter and the layout below so the box always fits its contents. */
export const LEGEND_FONT_SIZE = 10;
export const LEGEND_ROW_H = 16;
export const LEGEND_PAD = 8;
export const LEGEND_SYMBOL_W = 14;
/** Helvetica's average advance as a fraction of the font size — the same
 * approximation the stamp appearance uses for its centring. */
const CHAR_W = 0.55;

export interface LegendLayout {
  /** Box size in PDF points. */
  widthPt: number;
  heightPt: number;
  /** Row baselines measured DOWN from the box top, in points. */
  rows: { symbol: string; group: string; color: string; count: number; y: number }[];
  /** The totals line's baseline, and its value. */
  totalY: number;
  total: number;
}

/**
 * Lay a legend out for a set of rows.
 *
 * Height is the header + one line per row + the total; width is driven by the
 * longest group name so a legend never clips its own text (the stamp's
 * single-line clip is right for a fixed label and wrong for a table).
 */
export function legendLayout(rows: readonly CountLegendRow[], title: string): LegendLayout {
  const total = rows.reduce((n, r) => n + r.count, 0);
  const longest = rows.reduce((n, r) => Math.max(n, r.group.length), title.length);
  const countW = Math.max(3, String(total).length + 1) * LEGEND_FONT_SIZE * CHAR_W;
  const widthPt = Math.ceil(
    LEGEND_PAD * 2 + LEGEND_SYMBOL_W + longest * LEGEND_FONT_SIZE * CHAR_W + countW + 8,
  );
  const lines = rows.length + 2; // title + rows + total
  const heightPt = Math.ceil(LEGEND_PAD * 2 + lines * LEGEND_ROW_H);
  const laid = rows.map((r, i) => ({
    ...r,
    y: LEGEND_PAD + (i + 1) * LEGEND_ROW_H + LEGEND_FONT_SIZE * 0.8,
  }));
  return {
    widthPt,
    heightPt,
    rows: laid,
    totalY: LEGEND_PAD + (rows.length + 1) * LEGEND_ROW_H + LEGEND_FONT_SIZE * 0.8,
    total,
  };
}

/**
 * The legend's `/Contents` — the plain-text table any other viewer shows.
 *
 * Generated ENGLISH at the writer for its fixed words (the title and "Total"
 * arrive from the caller already resolved that way), with the group names the
 * user's own text: the same rule the measure format strings follow.
 */
export function legendText(rows: readonly CountLegendRow[], title: string, totalWord: string): string {
  const lines = [title];
  for (const r of rows) lines.push(`${r.group}\t${r.count}`);
  lines.push(`${totalWord}\t${rows.reduce((n, r) => n + r.count, 0)}`);
  return lines.join('\n');
}
