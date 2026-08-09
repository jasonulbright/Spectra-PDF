// The renderer half of spell check: what gets underlined, what a fix writes,
// and which dictionary a check asks for. All of it is arithmetic and policy
// the panel and the paragraph editor would otherwise carry inline, and there
// is no DOM test environment to exercise it there.
import { describe, it, expect } from 'vitest';
import {
  AUTO_LANGUAGE,
  addCustomWord,
  groupByWord,
  misspelledRanges,
  occurrencesDescending,
  paragraphFix,
  removeCustomWord,
  replaceRange,
  resolveSpellLanguage,
  wordAt,
  type DictionaryEntry,
  type SpellIssue,
} from '../src/renderer/lib/spellcheck';
import { styledSegments, segmentsToHtml } from '../src/renderer/lib/edit-paragraphs';

const DICTS: DictionaryEntry[] = [
  { tag: 'en_US', bcp47: 'en-US', origin: 'bundled' },
  { tag: 'en_GB', bcp47: 'en-GB', origin: 'bundled' },
  { tag: 'de_DE', bcp47: 'de-DE', origin: 'bundled' },
  { tag: 'fr_FR', bcp47: 'fr-FR', origin: 'bundled' },
];

function issue(partial: Partial<SpellIssue>): SpellIssue {
  return {
    source: 'text',
    word: 'recieve',
    start: 0,
    end: 7,
    context: '',
    ...partial,
  };
}

describe('resolveSpellLanguage', () => {
  it('honours an explicit choice over everything else', () => {
    expect(resolveSpellLanguage('de_DE', 'fr-FR', 'en-US', DICTS)).toBe('de_DE');
  });

  it('falls back to the document when the choice is automatic', () => {
    expect(resolveSpellLanguage(AUTO_LANGUAGE, 'fr-FR', 'en-US', DICTS)).toBe('fr-FR');
  });

  it('falls back to the interface language when the document says nothing', () => {
    expect(resolveSpellLanguage(AUTO_LANGUAGE, null, 'de-DE', DICTS)).toBe('de-DE');
  });

  it('falls back to English when neither resolves to a dictionary', () => {
    expect(resolveSpellLanguage(AUTO_LANGUAGE, 'ja-JP', 'ja-JP', DICTS)).toBe('en_US');
  });

  it('matches a bare base language against a regional dictionary', () => {
    expect(resolveSpellLanguage(AUTO_LANGUAGE, 'de', 'en-US', DICTS)).toBe('de');
  });

  it('ignores a pinned language that is no longer installed', () => {
    // A user dictionary the user later deleted must not strand every check
    // on a refusal — the ladder simply carries on to the next rung.
    expect(resolveSpellLanguage('zz_ZZ', 'fr-FR', 'en-US', DICTS)).toBe('fr-FR');
  });
});

describe('replaceRange', () => {
  it('replaces a code-point range', () => {
    expect(replaceRange('the recieve here', 4, 11, 'receive')).toBe('the receive here');
  });

  it('counts astral characters as one', () => {
    // A UTF-16 slice would cut the clef in half and leave a lone surrogate.
    expect(replaceRange('𝄞 helo', 2, 6, 'hello')).toBe('𝄞 hello');
  });

  it('leaves the text alone for an out-of-range span', () => {
    expect(replaceRange('short', 2, 99, 'x')).toBe('short');
  });

  it('leaves the text alone for an inverted span', () => {
    expect(replaceRange('short', 4, 2, 'x')).toBe('short');
  });
});

describe('wordAt', () => {
  it('reads the word a range names', () => {
    expect(wordAt('the recieve here', 4, 11)).toBe('recieve');
  });

  it('reads astral text by code point', () => {
    expect(wordAt('𝄞 helo', 2, 6)).toBe('helo');
  });

  it('returns nothing for an empty or out-of-range span', () => {
    expect(wordAt('short', 2, 2)).toBe('');
    expect(wordAt('short', 0, 99)).toBe('');
  });
});

describe('paragraphFix', () => {
  const spans = [
    { start: 0, end: 4, run: 0 },
    { start: 4, end: 16, run: 1 },
  ];

  it('replaces the word and keeps the spans covering', () => {
    const fix = paragraphFix('the recieve here', spans, issue({ start: 4, end: 11 }), 'receive');
    expect(fix).not.toBeNull();
    expect(fix!.text).toBe('the receive here');
    expect(fix!.spans[0].start).toBe(0);
    expect(fix!.spans[fix!.spans.length - 1].end).toBe(fix!.text.length);
  });

  it('gives the correction the style of the word it replaces', () => {
    // The replaced characters sit wholly inside run 1, so the correction
    // must too — the caret-inheritance rule the editor already applies.
    const fix = paragraphFix('the recieve here', spans, issue({ start: 4, end: 11 }), 'receive');
    const covering = fix!.spans.find((s) => s.start <= 5 && s.end > 5);
    expect(covering?.run).toBe(1);
  });

  it('refuses when the range no longer holds the reported word', () => {
    expect(
      paragraphFix('the received here', spans, issue({ start: 4, end: 11 }), 'receive'),
    ).toBeNull();
  });

  it('refuses an empty replacement', () => {
    expect(paragraphFix('the recieve here', spans, issue({ start: 4, end: 11 }), '')).toBeNull();
  });

  it('produces spans a span-less listing can still commit', () => {
    const fix = paragraphFix('recieve', [], issue({ start: 0, end: 7 }), 'receive', 3);
    expect(fix!.spans).toEqual([{ start: 0, end: 7, run: 3 }]);
  });
});

