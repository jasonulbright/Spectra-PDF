/**
 * A typed page-scope field, in the one shape the engine takes.
 *
 * Every engine door that scopes by page reads `"all"` or a list of 1-based
 * numbers and refuses any other string spelling (`search_regions._page_numbers`
 * is the canonical one). A user types `1,3,5`, so the conversion has to happen
 * somewhere; here, rather than in a refusal — an unattended folder run cannot
 * act on a refusal, so for it a bad spelling is not a message, it is a failed
 * file.
 */

export type PageScope = 'all' | number[];

export function pagesParam(raw: string | number | undefined): PageScope {
  const text = String(raw ?? '').trim();
  if (text === '' || text.toLowerCase() === 'all') return 'all';
  const nums = text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .map((n) => Math.floor(n));
  return nums.length > 0 ? nums : 'all';
}
