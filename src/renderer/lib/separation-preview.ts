// The separation preview's pure model: what the engine's plates mean, which
// of them are showing, what the ink arithmetic produces, and how the plate
// cache is keyed and pruned.
//
// The panel and the canvas are thin shells over this. There is no DOM test
// environment, so every decision that can be wrong lives here where it is
// testable — the components only render what these functions decide.

export type InkKind = 'process' | 'spot' | 'all' | 'none';

/** A colorant the document declares. */
export interface Ink {
  name: string;
  kind: InkKind;
  alternate: string;
  display_rgb: number[] | null;
  pages: number[];
  used_in: string[];
}

/** One rasterized plate of a page. */
export interface Plate {
  name: string;
  kind: InkKind;
  display_rgb: number[];
  file: string;
}

/** What one separation render produced. */
export interface PlateSet {
  dir: string;
  plates: Plate[];
  width: number;
  height: number;
  dpi: number;
  page: number;
  overprint: boolean;
  /** Per-process-ink page coverage as a fraction — a page AVERAGE. */
  coverage: Record<string, number>;
}

/** What a composite of a chosen plate subset produced. */
export interface CompositeResult {
  png: string;
  width: number;
  height: number;
  inks: string[];
  max_tac: number;
  over_pixels: number;
  total_pixels: number;
  over_fraction: number;
}

/** Total ink a press job is normally held to, in percent. */
export const DEFAULT_TAC_LIMIT = 300;
export const MIN_TAC_LIMIT = 100;
export const MAX_TAC_LIMIT = 400;

/** Neutral density multiplies an ink's absorption in the composite. */
export const DEFAULT_INK_DENSITY = 1;
export const MIN_INK_DENSITY = 0.1;
export const MAX_INK_DENSITY = 2;

/** Separation rasters above this resolution buy nothing a display can show. */
export const MAX_PREVIEW_DPI = 300;
export const MIN_PREVIEW_DPI = 36;
/** Long-edge pixels a preview page is rastered to — a fit-to-width letter
 *  page on a 2× display, which is the most any panel of this size resolves. */
export const PREVIEW_RASTER = 1650;

/** Only these two kinds are inks a user can switch. `/All` paints every plate
 *  and owns none; `/None` paints nothing. Neither is ever offered. */
export function isToggleableInk(ink: { kind: InkKind }): boolean {
  return ink.kind === 'process' || ink.kind === 'spot';
}

/** The plates a composite should draw, given the switched-off ink names. */
export function visiblePlates(plates: readonly Plate[], hidden: ReadonlySet<string>): Plate[] {
  return plates.filter((p) => isToggleableInk(p) && !hidden.has(p.name));
}

export interface InkRequest {
  name: string;
  display_rgb: number[];
  density: number;
}

/** What the engine is asked to composite: the visible plates, each carrying
 *  the display colour and density the panel currently holds. */
export function compositeRequest(
  plates: readonly Plate[],
  hidden: ReadonlySet<string>,
  densities: ReadonlyMap<string, number>,
): InkRequest[] {
  return visiblePlates(plates, hidden).map((p) => ({
    name: p.name,
    display_rgb: p.display_rgb,
    density: clampDensity(densities.get(p.name) ?? DEFAULT_INK_DENSITY),
  }));
}

export function clampDensity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INK_DENSITY;
  return Math.min(MAX_INK_DENSITY, Math.max(MIN_INK_DENSITY, value));
}

export function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TAC_LIMIT;
  return Math.min(MAX_TAC_LIMIT, Math.max(MIN_TAC_LIMIT, Math.round(value)));
}

/**
 * One pixel of the composite, in 0…255 sRGB.
 *
 * Each ink multiplies its own absorption down, scaled by its coverage at that
 * pixel and by its density — so an ink switched off leaves the pixel exactly
 * as if that ink had never printed. This mirrors the engine's array
 * arithmetic; it is here so the model can be proven against it.
 */
export function compositePixel(
  inks: readonly InkRequest[],
  coverage: readonly number[],
): [number, number, number] {
  const rgb: [number, number, number] = [1, 1, 1];
  inks.forEach((ink, index) => {
    const amount = Math.min(1, Math.max(0, coverage[index] ?? 0));
    for (let c = 0; c < 3; c += 1) {
      const absorb = 1 - (ink.display_rgb[c] ?? 0) / 255;
      rgb[c] *= Math.min(1, Math.max(0, 1 - amount * ink.density * absorb));
    }
  });
  return [
    Math.round(rgb[0] * 255),
    Math.round(rgb[1] * 255),
    Math.round(rgb[2] * 255),
  ];
}

/** Total ink at one pixel, in percent. */
export function totalInk(coverage: readonly number[]): number {
  return coverage.reduce((sum, c) => sum + Math.min(1, Math.max(0, c)) * 100, 0);
}

/**
 * The resolution to raster a page at.
 *
 * Capped at what the display can show: the ink arithmetic is
 * resolution-independent, so anything beyond the on-screen pixel pitch costs
 * time and changes no number the panel reports.
 */
export function previewDpi(pageWidthPoints: number, pageHeightPoints: number): number {
  const longEdge = Math.max(pageWidthPoints, pageHeightPoints);
  if (!(longEdge > 0)) return MIN_PREVIEW_DPI;
  const dpi = (PREVIEW_RASTER * 72) / longEdge;
  return Math.round(Math.min(MAX_PREVIEW_DPI, Math.max(MIN_PREVIEW_DPI, dpi)));
}

// ── the plate cache ────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  /** The page this entry belongs to. Held as a FIELD, never parsed back out
   *  of the key: a page id is opaque and string-building or splitting one is
   *  how a stale id re-binds. */
  pageId: string;
  value: T;
}

export function plateCacheKey(
  fileId: string,
  pageId: string,
  dpi: number,
  overprint: boolean,
): string {
  return JSON.stringify([fileId, pageId, dpi, overprint]);
}

/**
 * Drop every entry whose page is no longer in the document.
 *
 * Synchronous, and run before the first await of anything that reads the
 * cache: a page id is generation-tagged, so an entry keyed by a retired id
 * can never re-bind and would otherwise show one page's separations under
 * another's. Returns the removed keys so the caller can release what they
 * held.
 */
export function prunePlateCache<T>(
  cache: Map<string, CacheEntry<T>>,
  livePageIds: ReadonlySet<string>,
): string[] {
  const removed: string[] = [];
  for (const [key, entry] of cache) {
    if (!livePageIds.has(entry.pageId)) removed.push(key);
  }
  for (const key of removed) cache.delete(key);
  return removed;
}

/** The per-ink page coverage readout, ordered and labelled as percentages.
 *  This is the device's page AVERAGE — it cannot answer "how much ink is on
 *  the heaviest pixel", which is what the limit alarm measures. */
export function coverageRows(coverage: Record<string, number>): Array<{ name: string; pct: number }> {
  return ['Cyan', 'Magenta', 'Yellow', 'Black']
    .filter((name) => typeof coverage[name] === 'number')
    .map((name) => ({ name, pct: coverage[name] * 100 }));
}

/** Does this composite trip the limit? */
export function alarmTripped(result: Pick<CompositeResult, 'over_pixels'>): boolean {
  return result.over_pixels > 0;
}
