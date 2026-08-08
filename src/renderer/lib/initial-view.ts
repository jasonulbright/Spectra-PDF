// The Initial View tab's model: the engine payload, the change set a save
// sends, and the translation from a document's stated initial view into this
// app's own view state.
//
// The rules live here rather than in the dialog because there is no DOM test
// environment — a rule inside a component is a rule with no test.

import type { NavPanelId, PageLayoutMode, SpreadDirection } from '../state/types';

export type PageLayoutValue =
  | 'default'
  | 'single-page'
  | 'one-column'
  | 'two-column-left'
  | 'two-column-right'
  | 'two-page-left'
  | 'two-page-right';

export type PageModeValue =
  | 'default'
  | 'none'
  | 'outlines'
  | 'thumbnails'
  | 'full-screen'
  | 'oc'
  | 'attachments';

export type ZoomValue =
  | 'default'
  | 'fit-page'
  | 'fit-width'
  | 'fit-height'
  | 'fit-visible'
  | 'percent';

export type ReadingDirection = 'L2R' | 'R2L';

export const PAGE_LAYOUT_VALUES: readonly PageLayoutValue[] = [
  'default',
  'single-page',
  'one-column',
  'two-column-left',
  'two-column-right',
  'two-page-left',
  'two-page-right',
];

export const PAGE_MODE_VALUES: readonly PageModeValue[] = [
  'default',
  'none',
  'outlines',
  'thumbnails',
  'full-screen',
  'oc',
  'attachments',
];

export const ZOOM_VALUES: readonly ZoomValue[] = [
  'default',
  'fit-page',
  'fit-width',
  'fit-height',
  'fit-visible',
  'percent',
];

/** The magnification steps the panel offers, matching the engine's accepted
 * range at both ends. */
export const ZOOM_PERCENT_STEPS: readonly number[] = [
  25, 50, 75, 100, 125, 150, 200, 400, 800, 1600, 6400,
];

export const ZOOM_PERCENT_MIN = 1;
export const ZOOM_PERCENT_MAX = 6400;

/** The window options this app writes but its own window cannot obey: they
 * describe a reader's chrome and geometry, and this app's shell is not
 * document-driven. The panel labels them rather than implying an effect. */
export const VIEWER_ONLY_OPTIONS = [
  'hide_toolbar',
  'hide_menubar',
  'hide_window_ui',
  'fit_window',
  'center_window',
  'display_doc_title',
] as const;

export type ViewerOnlyOption = (typeof VIEWER_ONLY_OPTIONS)[number];

/** Magnifications this app's own camera can reproduce. The rest are written
 * to the file and honored by other readers; this app has one absolute-zoom
 * seam and one fit-width seam, so it claims exactly those two. */
export const HONORED_ZOOMS: readonly ZoomValue[] = ['percent', 'fit-width'];

export interface InitialView {
  page_layout: PageLayoutValue;
  page_mode: PageModeValue;
  /** 1-based, or null when the document names no opening page. */
  open_page: number | null;
  zoom: ZoomValue;
  zoom_percent: number | null;
  hide_toolbar: boolean;
  hide_menubar: boolean;
  hide_window_ui: boolean;
  fit_window: boolean;
  center_window: boolean;
  display_doc_title: boolean;
  direction: ReadingDirection;
  /** False when the document's open action is a script: a destination write
   * would destroy it, so the engine refuses and the panel says so up front. */
  open_action_replaceable: boolean;
  pages: number;
}

export const DEFAULT_INITIAL_VIEW: InitialView = {
  page_layout: 'default',
  page_mode: 'default',
  open_page: null,
  zoom: 'default',
  zoom_percent: null,
  hide_toolbar: false,
  hide_menubar: false,
  hide_window_ui: false,
  fit_window: false,
  center_window: false,
  display_doc_title: false,
  direction: 'L2R',
  open_action_replaceable: true,
  pages: 0,
};

/** Read an engine payload into the model, replacing anything unrecognized with
 * its default — an engine that grows a value this build does not know must not
 * put an out-of-range string into a select. */
export function parseInitialView(raw: Record<string, unknown>): InitialView {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = raw[key];
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  };
  const bool = (key: string): boolean => raw[key] === true;
  const page = typeof raw.open_page === 'number' && raw.open_page >= 1 ? raw.open_page : null;
  const percent =
    typeof raw.zoom_percent === 'number' && Number.isFinite(raw.zoom_percent)
      ? raw.zoom_percent
      : null;
  return {
    page_layout: pick('page_layout', PAGE_LAYOUT_VALUES, 'default'),
    page_mode: pick('page_mode', PAGE_MODE_VALUES, 'default'),
    open_page: page,
    zoom: pick('zoom', ZOOM_VALUES, 'default'),
    zoom_percent: percent,
    hide_toolbar: bool('hide_toolbar'),
    hide_menubar: bool('hide_menubar'),
    hide_window_ui: bool('hide_window_ui'),
    fit_window: bool('fit_window'),
    center_window: bool('center_window'),
    display_doc_title: bool('display_doc_title'),
    direction: pick<ReadingDirection>('direction', ['L2R', 'R2L'], 'L2R'),
    open_action_replaceable: raw.open_action_replaceable !== false,
    pages: typeof raw.pages === 'number' ? raw.pages : 0,
  };
}

