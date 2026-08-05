import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileMatcher } from '../src/renderer/search/normalize';

// F15 slice C — the renderer half of the shared matcher pin. The SAME JSON
// file drives tests/test_text_match.py; if the two matchers ever disagree
// about a query, one of the two suites goes red before a user finds out that
// the find bar and Search & Redact see different documents (the S1 lesson —
// the GUI and the CLI ran different forms implementations, and a user found
// that one).
interface Case {
  name: string;
  query: string;
  text: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  spans: [number, number][];
}

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'matcher-corpus.json'), 'utf8'),
) as { cases: Case[] };

function spansOf(c: Case): [number, number][] {
  const { regex, error } = compileMatcher(c.query, {
    regex: c.regex,
    caseSensitive: c.caseSensitive,
    wholeWord: c.wholeWord,
  });
  expect(error, c.name).toBeNull();
  if (!regex) return [];
  const out: [number, number][] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(c.text)) !== null) {
    if (m[0].length > 0) out.push([m.index, m.index + m[0].length]);
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return out;
}

describe('shared matcher corpus', () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      expect(spansOf(c)).toEqual(c.spans);
    });
  }

  it('exercises every mode (a corpus that skips a mode pins nothing about it)', () => {
    expect(corpus.cases.some((c) => c.regex)).toBe(true);
    expect(corpus.cases.some((c) => c.wholeWord)).toBe(true);
    expect(corpus.cases.some((c) => c.caseSensitive)).toBe(true);
    expect(corpus.cases.some((c) => c.regex && c.wholeWord)).toBe(true);
  });
});
