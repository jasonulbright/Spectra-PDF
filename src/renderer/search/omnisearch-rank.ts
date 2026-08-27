import type { ToolId } from '../commands/tools';

// The tool half of the omnisearch, as a PURE leaf module.
//
// It lives apart from `components/OmniSearch.tsx` deliberately: there is no
// DOM test environment in this repo, so importing the component into a test
// drags in pdf.js and dies on `DOMMatrix`. The part worth pinning is the
// ranking — what a user sees first — and that is just data in, data out.
// (Same reasoning as `lib/toolbar-layout.ts` and `canvas/spread-layout.ts`.)

export interface RankableTool {
  id: ToolId;
  title: string;
  description: string;
}

export interface RankedTool extends RankableTool {
  /** 0 = name prefix, 1 = name substring, 2 = description only. Lower wins. */
  score: number;
}

// --- Frecency ------------------------------------------------------------
//
// A decayed use counter per tool: each pick adds 1 to a weight that halves
// every HALF_LIFE_MS of elapsed time, so a tool used twice today outranks one
// used ten times last month without ever pinning the list to ancient history.
//
// It only ever REORDERS WITHIN A MATCH TIER. A tool the query does not match
// is not a result no matter how often it was picked — a search box whose past
// answers outvote the typed one stops being a search box.
//
// Text hits are deliberately outside this: a page is a fact about ONE
// document, and a frecency table keyed by page would rank a closed file's
// pages against an open one's.

export interface FrecencyEntry {
  /** Decayed pick weight as of `at`. */
  weight: number;
  /** Epoch ms the weight was last brought up to date. */
  at: number;
}

/** Tool id → entry. Plain object so it serializes as-is. */
export type FrecencyStore = Readonly<Record<string, FrecencyEntry>>;

export const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** Entries kept. Bounded so a long-lived profile cannot grow the key without
 * limit; the weakest decayed entries are the ones dropped. */
export const FRECENCY_MAX_ENTRIES = 40;
/** Below this a decayed entry carries no ordering information and is dropped
 * rather than kept forever at a vanishing weight. */
const FRECENCY_FLOOR = 0.01;

/** An entry's weight decayed to `now`. Never negative; a future `at` (a clock
 * that moved backwards) decays by zero rather than amplifying. */
export function frecencyWeight(entry: FrecencyEntry | undefined, now: number): number {
  if (!entry || !Number.isFinite(entry.weight) || entry.weight <= 0) return 0;
  const elapsed = Math.max(0, now - entry.at);
  return entry.weight * Math.pow(0.5, elapsed / FRECENCY_HALF_LIFE_MS);
}

/**
 * Record one activation, returning a NEW store (the caller persists it).
 * The existing weight is decayed to `now` before the +1, which is what makes
 * this a frecency rather than a lifetime counter.
 */
export function recordFrecencyPick(
  store: FrecencyStore,
  id: string,
  now: number,
): FrecencyStore {
  const next: Record<string, FrecencyEntry> = {};
  for (const [key, entry] of Object.entries(store)) {
    const weight = frecencyWeight(entry, now);
    if (weight >= FRECENCY_FLOOR) next[key] = { weight, at: now };
  }
  next[id] = { weight: (next[id]?.weight ?? 0) + 1, at: now };
  const keys = Object.keys(next);
  if (keys.length > FRECENCY_MAX_ENTRIES) {
    // Drop the weakest; equal weights break by RECENCY, so a table full of
    // once-used tools sheds the oldest rather than the alphabetically last.
    // The pick just recorded is never a candidate — a signal that could
    // evict the thing that produced it records nothing.
    const others = keys.filter((k) => k !== id);
    others.sort(
      (a, b) => next[b]!.weight - next[a]!.weight || next[b]!.at - next[a]!.at || (a < b ? -1 : 1),
    );
    for (const key of others.slice(FRECENCY_MAX_ENTRIES - 1)) delete next[key];
  }
  return next;
}

/** Parse a persisted store. Anything unrecognizable is an EMPTY store: a
 * corrupt entry costs a ranking nudge, never the search box. */
export function parseFrecency(raw: string | null): FrecencyStore {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, FrecencyEntry> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (kept >= FRECENCY_MAX_ENTRIES) break;
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.weight !== 'number' || !Number.isFinite(v.weight) || v.weight <= 0) continue;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
    out[key] = { weight: v.weight, at: v.at };
    kept++;
  }
  return out;
}

export function serializeFrecency(store: FrecencyStore): string {
  return JSON.stringify(store);
}

/**
 * Alphabetical ordering for the tie-break, in the language the titles are
 * displayed in. A bare `localeCompare()` collates by the HOST locale, which
 * sorts `å ä ö` and `æ ø å` among the a-vowels and `ch` under c — visibly
 * wrong ordering for the language on screen. Memoized: a collator is
 * expensive to construct and the ranking runs per keystroke.
 */
const collators = new Map<string, Intl.Collator>();
function collator(lng: string): Intl.Collator {
  let c = collators.get(lng);
  if (!c) {
    try {
      // A leaf module cannot know which tags its caller considers real: a
      // malformed one throws RangeError out of the constructor, and a search
      // box must not take the app down over a sort order.
      c = new Intl.Collator(lng || undefined);
    } catch {
      c = new Intl.Collator();
    }
    collators.set(lng, c);
  }
  return c;
}

/**
 * Tool matches, ranked: a name that STARTS with the query beats a name that
 * merely contains it, which beats a description-only match. Someone typing
 * "re" means Redact/Repair before a tool whose blurb happens to say "removes".
 * Ties break alphabetically so the order is stable rather than catalog-order.
 *
 * `lng` is the language the titles were resolved in, so the tie-break follows
 * the same language the user is reading. Matching itself stays
 * locale-invariant (`toLowerCase`) — a query is compared, not displayed, and
 * Turkish case mapping would drop every `I` from the comparison.
 *
 * `frecency` reorders WITHIN a tier only, ahead of the alphabetical
 * tie-break: past picks decide which of two equally good matches comes first,
 * and can never lift a non-match or jump a tier. It is passed in rather than
 * read, so this stays a pure function of its arguments.
 */
export function rankToolMatches(
  query: string,
  defs: readonly RankableTool[],
  lng = '',
  frecency: FrecencyStore = {},
  now = 0,
): RankedTool[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: RankedTool[] = [];
  for (const t of defs) {
    const title = t.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 0;
    else if (title.includes(q)) score = 1;
    else if (t.description.toLowerCase().includes(q)) score = 2;
    if (score >= 0) out.push({ id: t.id, title: t.title, description: t.description, score });
  }
  const order = collator(lng);
  out.sort(
    (a, b) =>
      a.score - b.score ||
      frecencyWeight(frecency[b.id], now) - frecencyWeight(frecency[a.id], now) ||
      order.compare(a.title, b.title),
  );
  return out;
}