/** The `set_initial_view` parameters that carry `next` from `base`, or null
 * when nothing changed. Only what MOVED is sent: every engine parameter is
 * none-means-unchanged, so an untouched key is never rewritten. */
export function initialViewChanges(
  base: InitialView,
  next: InitialView,
): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};
  if (next.page_layout !== base.page_layout) params.page_layout = next.page_layout;
  if (next.page_mode !== base.page_mode) params.page_mode = next.page_mode;

  const pageMoved = next.open_page !== base.open_page;
  const zoomMoved =
    next.zoom !== base.zoom ||
    (next.zoom === 'percent' && next.zoom_percent !== base.zoom_percent);
  if (pageMoved || zoomMoved) {
    // The opening page and its magnification are ONE destination, so a zoom
    // change alone still has to name the page it applies to. Zero removes the
    // open action, which is what "no opening page" means.
    params.open_page = next.open_page ?? 0;
    if (next.open_page !== null) {
      params.zoom = next.zoom;
      if (next.zoom === 'percent') params.zoom_percent = next.zoom_percent ?? 100;
    }
  }

  for (const key of VIEWER_ONLY_OPTIONS) {
    if (next[key] !== base[key]) params[key] = next[key];
  }
  if (next.direction !== base.direction) params.direction = next.direction;
  return Object.keys(params).length > 0 ? params : null;
}

/** How a document's initial view moves this app's own view state. A null
 * field means "the document said nothing" — the workbench keeps what the user
 * had, which is why opening an ordinary PDF does not close their nav pane. */
export interface InitialViewPlan {
  pageLayout: PageLayoutMode | null;
  twoUpCover: boolean | null;
  spreadDirection: SpreadDirection;
  navPane: { open: boolean; panel: NavPanelId | null } | null;
  readingMode: boolean | null;
  /** 1-based opening page, or null. */
  page: number | null;
  /** Magnification as a percentage, or null when this app cannot reproduce
   * the document's chosen form. */
  zoomPercent: number | null;
  /** The document asked for fit-width, which this app's reading view has. */
  fitWidth: boolean;
}

const LAYOUT_PLAN: Record<
  Exclude<PageLayoutValue, 'default'>,
  { pageLayout: PageLayoutMode; twoUpCover: boolean }
> = {
  'single-page': { pageLayout: 'single', twoUpCover: false },
  'one-column': { pageLayout: 'single', twoUpCover: false },
  'two-column-left': { pageLayout: 'two', twoUpCover: false },
  'two-page-left': { pageLayout: 'two', twoUpCover: false },
  // "…Right" means odd-numbered pages sit on the right, which is the bound-book
  // convention this app spells as a cover page alone.
  'two-column-right': { pageLayout: 'two', twoUpCover: true },
  'two-page-right': { pageLayout: 'two', twoUpCover: true },
};

const MODE_PANEL: Record<Exclude<PageModeValue, 'default' | 'none' | 'full-screen'>, NavPanelId> = {
  outlines: 'bookmarks',
  thumbnails: 'pages',
  oc: 'layers',
  attachments: 'attachments',
};

export function initialViewPlan(view: InitialView): InitialViewPlan {
  const layout = view.page_layout === 'default' ? null : LAYOUT_PLAN[view.page_layout];
  let navPane: InitialViewPlan['navPane'] = null;
  let readingMode: boolean | null = null;
  if (view.page_mode === 'none') {
    navPane = { open: false, panel: null };
    readingMode = false;
  } else if (view.page_mode === 'full-screen') {
    navPane = { open: false, panel: null };
    readingMode = true;
  } else if (view.page_mode !== 'default') {
    navPane = { open: true, panel: MODE_PANEL[view.page_mode] };
    readingMode = false;
  }
  const percent =
    view.open_page !== null && view.zoom === 'percent' && view.zoom_percent !== null
      ? view.zoom_percent
      : null;
  return {
    pageLayout: layout?.pageLayout ?? null,
    twoUpCover: layout?.twoUpCover ?? null,
    // Every document has a reading direction (absent means L2R), so this is
    // always stated: a spread left reversed by the previous document would be
    // a stale window, not a preserved preference.
    spreadDirection: view.direction === 'R2L' ? 'r2l' : 'l2r',
    navPane,
    readingMode,
    page: view.open_page,
    zoomPercent: percent,
    fitWidth: view.open_page !== null && view.zoom === 'fit-width',
  };
}

/** Whether a plan would change anything at all — an ordinary PDF's plan moves
 * only the spread direction, and re-stating the direction it already has is
 * not a reason to touch the workbench. */
export function planIsInert(plan: InitialViewPlan, currentDirection: SpreadDirection): boolean {
  return (
    plan.pageLayout === null &&
    plan.navPane === null &&
    plan.readingMode === null &&
    plan.page === null &&
    plan.spreadDirection === currentDirection
  );
}
