/**
 * The page-range field's syntax, in one place.
 *
 * Every panel that scopes an operation by page offers the same field, so the
 * field has to mean the same thing in all of them. It did not: three panels
 * split on commas and ran `parseInt` over the parts, which reads `1-5` as the
 * single page 1 — a silently narrower operation that reports success, not a
 * refusal the reader can act on.
 *
 * Syntax: `all` (any case, surrounding space) is the whole document, spelled
 * to the engine as an absent list. Otherwise a comma-separated list of 1-based
 * page numbers and inclusive `from-to` ranges. A token that names no page is
 * dropped; a field that names no page at all is an error, because an empty
 * list means "no pages" to the engine and would act on nothing while
 * reporting success.
 */

const RANGE = /^(\d+)\s*-\s*(\d+)$/;

/** Pages named by the field, or `undefined` for the whole document. */
export type PageRangeResult = { pages: number[] | undefined } | { error: 'badPages' };

export function parsePageRangeField(input: string): PageRangeResult {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'all') return { pages: undefined };
  const pages = new Set<number>();
  for (const raw of trimmed.split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    const range = RANGE.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      // A reversed or zero-based range names no page; dropping it matches how
      // every other unreadable token is treated, and the empty-field error
      // below still catches a field made only of them.
      if (from < 1 || to < from) continue;
      for (let p = from; p <= to; p++) pages.add(p);
      continue;
    }
    const n = parseInt(token, 10);
    if (Number.isFinite(n) && n >= 1) pages.add(Math.floor(n));
  }
  if (pages.size === 0) return { error: 'badPages' };
  return { pages: [...pages].sort((a, b) => a - b) };
}

/**
 * Page numbers written back as the field's own syntax — runs of three or more
 * collapse to `from-to`. A pair stays two numbers: `4-5` is no shorter than
 * `4,5` and reads as a range the user did not ask for.
 */
export function formatPageRange(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].filter((n) => Number.isFinite(n) && n >= 1).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}-${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(',');
}
