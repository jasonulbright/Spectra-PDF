// Spell check, renderer side: the engine's report projected into the shapes
// the panel and the paragraph editor need, the custom-word list, and the
// language resolution.
//
// A LEAF module by design — no React, no Tauri, no DOM beyond localStorage —
// so the rules that decide what gets underlined and what a fix writes are
// unit-testable. The engine owns the dictionary; this owns the addressing.
//
// INDEX DOMAIN: every offset here is a CODE POINT, the domain the engine
// slices Python strings in and the domain the paragraph editor's style spans
// already use. A UTF-16 offset handed to a fix retargets it after any astral
// character.
import { computeEditSpans, type EditSpan } from './edit-paragraphs';

/** Where a misspelling was found. The three sources are addressed the way the
 * surface that fixes each one is addressed, never by a shared synthetic id —
 * a fix must be able to name its target to the machinery that performs it. */
export type SpellSource = 'text' | 'comments' | 'fields';

export interface SpellIssue {
  source: SpellSource;
  word: string;
  /** Code-point range of `word` inside the source text below. */
  start: number;
  end: number;
  context: string;
  /** `text`: the page and the paragraph's listing index + member runs. */
  page?: number;
  paragraph?: number;
  runs?: number[];
  paragraph_text?: string;
  /** `comments`: the annotation's index in the document listing. */
  annotation?: number;
  subtype?: string;
  annotation_text?: string;
  /** `fields`: the field's fully-qualified name. */
  field?: string;
  field_text?: string;
}

export interface SpellReport {
  language: string;
  tag: string;
  bcp47: string;
  document_language: string | null;
  issues: SpellIssue[];
  counts: Record<SpellSource, number>;
  checked: { paragraphs: number; comments: number; fields: number };
  skipped_paragraphs: number;
  words: number;
  truncated: boolean;
}

export interface DictionaryEntry {
  tag: string;
  bcp47: string;
  origin: 'bundled' | 'user';
}

/** The engine's own default marker. `auto` is not a language the engine
 * knows: it means "send no language and let the document's `/Lang`, then the
 * interface language, decide" — resolved by `resolveSpellLanguage` so the two
 * halves cannot answer it differently. */
export const AUTO_LANGUAGE = 'auto';

/**
 * Which dictionary a check should ask for.
 *
 * Document language is NOT interface language: a Spanish speaker proofreading
 * an English contract wants the English dictionary. So the ladder is the
 * document's own `/Lang` first, the interface language second, and `en_US`
 * last — and an explicit choice in the panel outranks all three, because the
 * user is the only one who can know what a document with no `/Lang` is
 * written in.
 */
export function resolveSpellLanguage(
  preference: string,
  documentLanguage: string | null,
  uiLanguage: string,
  available: DictionaryEntry[],
): string {
  const has = (tag: string): boolean => {
    const wanted = tag.replace('-', '_').toLowerCase();
    const base = wanted.split('_')[0];
    return available.some(
      (d) => d.tag.toLowerCase() === wanted || d.tag.split('_')[0].toLowerCase() === base,
    );
  };
  if (preference && preference !== AUTO_LANGUAGE && has(preference)) return preference;
  for (const candidate of [documentLanguage, uiLanguage]) {
    if (candidate && has(candidate)) return candidate;
  }
  return 'en_US';
}

// ── custom words ───────────────────────────────────────────────────────────
//
// The list lives in ONE place — here — and rides every engine call. The
// alternative, a copy inside the engine process, is a second authority that
// goes stale the moment the user adds a word while a check is in flight.

const CUSTOM_WORDS_KEY = 'spectra-custom-words';

export function loadCustomWords(): string[] {
  try {
    const stored = localStorage.getItem(CUSTOM_WORDS_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((w): w is string => typeof w === 'string' && w.length > 0);
  } catch {
    return [];
  }
}

export function saveCustomWords(words: string[]): void {
  localStorage.setItem(CUSTOM_WORDS_KEY, JSON.stringify(words));
}

/** Add a word, case-preserving and duplicate-free. Comparison is
 * case-insensitive so adding `Spectra` does not leave `spectra` still
 * underlined — the engine matches the list both ways for the same reason. */
export function addCustomWord(words: string[], word: string): string[] {
  const trimmed = word.trim();
  if (!trimmed) return words;
  if (words.some((w) => w.toLowerCase() === trimmed.toLowerCase())) return words;
  return [...words, trimmed].sort((a, b) => a.localeCompare(b));
}

export function removeCustomWord(words: string[], word: string): string[] {
  return words.filter((w) => w.toLowerCase() !== word.toLowerCase());
}

// ── projections ────────────────────────────────────────────────────────────

/** Replace a code-point range. Written through `Array.from` rather than
 * `String.slice` because a UTF-16 slice at an astral boundary produces a lone
 * surrogate, which the engine then refuses (or worse, stores). */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  const chars = Array.from(text);
  if (start < 0 || end > chars.length || end < start) return text;
  return chars.slice(0, start).join('') + replacement + chars.slice(end).join('');
}

