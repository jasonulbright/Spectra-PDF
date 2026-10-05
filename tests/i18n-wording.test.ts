// Wording rules the catalogs must keep. Each one is a defect a reader saw:
// a count written as "1 pages" or "page(s)", two different buttons with one
// label, the snap toggle and the zoom-fit toggle with one word, a British
// spelling beside an American one, and a double hyphen where every other
// message uses a dash.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHROME_STRINGS } from '../src/renderer/i18n-chrome';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';
import { WORKBENCH_STRINGS } from '../src/renderer/i18n-workbench';
import { CANVAS_STRINGS } from '../src/renderer/i18n-canvas';
import { REFUSAL_STRINGS } from '../src/renderer/i18n-refusals';
import { ENGINE_MESSAGE_ROWS } from '../src/renderer/lib/engine-messages';

const LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt-BR', 'ja', 'zh-CN', 'nl', 'da', 'sv', 'nb', 'fi', 'ru', 'uk', 'pl', 'cs', 'sk', 'ko', 'zh-TW', 'tr', 'hu', 'el', 'ro', 'sl', 'ca', 'ar', 'he'];
const catalog = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(__dirname, `../src/renderer/locales/${locale}/chrome.json`), 'utf8'));

const TABLES: Record<string, string> = {
  ...CHROME_STRINGS,
  ...PANEL_STRINGS,
  ...DIALOG_STRINGS,
  ...WORKBENCH_STRINGS,
  ...CANVAS_STRINGS,
  ...REFUSAL_STRINGS,
};
const withoutPlaceholders = (s: string): string => s.replace(/\{\{[^}]*\}\}/g, '');

describe('English UI copy', () => {
  it('never writes a count with a parenthesised plural', () => {
    expect(Object.entries(TABLES).filter(([, v]) => /\w\((?:s|es)\)/.test(v)).map(([k]) => k)).toEqual([]);
    expect(ENGINE_MESSAGE_ROWS.filter((r) => /\w\((?:s|es)\)/.test(r.message)).map((r) => r.key)).toEqual([]);
  });

  it('uses American spelling', () => {
    const british =
      /(?<![A-Za-z])(re)?(colour|licence|analys(e|ed|es|ing)\b|recognis|greyscale|greyed|grey\b|catalogue|centre|centred|modelled|cancelled|labelled|judgement|behaviour|rasteris)/i;
    const tables = Object.entries(TABLES).filter(([, v]) => british.test(withoutPlaceholders(v)));
    const engine = ENGINE_MESSAGE_ROWS.filter((r) => british.test(withoutPlaceholders(r.message)));
    // The generated catalog also carries the derived tables: guided-action
    // step labels, tool descriptions, command titles, menu labels.
    const derived = Object.entries(catalog('en')).filter(([, v]) => british.test(withoutPlaceholders(v)));
    expect(tables.map(([k]) => k)).toEqual([]);
    expect(engine.map((r) => r.key)).toEqual([]);
    expect(derived.map(([k]) => k)).toEqual([]);
  });

  it('writes a dash, never a double hyphen, in engine messages', () => {
    expect(ENGINE_MESSAGE_ROWS.filter((r) => /(^|\s)--(\s|$)/.test(r.message)).map((r) => r.key)).toEqual([]);
  });
});

describe('labels that must stay distinct in every language', () => {
  const pairs: [string, string][] = [
    ['chrome.status.snap', 'chrome.status.fit'],
    ['panel.preflight.export', 'panel.preflight.exportProfile'],
  ];
  for (const locale of LOCALES) {
    it(`${locale} gives each control of a pair its own label`, () => {
      const cat = catalog(locale);
      for (const [a, b] of pairs) expect(cat[a], `${locale}: ${a} and ${b}`).not.toBe(cat[b]);
    });
  }
});
