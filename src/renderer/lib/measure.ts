// Measure-tool math (parity map § 2): pure geometry + unit formatting, kept
// out of PageCell because there is no DOM test environment — the breakable
// part must be the testable part (the spread-layout precedent).
//
// Coordinates arrive DISPLAY-NORMALIZED (0..1 against the displayed page,
// the annotation gesture space) and are scaled by the displayed page dims in
// PDF points. Lengths are rotation-invariant, so values need no
// un-projection — only a left-behind annotation's points do (the caller
// un-projects those exactly like ink strokes).

export type MeasureUnit = 'pt' | 'in' | 'mm' | 'cm' | 'ft' | 'm';

/** "from fromUnit = to toUnit" — the king's scale ratio (1 in = 1 ft). */
export interface MeasureScale {
  from: number;
  fromUnit: MeasureUnit;
  to: number;
  toUnit: MeasureUnit;
}

export const DEFAULT_MEASURE_SCALE: MeasureScale = {
  from: 1,
  fromUnit: 'in',
  to: 1,
  toUnit: 'in',
};

export const MEASURE_UNITS: readonly MeasureUnit[] = ['pt', 'in', 'mm', 'cm', 'ft', 'm'];

// Points per unit (72 pt = 1 in; 1 in = 25.4 mm).
const PT_PER: Record<MeasureUnit, number> = {
  pt: 1,
  in: 72,
  mm: 72 / 25.4,
  cm: 720 / 25.4,
  ft: 864,
  m: 72_000 / 25.4,
};

/** Length of a display-normalized flat polyline [x0,y0,x1,y1,…] in PDF
 * points, against the DISPLAYED page dims (axes already swapped at 90/270 by
 * the caller). Fewer than two points measure zero. */
export function polylineLengthPts(points: number[], dispW: number, dispH: number): number {
  let total = 0;
  for (let i = 2; i + 1 < points.length; i += 2) {
    const dx = (points[i] - points[i - 2]) * dispW;
    const dy = (points[i + 1] - points[i - 1]) * dispH;
    total += Math.hypot(dx, dy);
  }
  return total;
}

/** Area of the ring the points describe (auto-closed), in square PDF points —
 * the shoelace formula, absolute value so winding order doesn't matter.
 * Fewer than three points enclose nothing. */
export function ringAreaPts2(points: number[], dispW: number, dispH: number): number {
  const n = points.length / 2;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = points[i * 2] * dispW;
    const yi = points[i * 2 + 1] * dispH;
    const xj = points[j * 2] * dispW;
    const yj = points[j * 2 + 1] * dispH;
    sum += xi * yj - xj * yi;
  }
  return Math.abs(sum) / 2;
}

/** The scale ratio's multiplier from REAL page units to REPORTED units:
 * "from fromUnit = to toUnit" means one fromUnit on paper reads as
 * (to/from) toUnit. Degenerate `from <= 0` falls back to 1:1. */
function reportedPerPt(scale: MeasureScale): number {
  const from = scale.from > 0 ? scale.from : 1;
  return (scale.to / from) / PT_PER[scale.fromUnit];
}

function trim(v: number): string {
  const s = v.toFixed(2);
  return s.replace(/\.?0+$/, '') || '0';
}

/** The /Measure NumberFormat conversion factor: reported units per PDF
 * POINT along an axis (the C entry other tools re-measure with). */
export function measureUnitsPerPoint(scale: MeasureScale): number {
  return reportedPerPt(scale);
}

/** The /Measure /R ratio string, in the king's own phrasing ("1 in = 2 ft"). */
export function measureRatioLabel(scale: MeasureScale): string {
  return `${trim(scale.from)} ${scale.fromUnit} = ${trim(scale.to)} ${scale.toUnit}`;
}

/** "3.42 ft" — a polyline length in the scale's reported unit. */
export function formatDistance(lengthPts: number, scale: MeasureScale): string {
  return `${trim(lengthPts * reportedPerPt(scale))} ${scale.toUnit}`;
}

/** "12.34 sq ft" — a ring area in the scale's reported unit, squared. */
export function formatArea(areaPts2: number, scale: MeasureScale): string {
  const k = reportedPerPt(scale);
  return `${trim(areaPts2 * k * k)} sq ${scale.toUnit}`;
}

// ── Recompute against a CAPTURED factor ──────────────────────────────────
// A finished measurement stores its /C units-per-point + unit at creation;
// resizing it recomputes the reported value from THOSE, never from the live
// toolbar scale (which may have changed since). Same trim/format as above,
// one implementation of the phrasing.

/** "3.42 ft" from a captured units-per-point factor. */
export function formatDistanceWithFactor(lengthPts: number, unitsPerPt: number, unit: string): string {
  return `${trim(lengthPts * unitsPerPt)} ${unit}`;
}

/** "12.34 sq ft" from a captured units-per-point factor. */
export function formatAreaWithFactor(areaPts2: number, unitsPerPt: number, unit: string): string {
  return `${trim(areaPts2 * unitsPerPt * unitsPerPt)} sq ${unit}`;
}
