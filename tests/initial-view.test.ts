// The Initial View tab's model: parsing an engine payload, the change set a
// save sends, and the translation into this app's own view state.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INITIAL_VIEW,
  HONORED_ZOOMS,
  PAGE_LAYOUT_VALUES,
  PAGE_MODE_VALUES,
  VIEWER_ONLY_OPTIONS,
  ZOOM_VALUES,
  initialViewChanges,
  initialViewPlan,
  parseInitialView,
  planIsInert,
  planMovesWorkbench,
  type InitialView,
} from '../src/renderer/lib/initial-view';
import { appReducer, initialState } from '../src/renderer/state/reducer';

const view = (patch: Partial<InitialView> = {}): InitialView => ({
  ...DEFAULT_INITIAL_VIEW,
  pages: 10,
  ...patch,
});

describe('parseInitialView', () => {
  it('reads a full engine payload', () => {
    const parsed = parseInitialView({
      page_layout: 'two-column-right',
      page_mode: 'outlines',
      open_page: 3,
      zoom: 'percent',
      zoom_percent: 125,
      hide_toolbar: true,
      hide_menubar: false,
      hide_window_ui: false,
      fit_window: true,
      center_window: false,
      display_doc_title: true,
      direction: 'R2L',
      open_action_replaceable: true,
      pages: 9,
    });
    expect(parsed.page_layout).toBe('two-column-right');
    expect(parsed.page_mode).toBe('outlines');
    expect(parsed.open_page).toBe(3);
    expect(parsed.zoom_percent).toBe(125);
    expect(parsed.direction).toBe('R2L');
    expect(parsed.fit_window).toBe(true);
    expect(parsed.pages).toBe(9);
  });

  it('replaces a value this build does not know with its default', () => {
    const parsed = parseInitialView({
      page_layout: 'spiral',
      page_mode: 'kaleidoscope',
      zoom: 'fit-everything',
      direction: 'ttb',
    });
    expect(parsed.page_layout).toBe('default');
    expect(parsed.page_mode).toBe('default');
    expect(parsed.zoom).toBe('default');
    expect(parsed.direction).toBe('L2R');
  });

  it('treats a missing payload as every default, and a missing replaceable flag as replaceable', () => {
    const parsed = parseInitialView({});
    expect(parsed).toEqual({ ...DEFAULT_INITIAL_VIEW, pages: 0 });
    expect(parsed.open_action_replaceable).toBe(true);
  });

  it('rejects a page number below one rather than sending it to the engine', () => {
    expect(parseInitialView({ open_page: 0 }).open_page).toBeNull();
    expect(parseInitialView({ open_page: -4 }).open_page).toBeNull();
  });

  it('every declared value is a value the parser accepts', () => {
    for (const value of PAGE_LAYOUT_VALUES) {
      expect(parseInitialView({ page_layout: value }).page_layout).toBe(value);
    }
    for (const value of PAGE_MODE_VALUES) {
      expect(parseInitialView({ page_mode: value }).page_mode).toBe(value);
    }
    for (const value of ZOOM_VALUES) {
      expect(parseInitialView({ zoom: value }).zoom).toBe(value);
    }
  });
});

describe('initialViewChanges', () => {
  it('sends nothing when nothing moved', () => {
    expect(initialViewChanges(view(), view())).toBeNull();
  });

  it('sends only the field that moved', () => {
    expect(initialViewChanges(view(), view({ page_mode: 'thumbnails' }))).toEqual({
      page_mode: 'thumbnails',
    });
  });

  it('names the page whenever the magnification moves, since they are one destination', () => {
    const base = view({ open_page: 4, zoom: 'fit-page' });
    expect(initialViewChanges(base, { ...base, zoom: 'fit-width' })).toEqual({
      open_page: 4,
      zoom: 'fit-width',
    });
  });

  it('carries the percentage with a percent magnification', () => {
    const base = view({ open_page: 2, zoom: 'percent', zoom_percent: 100 });
    expect(initialViewChanges(base, { ...base, zoom_percent: 175 })).toEqual({
      open_page: 2,
      zoom: 'percent',
      zoom_percent: 175,
    });
  });

  it('sends page zero to remove the open action', () => {
    const base = view({ open_page: 3, zoom: 'fit-page' });
    expect(initialViewChanges(base, { ...base, open_page: null })).toEqual({ open_page: 0 });
  });

  it('does not send a magnification with no page to apply it to', () => {
    const base = view({ open_page: null, zoom: 'default' });
    const changes = initialViewChanges(base, { ...base, zoom: 'fit-page' });
    expect(changes).toBeNull();
  });

  it('changes only the page so exact stored coordinates and magnification survive', () => {
    for (const zoom of ['custom', 'percent', 'fit-width'] as const) {
      const base = view({ open_page: 2, zoom, zoom_percent: zoom === 'percent' ? 0.25 : null });
      expect(initialViewChanges(base, { ...base, open_page: 3 })).toEqual({ open_page: 3 });
    }
  });

  it('sends every window option that moved, in either direction', () => {
    const on = view(Object.fromEntries(VIEWER_ONLY_OPTIONS.map((k) => [k, true])));
    expect(initialViewChanges(view(), on)).toEqual(
      Object.fromEntries(VIEWER_ONLY_OPTIONS.map((k) => [k, true])),
    );
    expect(initialViewChanges(on, view())).toEqual(
      Object.fromEntries(VIEWER_ONLY_OPTIONS.map((k) => [k, false])),
    );
  });

  it('sends the direction when it moves', () => {
    expect(initialViewChanges(view(), view({ direction: 'R2L' }))).toEqual({ direction: 'R2L' });
  });
});

