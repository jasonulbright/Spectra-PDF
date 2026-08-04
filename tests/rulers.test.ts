// N11 slice B — the GRID and RULER math. Pure, so it is tested here rather
// than through the DOM; the drawing itself is proven by e2e spec 106.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GRID,
  gridForPage,
  gridLines,
  gridSpacingPoints,
  niceStep,
  rulerTicks,
  type GridConfig,
} from '../src/renderer/lib/rulers';
import { gridPoint } from '../src/renderer/lib/snap';
import { measureUnitsPerPoint, type MeasureScale } from '../src/renderer/lib/measure';

const ONE_TO_ONE: MeasureScale = { from: 1, fromUnit: 'in', to: 1, toUnit: 'in' };
/** A quarter-inch architectural scale: 1 in on paper = 4 ft in the world. */
const QUARTER: MeasureScale = { from: 1, fromUnit: 'in', to: 4, toUnit: 'ft' };

const cfg = (over: Partial<GridConfig> = {}): GridConfig => ({ ...DEFAULT_GRID, ...over });

describe('grid spacing in PAPER units', () => {
  it('turns inches into points', () => {
    expect(gridSpacingPoints(cfg({ spacing: 0.5, unit: 'in' }), ONE_TO_ONE)).toBeCloseTo(36, 10);
    expect(gridSpacingPoints(cfg({ spacing: 10, unit: 'mm' }), ONE_TO_ONE)).toBeCloseTo(
      (10 * 72) / 25.4,
      10,
    );
  });

  it('ignores the drawing scale entirely — a paper inch is an inch', () => {
    expect(gridSpacingPoints(cfg({ spacing: 1, unit: 'in' }), QUARTER)).toBeCloseTo(72, 10);
  });
});

describe('grid spacing through the DRAWING SCALE', () => {
  it('lands a 1 ft grid every 18 pt on a 1 in = 4 ft sheet', () => {
    // 1 in of paper spans 4 ft, so 1 ft is a quarter inch: 18 pt.
    const pts = gridSpacingPoints(cfg({ spacing: 1, useScale: true }), QUARTER);
    expect(pts).toBeCloseTo(18, 10);
  });

  it('reads the unit off the SCALE, not off the config', () => {
    // `unit` says mm and is deliberately unread: the reported unit is ft.
    const a = gridSpacingPoints(cfg({ spacing: 2, unit: 'mm', useScale: true }), QUARTER);
    const b = gridSpacingPoints(cfg({ spacing: 2, unit: 'm', useScale: true }), QUARTER);
    expect(a).toBeCloseTo(b, 12);
    expect(a).toBeCloseTo(36, 10);
  });

  it('agrees with what a measurement of that span would report', () => {
    const pts = gridSpacingPoints(cfg({ spacing: 3, useScale: true }), QUARTER);
    expect(pts * measureUnitsPerPoint(QUARTER)).toBeCloseTo(3, 10);
  });

  it('falls back to 1:1 rather than dividing by zero on a degenerate scale', () => {
    const bad: MeasureScale = { from: 0, fromUnit: 'in', to: 1, toUnit: 'in' };
    expect(gridSpacingPoints(cfg({ spacing: 1, useScale: true }), bad)).toBeCloseTo(72, 10);
  });
});

describe('gridForPage', () => {
  // A US-letter page: 612 × 792 pt.
  it('is anisotropic in NORMALIZED units because it is isotropic in points', () => {
    const g = gridForPage(cfg({ spacing: 1, unit: 'in' }), ONE_TO_ONE, 612, 792)!;
    expect(g.spacingX).toBeCloseTo(72 / 612, 12);
    expect(g.spacingY).toBeCloseTo(72 / 792, 12);
    // …which is the same absolute spacing on both axes.
    expect(g.spacingX * 612).toBeCloseTo(g.spacingY * 792, 10);
  });

  it('carries a non-zero origin through the same conversion', () => {
    const g = gridForPage(cfg({ spacing: 1, originX: 0.5, originY: 0.25 }), ONE_TO_ONE, 612, 792)!;
    expect(g.originX).toBeCloseTo(36 / 612, 12);
    expect(g.originY).toBeCloseTo(18 / 792, 12);
  });

  it('refuses a degenerate page or a non-positive spacing', () => {
    expect(gridForPage(cfg(), ONE_TO_ONE, 0, 792)).toBeNull();
    expect(gridForPage(cfg({ spacing: 0 }), ONE_TO_ONE, 612, 792)).toBeNull();
    expect(gridForPage(cfg({ spacing: -3 }), ONE_TO_ONE, 612, 792)).toBeNull();
  });

  it('quantizes a point to where a drafter expects, scale and origin included', () => {
    // 1 ft grid on the quarter-inch sheet: lines every 18 pt of paper.
    const g = gridForPage(cfg({ spacing: 1, useScale: true }), QUARTER, 612, 792)!;
    // A point 20 pt from the left edge snaps to the line at 18 pt.
    const q = gridPoint({ x: 20 / 612, y: 0 }, g);
    expect(q.x * 612).toBeCloseTo(18, 8);
  });
});

describe('gridLines', () => {
  it('runs BOTH ways from the origin — an origin is a phase, not an edge', () => {
    const xs = gridLines(0.25, 0.1);
    expect(xs[0]).toBeCloseTo(0.1, 12);
    expect(xs).toHaveLength(4); // 0.1, 0.35, 0.6, 0.85
    const shifted = gridLines(0.25, 0.6);
    expect(shifted[0]).toBeCloseTo(0.1, 12); // reached by going backwards
  });

  it('covers the whole 0..1 span and never leaves it', () => {
    for (const line of gridLines(0.037, -0.2)) {
      expect(line).toBeGreaterThanOrEqual(0);
      expect(line).toBeLessThanOrEqual(1);
    }
  });

  it('returns NOTHING rather than 36 000 lines at a pathological density', () => {
    expect(gridLines(0.00001, 0)).toEqual([]);
    expect(gridLines(0, 0)).toEqual([]);
    expect(gridLines(-1, 0)).toEqual([]);
  });
});

