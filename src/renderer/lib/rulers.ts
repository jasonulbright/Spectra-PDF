// N11 slice B — GRID and RULER math. Pure functions only: no DOM, no React,
// no i18n (a tick carries its NUMBER; the component formats it through
// `tNumber`, because a pure module must not know the locale). Same reason
// `measure.ts` and `snap.ts` are shaped this way — this repo has no DOM test
// environment, so the breakable part must be the testable part.
//
// The one idea both halves share: a drawing sheet is read in REAL-WORLD units
// through the measure scale, not in paper units. A 1 ft grid on a 1/4"=1'0"
// sheet must land a line every 18 pt of paper, and the ruler beside it must
// say "1 ft" there. So everything below converts through
// `measureUnitsPerPoint`, which is the same factor a finished measurement
// captures into its /Measure dictionary.
import { measureUnitsPerPoint, ptPerUnit, type MeasureScale, type MeasureUnit } from './measure';
import type { SnapGrid } from './snap';

/**
 * A grid's spacing and origin.
 *
 * `useScale` switches which units `spacing`/`origin*` are expressed in:
 *
 * - `false` — PAPER units, named by `unit` (a 0.5 in grid is 36 pt, always).
 * - `true` — the measure scale's REPORTED unit (`scale.toUnit`), so the same
 *   number means a different amount of paper as the drawing scale changes.
 *   `unit` is then unread; the UI shows the scale's unit in its place.
 */
export interface GridConfig {
  spacing: number;
  unit: MeasureUnit;
  useScale: boolean;
  /** Offset of the first line from the page's top-left corner, same unit. */
  originX: number;
  originY: number;
}

export const DEFAULT_GRID: GridConfig = {
  spacing: 1,
  unit: 'in',
  useScale: false,
  originX: 0,
  originY: 0,
};

/** Spacing bounds, in whatever unit the config names. A non-positive spacing
 * is not a grid; the upper bound only stops a typo producing a single line
 * three miles off the page. */
export const GRID_SPACING_MIN = 0.001;
export const GRID_SPACING_MAX = 10_000;

/** One config value in PDF points. */
function toPoints(value: number, cfg: GridConfig, scale: MeasureScale): number {
  if (!Number.isFinite(value)) return 0;
  if (!cfg.useScale) return value * ptPerUnit(cfg.unit);
  const perPt = measureUnitsPerPoint(scale);
  return perPt > 0 ? value / perPt : 0;
}

/** The grid's line spacing in PDF points — what the popover's readout and the
 * renderer's "is this too dense to draw?" check both want. */
export function gridSpacingPoints(cfg: GridConfig, scale: MeasureScale): number {
  return toPoints(cfg.spacing, cfg, scale);
}

/**
 * The display-normalized grid for one page, or null when there is nothing to
 * draw or snap to.
 *
 * `dispWpt`/`dispHpt` are the page's DISPLAYED size in PDF points — the axes
 * already swapped at 90/270, exactly the pair the measure tool computes its
 * lengths against. Spacing is isotropic in POINTS and therefore anisotropic in
 * normalized units, which is why the two axes get separate numbers.
 */
export function gridForPage(
  cfg: GridConfig,
  scale: MeasureScale,
  dispWpt: number,
  dispHpt: number,
): SnapGrid | null {
  if (!(dispWpt > 0) || !(dispHpt > 0)) return null;
  const spacingPt = gridSpacingPoints(cfg, scale);
  if (!(spacingPt > 0)) return null;
  const originXpt = toPoints(cfg.originX, cfg, scale);
  const originYpt = toPoints(cfg.originY, cfg, scale);
  return {
    spacingX: spacingPt / dispWpt,
    spacingY: spacingPt / dispHpt,
    originX: originXpt / dispWpt,
    originY: originYpt / dispHpt,
  };
}

/**
 * Line positions along one normalized axis, from the origin outward in BOTH
 * directions — an origin is a phase, not a starting edge, so a grid offset by
 * 0.3 in still has lines to the left of it.
 *
 * `maxLines` is a hard stop, not a hint: a 0.001 in spacing on a 36 in sheet
 * is 36 000 lines, which is a frozen tab rather than a dense grid. Returning
 * an empty array makes "too dense to draw" a visible nothing rather than a
 * hang, and snapping is unaffected (quantization needs no line list).
 */
