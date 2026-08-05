// N12 wave-1 locales — `resolveLanguage` is the ONE place an OS locale (or a
// stored preference) becomes a shipped catalog, and it is the only piece of
// the i18n surface the catalog parity gate cannot see. It earned a test when
// the first REGIONAL locales shipped: `pt-BR` and `zh-CN` are the only
// catalogs for their languages, so a `pt-PT`/`zh-TW`/bare-`zh` system would
// have fallen through to English under the old exact-or-base-only match.
import { describe, it, expect } from 'vitest';
import { resolveLanguage, SHIPPED_LOCALES, LOCALE_NATIVE_NAMES } from '../src/renderer/i18n';

describe('resolveLanguage (N12)', () => {
  it('takes an exact tag', () => {
    for (const locale of SHIPPED_LOCALES) {
      expect(resolveLanguage(locale)).toBe(locale);
    }
  });

  it('takes a bare base language to its bare catalog', () => {
    expect(resolveLanguage('es-MX')).toBe('es');
    expect(resolveLanguage('de-AT')).toBe('de');
    expect(resolveLanguage('fr-CA')).toBe('fr');
  });

  it('takes a base language to a REGIONAL catalog when that is the only one', () => {
    // Portuguese ships as pt-BR only. Every other spelling of the language
    // must reach it rather than fall back to English.
    expect(resolveLanguage('pt')).toBe('pt-BR');
    expect(resolveLanguage('pt-PT')).toBe('pt-BR');
  });

  it('is case-insensitive about the tag', () => {
    expect(resolveLanguage('PT-br')).toBe('pt-BR');
    expect(resolveLanguage('ES')).toBe('es');
  });

  it('falls back to English for a language we do not ship', () => {
    expect(resolveLanguage('sv')).toBe('en');
    expect(resolveLanguage('ko-KR')).toBe('en');
  });

  it('names every shipped locale in its own language', () => {
    for (const locale of SHIPPED_LOCALES) {
      expect(LOCALE_NATIVE_NAMES[locale], `${locale} has no native name`).toBeTruthy();
    }
  });
});