/** The word a range currently holds — the fix's own precondition. */
export function wordAt(text: string, start: number, end: number): string {
  const chars = Array.from(text);
  if (start < 0 || end > chars.length || end <= start) return '';
  return chars.slice(start, end).join('');
}

/**
 * The text and style spans a page-text fix commits.
 *
 * `computeEditSpans` is the paragraph editor's OWN mapping, called here for
 * exactly the reason the editor calls it: the correction must inherit the
 * style of the characters it replaces, and a hand-rolled second mapping would
 * be a second answer to that question. Returns null when the range no longer
 * holds the word the report named — a document that moved underneath refuses
 * rather than corrupting a different word.
 */
export function paragraphFix(
  paragraphText: string,
  spans: EditSpan[],
  issue: { word: string; start: number; end: number },
  replacement: string,
  fallbackRun?: number,
): { text: string; spans: EditSpan[] } | null {
  if (!replacement) return null;
  if (wordAt(paragraphText, issue.start, issue.end) !== issue.word) return null;
  const text = replaceRange(paragraphText, issue.start, issue.end, replacement);
  const mapped = computeEditSpans(paragraphText, text, spans, fallbackRun);
  const length = Array.from(text).length;
  // The engine requires the span map to COVER the text, and the diff-based
  // mapping only covers what the incoming spans covered — a listing always
  // carries spans, but a caller that has none would otherwise send a map
  // spanning just the edited characters and be refused. One span over the
  // whole paragraph at the fallback run is the honest degrade.
  const covers =
    mapped.length > 0 &&
    mapped[0].start === 0 &&
    mapped[mapped.length - 1].end === length &&
    mapped.every((s, i) => i === 0 || mapped[i - 1].end === s.start);
  if (covers) return { text, spans: mapped };
  const run = spans[0]?.run ?? fallbackRun;
  if (run === undefined) return null;
  return { text, spans: [{ start: 0, end: length, run }] };
}

/** Every occurrence of a word in one text, as fix-ready ranges, LAST FIRST.
 *
 * Last first is load-bearing for fix-all: applying an earlier replacement
 * shifts every later offset, so a forward walk corrupts the tail whenever the
 * replacement is not the same length as the word. */
export function occurrencesDescending(
  issues: SpellIssue[],
  word: string,
): SpellIssue[] {
  return issues.filter((i) => i.word === word).sort((a, b) => b.start - a.start);
}

/** Ranges the paragraph editor should underline, for ONE paragraph. */
export function misspelledRanges(
  issues: SpellIssue[],
  page: number,
  paragraph: number,
): Array<{ start: number; end: number }> {
  return issues
    .filter((i) => i.source === 'text' && i.page === page && i.paragraph === paragraph)
    .map((i) => ({ start: i.start, end: i.end }));
}

/** The distinct misspelled words, most frequent first, each with its count.
 * The panel groups by word because that is what "fix all" acts on. */
export function groupByWord(
  issues: SpellIssue[],
): Array<{ word: string; count: number; sources: SpellSource[] }> {
  const byWord = new Map<string, { count: number; sources: Set<SpellSource> }>();
  for (const issue of issues) {
    const entry = byWord.get(issue.word) ?? { count: 0, sources: new Set<SpellSource>() };
    entry.count += 1;
    entry.sources.add(issue.source);
    byWord.set(issue.word, entry);
  }
  return [...byWord.entries()]
    .map(([word, entry]) => ({
      word,
      count: entry.count,
      sources: [...entry.sources],
    }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

/** A per-instance outcome, so a fix-all that half-landed says so. Reporting
 * one aggregate "done" over a run where the third occurrence's page had moved
 * would be claiming work that did not happen. */
export interface FixOutcome {
  issue: SpellIssue;
  ok: boolean;
  reason?: string;
}

export function fixSummary(outcomes: FixOutcome[]): { fixed: number; failed: number } {
  return {
    fixed: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
  };
}
