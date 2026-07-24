export interface OcrLanguage {
  code: string
  label: string
}

// The vendored recognition languages (P1). Every entry's traineddata is staged
// into resources/ocr-lang by scripts/sync-ocr-assets.mjs — the script PARSES
// this file for the codes, so this list is the single source of truth and a
// language added here without a matching @tesseract.js-data package fails the
// staging loudly instead of failing recognition silently at runtime.
// Alphabetical by label, English first (the default).
export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'eng', label: 'English' },
  { code: 'sqi', label: 'Albanian' },
  { code: 'ara', label: 'Arabic' },
  { code: 'eus', label: 'Basque' },
  { code: 'bul', label: 'Bulgarian' },
  { code: 'cat', label: 'Catalan' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'chi_tra', label: 'Chinese (Traditional)' },
  { code: 'hrv', label: 'Croatian' },
  { code: 'ces', label: 'Czech' },
  { code: 'dan', label: 'Danish' },
  { code: 'nld', label: 'Dutch' },
  { code: 'est', label: 'Estonian' },
  { code: 'fin', label: 'Finnish' },
  { code: 'fra', label: 'French' },
  { code: 'glg', label: 'Galician' },
  { code: 'deu', label: 'German' },
  { code: 'ell', label: 'Greek' },
  { code: 'heb', label: 'Hebrew' },
  { code: 'hin', label: 'Hindi' },
  { code: 'hun', label: 'Hungarian' },
  { code: 'isl', label: 'Icelandic' },
  { code: 'ind', label: 'Indonesian' },
  { code: 'gle', label: 'Irish' },
  { code: 'ita', label: 'Italian' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'kor', label: 'Korean' },
  { code: 'lav', label: 'Latvian' },
  { code: 'lit', label: 'Lithuanian' },
  { code: 'mkd', label: 'Macedonian' },
  { code: 'msa', label: 'Malay' },
  { code: 'mlt', label: 'Maltese' },
  { code: 'nor', label: 'Norwegian' },
  { code: 'fas', label: 'Persian' },
  { code: 'pol', label: 'Polish' },
  { code: 'por', label: 'Portuguese' },
  { code: 'ron', label: 'Romanian' },
  { code: 'rus', label: 'Russian' },
  { code: 'srp', label: 'Serbian' },
  { code: 'slk', label: 'Slovak' },
  { code: 'slv', label: 'Slovenian' },
  { code: 'spa', label: 'Spanish' },
  { code: 'swe', label: 'Swedish' },
  { code: 'tha', label: 'Thai' },
  { code: 'tur', label: 'Turkish' },
  { code: 'ukr', label: 'Ukrainian' },
  { code: 'vie', label: 'Vietnamese' },
]

export const DEFAULT_OCR_LANGUAGE = 'eng'