describe('initialViewPlan', () => {
  it('says nothing about layout, pane or reading mode for a document that states nothing', () => {
    const plan = initialViewPlan(view());
    expect(plan.seed).toBeNull();
    expect(plan.navPane).toBeNull();
    expect(plan.readingMode).toBeNull();
    expect(plan.page).toBeNull();
    expect(plan.spreadDirection).toBe('l2r');
  });

  it('maps single-column layouts to one page per row', () => {
    for (const value of ['single-page', 'one-column'] as const) {
      const plan = initialViewPlan(view({ page_layout: value }));
      expect(plan.seed?.state.layoutMode).toBe('single');
      expect(plan.seed?.state.coverAlone).toBe(false);
    }
  });

  it('maps the two-up layouts, with the cover alone only for the "right" pair', () => {
    for (const value of ['two-column-left', 'two-page-left'] as const) {
      const plan = initialViewPlan(view({ page_layout: value }));
      expect(plan.seed?.state.layoutMode).toBe('grid');
      expect(plan.seed?.state.coverAlone).toBe(false);
      expect(plan.seed?.columnsHint).toBe(2);
    }
    for (const value of ['two-column-right', 'two-page-right'] as const) {
      const plan = initialViewPlan(view({ page_layout: value }));
      expect(plan.seed?.state.layoutMode).toBe('grid');
      expect(plan.seed?.state.coverAlone).toBe(true);
    }
  });

  it('opens the nav pane on the panel the page mode names', () => {
    const cases = {
      outlines: 'bookmarks',
      thumbnails: 'pages',
      oc: 'layers',
      attachments: 'attachments',
    } as const;
    for (const [mode, panel] of Object.entries(cases)) {
      const plan = initialViewPlan(view({ page_mode: mode as never }));
      expect(plan.navPane).toEqual({ open: true, panel });
      expect(plan.readingMode).toBe(false);
    }
  });

  it('closes the pane for UseNone and enters reading mode for FullScreen', () => {
    const none = initialViewPlan(view({ page_mode: 'none' }));
    expect(none.navPane).toEqual({ open: false, panel: null });
    expect(none.readingMode).toBe(false);
    const full = initialViewPlan(view({ page_mode: 'full-screen' }));
    expect(full.navPane).toEqual({ open: false, panel: null });
    expect(full.readingMode).toBe(true);
  });

  it('carries a percent magnification as a custom zoom', () => {
    const seed = initialViewPlan(view({ open_page: 2, zoom: 'percent', zoom_percent: 150 })).seed;
    expect(seed?.state).toEqual({ zoomMode: 'custom', zoomPercent: 150, page: 2 });
  });

  it('carries every fit form the reading view has', () => {
    const cases = {
      'fit-page': 'fitPage',
      'fit-visible': 'fitPage',
      'fit-width': 'fitWidth',
      'fit-height': 'fitHeight',
    } as const;
    for (const [zoom, mode] of Object.entries(cases)) {
      expect(initialViewPlan(view({ open_page: 2, zoom: zoom as keyof typeof cases })).seed?.state.zoomMode).toBe(mode);
    }
  });

  it('claims exactly the magnifications the reading view reproduces', () => {
    expect([...HONORED_ZOOMS].sort()).toEqual(['fit-height', 'fit-page', 'fit-visible', 'fit-width', 'percent']);
    expect(HONORED_ZOOMS).not.toContain('custom');
    expect(HONORED_ZOOMS).not.toContain('default');
  });

  it('states no zoom for a stored view rectangle or an unstated magnification', () => {
    for (const zoom of ['custom', 'default'] as const) {
      expect(initialViewPlan(view({ open_page: 2, zoom })).seed?.state).toEqual({ page: 2 });
    }
  });

  it('carries the opening page in the plan and in the seed', () => {
    const plan = initialViewPlan(view({ open_page: 4 }));
    expect(plan.page).toBe(4);
    expect(plan.seed).toEqual({ state: { page: 4 }, columnsHint: null });
  });

  it('always states the direction, so a previous document cannot leave a spread reversed', () => {
    expect(initialViewPlan(view({ direction: 'R2L' })).spreadDirection).toBe('r2l');
    expect(initialViewPlan(view({ direction: 'L2R' })).spreadDirection).toBe('l2r');
  });
});

