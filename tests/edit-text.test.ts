import { describe, it, expect } from 'vitest';
import { fetchTextRuns, unencodableChars } from '../src/renderer/lib/edit-text';

describe('unencodableChars (7.2 live validation)', () => {
  it('empty when fully expressible', () => {
    expect(unencodableChars('Hello', 'Helo')).toEqual([]);
  });
  it('names missing chars once, in order', () => {
    expect(unencodableChars('Héllo→→', 'Hlo')).toEqual(['é', '→']);
  });
  it('empty value is always valid', () => {
    expect(unencodableChars('', '')).toEqual([]);
  });
});

describe('fetchTextRuns projection', () => {
  it('projects engine rects and carries the editability taxonomy', async () => {
    const runs = await fetchTextRuns(
      async () => ({
        runs: [
          {
            index: 0,
            text: 'Hi',
            rect: [72, 700, 100, 712],
            nested: false,
            editable: true,
            reason: null,
            encodable: 'Hi',
          },
          {
            index: 1,
            text: '□',
            rect: [72, 680, 90, 692],
            nested: true,
            editable: false,
            reason: 'Type3 fonts (glyph procedures) are not editable',
            encodable: '',
          },
        ],
      }),
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
    );
    expect(runs[0].rect.x).toBeCloseTo(72 / 612);
    expect(runs[0].rect.y).toBeCloseTo(1 - 712 / 792);
    expect(runs[0].editable).toBe(true);
    expect(runs[1].editable).toBe(false);
    expect(runs[1].reason).toMatch(/Type3/);
  });
});

describe('ligature-aware validation (9.B5)', () => {
  it('accepts a char reachable only through a sequence (engine-order mirror)', () => {
    // 'i' is NOT single-encodable; "fi" is a listed sequence. A
    // singles-first walk would false-refuse — sequences match first.
    expect(unencodableChars('fit', 'ft', ['fi'])).toEqual([]);
    expect(unencodableChars('it', 'ft', ['fi'])).toEqual(['i']);
  });

  it('matches longest-first on overlapping sequences', () => {
    // "ffi" beats "ff"; the trailing char then stands alone.
    expect(unencodableChars('ffix', 'x', ['ff', 'ffi'])).toEqual([]);
    expect(unencodableChars('ffx', 'x', ['ff', 'ffi'])).toEqual([]);
    expect(unencodableChars('ffiy', 'x', ['ff', 'ffi'])).toEqual(['y']);
  });

  it('is greedy like the engine (no backtracking)', () => {
    // "ab" matches at 0, leaving 'c' unreachable — the engine fails the
    // same way, so validation and belt agree.
    expect(unencodableChars('abc', 'ab', ['ab', 'bc'])).toEqual(['c']);
  });

  it('empty sequence list preserves the shipped single-char behavior', () => {
    expect(unencodableChars('abc', 'ab')).toEqual(['c']);
  });
});
