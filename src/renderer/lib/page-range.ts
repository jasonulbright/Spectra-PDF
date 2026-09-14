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
 * page numbers and inclusive `from-to` ranges. Every token must be valid and
 * in the concrete document: partial parsing silently changes the selection.
 * Validate all intervals, then merge them before bounded expansion.
 */

const RANGE = /^(\d+)(?:\s*-\s*(\d+))?$/;

/** Pages named by the field, or `undefined` for the whole document. */
export type PageRangeResult = { pages: number[] | undefined } | { error: 'badPages' };

export function parsePageRangeField(input: string, pageCount: number): PageRangeResult {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || typeof input !== 'string') return { error: 'badPages' };
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'all') return { pages: undefined };
  const intervals: [number, number][] = [];
  for (const raw of trimmed.split(',')) {
    const token = raw.trim();
    const range = RANGE.exec(token);
    if (!range) return { error: 'badPages' };
    const from = Number(range[1]), to = range[2] === undefined ? from : Number(range[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
        || from < 1 || to < from || to > pageCount) return { error: 'badPages' };
    intervals.push([from, to]);
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [from, to] of intervals) {
    const prior = merged[merged.length - 1];
    if (prior && from - prior[1] <= 1) prior[1] = Math.max(prior[1], to);
    else merged.push([from, to]);
  }
  const pages: number[] = [];
  for (const [from, to] of merged) {
    for (let page = from; ; page++) {
      pages.push(page);
      if (page === to) break;
    }
  }
  return pages.length ? { pages } : { error: 'badPages' };
}

/**
 * Page numbers written back as the field's own syntax — runs of three or more
 * collapse to `from-to`. A pair stays two numbers: `4-5` is no shorter than
 * `4,5` and reads as a range the user did not ask for.
 */
export function formatPageRange(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].filter((n) => Number.isSafeInteger(n) && n >= 1).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] - sorted[j] === 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}-${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(',');
}
