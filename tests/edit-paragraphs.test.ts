import { describe, it, expect } from 'vitest';
import {
  computeEditSpans,
  fetchEditTextListing,
  hexToRgb,
  paragraphUnencodable,
  sanitizeParagraphInput,
  utf16ToCodePointIndex,
} from '../src/renderer/lib/edit-paragraphs';

describe('computeEditSpans (7.5 caret inheritance)', () => {
  const spans = [
    { start: 0, end: 6, run: 0 }, // "Hello "
    { start: 6, end: 11, run: 1 }, // "World"
  ];

  it('unchanged text keeps the spans', () => {
    expect(computeEditSpans('Hello World', 'Hello World', spans)).toEqual(spans);
  });

  it('an insertion inherits the style of the char before the change', () => {
    const out = computeEditSpans('Hello World', 'Hello Cruel World', spans);
    // "Cruel " is inserted at 6; the char before is span 0's space.
    expect(out).toEqual([
      { start: 0, end: 12, run: 0 },
      { start: 12, end: 17, run: 1 },
    ]);
  });

  it('an append extends the last span', () => {
    const out = computeEditSpans('Hello World', 'Hello Worlds', spans);
    expect(out).toEqual([
      { start: 0, end: 6, run: 0 },
      { start: 6, end: 12, run: 1 },
    ]);
  });

  it('a prepend takes the first span style', () => {
    const out = computeEditSpans('Hello World', 'Oh Hello World', spans);
    expect(out).toEqual([
      { start: 0, end: 9, run: 0 },
      { start: 9, end: 14, run: 1 },
    ]);
  });

  it('a replacement across the boundary inherits from before the change', () => {
    const out = computeEditSpans('Hello World', 'Hey there', spans);
    // Common prefix "He", suffix "" ... the middle takes span 0.
    expect(out[0].run).toBe(0);
    expect(out[out.length - 1].end).toBe(9);
    const covered = out.every((sp, i) => (i === 0 ? sp.start === 0 : sp.start === out[i - 1].end));
    expect(covered).toBe(true);
  });

  it('deletion of everything yields no spans', () => {
    expect(computeEditSpans('Hello World', '', spans)).toEqual([]);
  });

  it('empty old spans fall back to the provided run so text is always covered', () => {
    expect(computeEditSpans('', 'hello', [], 7)).toEqual([{ start: 0, end: 5, run: 7 }]);
    // Without a fallback there is nothing to inherit — empty, not throw.
    expect(computeEditSpans('', 'hello', [])).toEqual([]);
  });

  it('shrink with overlapping prefix/suffix stays in range', () => {
    const one = [{ start: 0, end: 3, run: 0 }];
    const out = computeEditSpans('aaa', 'aa', one);
    expect(out).toEqual([{ start: 0, end: 2, run: 0 }]);
  });

  it('indexes are code points, not UTF-16 units', () => {
    // "𝄞" is one code point (two UTF-16 units); the engine slices Python
    // strings, so spans must be code-point ranges.
    const one = [{ start: 0, end: 3, run: 0 }];
    const out = computeEditSpans('a𝄞b', 'a𝄞bc', one);
    expect(out).toEqual([{ start: 0, end: 4, run: 0 }]);
  });
});

describe('paragraphUnencodable (per-span validation)', () => {
  it('validates each range against its own font', () => {
    const spans = [
      { start: 0, end: 2, run: 0 },
      { start: 2, end: 4, run: 1 },
    ];
    const inv = new Map([
      [0, 'ab'],
      [1, 'cd'],
    ]);
    expect(paragraphUnencodable('abcd', spans, inv)).toEqual([]);
    // 'c' is fine for run 1 but the SAME char in run 0's range is not.
    expect(paragraphUnencodable('cbcd', spans, inv)).toEqual(['c']);
  });

  it('spaces always pass (synthetic-gap emission)', () => {
    const spans = [{ start: 0, end: 3, run: 0 }];
    expect(paragraphUnencodable('a b', spans, new Map([[0, 'ab']]))).toEqual([]);
  });

  it('dedups in order', () => {
    const spans = [{ start: 0, end: 4, run: 0 }];
    expect(paragraphUnencodable('→→é→', spans, new Map([[0, 'x']]))).toEqual(['→', 'é']);
  });
});

