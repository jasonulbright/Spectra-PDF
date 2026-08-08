// The Fonts tab's model: parsing the engine payload, grouping and ordering,
// the four program-status states, and the stable per-row DOM handle.
import { describe, it, expect } from 'vitest';
import {
  fontStatus,
  fontTestId,
  groupFonts,
  parseDocumentFonts,
  type DocumentFont,
} from '../src/renderer/lib/font-inventory';

const font = (patch: Partial<DocumentFont> = {}): DocumentFont => ({
  name: 'Helvetica',
  raw_name: 'Helvetica',
  type: 'Type1',
  encoding: 'WinAnsiEncoding',
  embedded: false,
  subset: false,
  substitute: null,
  pages: [1],
  page_count: 1,
  ...patch,
});

describe('parseDocumentFonts', () => {
  it('reads an engine payload', () => {
    const fonts = parseDocumentFonts({
      fonts: [
        {
          name: 'NotoSans',
          raw_name: 'ABCDEF+NotoSans',
          type: 'CIDFontType2',
          encoding: 'Identity-H',
          embedded: true,
          subset: true,
          substitute: null,
          pages: [1, 2],
          page_count: 2,
        },
      ],
    });
    expect(fonts).toHaveLength(1);
    expect(fonts[0].raw_name).toBe('ABCDEF+NotoSans');
    expect(fonts[0].subset).toBe(true);
    expect(fonts[0].page_count).toBe(2);
  });

  it('answers an empty list for a payload with no fonts array', () => {
    expect(parseDocumentFonts(null)).toEqual([]);
    expect(parseDocumentFonts({})).toEqual([]);
    expect(parseDocumentFonts({ fonts: 'no' })).toEqual([]);
  });

  it('fills a missing type and encoding rather than rendering blanks', () => {
    const [parsed] = parseDocumentFonts({ fonts: [{ name: 'X' }] });
    expect(parsed.type).toBe('Unknown');
    expect(parsed.encoding).toBe('Built-in');
    expect(parsed.embedded).toBe(false);
  });

  it('derives a missing page count from the page list', () => {
    const [parsed] = parseDocumentFonts({ fonts: [{ name: 'X', pages: [3, 4, 9] }] });
    expect(parsed.page_count).toBe(3);
  });
});

describe('groupFonts', () => {
  it('groups by type in the declared order, not alphabetically', () => {
    const groups = groupFonts([
      font({ name: 'Zed', type: 'Type3' }),
      font({ name: 'Alpha', type: 'CIDFontType2' }),
      font({ name: 'Beta', type: 'Type1' }),
      font({ name: 'Gamma', type: 'TrueType' }),
    ]);
    expect(groups.map((g) => g.type)).toEqual([
      'Type1',
      'TrueType',
      'CIDFontType2',
      'Type3',
    ]);
  });

  it('puts a type this build does not name last, alphabetically among its peers', () => {
    const groups = groupFonts([
      font({ name: 'A', type: 'Zenith' }),
      font({ name: 'B', type: 'Aardvark' }),
      font({ name: 'C', type: 'Type1' }),
    ]);
    expect(groups.map((g) => g.type)).toEqual(['Type1', 'Aardvark', 'Zenith']);
  });

  it('orders fonts within a group by display name', () => {
    const groups = groupFonts([
      font({ name: 'Zapf' }),
      font({ name: 'Arial' }),
      font({ name: 'Menlo' }),
    ]);
    expect(groups[0].fonts.map((f) => f.name)).toEqual(['Arial', 'Menlo', 'Zapf']);
  });

  it('sorts a nameless font last rather than letting an empty string lead', () => {
    const groups = groupFonts([
      font({ name: '', raw_name: '', type: 'Type1' }),
      font({ name: 'Arial' }),
    ]);
    expect(groups[0].fonts.map((f) => f.name)).toEqual(['Arial', '']);
  });

  it('keeps two same-named fonts apart by encoding, in a stable order', () => {
    const groups = groupFonts([
      font({ encoding: 'WinAnsiEncoding' }),
      font({ encoding: 'MacRomanEncoding' }),
    ]);
    expect(groups[0].fonts.map((f) => f.encoding)).toEqual([
      'MacRomanEncoding',
      'WinAnsiEncoding',
    ]);
  });

  it('leaves the input untouched', () => {
    const input = [font({ name: 'Zapf' }), font({ name: 'Arial' })];
    groupFonts(input);
    expect(input.map((f) => f.name)).toEqual(['Zapf', 'Arial']);
  });
});

describe('fontStatus', () => {
  it('separates an embedded font from an embedded subset', () => {
    expect(fontStatus(font({ embedded: true, subset: false }))).toEqual({ kind: 'embedded' });
    expect(fontStatus(font({ embedded: true, subset: true }))).toEqual({
      kind: 'embedded-subset',
    });
  });

  it('names the substituted face when the resolver answered one', () => {
    expect(fontStatus(font({ substitute: 'LiberationSans-Regular.ttf' }))).toEqual({
      kind: 'substituted',
      face: 'LiberationSans-Regular.ttf',
    });
  });

  it('reports an unknown substitution as unknown rather than inventing one', () => {
    expect(fontStatus(font({ substitute: null }))).toEqual({ kind: 'not-embedded' });
  });

  it('ignores a substitute an embedded font somehow carries', () => {
    expect(fontStatus(font({ embedded: true, substitute: 'X.ttf' }))).toEqual({
      kind: 'embedded',
    });
  });
});

describe('fontTestId', () => {
  it('is built from the raw name, so two subsets of one face do not collide', () => {
    const a = fontTestId(font({ raw_name: 'ABCDEF+NotoSans' }));
    const b = fontTestId(font({ raw_name: 'GHIJKL+NotoSans' }));
    expect(a).not.toBe(b);
  });

  it('is language-independent and safe in a selector', () => {
    expect(fontTestId(font({ raw_name: 'Times New Roman,Bold', type: 'TrueType' }))).toBe(
      'times-new-roman-bold-truetype-winansiencoding',
    );
  });

  it('degrades to a fixed handle for a font with nothing to name it', () => {
    expect(fontTestId(font({ raw_name: '', type: '', encoding: '' }))).toBe('unnamed');
  });
});
