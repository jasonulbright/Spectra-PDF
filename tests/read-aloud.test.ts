// Read Out Loud's reading model — everything decidable without a voice.
//
// The synthesizer half (`hooks/useReadAloud`) needs a browser and is covered
// by e2e 135; what a test environment CAN hold is the whole of what gets said
// and where it is drawn, which is here.
import { describe, it, expect } from 'vitest';
import {
  fetchReadAloudPage,
  normalizeRate,
  pickVoice,
  readingLocale,
  rectsForRange,
  segmentSentences,
  utterancesForPage,
  type ReadBlock,
  type ReadPage,
} from '../src/renderer/lib/read-aloud';

const GEOMETRY = {
  box: { x: 0, y: 0, width: 100, height: 100 },
  bakedRotate: 0,
};

/** A block whose spans carry per-character geometry: five characters of one
 * run, each 10 wide, at y 0..10 in a 100×100 page. */
function exactBlock(): ReadBlock {
  return {
    index: 0,
    role: 'P',
    text: 'abcde',
    rect: { x: 0, y: 0, w: 0.5, h: 0.1 },
    spans: [
      {
        s: 0,
        e: 5,
        run: 0,
        rect: { x: 0, y: 0, w: 0.5, h: 0.1 },
        chars: [0, 1, 2, 3, 4].map((i) => ({ x: i * 0.1, y: 0, w: 0.1, h: 0.1 })),
      },
    ],
  };
}

describe('rectsForRange', () => {
  it('slices an exact span to the characters named', () => {
    const rects = rectsForRange(exactBlock(), 1, 3);
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBeCloseTo(0.1);
    expect(rects[0].w).toBeCloseTo(0.2);
  });

  it('gives the whole run for a span with no proved character map', () => {
    const block = exactBlock();
    delete block.spans[0].chars;
    expect(rectsForRange(block, 1, 3)).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.1 }]);
  });

  it('returns ONE rect per span and never a box bounded across them', () => {
    // Two runs on two lines: a range crossing both must not produce a single
    // rectangle swallowing the margin between them (search_text_regions rule 3).
    const block: ReadBlock = {
      index: 0,
      role: null,
      text: 'abcd',
      rect: { x: 0, y: 0, w: 0.4, h: 0.5 },
      spans: [
        {
          s: 0,
          e: 2,
          run: 0,
          rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
          chars: [
            { x: 0, y: 0, w: 0.1, h: 0.1 },
            { x: 0.1, y: 0, w: 0.1, h: 0.1 },
          ],
        },
        {
          s: 2,
          e: 4,
          run: 1,
          rect: { x: 0, y: 0.4, w: 0.2, h: 0.1 },
          chars: [
            { x: 0, y: 0.4, w: 0.1, h: 0.1 },
            { x: 0.1, y: 0.4, w: 0.1, h: 0.1 },
          ],
        },
      ],
    };
    const rects = rectsForRange(block, 1, 3);
    expect(rects).toHaveLength(2);
    expect(rects[0].y).toBeCloseTo(0);
    expect(rects[1].y).toBeCloseTo(0.4);
  });

  it('is empty for an empty range', () => {
    expect(rectsForRange(exactBlock(), 2, 2)).toEqual([]);
  });

  it('falls back to the span rect when the slice names only ink-less boxes', () => {
    const block = exactBlock();
    block.spans[0].chars = block.spans[0].chars!.map((r) => ({ ...r, w: 0, h: 0 }));
    expect(rectsForRange(block, 0, 2)).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.1 }]);
  });
});

describe('segmentSentences', () => {
  it('splits a paragraph and reports offsets into it', () => {
    const text = 'One thing happened. Then another thing did.';
    const parts = segmentSentences(text, 'en-US');
    expect(parts).toHaveLength(2);
    expect(text.slice(parts[0].start, parts[0].end)).toBe(parts[0].text);
    expect(parts[0].text.trim()).toBe('One thing happened.');
    expect(parts[1].text.trim()).toBe('Then another thing did.');
  });

  it('drops a segment with nothing in it', () => {
    expect(segmentSentences('   \n  ', 'en-US')).toEqual([]);
  });

  it('reads an unusable locale tag as the runtime default rather than failing', () => {
    // The tag is the DOCUMENT's; a malformed /Lang must never take the reader
    // down with it.
    const parts = segmentSentences('A sentence.', 'not a language tag');
    expect(parts).toHaveLength(1);
  });
});