describe('occurrencesDescending', () => {
  it('orders the occurrences last-first', () => {
    // Load-bearing for "change all": replacing an earlier occurrence shifts
    // every later offset, so a forward walk corrupts the tail whenever the
    // replacement is not the same length as the word.
    const issues = [
      issue({ start: 4, end: 11 }),
      issue({ start: 40, end: 47 }),
      issue({ start: 20, end: 27 }),
    ];
    expect(occurrencesDescending(issues, 'recieve').map((i) => i.start)).toEqual([40, 20, 4]);
  });

  it('takes only the named word', () => {
    const issues = [issue({ start: 0, end: 7 }), issue({ word: 'seperate', start: 9, end: 17 })];
    expect(occurrencesDescending(issues, 'seperate')).toHaveLength(1);
  });
});

describe('groupByWord', () => {
  it('groups by word, most frequent first', () => {
    const issues = [
      issue({ word: 'seperate' }),
      issue({ word: 'recieve' }),
      issue({ word: 'recieve' }),
    ];
    expect(groupByWord(issues).map((g) => [g.word, g.count])).toEqual([
      ['recieve', 2],
      ['seperate', 1],
    ]);
  });

  it('records every source a word was found in', () => {
    const issues = [
      issue({ word: 'recieve', source: 'text' }),
      issue({ word: 'recieve', source: 'fields' }),
    ];
    expect(groupByWord(issues)[0].sources.sort()).toEqual(['fields', 'text']);
  });
});

describe('misspelledRanges', () => {
  it('takes only the page-text hits of one paragraph', () => {
    const issues = [
      issue({ source: 'text', page: 1, paragraph: 0, start: 4, end: 11 }),
      issue({ source: 'text', page: 1, paragraph: 1, start: 0, end: 7 }),
      issue({ source: 'text', page: 2, paragraph: 0, start: 0, end: 7 }),
      issue({ source: 'comments', page: 1, start: 0, end: 7 }),
    ];
    expect(misspelledRanges(issues, 1, 0)).toEqual([{ start: 4, end: 11 }]);
  });
});

describe('custom words', () => {
  it('adds a word and keeps the list sorted', () => {
    expect(addCustomWord(['beta'], 'alpha')).toEqual(['alpha', 'beta']);
  });

  it('does not add a word that differs only in case', () => {
    expect(addCustomWord(['Spectra'], 'spectra')).toEqual(['Spectra']);
  });

  it('ignores blank input', () => {
    expect(addCustomWord(['alpha'], '   ')).toEqual(['alpha']);
  });

  it('removes case-insensitively', () => {
    expect(removeCustomWord(['Spectra', 'beta'], 'spectra')).toEqual(['beta']);
  });
});

describe('the misspelling axis in the editor', () => {
  it('segments on a misspelled range like any other style axis', () => {
    const segs = styledSegments('the recieve here', [], [], [], [{ start: 4, end: 11 }]);
    expect(segs.map((s) => [s.text, s.misspelled])).toEqual([
      ['the ', false],
      ['recieve', true],
      [' here', false],
    ]);
  });

  it('folds independently of colour', () => {
    const segs = styledSegments(
      'the recieve here',
      [{ start: 0, end: 8, color: '#ff0000' }],
      [],
      [],
      [{ start: 4, end: 11 }],
    );
    expect(segs.map((s) => s.text)).toEqual(['the ', 'reci', 'eve', ' here']);
    expect(segs.map((s) => s.misspelled)).toEqual([false, true, true, false]);
  });

  it('marks nothing when no range is given', () => {
    expect(styledSegments('the recieve here', []).every((s) => !s.misspelled)).toBe(true);
  });

  it('clamps a range past the end of the text', () => {
    const segs = styledSegments('abc', [], [], [], [{ start: 1, end: 99 }]);
    expect(segs.map((s) => [s.text, s.misspelled])).toEqual([
      ['a', false],
      ['bc', true],
    ]);
  });

  it('renders the mark as a class, never an inline decoration', () => {
    // A `text-decoration` in the style attribute would collide with the
    // underline a styled run may already carry.
    const html = segmentsToHtml(
      styledSegments('the recieve here', [], [], [], [{ start: 4, end: 11 }]),
      { basePx: 12, baseSize: 12, rev: 0 },
    );
    expect(html).toContain('class="page-editpara-misspelled"');
    expect(html).not.toContain('text-decoration');
  });

  it('escapes the text it marks', () => {
    const html = segmentsToHtml(styledSegments('<b>x', [], [], [], [{ start: 0, end: 4 }]), {
      basePx: 12,
      baseSize: 12,
      rev: 0,
    });
    expect(html).toContain('&lt;b&gt;x');
  });
});