describe('planIsInert', () => {
  it('is inert for an ordinary document whose direction already matches', () => {
    expect(planIsInert(initialViewPlan(view()), 'l2r')).toBe(true);
  });

  it('is not inert when the direction differs', () => {
    expect(planIsInert(initialViewPlan(view()), 'r2l')).toBe(false);
  });

  it('is not inert when the document names an opening page alone', () => {
    expect(planIsInert(initialViewPlan(view({ open_page: 4 })), 'l2r')).toBe(false);
  });

  it('is not inert when the document states a layout alone', () => {
    expect(planIsInert(initialViewPlan(view({ page_layout: 'two-page-left' })), 'l2r')).toBe(false);
  });
});

describe('planMovesWorkbench', () => {
  it('ignores the reading-view half', () => {
    const plan = initialViewPlan(view({ page_layout: 'two-page-left', open_page: 3, zoom: 'fit-width' }));
    expect(planMovesWorkbench(plan, 'l2r')).toBe(false);
  });

  it('moves for a direction, a nav pane or a reading mode', () => {
    expect(planMovesWorkbench(initialViewPlan(view()), 'r2l')).toBe(true);
    expect(planMovesWorkbench(initialViewPlan(view({ page_mode: 'outlines' })), 'l2r')).toBe(true);
    expect(planMovesWorkbench(initialViewPlan(view({ page_mode: 'full-screen' })), 'l2r')).toBe(true);
  });
});

describe('UI_APPLY_INITIAL_VIEW', () => {
  const baseState = () => initialState;

  it('applies direction, pane and reading mode as one act', () => {
    const state = baseState();
    const next = appReducer(state, {
      type: 'UI_APPLY_INITIAL_VIEW',
      plan: initialViewPlan(
        view({ page_layout: 'two-column-right', page_mode: 'outlines', direction: 'R2L' }),
      ),
    });
    expect(next.ui.spreadDirection).toBe('r2l');
    expect(next.ui.navPane.open).toBe(true);
    expect(next.ui.navPane.panel).toBe('bookmarks');
    expect(next.ui.readingMode).toBe(false);
  });

  it('leaves the user’s own settings alone for a document that states nothing', () => {
    let state = baseState();
    state = appReducer(state, { type: 'UI_OPEN_NAV_PANEL', panel: 'layers' });
    const next = appReducer(state, {
      type: 'UI_APPLY_INITIAL_VIEW',
      plan: initialViewPlan(view()),
    });
    expect(next.ui.navPane).toEqual(state.ui.navPane);
    expect(next.ui.readingMode).toBe(state.ui.readingMode);
  });

  it('keeps the pane’s width and its last panel when the document only closes it', () => {
    let state = baseState();
    state = appReducer(state, { type: 'UI_OPEN_NAV_PANEL', panel: 'bookmarks' });
    state = appReducer(state, { type: 'UI_SET_NAV_PANE_WIDTH', width: 320 });
    const next = appReducer(state, {
      type: 'UI_APPLY_INITIAL_VIEW',
      plan: initialViewPlan(view({ page_mode: 'none' })),
    });
    expect(next.ui.navPane.open).toBe(false);
    expect(next.ui.navPane.panel).toBe('bookmarks');
    expect(next.ui.navPane.width).toBe(320);
  });

  it('enters reading mode for a full-screen document', () => {
    const next = appReducer(baseState(), {
      type: 'UI_APPLY_INITIAL_VIEW',
      plan: initialViewPlan(view({ page_mode: 'full-screen' })),
    });
    expect(next.ui.readingMode).toBe(true);
    expect(next.ui.navPane.open).toBe(false);
  });
});
