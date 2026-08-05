import { describe, it, expect } from 'vitest';
import {
  normalizeLanguages,
  toTesseractLang,
  parseTesseractLang,
  describeLanguages,
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
