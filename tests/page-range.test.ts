// The page-scope field's syntax. Three panels parsed it separately and none of
// them read a hyphen, so `1-5` scoped an operation to page 1 and reported
// success — the reason these are pinned rather than left to the components.
import { describe, expect, it } from 'vitest';
import { formatPageRange, parsePageRangeField } from '../src/renderer/lib/page-range';

describe('parsePageRangeField', () => {
  it('reads "all" as the whole document, in any case and with space', () => {
    expect(parsePageRangeField('all')).toEqual({ pages: undefined });
    expect(parsePageRangeField('  ALL ')).toEqual({ pages: undefined });
  });

  it('reads a list, de-duplicated and ordered', () => {
    expect(parsePageRangeField('3, 1,3 , 2')).toEqual({ pages: [1, 2, 3] });
  });

  it('expands an inclusive hyphen range', () => {
    expect(parsePageRangeField('2-5')).toEqual({ pages: [2, 3, 4, 5] });
    expect(parsePageRangeField('1-3,7')).toEqual({ pages: [1, 2, 3, 7] });
    expect(parsePageRangeField('4 - 6')).toEqual({ pages: [4, 5, 6] });
  });

  it('reads a single-page range as that page', () => {
    expect(parsePageRangeField('9-9')).toEqual({ pages: [9] });
  });

  it('merges overlapping ranges rather than repeating pages', () => {
    expect(parsePageRangeField('1-4,3-6')).toEqual({ pages: [1, 2, 3, 4, 5, 6] });
  });

  it('drops entries that name no page', () => {
    expect(parsePageRangeField('1, x, 4')).toEqual({ pages: [1, 4] });
    expect(parsePageRangeField('0, 2')).toEqual({ pages: [2] });
    // Reversed and zero-based ranges name nothing; the good token survives.
    expect(parsePageRangeField('5-1, 8')).toEqual({ pages: [8] });
    expect(parsePageRangeField('0-3, 8')).toEqual({ pages: [8] });
  });

  it('refuses a field that names no valid page', () => {
    expect(parsePageRangeField('')).toEqual({ error: 'badPages' });
    expect(parsePageRangeField('nonsense')).toEqual({ error: 'badPages' });
    expect(parsePageRangeField('0')).toEqual({ error: 'badPages' });
    expect(parsePageRangeField('5-1')).toEqual({ error: 'badPages' });
  });
});

describe('formatPageRange', () => {
  it('writes a run of three or more as a range', () => {
    expect(formatPageRange([1, 2, 3, 4])).toBe('1-4');
    expect(formatPageRange([1, 2, 3, 7, 9, 10, 11])).toBe('1-3,7,9-11');
  });

  // A pair is no shorter written as a range, and reads as one the user did not
  // ask for.
  it('leaves a pair as two numbers', () => {
    expect(formatPageRange([4, 5])).toBe('4,5');
  });

  it('orders and de-duplicates', () => {
    expect(formatPageRange([5, 1, 5, 2])).toBe('1,2,5');
  });

  it('is empty for no pages', () => {
    expect(formatPageRange([])).toBe('');
  });

  // The field is written back into itself: what the affordance produces has to
  // parse to what it was given.
  it('round-trips through the parser', () => {
    for (const pages of [[1], [1, 2], [1, 2, 3], [2, 4, 6], [1, 2, 3, 8, 10, 11, 12]]) {
      expect(parsePageRangeField(formatPageRange(pages))).toEqual({ pages });
    }
  });
});