describe('niceStep', () => {
  it('climbs the 1-2-5 ladder', () => {
    expect(niceStep(0.9)).toBeCloseTo(1, 12);
    expect(niceStep(1)).toBeCloseTo(1, 12);
    expect(niceStep(1.1)).toBeCloseTo(2, 12);
    expect(niceStep(2.1)).toBeCloseTo(5, 12);
    expect(niceStep(5.1)).toBeCloseTo(10, 12);
    expect(niceStep(0.03)).toBeCloseTo(0.05, 12);
    expect(niceStep(300)).toBeCloseTo(500, 12);
  });

  it('does not overshoot an exact power of ten to its float dust', () => {
    // log10(0.001) can land a ulp low; the tolerance is what stops the step
    // from doubling to 0.002 there.
    expect(niceStep(0.001)).toBeCloseTo(0.001, 15);
    expect(niceStep(100)).toBeCloseTo(100, 12);
  });

  it('refuses a non-positive or non-finite input', () => {
    expect(niceStep(0)).toBe(0);
    expect(niceStep(-1)).toBe(0);
    expect(niceStep(Number.NaN)).toBe(0);
  });
});

describe('rulerTicks', () => {
  const base = { originPx: 100, extentPx: 800, pxPerPt: 1, unitsPerPt: 1 / 72 };

  it('labels round numbers of the reported unit', () => {
    const ticks = rulerTicks(base);
    const majors = ticks.filter((t) => t.major);
    expect(majors.length).toBeGreaterThan(2);
    for (const m of majors) {
      // At 72 px per inch the label step is 1 in; every label is an integer.
      expect(Math.abs(m.value - Math.round(m.value))).toBeLessThan(1e-9);
    }
  });

  it('puts value 0 exactly at the origin', () => {
    const zero = rulerTicks(base).find((t) => t.value === 0);
    expect(zero).toBeDefined();
    expect(zero!.pos).toBeCloseTo(100, 8);
    expect(zero!.major).toBe(true);
  });

  it('emits NEGATIVE values to the left of the page, which is what a ruler does', () => {
    expect(rulerTicks(base).some((t) => t.value < 0)).toBe(true);
  });

  it('stays inside the ruler', () => {
    for (const t of rulerTicks(base)) {
      expect(t.pos).toBeGreaterThanOrEqual(0);
      expect(t.pos).toBeLessThanOrEqual(800);
    }
  });

  it('coarsens the labels as the zoom drops rather than crowding them', () => {
    const near = rulerTicks({ ...base, pxPerPt: 4 });
    const far = rulerTicks({ ...base, pxPerPt: 0.25 });
    const labelStep = (ts: ReturnType<typeof rulerTicks>): number => {
      const majors = ts.filter((t) => t.major).map((t) => t.value);
      return Math.abs(majors[1] - majors[0]);
    };
    expect(labelStep(far)).toBeGreaterThan(labelStep(near));
    // …and no two labels are ever closer together than the minimum.
    for (const ts of [near, far]) {
      const majors = ts.filter((t) => t.major);
      expect(Math.abs(majors[1].pos - majors[0].pos)).toBeGreaterThanOrEqual(56 - 1e-6);
    }
  });

  it('subdivides on the LADDER: a 2-unit label step gets halves, not 0.4s', () => {
    // Pick a zoom whose label step is 2 in (56 px minimum ÷ 40 px/in = 1.4 →
    // niceStep 2). Its minors must be 0.5, the way a real ruler is divided.
    const ts = rulerTicks({ ...base, pxPerPt: 40 / 72 });
    const majors = ts.filter((t) => t.major).map((t) => t.value);
    expect(Math.abs(majors[1] - majors[0])).toBeCloseTo(2, 9);
    const all = ts.map((t) => t.value).sort((a, b) => a - b);
    expect(Math.abs(all[1] - all[0])).toBeCloseTo(0.5, 9);
  });

  it('drops the minor ticks rather than drawing a solid band', () => {
    // The default label/tick minimums can never collide (56 ÷ 5 > 5), so the
    // guard is proven where it is reachable: a caller that asks for dense
    // labels and sparse ticks gets labels only, never a grey smear.
    const ts = rulerTicks({ ...base, minLabelPx: 8, minTickPx: 6 });
    expect(ts.length).toBeGreaterThan(2);
    expect(ts.every((t) => t.major)).toBe(true);
  });

  it('reads in the SCALE unit, so a 1 in = 4 ft sheet labels feet', () => {
    const ts = rulerTicks({
      originPx: 0,
      extentPx: 900,
      pxPerPt: 1,
      unitsPerPt: measureUnitsPerPoint(QUARTER),
    });
    const majors = ts.filter((t) => t.major);
    // 72 pt of paper = 4 ft, so the ruler must reach ~50 ft across 900 px.
    expect(Math.max(...majors.map((t) => t.value))).toBeGreaterThan(40);
  });

  it('refuses degenerate inputs rather than looping', () => {
    expect(rulerTicks({ ...base, extentPx: 0 })).toEqual([]);
    expect(rulerTicks({ ...base, pxPerPt: 0 })).toEqual([]);
    expect(rulerTicks({ ...base, unitsPerPt: 0 })).toEqual([]);
    expect(rulerTicks({ ...base, originPx: Number.NaN })).toEqual([]);
  });
});
