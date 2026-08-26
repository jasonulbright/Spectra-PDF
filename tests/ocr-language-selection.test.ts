import { describe, it, expect } from 'vitest';
import {
  normalizeLanguages,
  toTesseractLang,
  parseTesseractLang,
  describeLanguages,
  ocrLanguageForTag,
  resolveSelectionLanguage,
  AUTO_OCR_LANGUAGE,
} from '../src/renderer/ocr/language-selection';
import { DEFAULT_OCR_LANGUAGE } from '../src/renderer/ocr/languages';

// Multi-language OCR selection. No DOM test env, so the
// orderings and refusals live in a pure module and are pinned here.

describe('normalizeLanguages', () => {
  it('never yields an empty selection — Tesseract rejects an empty lang string', () => {
    expect(normalizeLanguages([])).toEqual([DEFAULT_OCR_LANGUAGE]);
    expect(normalizeLanguages(['nonsense', ''])).toEqual([DEFAULT_OCR_LANGUAGE]);
  });

  it('drops codes with no vendored traineddata', () => {
    // An un-staged language recognizes to NOTHING at runtime. Silently
    // offering one is the silent-degradation class the staging gate exists
    // to prevent, so it is dropped here too rather than passed through.
    expect(normalizeLanguages(['eng', 'klingon'])).toEqual(['eng']);
  });

  it('de-duplicates', () => {
    expect(normalizeLanguages(['fra', 'fra', 'eng'])).toEqual(['eng', 'fra']);
  });

  it('sorts into catalog order so click order cannot change the result', () => {
    // Same set, opposite click order -> identical string. Without this, two
    // users picking the same languages get different cache keys and the
    // worker rebuilds its scheduler for no reason.
    expect(toTesseractLang(['fra', 'eng'])).toBe(toTesseractLang(['eng', 'fra']));
    expect(toTesseractLang(['fra', 'eng'])).toBe('eng+fra');
  });
});

describe('toTesseractLang / parseTesseractLang', () => {
  it("produces Tesseract's '+'-joined form", () => {
    expect(toTesseractLang(['eng', 'fra', 'deu'])).toBe('eng+fra+deu');
  });

  it('round-trips, and reads a legacy single code unchanged', () => {
    expect(parseTesseractLang('eng+fra')).toEqual(['eng', 'fra']);
    expect(parseTesseractLang('deu')).toEqual(['deu']);
    expect(parseTesseractLang('')).toEqual([DEFAULT_OCR_LANGUAGE]);
    const codes = ['eng', 'fra'];
    expect(parseTesseractLang(toTesseractLang(codes))).toEqual(codes);
  });

  it('tolerates whitespace and junk in a stored value', () => {
    expect(parseTesseractLang(' eng + fra ')).toEqual(['eng', 'fra']);
    expect(parseTesseractLang('eng+++')).toEqual(['eng']);
  });
});

describe('describeLanguages', () => {
  it('names one or two, counts beyond that', () => {
    expect(describeLanguages(['eng'])).toBe('English');
    expect(describeLanguages(['fra', 'eng'])).toBe('English + French');
    expect(describeLanguages(['eng', 'fra', 'deu'])).toBe('3 languages');
  });
});

// ── the view tier's language ladder ─────────────────────────────────────────
// The selection tier cannot stop and ask which model to load, so it resolves
// one. The ladder is the whole feature; these pin it.

