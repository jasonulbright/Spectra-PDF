import { describe, it, expect } from 'vitest';
import { unencodableChars } from '../src/renderer/lib/edit-text';

describe('unencodableChars (live validation)', () => {
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

describe('ligature-aware validation', () => {
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
