import { describe, it, expect, vi } from 'vitest';
vi.mock('pdfjs-dist', () => ({ OPS: { paintImageXObject: 85, paintImageXObjectRepeat: 88, paintInlineImageXObject: 86, paintImageMaskXObject: 83 } }));
import { orderedPageText, orientationOrder, itemOrientation, type OrientedItem } from '../src/renderer/search/text-order';
import { extractPageText } from '../src/renderer/search/extract';

const rad = (deg: number): number => (deg * Math.PI) / 180;
const at = (str: string, deg: number, x = 0, y = 0, hasEOL = false, size = 10): OrientedItem => ({
  str,
  hasEOL,
  transform: [size * Math.cos(rad(deg)), size * Math.sin(rad(deg)), -size * Math.sin(rad(deg)), size * Math.cos(rad(deg)), x, y],
});

function contentStreamText(items: readonly OrientedItem[]): string {
  let text = '';
  for (const it of items) {
    text += it.str;
    if (it.hasEOL) text += '\n';
  }
  return text;
}

const body = [at('Body line one of the page', 0, 72, 700, true), at('Body line two continues here', 0, 72, 686, true)];

describe('orientation reading order', () => {
  it('leaves upright text byte-identical', () => {
    const items = [...body, at('x', 0, 0, 0), at(' ', 0), at('tail', 0, 5, 5, false)];
    expect(orderedPageText(items)).toBe(contentStreamText(items));
    expect(orderedPageText(items, 90)).toBe(contentStreamText(items));
  });

  for (const deg of [90, 180, 270]) {
    it(`reads a ${deg}-degree sidebar after the body even when drawn first`, () => {
      const items = [at('SIDEBAR', deg, 20, 400, true), ...body];
      const expected = 'Body line one of the page\nBody line two continues here\nSIDEBAR\n';
      expect(orderedPageText(items)).toBe(expected);
      expect(contentStreamText(items)).not.toBe(expected);
    });
  }

  it('snaps near-axis jitter to the axis', () => {
    const items = [at('Deskewed ', 1.5, 0, 700), at('scan ', -2.5, 50, 700), at('text', 0.2, 90, 700, true)];
    expect(orientationOrder(items)).toEqual([[0, 1, 2]]);
    expect(orderedPageText(items)).toBe(contentStreamText(items));
  });

  it('chains an arc label into one part after the body', () => {
    const arc = ['A', 'R', 'C', 'L', 'B'].map((ch, i) => at(ch, 30 + i * 5, 300 + i * 8, 300));
    const items = [...arc.slice(0, 2), body[0], ...arc.slice(2), body[1]];
    const expected = 'Body line one of the page\nBody line two continues here\nARCLB';
    expect(orderedPageText(items)).toBe(expected);
    expect(contentStreamText(items)).not.toBe(expected);
  });

  it('chains an arc across 0/360 through the wrap', () => {
    const arc = [349, 352.5, 356.5, 3.5, 7].map((d) => at('W', d));
    expect(orientationOrder([...body, ...arc])).toEqual([[0, 1], [2, 3, 4, 5, 6]]);
  });

  it('reads a short off-axis group with the upright text', () => {
    const items = [body[0], at('ok', 45, 10, 10), body[1]];
    expect(orderedPageText(items)).toBe(contentStreamText(items));
  });

  it('counts a multi-scalar glyph by its scalars, as the engine does', () => {
    const own = [body[0], at('abc', 45, 10, 10), body[1]];
    expect(orientationOrder(own)).toEqual([[0, 2], [1]]);
    const astral = [body[0], at('\u{1D49C}\u{1D49C}', 45, 10, 10), body[1]];
    expect(orientationOrder(astral)).toEqual([[0, 1, 2]]);
  });

  it('orders mixed body and two sidebars by char count then angle', () => {
    const items = [at('LEFT', 90, 10, 400, true), at('RIGHT', 270, 590, 400, true), ...body];
    expect(orderedPageText(items)).toBe('Body line one of the page\nBody line two continues here\nRIGHT\nLEFT\n');
    const tie = [at('LEFT', 90, 10, 400, true), at('RITE', 270, 590, 400, true), ...body];
    expect(orderedPageText(tie)).toBe('Body line one of the page\nBody line two continues here\nLEFT\nRITE\n');
  });

  it('keeps reflected text a separate orientation', () => {
    const mirrored: OrientedItem = { str: 'MIRROR', transform: [10, 0, 0, -10, 0, 0], hasEOL: true };
    const items = [mirrored, ...body];
    expect(itemOrientation(mirrored)).toEqual({ angle: 0, reflected: true });
    expect(orderedPageText(items)).toBe('Body line one of the page\nBody line two continues here\nMIRROR\n');
  });

  it('folds /Rotate into the angle: page rotation alone never reorders', () => {
    expect(itemOrientation(at('a', 0), 90).angle).toBe(270);
    expect(itemOrientation(at('a', 90), 90).angle).toBe(0);
    // Equal counts: engine angles are 0 (drawn at 90) and 270 (drawn upright) on a /Rotate 90 page.
    const items = [at('UPRT', 0, 0, 0, true), at('SIDE', 90, 0, 0, true)];
    expect(orderedPageText(items, 0)).toBe('UPRT\nSIDE\n');
    expect(orderedPageText(items, 90)).toBe('SIDE\nUPRT\n');
  });

  it('keeps right-to-left strings untouched inside a part', () => {
    const items = [at('שלום עולם', 0, 500, 700, true), at('צד', 45), ...body];
    expect(orderedPageText(items)).toBe(contentStreamText(items));
  });
});

