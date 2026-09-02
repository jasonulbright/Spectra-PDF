import { describe, it, expect } from 'vitest';
import { pageDigits, pageFieldWidth, pageLabelWidth } from '../src/renderer/lib/page-field-width';

describe('pageDigits', () => {
  it('grows with the page count', () => {
    expect(pageDigits(1)).toBe(1);
    expect(pageDigits(9)).toBe(1);
    expect(pageDigits(10)).toBe(2);
    expect(pageDigits(99)).toBe(2);
    expect(pageDigits(100)).toBe(3);
    expect(pageDigits(575)).toBe(3);
    expect(pageDigits(1000)).toBe(4);
    expect(pageDigits(12345)).toBe(5);
  });

  it('degrades to one digit for empty or nonsense counts', () => {
    expect(pageDigits(0)).toBe(1);
    expect(pageDigits(-4)).toBe(1);
    expect(pageDigits(Number.NaN)).toBe(1);
    expect(pageDigits(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('keeps growing past seven digits so the widest page number renders whole', () => {
    expect(pageDigits(9_999_999)).toBe(7);
    expect(pageDigits(10_000_000)).toBe(8);
    expect(pageDigits(123_456_789)).toBe(9);
    expect(pageDigits(1_000_000_000)).toBe(10);
  });

  it('ignores a fractional count', () => {
    expect(pageDigits(99.9)).toBe(2);
  });
});

describe('pageFieldWidth', () => {
  it('is a calc of the digit count plus fixed field chrome', () => {
    expect(pageFieldWidth(575)).toBe('calc(3ch + 14px)');
    expect(pageFieldWidth(12345)).toBe('calc(5ch + 14px)');
  });

  it('never shrinks as the document grows', () => {
    const digitsOf = (css: string) => Number(/\((\d+)ch/.exec(css)![1]);
    let prev = 0;
    for (const count of [1, 9, 10, 99, 100, 575, 1000, 9999, 10_000, 1_000_000]) {
      const d = digitsOf(pageFieldWidth(count));
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('leaves room for the widest page number the document can hold', () => {
    // The regression: a fixed 40px field clipped the third digit at 575 pages
    // and hid digits four and five entirely.
    for (const count of [575, 1234, 57_500, 10_000_000, 1_000_000_000]) {
      expect(pageFieldWidth(count)).toContain(`${String(count).length}ch`);
    }
  });
});

describe('pageLabelWidth', () => {
  it('tracks the same digit count with the smaller label chrome', () => {
    expect(pageLabelWidth(575)).toBe('calc(3ch + 6px)');
    expect(pageLabelWidth(7)).toBe('calc(1ch + 6px)');
  });
});
