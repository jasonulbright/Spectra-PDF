import { describe, it, expect } from 'vitest';
import { rangeFillPercent } from '../src/renderer/lib/range-fill';

describe('rangeFillPercent', () => {
  it('maps the value onto the bounds', () => {
    expect(rangeFillPercent(150, 72, 600)).toBe('14.77%');
    expect(rangeFillPercent(72, 72, 600)).toBe('0%');
    expect(rangeFillPercent(600, 72, 600)).toBe('100%');
  });

  it('takes the HTML default bounds when they are absent', () => {
    expect(rangeFillPercent(25, undefined, undefined)).toBe('25%');
    expect(rangeFillPercent('40', '', '')).toBe('40%');
  });

  it('clamps a value outside the bounds the way the element does', () => {
    expect(rangeFillPercent(-5, 0, 10)).toBe('0%');
    expect(rangeFillPercent(50, 0, 10)).toBe('100%');
  });

  it('reads fractional bounds', () => {
    expect(rangeFillPercent(0.5, 0.05, 1)).toBe('47.37%');
  });

  it('reads an empty, reversed or unparsable range as empty', () => {
    expect(rangeFillPercent(5, 10, 10)).toBe('0%');
    expect(rangeFillPercent(5, 10, 0)).toBe('0%');
    expect(rangeFillPercent('abc', 0, 10)).toBe('0%');
    expect(rangeFillPercent(undefined, 0, 10)).toBe('0%');
    expect(rangeFillPercent(['1'], 0, 10)).toBe('0%');
  });
});
