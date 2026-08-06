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
    c = new Intl.Collator(lng || undefined);
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
 */
export function rankToolMatches(
  query: string,
  defs: readonly RankableTool[],
  lng = '',
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
  out.sort((a, b) => a.score - b.score || order.compare(a.title, b.title));
  return out;
}