describe('review fixes', () => {
  it('keeps a line-end item with the text it ends', () => {
    const items: OrientedItem[] = [
      at('SIDE', 90, 10, 400),
      { str: '', hasEOL: true, transform: [10, 0, 0, 10, 0, 0] },
      at('foo', 0, 72, 700),
      { str: '', hasEOL: true, transform: [0, 10, -10, 0, 0, 0] },
      at('bar', 0, 72, 686, true),
    ];
    expect(orderedPageText(items)).toBe('foo\nbar\nSIDE\n');
  });

  it('reads a non-finite transform as upright', () => {
    const bad: OrientedItem = { str: 'nan', transform: [NaN, 1, 0, 1, 0, 0] };
    expect(itemOrientation(bad)).toEqual({ angle: 0, reflected: false });
    expect(itemOrientation({ str: 'inf', transform: [Infinity, 0, 0, 1, 0, 0] }, 90).angle).toBe(270);
    const items = [body[0], bad, body[1]];
    expect(orientationOrder(items)).toEqual([[0, 1, 2]]);
  });

  it('counts drawn spaces like the engine and skips inferred space items', () => {
    // Engine: "a b" is three drawn glyphs, a part of its own.
    expect(orientationOrder([...body, at('a b', 45)])).toEqual([[0, 1], [2]]);
    // "ab" plus an inferred gap space is two glyphs: under three, read upright.
    expect(orientationOrder([...body, at('a', 45), at(' ', 45), at('b', 45)])).toEqual([[0, 1, 2, 3, 4]]);
  });

  it('orders RTL body before a rotated sidebar and keeps RTL strings as drawn', () => {
    const rtl = [at('שלום עולם גדול', 0, 500, 700, true), at('מאוד יפה כאן', 0, 500, 686, true)];
    const items = [at('SIDEBAR', 270, 590, 400, true), ...rtl];
    expect(orderedPageText(items)).toBe('שלום עולם גדול\nמאוד יפה כאן\nSIDEBAR\n');
  });
});

describe('extractPageText uses the orientation order', () => {
  const fakePdf = (items: OrientedItem[], rotate: number) =>
    ({
      getPage: async () => ({
        rotate,
        getTextContent: async () => ({ items }),
        getOperatorList: async () => ({ fnArray: [] }),
      }),
    }) as never;

  it('reads a rotated sidebar after the body', async () => {
    const items = [at('SIDEBAR', 90, 20, 400, true), ...body];
    const { text } = await extractPageText(fakePdf(items, 0), 0);
    expect(text).toBe('Body line one of the page\nBody line two continues here\nSIDEBAR\n');
  });

  it('passes /Rotate through', async () => {
    const items = [at('UPRT', 0, 0, 0, true), at('SIDE', 90, 0, 0, true)];
    expect((await extractPageText(fakePdf(items, 90), 0)).text).toBe('SIDE\nUPRT\n');
  });
});
