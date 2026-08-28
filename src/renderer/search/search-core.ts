// The corpus scan, shared by BOTH the render thread (literal/case/whole-word
// mode, which stays synchronous) and the search worker (regex mode, which
// cannot be trusted with the render thread — see search-worker-client.ts).
// Keeping ONE implementation is the point: a worker that scanned differently
// from the sync path would make regex mode silently disagree with literal mode.
import { compileMatcher, countMatches, firstMatch, type SearchOptions } from './normalize';

/** Characters of context kept either side of a page's first match. */
export const SNIPPET_RADIUS = 40;

export interface CorpusHit {
  pageId: string;
  /** Non-empty matches on the page (always > 0 — misses are not emitted). */
  count: number;
  /** Context window around the FIRST match, ellipsized when clipped. */
  snippet: string;
}

export interface CorpusSearch {
  hits: CorpusHit[];
  /** Set when regex mode is on and the pattern doesn't compile. */
  error: string | null;
}

export function snippetAround(
  text: string,
  index: number,
  length: number,
  radius: number = SNIPPET_RADIUS,
): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/**
 * Count matches and build a first-match snippet for every page of `corpus`.
 * Counts and snippets come from ONE pass so the two surfaces (FindBar tally,
 * Search panel list) can never disagree about which pages matched.
 */
export function runCorpusSearch(
  corpus: Iterable<[string, string]>,
  query: string,
  options: SearchOptions = {},
): CorpusSearch {
  const { regex, error } = compileMatcher(query, options);
  if (error) return { hits: [], error };
  if (!regex) return { hits: [], error: null };
  const hits: CorpusHit[] = [];
  for (const [pageId, text] of corpus) {
    const count = countMatches(text, regex);
    if (count === 0) continue;
    const hit = firstMatch(text, regex);
    hits.push({
      pageId,
      count,
      snippet: hit ? snippetAround(text, hit.index, hit.length) : '',
    });
  }
  return { hits, error: null };
}

/** One run of snippet text, flagged as matched or not. */
export interface SnippetSegment {
  text: string;
  match: boolean;
}

/**
 * Split a snippet into matched and unmatched runs, so a result list can point
 * at the term the reader searched for. Both result surfaces rendered the match
 * in the body colour, which leaves the reader scanning a wall of context for
 * the one word they typed — and, on a snippet built from a flattened table,
 * leaves them with no way to tell whether the row is a hit at all.
 *
 * It re-runs the SAME compiled matcher over the snippet rather than carrying an
 * offset through the worker protocol: the snippet is a slice of the very text
 * the matcher already scanned, so the two can never disagree about what
 * matched. A snippet clipped mid-word in whole-word mode can legitimately find
 * nothing; that returns the snippet as one unmatched run rather than guessing.
 */
export function markSnippet(
  snippet: string,
  query: string,
  options: SearchOptions = {},
): SnippetSegment[] {
  const { regex } = compileMatcher(query, options);
  if (!regex || snippet.length === 0) return [{ text: snippet, match: false }];
  const out: SnippetSegment[] = [];
  let at = 0;
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(snippet)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (m.index > at) out.push({ text: snippet.slice(at, m.index), match: false });
    out.push({ text: m[0], match: true });
    at = m.index + m[0].length;
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), match: false });
  return out.length ? out : [{ text: snippet, match: false }];
}
