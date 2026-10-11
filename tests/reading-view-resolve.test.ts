// Which view a reading pane opens with (live, sibling, saved, defaults), and
// the mapping of a document's own initial view (ISO 32000-2 §7.7.2 Table 29
// PageLayout, §12.3.2.2 Table 149 destinations) onto the reading-view axes.
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/renderer/lib/app-settings';
import {
  DEFAULT_INITIAL_VIEW,
  PAGE_LAYOUT_VALUES,
  ZOOM_VALUES,
  type InitialView,
} from '../src/renderer/lib/initial-view';
import {
  defaultsFromSettings,
  recordFromSnapshot,
  resolveOpeningView,
  seedFromInitialView,
} from '../src/renderer/lib/reading-view-resolve';
import {
  DEFAULT_READING_VIEW,
  READING_ZOOM_PERCENT_MAX,
  READING_ZOOM_PERCENT_MIN,
  type ReadingViewSnapshot,
  type ReadingViewState,
} from '../src/renderer/lib/reading-view-types';
import type { ViewHistoryRecord } from '../src/renderer/lib/view-history';

const view = (patch: Partial<InitialView> = {}): InitialView => ({ ...DEFAULT_INITIAL_VIEW, pages: 10, ...patch });

function snap(over: Partial<ReadingViewSnapshot> = {}): ReadingViewSnapshot {
  return {
    zoomMode: 'custom',
    zoomPercent: 150,
    layoutMode: 'grid',
    coverAlone: true,
    scrollMode: 'paged',
    page: 7,
    columns: 3,
    pageCount: 20,
    docIndex: 0,
    ...over,
  };
}

function saved(over: Partial<ViewHistoryRecord> = {}): ViewHistoryRecord {
  return {
    page: 5,
    docIndex: 0,
    zoomMode: 'fitWidth',
    zoomPercent: 88,
    layoutMode: 'single',
    coverAlone: false,
    scrollMode: 'paged',
    pageCount: 20,
    savedAt: 1,
    ...over,
  };
}

const defaults: ReadingViewState = { ...DEFAULT_READING_VIEW, zoomMode: 'actual', layoutMode: 'grid' };

describe('defaultsFromSettings', () => {
  it('reads the shipped defaults as a fitted single column on page 1', () => {
    expect(defaultsFromSettings(DEFAULTS)).toEqual(DEFAULT_READING_VIEW);
  });

  it('carries every Viewing preference', () => {
    expect(
      defaultsFromSettings({
        ...DEFAULTS,
        viewZoomMode: 'custom',
        viewZoomPercent: 250,
        viewLayoutMode: 'grid',
        viewScrollMode: 'paged',
      }),
    ).toEqual({
      zoomMode: 'custom',
      zoomPercent: 250,
      layoutMode: 'grid',
      coverAlone: false,
      scrollMode: 'paged',
      page: 1,
    });
  });

  it('uses the stored percentage only for a custom zoom', () => {
    expect(defaultsFromSettings({ ...DEFAULTS, viewZoomMode: 'fitWidth', viewZoomPercent: 250 }).zoomPercent).toBe(100);
  });
});