describe('sanitizeParagraphInput', () => {
  it('newlines become spaces', () => {
    expect(sanitizeParagraphInput('a\r\nb\nc')).toBe('a b c');
  });
});

describe('hexToRgb (A1 colour control)', () => {
  it('parses #rrggbb to 0-1 floats', () => {
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    const [r, g, b] = hexToRgb('#8040c0')!;
    expect(r).toBeCloseTo(0x80 / 255);
    expect(g).toBeCloseTo(0x40 / 255);
    expect(b).toBeCloseTo(0xc0 / 255);
  });
  it('accepts without the hash and is case-insensitive', () => {
    expect(hexToRgb('FF0000')).toEqual([1, 0, 0]);
  });
  it('rejects malformed input', () => {
    expect(hexToRgb('#fff')).toBeNull();
    expect(hexToRgb('red')).toBeNull();
    expect(hexToRgb('#gggggg')).toBeNull();
  });
});

describe('fetchEditTextListing projection', () => {
  const listing = {
    runs: [
      {
        index: 0,
        text: 'Hello',
        rect: [72, 700, 100, 712] as [number, number, number, number],
        nested: false,
        editable: true,
        reason: null,
        encodable: 'Helo',
      },
      {
        index: 1,
        text: 'Rotated',
        rect: [200, 300, 212, 340] as [number, number, number, number],
        nested: false,
        editable: true,
        reason: null,
        encodable: 'Rotated',
      },
    ],
    paragraphs: [
      {
        index: 0,
        runs: [0],
        box: [72, 700, 100, 712] as [number, number, number, number],
        text: 'Hello',
        spans: [{ start: 0, end: 5, run: 0 }],
        alignment: 'left',
        line_count: 1,
        editable: true,
        reason: null,
      },
    ],
  };

  it('covered runs leave the run-box layer; the rest stay', async () => {
    const out = await fetchEditTextListing(
      async () => listing,
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
    );
    expect(out.paragraphs).toHaveLength(1);
    expect(out.paragraphs[0].encodableByRun.get(0)).toBe('Helo');
    expect(out.runBoxes.map((r) => r.index)).toEqual([1]);
    expect(out.paragraphs[0].rect.x).toBeCloseTo(72 / 612);
  });

  it('refused paragraphs decompose to run boxes', async () => {
    const refused = {
      ...listing,
      paragraphs: [
        { ...listing.paragraphs[0], editable: false, reason: 'right-to-left text does not reflow' },
      ],
    };
    const out = await fetchEditTextListing(
      async () => refused,
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
    );
    expect(out.paragraphs).toHaveLength(0);
    expect(out.runBoxes.map((r) => r.index)).toEqual([0, 1]);
  });
});

describe('utf16ToCodePointIndex (A4 split caret domain)', () => {
  it('is identity for BMP-only text', () => {
    expect(utf16ToCodePointIndex('hello world', 6)).toBe(6);
    expect(utf16ToCodePointIndex('hello', 0)).toBe(0);
    expect(utf16ToCodePointIndex('hello', 5)).toBe(5);
  });

  it('counts an astral char as ONE code point past it', () => {
    // '𝄞' is two UTF-16 units; a caret after it is utf16 index 2, cp 1.
    const text = '𝄞ab';
    expect(utf16ToCodePointIndex(text, 2)).toBe(1);
    expect(utf16ToCodePointIndex(text, 3)).toBe(2);
    expect(utf16ToCodePointIndex(text, 4)).toBe(3);
  });
});
