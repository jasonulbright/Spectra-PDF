// The flattener panel's model: what the engine reported, what the canvas
// highlights, and what the two controls are allowed to be.
//
// What participates in transparency, which objects a region absorbs, and where
// a region boundary lands are ENGINE rules and live there alone. What lives
// here is what the panel and the overlay have to decide by themselves: which
// categories are shown, how a device-space rect becomes a display-normalized
// one, and whether a balance/resolution pair can be sent at all. There is no
// DOM test environment, so those rules live in the model, not the component.

export type FlattenCategory =
  | 'transparent'
  | 'affected'
  | 'rasterized'
  | 'outlined_strokes'
  | 'outlined_text'
  | 'expanded_patterns';

export const FLATTEN_CATEGORIES: readonly FlattenCategory[] = [
  'transparent',
  'affected',
  'rasterized',
  'outlined_strokes',
  'outlined_text',
  'expanded_patterns',
];

/** The resolutions offered. Below 72 a region raster is coarser than the page
 *  it replaces; above 600 the pixel cap is what answers, not the control. */
export const FLATTEN_DPI_CHOICES: readonly number[] = [72, 150, 300, 600];
export const DEFAULT_FLATTEN_DPI = 150;
export const DEFAULT_FLATTEN_BALANCE = 0.5;

export interface FlattenObject {
  index: number;
  kind: string;
  rect: number[];
  transparent: boolean;
  pattern: boolean;
  clipped: boolean;
  categories: FlattenCategory[];
}

export interface FlattenPageReport {
  page: number;
  error: string | null;
  page_box?: number[];
  objects: FlattenObject[];
  regions: number[][];
  region_members?: number[][];
  region_pixels?: number[][];
  whole_page: boolean;
  counts: Record<FlattenCategory, number>;
}

export interface FlattenReport {
  pages: FlattenPageReport[];
  balance: number;
  dpi: number;
  transparent_pages: number[];
}

export interface HighlightRect {
  /** Display-normalized 0…1, y measured from the TOP — the convention every
   *  page-space overlay on this canvas already uses. */
  x: number;
  y: number;
  w: number;
  h: number;
  category: FlattenCategory | 'region';
  key: string;
}

/** The balance the engine will actually receive. Out-of-range is clamped
 *  rather than refused: the control is a slider and a slider cannot produce a
 *  value the engine should argue about. */
export function clampBalance(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FLATTEN_BALANCE;
  return Math.min(1, Math.max(0, value));
}

/** The resolution the engine will actually receive: one of the offered
 *  choices, or the default when the caller invents one. */
export function clampDpi(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FLATTEN_DPI;
  const rounded = Math.round(value);
  return FLATTEN_DPI_CHOICES.includes(rounded) ? rounded : DEFAULT_FLATTEN_DPI;
}

/** The page's report, or null when the document has none for it. */
export function pageReport(
  report: FlattenReport | null,
  page: number,
): FlattenPageReport | null {
  if (!report) return null;
  return report.pages.find((entry) => entry.page === page) ?? null;
}

/** Category totals across every page the report covers — what the panel
 *  states before anything is rewritten. */
export function totals(report: FlattenReport | null): Record<FlattenCategory, number> {
  const out = Object.fromEntries(
    FLATTEN_CATEGORIES.map((name) => [name, 0]),
  ) as Record<FlattenCategory, number>;
  if (!report) return out;
  for (const page of report.pages) {
    for (const name of FLATTEN_CATEGORIES) out[name] += page.counts?.[name] ?? 0;
  }
  return out;
}

/** How many regions the whole document would rasterize. */
export function regionCount(report: FlattenReport | null): number {
  if (!report) return 0;
  return report.pages.reduce((sum, page) => sum + page.regions.length, 0);
}

/** The pages whose content stream could not be read. One unreadable page is
 *  reported and the rest of the document still classifies; it never returns
 *  silently. */
export function unreadablePages(report: FlattenReport | null): number[] {
  if (!report) return [];
  return report.pages.filter((page) => page.error !== null).map((page) => page.page);
}

function normalize(
  rect: number[],
  box: number[],
  category: FlattenCategory | 'region',
  key: string,
): HighlightRect | null {
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  if (!(width > 0) || !(height > 0)) return null;
  const x0 = Math.min(rect[0], rect[2]);
  const x1 = Math.max(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]);
  const y1 = Math.max(rect[1], rect[3]);
  return {
    x: (x0 - box[0]) / width,
    // PDF space measures y upward from the box's bottom; the overlay measures
    // it downward from the page's top.
    y: (box[3] - y1) / height,
    w: (x1 - x0) / width,
    h: (y1 - y0) / height,
    category,
    key,
  };
}

/**
 * The rectangles the canvas draws for one page: every region, plus every
 * object carrying a category the caller left switched on.
 *
 * An object can hold several categories; it is drawn once per category it
 * carries so the legend and the page agree — hiding one of two would make the
 * count say something the highlight does not.
 */
export function highlightRects(
  page: FlattenPageReport | null,
  shown: ReadonlySet<FlattenCategory>,
): HighlightRect[] {
  if (!page || !page.page_box) return [];
  const box = page.page_box;
  const out: HighlightRect[] = [];
  page.regions.forEach((region, index) => {
    const rect = normalize(region, box, 'region', `region-${index}`);
    if (rect) out.push(rect);
  });
  for (const object of page.objects) {
    if (object.clipped) continue;
    for (const category of object.categories ?? []) {
      if (!shown.has(category)) continue;
      const rect = normalize(object.rect, box, category, `${category}-${object.index}`);
      if (rect) out.push(rect);
    }
  }
  return out;
}