describe('resolveOpeningView precedence', () => {
  const all = { live: snap({ page: 1 }), siblingLive: snap({ page: 2 }), saved: saved({ page: 3 }), defaults, pageCount: 20 };

  it('prefers the live snapshot', () => {
    const r = resolveOpeningView(all);
    expect(r.source).toBe('live');
    expect(r.state.page).toBe(1);
    expect(r.state).not.toHaveProperty('columns');
    expect(r.state).not.toHaveProperty('pageCount');
  });

  it('then the sibling pane', () => {
    const r = resolveOpeningView({ ...all, live: null });
    expect(r.source).toBe('sibling');
    expect(r.state.page).toBe(2);
  });

  it('then the saved row', () => {
    const r = resolveOpeningView({ ...all, live: null, siblingLive: null });
    expect(r.source).toBe('saved');
    expect(r.state).toEqual({
      zoomMode: 'fitWidth',
      zoomPercent: 88,
      layoutMode: 'single',
      coverAlone: false,
      scrollMode: 'paged',
      page: 3,
    });
  });

  it('then the defaults', () => {
    const r = resolveOpeningView({ ...all, live: null, siblingLive: null, saved: null });
    expect(r.source).toBe('defaults');
    expect(r.state).toEqual(defaults);
    r.state.page = 9;
    expect(defaults.page).toBe(1);
  });

  it('clamps the page to the current count on every rung', () => {
    expect(resolveOpeningView({ ...all, live: snap({ page: 30 }), pageCount: 12 }).state.page).toBe(12);
    expect(resolveOpeningView({ ...all, live: null, siblingLive: snap({ page: 30 }), pageCount: 12 }).state.page).toBe(12);
    expect(
      resolveOpeningView({ ...all, live: null, siblingLive: null, saved: saved({ page: 30 }), pageCount: 12 }).state.page,
    ).toBe(12);
    expect(resolveOpeningView({ ...all, live: null, siblingLive: null, saved: saved({ page: 30 }), pageCount: 0 }).state.page).toBe(1);
  });

  it('restores a saved row of another document of the file without its page', () => {
    const r = resolveOpeningView({ ...all, live: null, siblingLive: null, saved: saved({ docIndex: 1 }), docIndex: 0 });
    expect(r.source).toBe('saved');
    expect(r.state.page).toBe(1);
    expect(r.state.zoomMode).toBe('fitWidth');
    expect(resolveOpeningView({ ...all, live: null, siblingLive: null, saved: saved({ docIndex: 1 }), docIndex: 1 }).state.page).toBe(5);
  });
});

describe('seedFromInitialView: PageLayout (Table 29)', () => {
  const cases: Record<string, Partial<ReadingViewState>> = {
    'single-page': { layoutMode: 'single', scrollMode: 'paged', coverAlone: false },
    'one-column': { layoutMode: 'single', scrollMode: 'continuous', coverAlone: false },
    'two-column-left': { layoutMode: 'grid', scrollMode: 'continuous', coverAlone: false },
    'two-column-right': { layoutMode: 'grid', scrollMode: 'continuous', coverAlone: true },
    'two-page-left': { layoutMode: 'grid', scrollMode: 'paged', coverAlone: false },
    'two-page-right': { layoutMode: 'grid', scrollMode: 'paged', coverAlone: true },
  };

  it('covers every layout value', () => {
    expect(Object.keys(cases).sort()).toEqual(PAGE_LAYOUT_VALUES.filter((v) => v !== 'default').sort());
  });

  for (const [layout, state] of Object.entries(cases)) {
    it(`maps ${layout}`, () => {
      const seed = seedFromInitialView(view({ page_layout: layout as InitialView['page_layout'] }));
      expect(seed?.state).toEqual(state);
      expect(seed?.columnsHint).toBe(state.layoutMode === 'grid' ? 2 : null);
    });
  }

  it('asks for no column count when a two-up layout states its own zoom', () => {
    const seed = seedFromInitialView(view({ page_layout: 'two-page-left', open_page: 1, zoom: 'fit-width' }));
    expect(seed?.columnsHint).toBeNull();
    expect(seed?.state).toMatchObject({ layoutMode: 'grid', scrollMode: 'paged', zoomMode: 'fitWidth' });
  });

  it('keeps the column hint when the stated zoom is one this view cannot reproduce', () => {
    expect(seedFromInitialView(view({ page_layout: 'two-column-left', open_page: 1, zoom: 'custom' }))?.columnsHint).toBe(2);
  });
});

