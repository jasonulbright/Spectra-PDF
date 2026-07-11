const SOFT_HYPHEN = /­/g
const WHITESPACE = /\s+/g

export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(SOFT_HYPHEN, '')
    .toLowerCase()
    .replace(WHITESPACE, ' ')
    .trim()
}

export const normalizeQuery = normalizeText

export function hasMatch(haystack: string, needle: string): boolean {
  return needle.length > 0 && haystack.includes(needle)
}

// Which OCR word boxes to highlight for a query. A page's OCR words are
// single TSV tokens (never contain whitespace), so a multi-word query can
// never be a substring of one word — matching the whole normalized query
// against each word highlights NOTHING for any 2+ word search. Instead split
// the query into tokens and highlight a word if it contains any token (the
// page-level phrase match already gates which pages get highlights at all).
export function highlightWords<T extends { text: string }>(words: T[], query: string): T[] {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  return words.filter((w) => {
    const wt = w.text.toLowerCase();
    return tokens.some((t) => wt.includes(t));
  });
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}
