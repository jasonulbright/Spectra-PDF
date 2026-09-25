import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { foldSentences } from '../src/renderer/lib/sentence-join';

const fill = (pattern: string) => (first: string, second: string): string =>
  pattern.replace('{{first}}', first).replace('{{second}}', second);
const catalog = (lng: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve(__dirname, `../src/renderer/locales/${lng}/chrome.json`), 'utf8'));

describe('foldSentences', () => {
  it('returns a single sentence unchanged and drops empty parts', () => {
    expect(foldSentences(['A.'], fill('{{first}} {{second}}'))).toBe('A.');
    expect(foldSentences(['', 'A.', ''], fill('{{first}} {{second}}'))).toBe('A.');
    expect(foldSentences([], fill('{{first}} {{second}}'))).toBe('');
  });

  it('joins through the Japanese pattern without a space', () => {
    const pair = fill(catalog('ja')['chrome.common.sentencePair']);
    expect(foldSentences(['一。', '二。', '三。'], pair)).toBe('一。二。三。');
  });

  it('joins through the German pattern with a space', () => {
    const pair = fill(catalog('de')['chrome.common.sentencePair']);
    expect(foldSentences(['Eins.', 'Zwei.'], pair)).toBe('Eins. Zwei.');
  });
});
