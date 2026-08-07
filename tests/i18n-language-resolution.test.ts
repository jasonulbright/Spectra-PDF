// `resolveLanguage` is the ONE place an OS locale (or a
// stored preference) becomes a shipped catalog, and it is the only piece of
// the i18n surface the catalog parity gate cannot see. It earned a test when
// the first REGIONAL locales shipped: `pt-BR` and `zh-CN` are the only
// catalogs for their languages, so a `pt-PT`/`zh-TW`/bare-`zh` system would
// have fallen through to English under the old exact-or-base-only match.
import { describe, it, expect } from 'vitest';
import {
  resolveLanguage,
  ambiguousBases,
  textDirection,
  formattingLocale,
  LANGUAGE_ALIASES,
  SHIPPED_LOCALES,
  LOCALE_NATIVE_NAMES,
} from '../src/renderer/i18n';

describe('resolveLanguage', () => {
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
    // Portuguese ships as pt-BR only. Every other spelling of it must reach
    // that catalog rather than fall back to English.
    expect(resolveLanguage('pt')).toBe('pt-BR');
    expect(resolveLanguage('pt-PT')).toBe('pt-BR');
  });

  it('sends the Simplified-Chinese family to zh-CN', () => {
    for (const tag of ['zh', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh-CN']) {
      expect(resolveLanguage(tag), tag).toBe('zh-CN');
    }
  });

  it('sends the Traditional-Chinese family to zh-TW, never to the Simplified catalog', () => {
    // Traditional is a different catalog, not a regional spelling of zh-CN:
    // the script differs and so does the terminology. The alias rows were
    // authored before the catalog and did not change when it landed — the
    // answer moved from English to zh-TW because the target became shipped.
    for (const tag of ['zh-Hant', 'zh-Hant-TW', 'zh-TW', 'zh-HK', 'zh-MO']) {
      expect(resolveLanguage(tag), tag).toBe('zh-TW');
    }
    for (const prefix of ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo']) {
      expect(LANGUAGE_ALIASES[prefix], prefix).toBe('zh-TW');
    }
  });

  it('routes the whole Norwegian family to Bokmål, and legacy Hebrew ahead of its catalog', () => {
    // `nb` ships, so the macrolanguage and the Nynorsk tags now reach it —
    // the alias rows were authored before the catalog and did not change.
    for (const tag of ['no', 'no-NO', 'nn', 'nn-NO', 'nb', 'nb-NO']) {
      expect(resolveLanguage(tag), tag).toBe('nb');
    }
    expect(LANGUAGE_ALIASES['no']).toBe('nb');
    expect(LANGUAGE_ALIASES['nn']).toBe('nb');
    expect(resolveLanguage('iw')).toBe('en');
    expect(resolveLanguage('iw-IL')).toBe('en');
    expect(LANGUAGE_ALIASES['iw']).toBe('he');
  });

  it('decides every ambiguous base from the alias table, never from array order', () => {
    // A second regional catalog for a language makes the base match a coin
    // flip on `SHIPPED_LOCALES` order. This is the assertion that turns that
    // into a missing alias row.
    for (const base of ambiguousBases()) {
      expect(LANGUAGE_ALIASES[base], `base ${base} has two catalogs and no alias row`)
        .toBeTruthy();
    }
    for (const target of Object.values(LANGUAGE_ALIASES)) {
      if (!SHIPPED_LOCALES.includes(target)) continue;
      expect(resolveLanguage(target), `alias target ${target}`).toBe(target);
    }
  });

  it('is case-insensitive about the tag', () => {
    expect(resolveLanguage('PT-br')).toBe('pt-BR');
    expect(resolveLanguage('ES')).toBe('es');
    expect(resolveLanguage('JA')).toBe('ja');
    expect(resolveLanguage('ZH-cn')).toBe('zh-CN');
  });

  it('takes a regional tag to its bare catalog', () => {
    expect(resolveLanguage('ja-JP')).toBe('ja');
    // The Slavic wave ships five bare tags, and the regional forms every
    // Windows install actually reports have to reach them by the base-match
    // step alone — an alias row for any of these would be dead weight, and
    // `uk-UA` is additionally the tag some systems still report for Ukrainian.
    expect(resolveLanguage('ru-RU')).toBe('ru');
    expect(resolveLanguage('uk-UA')).toBe('uk');
    expect(resolveLanguage('pl-PL')).toBe('pl');
    expect(resolveLanguage('cs-CZ')).toBe('cs');
    expect(resolveLanguage('sk-SK')).toBe('sk');
    // Korean ships bare, so `ko-KR` reaches it by the base-match step. It is
    // NOT an ambiguous base — `zh` is the only base with two catalogs.
    expect(resolveLanguage('ko-KR')).toBe('ko');
    expect(resolveLanguage('tr-TR')).toBe('tr');
    expect(resolveLanguage('hu-HU')).toBe('hu');
  });

  it('falls back to English for a language we do not ship', () => {
    // Icelandic and Afrikaans are outside the locale register entirely, so
    // these stay unshipped as later waves land (`sv` and `ko` did not).
    expect(resolveLanguage('is')).toBe('en');
    expect(resolveLanguage('af-ZA')).toBe('en');
  });

  it('names every shipped locale in its own language', () => {
    for (const locale of SHIPPED_LOCALES) {
      expect(LOCALE_NATIVE_NAMES[locale], `${locale} has no native name`).toBeTruthy();
    }
  });
});

describe('textDirection', () => {
  it('reads direction from CLDR rather than a list of locales', () => {
    for (const tag of ['ar', 'ar-EG', 'he', 'he-IL', 'fa', 'ur', 'ckb']) {
      expect(textDirection(tag), tag).toBe('rtl');
    }
    for (const tag of [...SHIPPED_LOCALES, 'ru', 'el', 'ko', 'zh-TW', 'tr']) {
      expect(textDirection(tag), tag).toBe('ltr');
    }
  });

  it('answers for the pseudo-locales, which have no BCP-47 identity', () => {
    expect(textDirection('qps')).toBe('ltr');
    expect(textDirection('qps-rtl')).toBe('rtl');
  });

  it('never throws on a tag Intl cannot parse', () => {
    expect(textDirection('not a tag')).toBe('ltr');
    expect(textDirection('')).toBe('ltr');
  });
});

describe('formattingLocale', () => {
  it('gives the Intl formatters a tag they can parse', () => {
    // `qps-rtl` is not well-formed BCP-47 (there is no three-letter region),
    // so every Intl constructor throws RangeError on it — which unmounts the
    // whole app the first time a ruler label formats a number.
    expect(() => new Intl.NumberFormat('qps-rtl')).toThrow(RangeError);
    expect(formattingLocale('qps-rtl')).toBe('en');
    expect(formattingLocale('qps')).toBe('en');
    expect(() => new Intl.NumberFormat(formattingLocale('qps-rtl'))).not.toThrow();
  });

  it('leaves a real language alone', () => {
    for (const locale of SHIPPED_LOCALES) {
      expect(formattingLocale(locale), locale).toBe(locale);
    }
  });
});
