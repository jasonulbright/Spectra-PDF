import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from './languages';
// The SUMMARY is user-facing copy and the language names come from
// Intl.DisplayNames — the only non-pure import here (i18n is itself a data
// module, so the orderings and refusals below stay unit-testable).
import { tChrome, tChromeCount, tOcrLanguage } from '../i18n';

// Multi-language recognition.
//
// Tesseract takes several models at once as a '+'-joined code string
// ("eng+fra"), loads them all, and lets any of them claim a word. That is what
// makes a folder of mixed English/French documents work with one pass.
//
// It is NOT auto-detection, and the difference matters enough to say in the
// UI: every extra model costs recognition time, and on a page that IS purely
// one language the single correct model is usually more accurate than a pile
// of them. More languages is not "safer".
//
// Pure on purpose: there is no DOM test environment, so the orderings and
// refusals live here where they can be pinned, and the component just renders.

/** Catalog order, so the joined string is stable regardless of click order. */
const CATALOG_ORDER = new Map(OCR_LANGUAGES.map((l, i) => [l.code, i]));

/**
 * Clean a set of selected codes: drop anything not in the vendored catalog
 * (an un-staged language would recognize to NOTHING at runtime — the silent
 * degradation the staging gate exists to prevent), de-duplicate, and sort into
 * catalog order. An empty or fully-invalid selection falls back to the default
 * rather than producing an empty language string, which Tesseract rejects.
 */
export function normalizeLanguages(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const c of codes) {
    if (CATALOG_ORDER.has(c)) seen.add(c);
  }
  if (seen.size === 0) return [DEFAULT_OCR_LANGUAGE];
  return [...seen].sort((a, b) => (CATALOG_ORDER.get(a) ?? 0) - (CATALOG_ORDER.get(b) ?? 0));
}

/** The '+'-joined form Tesseract wants. Always normalized first. */
export function toTesseractLang(codes: readonly string[]): string {
  return normalizeLanguages(codes).join('+');
}

/** Inverse of `toTesseractLang`, for reading a persisted/legacy single code. */
export function parseTesseractLang(value: string): string[] {
  return normalizeLanguages(value.split('+').map((s) => s.trim()).filter(Boolean));
}

// ── the view tier's language ────────────────────────────────────────────────
//
// The selection tier recognises a page nobody asked to modify, so it cannot
// stop and ask which models to load the way the Scan & OCR door does. It
// resolves one instead, and the ladder is stated here — the single place the
// decision is made — rather than spread across the component that consumes it.
//
// PRECEDENCE, highest first:
//
//   1. An EXPLICIT preference (`scanSelectLanguage`, anything but `auto`).
//   2. The document's own `/Lang`, mapped to a model when the mapping is
//      unambiguous and that model is in the vendored catalog.
//   3. `eng`.
//
// The explicit preference outranks the document deliberately, and the same way
// `lib/spellcheck.resolveSpellLanguage` ranks its own: a `/Lang` is written by
// whatever produced the file and is routinely wrong or absent on exactly the
// scanned documents this tier serves, while a user who went to Preferences and
// named a language is the one party who has actually looked at the page. A
// ladder that let `/Lang` win would leave the picker inert on every tagged
// document, which is indistinguishable from the picker not working.
//
// Interface language is NOT in the ladder. A German speaker reading an English
// scan wants the English model; the spelling ladder can fall back to the UI
// language because a dictionary miss only costs a squiggle, whereas the wrong
// recognition model costs the word boxes a sweep snaps to.

/** "Decide from the document." Not a language tesseract knows — resolved by
 *  `resolveSelectionLanguage` so no consumer can answer it differently. */
export const AUTO_OCR_LANGUAGE = 'auto';

/** BCP-47 tag → model code, derived from the catalog itself so a language
 *  added there becomes reachable from a `/Lang` with no second list to keep in
 *  step. */
const BY_TAG = new Map(OCR_LANGUAGES.map((l) => [l.bcp47.toLowerCase(), l.code]));

/** Primary subtag → model, and ONLY where the catalog holds exactly one model
 *  for it. `zh` holds two (`chi_sim`, `chi_tra`), and a document whose `/Lang`
 *  is bare `zh` has not said which script it is printed in — recognising
 *  Traditional pages with the Simplified model is precisely the silent
 *  degradation this refuses. An ambiguous primary maps to nothing and the
 *  ladder falls through to `eng`. */
