// Measure-tool math (lib/measure.ts): lengths, areas, scale ratios, units.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEASURE_SCALE,
  formatArea,
  formatDistance,
  polylineLengthPts,
  ringAreaPts2,
  type MeasureScale,
} from '../src/renderer/lib/measure';

// A US-Letter page: 612×792 pt.
const W = 612;
const H = 792;

describe('measure math', () => {
  it('measures a horizontal span in points against the displayed dims', () => {
    // Half the page width: 306 pt.
    expect(polylineLengthPts([0, 0.5, 0.5, 0.5], W, H)).toBeCloseTo(306, 6);
  });

  it('accumulates multi-segment perimeters and mixes axes correctly', () => {
    // A 3-4-5 triangle in points: dx=0.5*612=306? No — use exact pt deltas:
    // right 300pt, then up 400pt → 300 + 400 = 700 total.
    const pts = [0, 0, 300 / W, 0, 300 / W, 400 / H];
    expect(polylineLengthPts(pts, W, H)).toBeCloseTo(700, 6);
    // The hypotenuse back to the origin closes a 300×400 right triangle: 500.
    const ring = [...pts, 0, 0];
    expect(polylineLengthPts(ring, W, H)).toBeCloseTo(1200, 6);
  });

  it('zero/one-point inputs measure zero; sub-3-vertex rings enclose nothing', () => {
    expect(polylineLengthPts([], W, H)).toBe(0);
    expect(polylineLengthPts([0.3, 0.4], W, H)).toBe(0);
    expect(ringAreaPts2([0, 0, 1, 1], W, H)).toBe(0);
  });

  it('shoelace area is winding-independent and auto-closes', () => {
    // A 100×200 pt rectangle = 20000 pt².
    const rect = [0, 0, 100 / W, 0, 100 / W, 200 / H, 0, 200 / H];
    expect(ringAreaPts2(rect, W, H)).toBeCloseTo(20_000, 6);
    const reversed = [0, 0, 0, 200 / H, 100 / W, 200 / H, 100 / W, 0];
    expect(ringAreaPts2(reversed, W, H)).toBeCloseTo(20_000, 6);
  });

  it('formats 1:1 inches by default (72 pt = 1 in)', () => {
    expect(formatDistance(72, DEFAULT_MEASURE_SCALE)).toBe('1 in');
    expect(formatDistance(180, DEFAULT_MEASURE_SCALE)).toBe('2.5 in');
  });

  it('applies the scale ratio: 1 in = 2 ft doubles into feet', () => {
    const scale: MeasureScale = { from: 1, fromUnit: 'in', to: 2, toUnit: 'ft' };
    expect(formatDistance(72, scale)).toBe('2 ft');
    expect(formatDistance(36, scale)).toBe('1 ft');
  });

  it('metric from-units convert: 1 cm = 1 m reads a cm on paper as a metre', () => {
    const scale: MeasureScale = { from: 1, fromUnit: 'cm', to: 1, toUnit: 'm' };
    // 1 cm on paper = 720/25.4 pt.
    expect(formatDistance(720 / 25.4, scale)).toBe('1 m');
  });

  it('area squares the ratio: 1 in = 10 ft turns 1 sq in into 100 sq ft', () => {
    const scale: MeasureScale = { from: 1, fromUnit: 'in', to: 10, toUnit: 'ft' };
    expect(formatArea(72 * 72, scale)).toBe('100 sq ft');
  });

  it('degenerate from<=0 falls back to 1:1 rather than dividing by zero', () => {
    const scale: MeasureScale = { from: 0, fromUnit: 'in', to: 3, toUnit: 'ft' };
    expect(formatDistance(72, scale)).toBe('3 ft');
  });

  it('trims trailing zeros without losing precision', () => {
    expect(formatDistance(108, DEFAULT_MEASURE_SCALE)).toBe('1.5 in');
    expect(formatDistance(73, DEFAULT_MEASURE_SCALE)).toBe('1.01 in');
  });
});