export function gridLines(
  spacing: number,
  origin: number,
  maxLines = 2000,
): number[] {
  if (!(spacing > 0) || !Number.isFinite(origin)) return [];
  if (1 / spacing > maxLines) return [];
  const first = Math.ceil((0 - origin) / spacing);
  const last = Math.floor((1 - origin) / spacing);
  const out: number[] = [];
  for (let k = first; k <= last; k++) out.push(origin + k * spacing);
  return out;
}

// ── Rulers ───────────────────────────────────────────────────────────────

export interface RulerTick {
  /** Position along the ruler, in CSS pixels from its start. */
  pos: number;
  /** The value at that position, in the scale's reported unit. Negative to
   * the left of / above the page origin, which is what a ruler does. */
  value: number;
  /** Labelled ticks are drawn long and carry their number. */
  major: boolean;
}

export interface RulerTickOpts {
  /** Where value 0 sits, in ruler pixels — the page's left (top ruler) or top
   * (left ruler) edge. Read from the DOM, never computed from document-space
   * offsets: the reading view caps its spacer and TRANSLATES rows under it
   * (P12), so an offset derived from `row * rowH` would be wrong past the cap
   * and a rect is right at every scroll position by construction. */
  originPx: number;
  /** The ruler's length in pixels. */
  extentPx: number;
  /** Display pixels per PDF point (the reading view's zoom, in effect). */
  pxPerPt: number;
  /** Reported units per PDF point — `measureUnitsPerPoint(scale)`. */
  unitsPerPt: number;
  /** The smallest gap a LABELLED tick may have. */
  minLabelPx?: number;
  /** The smallest gap any tick may have. */
  minTickPx?: number;
}

/** The 1-2-5 ladder: the smallest "round" number at or above `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    const step = pow * m;
    // A hair of tolerance: log10 of an exact power of ten can land a ulp low,
    // which would otherwise pick 2× the right step.
    if (step >= raw * (1 - 1e-9)) return step;
  }
  return pow * 10;
}

/**
 * The ticks for one ruler.
 *
 * Both the label step and the minor step come off the 1-2-5 ladder so the
 * numbers stay readable at any zoom (0.5 / 1 / 2 / 5 ft, never 0.37). Minors
 * are a fifth of the label step, dropped entirely when that would put them
 * closer together than `minTickPx` — a solid grey band is not a ruler.
 */
export function rulerTicks(opts: RulerTickOpts): RulerTick[] {
  const { originPx, extentPx, pxPerPt, unitsPerPt } = opts;
  const minLabelPx = opts.minLabelPx ?? 56;
  const minTickPx = opts.minTickPx ?? 5;
  if (!(extentPx > 0) || !(pxPerPt > 0) || !(unitsPerPt > 0)) return [];
  if (!Number.isFinite(originPx)) return [];
  const pxPerUnit = pxPerPt / unitsPerPt;
  if (!(pxPerUnit > 0)) return [];
  const labelStep = niceStep(minLabelPx / pxPerUnit);
  if (!(labelStep > 0)) return [];
  // The minor step must ALSO be a round number, or a 2-unit label step gives
  // ticks at 0.4 / 0.8 / 1.2 and the ruler stops being readable. A 2 divides
  // into four (0.5s); 1 and 5 divide into five. That is how every physical
  // ruler is subdivided, and for the same reason.
  const mantissa = labelStep / Math.pow(10, Math.floor(Math.log10(labelStep) + 1e-9));
  const divisions = Math.abs(mantissa - 2) < 1e-6 ? 4 : 5;
  const minor = labelStep / divisions;
  const step = minor * pxPerUnit >= minTickPx ? minor : labelStep;
  const stepPx = step * pxPerUnit;
  if (!(stepPx > 0)) return [];
  const first = Math.ceil((0 - originPx) / stepPx);
  const last = Math.floor((extentPx - originPx) / stepPx);
  if (last < first) return [];
  if (last - first > 4000) return []; // a pathological zoom, not a ruler
  const out: RulerTick[] = [];
  for (let k = first; k <= last; k++) {
    const value = k * step;
    const ratio = value / labelStep;
    const major = Math.abs(ratio - Math.round(ratio)) < 1e-6;
    // Snap the value to zero across the float dust a k*step product leaves,
    // so the origin label reads "0" rather than "-0".
    out.push({ pos: originPx + k * stepPx, value: Math.abs(value) < 1e-9 ? 0 : value, major });
  }
  return out;
}