describe('seedFromInitialView: destinations (Table 149)', () => {
  const cases: Record<string, Partial<ReadingViewState> | null> = {
    'fit-page': { zoomMode: 'fitPage' }, // Fit
    'fit-visible': { zoomMode: 'fitPage' }, // FitB
    'fit-width': { zoomMode: 'fitWidth' }, // FitH, FitBH
    'fit-height': { zoomMode: 'fitHeight' }, // FitV, FitBV
    percent: { zoomMode: 'custom', zoomPercent: 125 }, // XYZ with a zoom
    custom: null, // FitR
    default: null, // XYZ with no zoom, or no destination
  };

  it('covers every zoom value', () => {
    expect(Object.keys(cases).sort()).toEqual([...ZOOM_VALUES].sort());
  });

  for (const [zoom, state] of Object.entries(cases)) {
    it(`maps ${zoom}`, () => {
      const seed = seedFromInitialView(view({ zoom: zoom as InitialView['zoom'], zoom_percent: zoom === 'percent' ? 125 : null }));
      expect(seed?.state ?? null).toEqual(state);
      expect(seed?.columnsHint ?? null).toBeNull();
    });
  }

  it('clamps a percentage to the reading range and ignores a non-positive one', () => {
    expect(seedFromInitialView(view({ zoom: 'percent', zoom_percent: 99_999 }))?.state.zoomPercent).toBe(6400);
    expect(seedFromInitialView(view({ zoom: 'percent', zoom_percent: 0.5 }))?.state.zoomPercent).toBe(1);
    expect(seedFromInitialView(view({ zoom: 'percent', zoom_percent: 0 }))).toBeNull();
    expect(seedFromInitialView(view({ zoom: 'percent', zoom_percent: null }))).toBeNull();
  });
});

describe('seedFromInitialView: opening page', () => {
  it('carries the destination page', () => {
    expect(seedFromInitialView(view({ open_page: 4 }))).toEqual({ state: { page: 4 }, columnsHint: null });
  });

  it('clamps a page past the end', () => {
    expect(seedFromInitialView(view({ open_page: 40, pages: 10 }))?.state.page).toBe(10);
  });

  it('returns null for a document that states nothing', () => {
    expect(seedFromInitialView(view())).toBeNull();
  });

  it('combines every stated axis', () => {
    expect(
      seedFromInitialView(view({ page_layout: 'two-column-right', open_page: 3, zoom: 'percent', zoom_percent: 80 })),
    ).toEqual({
      state: {
        layoutMode: 'grid',
        scrollMode: 'continuous',
        coverAlone: true,
        zoomMode: 'custom',
        zoomPercent: 80,
        page: 3,
      },
      columnsHint: null,
    });
  });
});

describe('recordFromSnapshot', () => {
  it('keeps the axes, the page number, the document index and the count', () => {
    expect(recordFromSnapshot(snap(), 2, 1234)).toEqual({
      page: 7,
      docIndex: 2,
      zoomMode: 'custom',
      zoomPercent: 150,
      layoutMode: 'grid',
      coverAlone: true,
      scrollMode: 'paged',
      pageCount: 20,
      savedAt: 1234,
    });
  });

  it('never carries the resolved column count', () => {
    expect(recordFromSnapshot(snap(), 0, 1)).not.toHaveProperty('columns');
  });

  it('sanitizes a zero-page snapshot', () => {
    expect(recordFromSnapshot(snap({ page: 0, pageCount: 0, zoomPercent: Number.NaN }), -1, 1)).toMatchObject({
      page: 1,
      docIndex: 0,
      pageCount: 0,
      zoomPercent: 100,
    });
  });

  it('round-trips through resolveOpeningView', () => {
    const r = resolveOpeningView({
      live: null,
      siblingLive: null,
      saved: recordFromSnapshot(snap(), 0, 1),
      defaults,
      pageCount: 20,
    });
    expect(r.state).toEqual({
      zoomMode: 'custom',
      zoomPercent: 150,
      layoutMode: 'grid',
      coverAlone: true,
      scrollMode: 'paged',
      page: 7,
    });
  });
});

describe('recordFromSnapshot zoom bounds', () => {
  it('stores the rendered percent unchanged inside the bounds and clamps to them outside', () => {
    expect(recordFromSnapshot(snap({ zoomPercent: 2.424 }), 0, 1).zoomPercent).toBe(2.424);
    expect(recordFromSnapshot(snap({ zoomPercent: 6399.5 }), 0, 1).zoomPercent).toBe(6399.5);
    expect(recordFromSnapshot(snap({ zoomPercent: 7757.576 }), 0, 1).zoomPercent).toBe(READING_ZOOM_PERCENT_MAX);
    expect(recordFromSnapshot(snap({ zoomPercent: 0.5 }), 0, 1).zoomPercent).toBe(READING_ZOOM_PERCENT_MIN);
  });
});