const BY_PRIMARY = (() => {
  const byPrimary = new Map<string, string[]>();
  for (const l of OCR_LANGUAGES) {
    const primary = l.bcp47.toLowerCase().split('-')[0];
    const bucket = byPrimary.get(primary);
    if (bucket) bucket.push(l.code);
    else byPrimary.set(primary, [l.code]);
  }
  const unique = new Map<string, string>();
  for (const [primary, codes] of byPrimary) {
    if (codes.length === 1) unique.set(primary, codes[0]);
  }
  return unique;
})();

/** Region subtag → the script it implies, for the one primary subtag whose
 *  models are split by script. Chinese is the exception to "a region carries no
 *  recognition meaning": `zh-TW` names Traditional and `zh-CN` names Simplified
 *  as unambiguously as an explicit script subtag does (CLDR likelySubtags), and
 *  `zh-TW` is the commonest shape a producer writes Traditional Chinese into
 *  `/Lang` as. Without this, such a document falls through to `eng` — the worst
 *  available outcome. Bare `zh` stays unmapped: it has still said nothing. */
const REGION_IMPLIES_SCRIPT: Record<string, Record<string, string>> = {
  zh: { tw: 'hant', hk: 'hant', mo: 'hant', cn: 'hans', sg: 'hans' },
};

/**
 * A document `/Lang` → the model that recognises it, or null when nothing in
 * the catalog unambiguously does.
 *
 * `/Lang` is a BCP-47 tag in any of its shapes — `en`, `en-US`, `zh-Hant-TW`,
 * and (from producers that never read the spec) `en_US`. Region and variant
 * subtags carry no recognition meaning — one model covers `en-US` and `en-GB`
 * alike — except where `REGION_IMPLIES_SCRIPT` records that they do. A SCRIPT
 * subtag always carries meaning, so it is tried before the primary subtag is
 * judged ambiguous.
 */
export function ocrLanguageForTag(tag: string | null | undefined): string | null {
  const norm = (tag ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!norm) return null;
  const exact = BY_TAG.get(norm);
  if (exact) return exact;
  const parts = norm.split('-').filter(Boolean);
  if (parts.length === 0) return null;
  // A four-letter second subtag is a script (`zh-hant-tw`); anything else
  // there is a region or a variant and cannot disambiguate a model.
  if (parts.length > 1 && parts[1].length === 4) {
    const withScript = BY_TAG.get(`${parts[0]}-${parts[1]}`);
    if (withScript) return withScript;
  }
  const regions = REGION_IMPLIES_SCRIPT[parts[0]];
  if (regions) {
    for (const part of parts.slice(1)) {
      const script = regions[part];
      if (script) {
        const implied = BY_TAG.get(`${parts[0]}-${script}`);
        if (implied) return implied;
      }
    }
  }
  return BY_PRIMARY.get(parts[0]) ?? null;
}

/**
 * The model string the view-tier recognizer runs with. See the PRECEDENCE
 * block above — this function IS that ladder.
 *
 * Returns a '+'-joined string like the rest of this module, so a preference
 * naming several models reaches tesseract the same way the Scan & OCR door's
 * does. A preference naming languages that are not in the vendored catalog is
 * not honoured as garbage: `normalizeLanguages` drops them, and a preference
 * left with nothing real in it falls through to the document rather than
 * pinning `eng` on a page that said it was French.
 */
export function resolveSelectionLanguage(
  preference: string,
  documentLanguage: string | null | undefined,
): string {
  const pinned = (preference || '').trim();
  if (pinned && pinned !== AUTO_OCR_LANGUAGE) {
    const codes = pinned.split('+').map((s) => s.trim()).filter(Boolean);
    // `normalizeLanguages` returns the default for a fully-unknown selection,
    // which here would silently outrank the document. Ask whether anything
    // survived instead of taking that fallback as an answer.
    const known = codes.filter((c) => CATALOG_ORDER.has(c));
    if (known.length > 0) return toTesseractLang(known);
  }
  return ocrLanguageForTag(documentLanguage) ?? DEFAULT_OCR_LANGUAGE;
}

/** Human summary for the picker ("English", "English + French", "3 languages"). */
export function describeLanguages(codes: readonly string[]): string {
  const norm = normalizeLanguages(codes);
  if (norm.length > 2) return tChromeCount('dialog.ocr.langCount', norm.length);
  if (norm.length === 2) {
    return tChrome('dialog.ocr.langPair', {
      a: tOcrLanguage(norm[0]),
      b: tOcrLanguage(norm[1]),
    });
  }
  return tOcrLanguage(norm[0]);
}