describe('utterancesForPage', () => {
  const page = (blocks: ReadBlock[]): ReadPage => ({
    page: 3,
    order: 'structure',
    reason: null,
    artifacts: 0,
    blocks,
  });

  const block = (index: number, text: string): ReadBlock => ({
    index,
    role: 'P',
    text,
    rect: { x: 0, y: 0, w: 1, h: 0.1 },
    spans: [{ s: 0, e: text.length, run: index, rect: { x: 0, y: 0, w: 1, h: 0.1 } }],
  });

  it('carries the page and block a sentence came from', () => {
    const out = utterancesForPage(page([block(0, 'Alpha. Beta.')]), 7, 'en-US');
    expect(out).toHaveLength(2);
    expect(out.every((u) => u.pageIndex === 7 && u.blockIndex === 0)).toBe(true);
    expect(out[1].text.trim()).toBe('Beta.');
  });

  it('skips a block that yields no sentence instead of speaking nothing', () => {
    const out = utterancesForPage(page([block(0, '   '), block(1, 'Real text.')]), 0, 'en-US');
    expect(out).toHaveLength(1);
    expect(out[0].blockIndex).toBe(1);
  });
});

describe('readingLocale', () => {
  it('takes the document over the interface', () => {
    expect(readingLocale('de-DE', 'en')).toBe('de-DE');
  });

  it('falls back to the interface language when the document says nothing', () => {
    expect(readingLocale(null, 'fr')).toBe('fr');
    expect(readingLocale('   ', 'fr')).toBe('fr');
  });

  it('falls back when the document states something that is not a tag', () => {
    expect(readingLocale('English (US)', 'fr')).toBe('fr');
  });
});

describe('pickVoice', () => {
  const voices = [
    { voiceURI: 'a', lang: 'en-US' },
    { voiceURI: 'b', lang: 'en-GB' },
    { voiceURI: 'c', lang: 'de-DE' },
  ];

  it('honours a pin that is still installed', () => {
    expect(pickVoice(voices, 'de-DE', 'a')).toBe('a');
  });

  it('ignores a pin naming a voice that is gone', () => {
    expect(pickVoice(voices, 'de-DE', 'uninstalled')).toBe('c');
  });

  it('prefers an exact tag, then the language', () => {
    expect(pickVoice(voices, 'en-GB', '')).toBe('b');
    expect(pickVoice(voices, 'en-AU', '')).toBe('a');
  });

  it('answers with nothing — the platform default — when no voice speaks it', () => {
    expect(pickVoice(voices, 'ja-JP', '')).toBe('');
    expect(pickVoice([], 'en-US', '')).toBe('');
  });
});

describe('normalizeRate', () => {
  it('keeps an offered rate', () => {
    expect(normalizeRate(1.5)).toBe(1.5);
  });

  it('pulls a stored oddity onto the offered set', () => {
    // The Web Speech API throws away the whole utterance on a rate it rejects,
    // so a hand-edited settings file must not be able to silence the reader.
    expect(normalizeRate(97)).toBe(3);
    expect(normalizeRate(0)).toBe(0.5);
    expect(normalizeRate(Number.NaN)).toBe(1);
  });
});

describe('fetchReadAloudPage', () => {
  const listing = {
    page: 2,
    order: 'structure',
    reason: null,
    artifacts: 4,
    blocks: [
      {
        index: 0,
        role: 'H1',
        text: 'Title',
        box: [0, 90, 50, 100],
        spans: [
          {
            s: 0,
            e: 5,
            run: 0,
            rect: [0, 90, 50, 100],
            exact: true,
            chars: [
              [0, 90, 10, 100],
              [10, 90, 20, 100],
              [20, 90, 30, 100],
              [30, 90, 40, 100],
              [40, 90, 50, 100],
            ],
          },
        ],
      },
      {
        index: 1,
        role: 'P',
        text: 'Body',
        box: [0, 0, 40, 10],
        spans: [{ s: 0, e: 4, run: 1, rect: [0, 0, 40, 10], exact: false }],
      },
    ],
  };

  it('converts page-space rects to display-normalized ones', async () => {
    const page = await fetchReadAloudPage(async () => listing, 'x.pdf', 2, GEOMETRY);
    expect(page.order).toBe('structure');
    expect(page.artifacts).toBe(4);
    // PDF y-up 90..100 is display y-down 0..0.1.
    expect(page.blocks[0].rect.y).toBeCloseTo(0);
    expect(page.blocks[0].rect.h).toBeCloseTo(0.1);
    expect(page.blocks[0].spans[0].chars).toHaveLength(5);
  });

  it('drops the character map of a span the engine did not prove exact', async () => {
    const page = await fetchReadAloudPage(async () => listing, 'x.pdf', 2, GEOMETRY);
    expect(page.blocks[1].spans[0].chars).toBeUndefined();
    expect(rectsForRange(page.blocks[1], 1, 2)).toHaveLength(1);
  });

  it('reads an unknown order as layout', async () => {
    const page = await fetchReadAloudPage(
      async () => ({ ...listing, order: 'something else' }),
      'x.pdf',
      2,
      GEOMETRY,
    );
    expect(page.order).toBe('layout');
  });
});
