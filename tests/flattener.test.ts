import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLATTEN_BALANCE,
  DEFAULT_FLATTEN_DPI,
  clampBalance,
  clampDpi,
  highlightRects,
  pageReport,
  regionCount,
  totals,
  unreadablePages,
  type FlattenCategory,
  type FlattenPageReport,
  type FlattenReport,
} from '../src/renderer/lib/flattener';

function page(overrides: Partial<FlattenPageReport> = {}): FlattenPageReport {
  return {
    page: 1,
    error: null,
    page_box: [0, 0, 200, 400],
    objects: [],
    regions: [],
    whole_page: false,
    counts: {
      transparent: 0, affected: 0, rasterized: 0,
      outlined_strokes: 0, outlined_text: 0, expanded_patterns: 0,
    },
    ...overrides,
  };
}

function report(pages: FlattenPageReport[]): FlattenReport {
  return { pages, balance: 0.5, dpi: 150, transparent_pages: [] };
}

const ALL = new Set<FlattenCategory>([
  'transparent', 'affected', 'rasterized',
  'outlined_strokes', 'outlined_text', 'expanded_patterns',
]);

describe('flattener controls', () => {
  it('clamps a balance into the range the engine accepts', () => {
    expect(clampBalance(-1)).toBe(0);
    expect(clampBalance(2)).toBe(1);
    expect(clampBalance(0.25)).toBe(0.25);
  });

  it('falls back to the default balance for a value that is not a number', () => {
    expect(clampBalance(Number.NaN)).toBe(DEFAULT_FLATTEN_BALANCE);
  });

  it('only accepts an offered resolution', () => {
    expect(clampDpi(300)).toBe(300);
    expect(clampDpi(137)).toBe(DEFAULT_FLATTEN_DPI);
    expect(clampDpi(Number.NaN)).toBe(DEFAULT_FLATTEN_DPI);
  });
});

describe('flattener report reading', () => {
  it('sums the category counts across every page', () => {
    const counts = totals(report([
      page({ page: 1, counts: { ...page().counts, transparent: 2, rasterized: 3 } }),
      page({ page: 2, counts: { ...page().counts, transparent: 1 } }),
    ]));
    expect(counts.transparent).toBe(3);
    expect(counts.rasterized).toBe(3);
    expect(counts.affected).toBe(0);
  });

  it('counts every region in the document, not just the first page', () => {
    expect(regionCount(report([
      page({ page: 1, regions: [[0, 0, 10, 10]] }),
      page({ page: 2, regions: [[0, 0, 10, 10], [20, 20, 30, 30]] }),
    ]))).toBe(3);
  });

  it('names the pages that could not be read rather than dropping them', () => {
    expect(unreadablePages(report([
      page({ page: 1 }),
      page({ page: 2, error: 'unreadable content stream' }),
    ]))).toEqual([2]);
  });

  it('returns nothing when there is no report at all', () => {
    expect(totals(null).transparent).toBe(0);
    expect(regionCount(null)).toBe(0);
    expect(unreadablePages(null)).toEqual([]);
    expect(pageReport(null, 1)).toBeNull();
  });

  it('finds a page by its number, not by its position', () => {
    const found = pageReport(report([page({ page: 4 }), page({ page: 7 })]), 7);
    expect(found?.page).toBe(7);
    expect(pageReport(report([page({ page: 4 })]), 7)).toBeNull();
  });
});

describe('flattener highlights', () => {
  it('projects a PDF rect into the overlay’s top-down normalized space', () => {
    const rects = highlightRects(page({
      regions: [[50, 300, 150, 400]],
    }), ALL);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ x: 0.25, y: 0, w: 0.5, h: 0.25, category: 'region' });
  });

  it('draws an object once per category it carries', () => {
    const rects = highlightRects(page({
      objects: [{
        index: 0, kind: 'text', rect: [0, 0, 100, 100],
        transparent: false, pattern: false, clipped: false,
        categories: ['rasterized', 'outlined_text'],
      }],
    }), ALL);
    expect(rects.map((r) => r.category)).toEqual(['rasterized', 'outlined_text']);
    expect(new Set(rects.map((r) => r.key)).size).toBe(2);
  });

  it('draws nothing for a category the panel switched off', () => {
    const shown = new Set<FlattenCategory>(['transparent']);
    const rects = highlightRects(page({
      objects: [{
        index: 0, kind: 'fill', rect: [0, 0, 100, 100],
        transparent: false, pattern: false, clipped: false,
        categories: ['rasterized'],
      }],
    }), shown);
    expect(rects).toEqual([]);
  });

  it('never draws a clipped-away object', () => {
    const rects = highlightRects(page({
      objects: [{
        index: 0, kind: 'fill', rect: [0, 0, 100, 100],
        transparent: true, pattern: false, clipped: true,
        categories: ['transparent'],
      }],
    }), ALL);
    expect(rects).toEqual([]);
  });

  it('draws nothing without a page box to project against', () => {
    const bare = page({ regions: [[0, 0, 10, 10]] });
    delete bare.page_box;
    expect(highlightRects(bare, ALL)).toEqual([]);
    expect(highlightRects(null, ALL)).toEqual([]);
  });

  it('tolerates a rect whose corners arrive in either order', () => {
    const rects = highlightRects(page({ regions: [[150, 400, 50, 300]] }), ALL);
    expect(rects[0]).toMatchObject({ x: 0.25, y: 0, w: 0.5, h: 0.25 });
  });
});
