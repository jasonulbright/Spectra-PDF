import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from './languages';
// N12: the SUMMARY is user-facing copy and the language names come from
// Intl.DisplayNames — the only non-pure import here (i18n is itself a data
// module, so the orderings and refusals below stay unit-testable).
import { tChrome, tChromeCount, tOcrLanguage } from '../i18n';

// Multi-language recognition (Phase 12, issue #1 request 1).
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
