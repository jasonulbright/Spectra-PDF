const SOFT_HYPHEN = /­/g
const WHITESPACE = /\s+/g

// Case-PRESERVING index/query normalization (NFKC + soft-hyphen strip +
// whitespace collapse + trim). This is what the search index now stores per
// page (P4): keeping original case is what lets case-sensitive AND regex modes
// work — case-insensitivity is applied at match time via the regex `i` flag,
// not by pre-lowercasing the corpus. Literal (non-regex) queries are put
// through the SAME normalization so a soft-hyphen/fullwidth/whitespace query
// still matches the normalized page text.
export function normalizeIndexText(input: string): string {
  return input.normalize('NFKC').replace(SOFT_HYPHEN, '').replace(WHITESPACE, ' ').trim()
}

// Lowercasing variant — retained for OCR-word highlighting's token compare and
// as the canvas highlight's non-empty gate. NOT used to build the index.
export function normalizeText(input: string): string {
  return normalizeIndexText(input).toLowerCase()
}

export const normalizeQuery = normalizeText

// The three advanced Find modes (P4). All default false (the plain
// case-insensitive substring search).
export interface SearchOptions {
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
}

export const NO_OPTIONS: SearchOptions = {}

export function optionsEqual(a: SearchOptions, b: SearchOptions): boolean {
  return (
    !!a.regex === !!b.regex &&
    !!a.caseSensitive === !!b.caseSensitive &&
    !!a.wholeWord === !!b.wholeWord
  )
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g
export function escapeRegExp(s: string): string {
  return s.replace(REGEXP_SPECIALS, '\\$&')
}

export interface CompiledMatcher {
  /** A global RegExp for the query+options, or null when the query is empty. */
  regex: RegExp | null
  /** Set when regex mode is on and the user's pattern doesn't compile. */
  error: string | null
}

// Compile a query + modes into ONE global RegExp used for counting, first-hit
// snippets, and OCR-word highlighting — so every surface matches identically.
// A literal query is normalized (index-consistent) then escaped; a regex query
// is taken verbatim (never normalized — that would corrupt the pattern). An
// invalid regex returns { regex: null, error } so the UI can show it instead
// of silently finding nothing.
export function compileMatcher(query: string, options: SearchOptions = {}): CompiledMatcher {
  const { regex = false, caseSensitive = false, wholeWord = false } = options
  let pattern: string
  if (regex) {
    if (query.length === 0) return { regex: null, error: null }
    pattern = query
  } else {
    const norm = normalizeIndexText(query)
    if (norm.length === 0) return { regex: null, error: null }
    pattern = escapeRegExp(norm)
  }
  if (wholeWord) pattern = `\\b(?:${pattern})\\b`
  const flags = caseSensitive ? 'g' : 'gi'
  try {
    return { regex: new RegExp(pattern, flags), error: null }
  } catch (e) {
    return { regex: null, error: e instanceof Error ? e.message : 'Invalid regular expression' }
  }
}

// Count NON-empty matches of a global regex over `text`. Zero-width matches
// (e.g. `a*`, `\b`) are skipped for counting and always advance lastIndex, so a
// zero-width-capable pattern neither loops forever nor inflates the count.
export function countMatches(text: string, regex: RegExp): number {
  regex.lastIndex = 0
  let count = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length > 0) count++
    if (m.index === regex.lastIndex) regex.lastIndex++
  }
  return count
}

// The first NON-empty match (index + length) of a global regex, or null.
export function firstMatch(text: string, regex: RegExp): { index: number; length: number } | null {
  regex.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length > 0) return { index: m.index, length: m[0].length }
    regex.lastIndex++
  }
  return null
}

export function hasMatch(haystack: string, needle: string): boolean {
  return needle.length > 0 && haystack.includes(needle)
}

// Which OCR word boxes to highlight for a query. A page's OCR words are
// single TSV tokens (never contain whitespace), so a multi-word query can
// never be a substring of one word — matching the whole normalized query
// against each word highlights NOTHING for any 2+ word search. Instead split
// the query into tokens and highlight a word if it contains any token (the
// page-level phrase match already gates which pages get highlights at all).
export function highlightWords<T extends { text: string }>(
  words: T[],
  query: string,
  options: SearchOptions = {},
): T[] {
  // Regex / case-sensitive / whole-word: match each OCR word with the SAME
  // compiled matcher the page-level search used, so the highlighted boxes agree
  // with the reported hits. (A page-level phrase gate already decided this page
  // matches; here we pick WHICH word boxes to draw.)
  if (options.regex || options.caseSensitive || options.wholeWord) {
    const { regex } = compileMatcher(query, options)
    if (!regex) return []
    return words.filter((w) => {
      regex.lastIndex = 0
      return regex.test(w.text)
    })
  }
  // Default (case-insensitive substring): per-token contains, so a multi-word
  // query still highlights each token's word (an OCR word never contains
  // whitespace, so the whole phrase could never be a substring of one word).
  const tokens = normalizeText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return []
  return words.filter((w) => {
    const wt = w.text.toLowerCase()
    return tokens.some((t) => wt.includes(t))
  })
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
