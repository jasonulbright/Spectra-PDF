export interface OcrLanguage {
  /** Tesseract's model code — what the engine and the traineddata staging use. */
  code: string
  /** English name. A LAST-RESORT fallback only: the UI says a language's name
   * through Intl.DisplayNames, which every locale already knows how to
   * spell, so these are never authored into the translation catalogs. */
  label: string
  /** BCP-47 tag for Intl.DisplayNames. Tesseract's codes are ISO 639-2/T plus
   * its own script suffixes (`chi_sim`), so the mapping is explicit rather
   * than guessed. */
  bcp47: string
}

// The vendored recognition languages. Every entry's traineddata is staged
// into resources/ocr-lang by scripts/sync-ocr-assets.mjs — the script PARSES
// this file for the codes, so this list is the single source of truth and a
// language added here without a matching @tesseract.js-data package fails the
// staging loudly instead of failing recognition silently at runtime.
// Alphabetical by label, English first (the default).
export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'eng', label: 'English', bcp47: 'en' },
  { code: 'sqi', label: 'Albanian', bcp47: 'sq' },
  { code: 'ara', label: 'Arabic', bcp47: 'ar' },
  { code: 'eus', label: 'Basque', bcp47: 'eu' },
  { code: 'bul', label: 'Bulgarian', bcp47: 'bg' },
  { code: 'cat', label: 'Catalan', bcp47: 'ca' },
  { code: 'chi_sim', label: 'Chinese (Simplified)', bcp47: 'zh-Hans' },
  { code: 'chi_tra', label: 'Chinese (Traditional)', bcp47: 'zh-Hant' },
  { code: 'hrv', label: 'Croatian', bcp47: 'hr' },
  { code: 'ces', label: 'Czech', bcp47: 'cs' },
  { code: 'dan', label: 'Danish', bcp47: 'da' },
  { code: 'nld', label: 'Dutch', bcp47: 'nl' },
  { code: 'est', label: 'Estonian', bcp47: 'et' },
  { code: 'fin', label: 'Finnish', bcp47: 'fi' },
  { code: 'fra', label: 'French', bcp47: 'fr' },
  { code: 'glg', label: 'Galician', bcp47: 'gl' },
  { code: 'deu', label: 'German', bcp47: 'de' },
  { code: 'ell', label: 'Greek', bcp47: 'el' },
  { code: 'heb', label: 'Hebrew', bcp47: 'he' },
  { code: 'hin', label: 'Hindi', bcp47: 'hi' },
  { code: 'hun', label: 'Hungarian', bcp47: 'hu' },
  { code: 'isl', label: 'Icelandic', bcp47: 'is' },
  { code: 'ind', label: 'Indonesian', bcp47: 'id' },
  { code: 'gle', label: 'Irish', bcp47: 'ga' },
  { code: 'ita', label: 'Italian', bcp47: 'it' },
  { code: 'jpn', label: 'Japanese', bcp47: 'ja' },
  { code: 'kor', label: 'Korean', bcp47: 'ko' },
  { code: 'lav', label: 'Latvian', bcp47: 'lv' },
  { code: 'lit', label: 'Lithuanian', bcp47: 'lt' },
  { code: 'mkd', label: 'Macedonian', bcp47: 'mk' },
  { code: 'msa', label: 'Malay', bcp47: 'ms' },
  { code: 'mlt', label: 'Maltese', bcp47: 'mt' },
  { code: 'nor', label: 'Norwegian', bcp47: 'no' },
  { code: 'fas', label: 'Persian', bcp47: 'fa' },
  { code: 'pol', label: 'Polish', bcp47: 'pl' },
  { code: 'por', label: 'Portuguese', bcp47: 'pt' },
  { code: 'ron', label: 'Romanian', bcp47: 'ro' },
  { code: 'rus', label: 'Russian', bcp47: 'ru' },
  { code: 'srp', label: 'Serbian', bcp47: 'sr' },
  { code: 'slk', label: 'Slovak', bcp47: 'sk' },
  { code: 'slv', label: 'Slovenian', bcp47: 'sl' },
  { code: 'spa', label: 'Spanish', bcp47: 'es' },
  { code: 'swe', label: 'Swedish', bcp47: 'sv' },
  { code: 'tha', label: 'Thai', bcp47: 'th' },
  { code: 'tur', label: 'Turkish', bcp47: 'tr' },
  { code: 'ukr', label: 'Ukrainian', bcp47: 'uk' },
  { code: 'vie', label: 'Vietnamese', bcp47: 'vi' },
]

export const DEFAULT_OCR_LANGUAGE = 'eng'
