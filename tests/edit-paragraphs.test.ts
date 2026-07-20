import { describe, it, expect } from 'vitest';
import {
  applySpanColor,
  applySpanFace,
  backdropSegments,
  computeEditSpans,
  fetchEditTextListing,
  hexToRgb,
  mergeSpanColors,
  mergeSpanFaces,
  paragraphUnencodable,
  remapRanges,
  sanitizeParagraphInput,
  seedSpanColors,
  spanColorsToStyles,
  spanFacesToStyles,
  spanSizesToStyles,
  applySpanSize,
  mergeSpanSizes,
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

  it('threads the writing mode; absent means horizontal (9.B4b)', async () => {
    const vertical = {
      ...listing,
      paragraphs: [{ ...listing.paragraphs[0], vertical: true }],
    };
    const out = await fetchEditTextListing(
      async () => vertical,
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
    );
    expect(out.paragraphs[0].vertical).toBe(true);
    // Pre-B4b engines omit the field — it must default false, not crash.
    const plain = await fetchEditTextListing(
      async () => listing,
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
    );
    expect(plain.paragraphs[0].vertical).toBe(false);
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

describe('remapRanges (9.A5a — per-span ranges follow the text)', () => {
  const R = [{ start: 6, end: 13, color: '#ff0000' }];

  it('shifts a range wholly after an insertion by the delta', () => {
    // Insert "XY" at the front: [6,13) → [8,15).
    expect(remapRanges('Hello colored world', 'XYHello colored world', R)).toEqual([
      { start: 8, end: 15, color: '#ff0000' },
    ]);
  });

  it('leaves a range wholly before the change unmoved', () => {
    // Append at the end — the front range is untouched.
    expect(remapRanges('Hello colored world', 'Hello colored world!!', R)).toEqual([
      { start: 6, end: 13, color: '#ff0000' },
    ]);
  });

  it('extends a range when typing inside it (the coloured text grows)', () => {
    // Replace "colored" (6..13) with "coloured" (one longer): the range
    // absorbs the change — end clamps to the new change end.
    const out = remapRanges('Hello colored world', 'Hello coloured world', R);
    expect(out[0].start).toBe(6);
    expect(out[0].end).toBe(14); // was 13, +1 for the inserted 'u'
  });

  it('drops a range collapsed to empty by a deletion', () => {
    // Delete exactly [6,13): the range has nothing left.
    expect(remapRanges('Hello colored world', 'Hello  world', R)).toEqual([]);
  });

  it('remaps astral text by CODE POINT, not UTF-16 unit', () => {
    // '𝄞' is 2 UTF-16 units but ONE code point; a range after it shifts by
    // the code-point delta.
    const ranges = [{ start: 2, end: 4, color: '#00ff00' }];
    // Insert one astral char at front: everything shifts by 1 code point.
    expect(remapRanges('abcd', '𝄞abcd', ranges)).toEqual([
      { start: 3, end: 5, color: '#00ff00' },
    ]);
  });
});

describe('applySpanColor / mergeSpanColors (9.A5a selection → colour)', () => {
  it('adds a colour to an empty set', () => {
    expect(applySpanColor([], 2, 5, '#ff0000')).toEqual([{ start: 2, end: 5, color: '#ff0000' }]);
  });

  it('clips an overlapping range, keeping its outside remainders', () => {
    const existing = [{ start: 0, end: 10, color: '#0000ff' }];
    // Paint [3,6) red inside the blue [0,10): blue splits to [0,3)+[6,10).
    expect(applySpanColor(existing, 3, 6, '#ff0000')).toEqual([
      { start: 0, end: 3, color: '#0000ff' },
      { start: 3, end: 6, color: '#ff0000' },
      { start: 6, end: 10, color: '#0000ff' },
    ]);
  });

  it('coalesces adjacent same-colour ranges', () => {
    expect(
      mergeSpanColors([
        { start: 0, end: 3, color: '#ff0000' },
        { start: 3, end: 6, color: '#FF0000' }, // case-insensitive
      ]),
    ).toEqual([{ start: 0, end: 6, color: '#ff0000' }]);
  });

  it('re-painting the same range replaces the colour', () => {
    const existing = [{ start: 2, end: 5, color: '#ff0000' }];
    expect(applySpanColor(existing, 2, 5, '#00ff00')).toEqual([
      { start: 2, end: 5, color: '#00ff00' },
    ]);
  });
});

describe('seedSpanColors / backdropSegments / spanColorsToStyles (9.A5a)', () => {
  it('seeds only spans that differ from the paragraph colour', () => {
    const spans = [
      { start: 0, end: 6, run: 0, color: '#000000' },
      { start: 6, end: 9, run: 1, color: '#ff0000' },
    ];
    expect(seedSpanColors(spans, '#000000')).toEqual([{ start: 6, end: 9, color: '#ff0000' }]);
    // An all-dominant paragraph seeds nothing.
    expect(seedSpanColors([{ start: 0, end: 9, run: 0, color: '#000000' }], '#000000')).toEqual([]);
  });

  it('splits text into base + coloured backdrop segments (with face flags)', () => {
    expect(backdropSegments('Hello colored world', [{ start: 6, end: 13, color: '#ff0000' }])).toEqual([
      { text: 'Hello ', color: null, bold: false, italic: false, sized: false },
      { text: 'colored', color: '#ff0000', bold: false, italic: false, sized: false },
      { text: ' world', color: null, bold: false, italic: false, sized: false },
    ]);
  });

  it('folds colour AND face independently, segmenting where either changes (A5b)', () => {
    // "Hello world": bold [0,5), red [3,8) — the overlap [3,5) is bold+red.
    expect(
      backdropSegments(
        'Hello world',
        [{ start: 3, end: 8, color: '#ff0000' }],
        [{ start: 0, end: 5, bold: true, italic: false }],
      ),
    ).toEqual([
      { text: 'Hel', color: null, bold: true, italic: false, sized: false },
      { text: 'lo', color: '#ff0000', bold: true, italic: false, sized: false },
      { text: ' wo', color: '#ff0000', bold: false, italic: false, sized: false },
      { text: 'rld', color: null, bold: false, italic: false, sized: false },
    ]);
  });

  it('converts to the engine span_styles shape', () => {
    expect(spanColorsToStyles([{ start: 2, end: 5, color: '#ff0000' }])).toEqual([
      { start: 2, end: 5, color: [1, 0, 0] },
    ]);
  });
});

describe('mergeSpanColors overlap flattening (9.A5a round-32 HIGH)', () => {
  it('resolves an overlap to disjoint runs, later-start wins (preview==commit)', () => {
    // The lens repro: two same-extent ranges overlapping after a retype
    // must flatten so the backdrop preview and the engine fold agree.
    const overlapping = [
      { start: 0, end: 17, color: '#ff0000' },
      { start: 1, end: 17, color: '#0000ff' },
    ];
    const flat = mergeSpanColors(overlapping);
    expect(flat).toEqual([
      { start: 0, end: 1, color: '#ff0000' },
      { start: 1, end: 17, color: '#0000ff' },
    ]);
    // backdropSegments and spanColorsToStyles both go through merge, so they
    // describe the SAME per-position colours (no silent mismatch).
    const segs = backdropSegments('Hi folks everyone', overlapping);
    expect(segs).toEqual([
      { text: 'H', color: '#ff0000', bold: false, italic: false, sized: false },
      { text: 'i folks everyone', color: '#0000ff', bold: false, italic: false, sized: false },
    ]);
    expect(spanColorsToStyles(overlapping)).toEqual([
      { start: 0, end: 1, color: [1, 0, 0] },
      { start: 1, end: 17, color: [0, 0, 1] },
    ]);
  });

  it('a fully-covering later range wins the whole overlap', () => {
    expect(
      mergeSpanColors([
        { start: 2, end: 8, color: '#ff0000' },
        { start: 0, end: 10, color: '#0000ff' }, // later start? no — starts earlier
      ]),
    ).toEqual([
      { start: 0, end: 2, color: '#0000ff' },
      { start: 2, end: 8, color: '#ff0000' }, // the red's later start wins its extent
      { start: 8, end: 10, color: '#0000ff' },
    ]);
  });
});

describe('per-span FACE helpers (9.A5b)', () => {
  it('applySpanFace paints a weight onto a range, clipping overlaps', () => {
    const out = applySpanFace([], 2, 6, { bold: true, italic: false });
    expect(out).toEqual([{ start: 2, end: 6, bold: true, italic: false }]);
    // Re-apply a different face over part of it: clip + insert.
    const out2 = applySpanFace(out, 4, 8, { bold: false, italic: true, family: 'serif' });
    expect(out2).toEqual([
      { start: 2, end: 4, bold: true, italic: false },
      { start: 4, end: 8, bold: false, italic: true, family: 'serif' },
    ]);
  });

  it('mergeSpanFaces coalesces adjacent identical faces and resolves overlaps', () => {
    expect(
      mergeSpanFaces([
        { start: 0, end: 3, bold: true, italic: false },
        { start: 3, end: 6, bold: true, italic: false },
      ]),
    ).toEqual([{ start: 0, end: 6, bold: true, italic: false }]);
  });

  it('remapRanges carries face fields through an edit', () => {
    expect(
      remapRanges('Hello world', 'XYHello world', [
        { start: 6, end: 11, bold: true, italic: false, family: 'mono' },
      ]),
    ).toEqual([{ start: 8, end: 13, bold: true, italic: false, family: 'mono' }]);
  });

  it('spanFacesToStyles emits face entries, omitting an unset family', () => {
    expect(
      spanFacesToStyles([
        { start: 0, end: 3, bold: true, italic: false },
        { start: 5, end: 8, bold: false, italic: true, family: 'serif' },
      ]),
    ).toEqual([
      { start: 0, end: 3, bold: true, italic: false },
      { start: 5, end: 8, bold: false, italic: true, family: 'serif' },
    ]);
  });
});

describe('per-span SIZE helpers (9.A5c)', () => {
  it('applySpanSize paints a size onto a range, clipping overlaps', () => {
    const out = applySpanSize([], 2, 6, 24);
    expect(out).toEqual([{ start: 2, end: 6, size: 24 }]);
    const out2 = applySpanSize(out, 4, 8, 10);
    expect(out2).toEqual([
      { start: 2, end: 4, size: 24 },
      { start: 4, end: 8, size: 10 },
    ]);
  });

  it('mergeSpanSizes coalesces adjacent equal sizes', () => {
    expect(
      mergeSpanSizes([
        { start: 0, end: 3, size: 18 },
        { start: 3, end: 6, size: 18 },
      ]),
    ).toEqual([{ start: 0, end: 6, size: 18 }]);
  });

  it('spanSizesToStyles emits size entries', () => {
    expect(spanSizesToStyles([{ start: 1, end: 4, size: 20 }])).toEqual([
      { start: 1, end: 4, size: 20 },
    ]);
  });

  it('backdropSegments marks a sized range without changing its width', () => {
    const segs = backdropSegments('Big word here', [], [], [{ start: 4, end: 8, size: 24 }]);
    expect(segs).toEqual([
      { text: 'Big ', color: null, bold: false, italic: false, sized: false },
      { text: 'word', color: null, bold: false, italic: false, sized: true },
      { text: ' here', color: null, bold: false, italic: false, sized: false },
    ]);
  });
});