describe('ocrLanguageForTag', () => {
  it('maps a plain BCP-47 tag to its model', () => {
    expect(ocrLanguageForTag('fr')).toBe('fra');
    expect(ocrLanguageForTag('de')).toBe('deu');
    expect(ocrLanguageForTag('en')).toBe('eng');
  });

  it('ignores region and variant subtags', () => {
    // One model covers en-US and en-GB alike; a region subtag carries no
    // recognition meaning, and treating it as unmappable would drop every
    // /Lang a real producer writes.
    expect(ocrLanguageForTag('en-US')).toBe('eng');
    expect(ocrLanguageForTag('pt-BR')).toBe('por');
    // Underscores, from producers that never read the spec.
    expect(ocrLanguageForTag('de_DE')).toBe('deu');
    // Case is not meaningful in a tag.
    expect(ocrLanguageForTag('FR-CA')).toBe('fra');
  });

  it('honours a script subtag, and refuses an ambiguous primary', () => {
    // zh holds two models. A document that says bare `zh` has not said which
    // script it is printed in, and recognising Traditional pages with the
    // Simplified model is the silent degradation this refuses.
    expect(ocrLanguageForTag('zh-Hans')).toBe('chi_sim');
    expect(ocrLanguageForTag('zh-Hant')).toBe('chi_tra');
    expect(ocrLanguageForTag('zh-Hant-TW')).toBe('chi_tra');
    expect(ocrLanguageForTag('zh')).toBeNull();
  });

  it('reads the script a Chinese region subtag implies', () => {
    // `zh-TW` is the commonest shape Traditional Chinese reaches `/Lang` in,
    // and the region names the script as unambiguously as `zh-Hant` does.
    expect(ocrLanguageForTag('zh-TW')).toBe('chi_tra');
    expect(ocrLanguageForTag('zh-HK')).toBe('chi_tra');
    expect(ocrLanguageForTag('zh-MO')).toBe('chi_tra');
    expect(ocrLanguageForTag('zh-CN')).toBe('chi_sim');
    expect(ocrLanguageForTag('zh-SG')).toBe('chi_sim');
    // The producer shapes that are not a hyphenated lowercase tag.
    expect(ocrLanguageForTag('zh_CN')).toBe('chi_sim');
    expect(ocrLanguageForTag('ZH-tw')).toBe('chi_tra');
    // An explicit script still wins over the region, however they disagree.
    expect(ocrLanguageForTag('zh-Hans-TW')).toBe('chi_sim');
    // A region that implies nothing leaves the primary ambiguous.
    expect(ocrLanguageForTag('zh-US')).toBeNull();
    // No other primary reads a region as a script.
    expect(ocrLanguageForTag('pt-TW')).toBe('por');
  });

  it('answers null for nothing, junk, and languages with no model', () => {
    expect(ocrLanguageForTag(null)).toBeNull();
    expect(ocrLanguageForTag(undefined)).toBeNull();
    expect(ocrLanguageForTag('  ')).toBeNull();
    expect(ocrLanguageForTag('-')).toBeNull();
    // Swahili is a real tag with no model in the vendored catalog.
    expect(ocrLanguageForTag('sw')).toBeNull();
  });
});

describe('resolveSelectionLanguage', () => {
  it('takes the document /Lang when the preference is auto', () => {
    expect(resolveSelectionLanguage(AUTO_OCR_LANGUAGE, 'fr-FR')).toBe('fra');
    expect(resolveSelectionLanguage('', 'de')).toBe('deu');
  });

  it('falls back to English with no preference and no usable /Lang', () => {
    expect(resolveSelectionLanguage(AUTO_OCR_LANGUAGE, null)).toBe(DEFAULT_OCR_LANGUAGE);
    expect(resolveSelectionLanguage(AUTO_OCR_LANGUAGE, 'zh')).toBe(DEFAULT_OCR_LANGUAGE);
    expect(resolveSelectionLanguage(AUTO_OCR_LANGUAGE, 'sw')).toBe(DEFAULT_OCR_LANGUAGE);
  });

  it('lets an EXPLICIT preference outrank the document', () => {
    // A /Lang is written by whatever produced the file and is routinely wrong
    // or absent on exactly the scanned documents this tier serves. A ladder
    // that let it win would leave the picker inert on every tagged document.
    expect(resolveSelectionLanguage('deu', 'fr-FR')).toBe('deu');
    expect(resolveSelectionLanguage('chi_tra', 'en-US')).toBe('chi_tra');
  });

  it('normalises a multi-model preference into catalog order', () => {
    expect(resolveSelectionLanguage('fra+eng', null)).toBe('eng+fra');
  });

  it('falls THROUGH a preference naming nothing real, rather than pinning English', () => {
    // `normalizeLanguages` answers a fully-unknown selection with the default,
    // which here would silently outrank a document that said it was French.
    expect(resolveSelectionLanguage('klingon', 'fr')).toBe('fra');
    // A partly-real preference keeps the part that exists.
    expect(resolveSelectionLanguage('klingon+deu', 'fr')).toBe('deu');
  });
});
