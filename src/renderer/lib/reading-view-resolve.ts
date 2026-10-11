// Which view a reading pane opens with, and how a document's own initial view
// maps onto the reading-view axes. Pure: no storage, no DOM, no app state.

import type { Settings } from './app-settings';
import type { InitialView, PageLayoutValue, ZoomValue } from './initial-view';
import {
  READING_ZOOM_PERCENT_MAX,
  READING_ZOOM_PERCENT_MIN,
  type ReadingViewSeed,
  type ReadingViewSnapshot,
  type ReadingViewState,
} from './reading-view-types';
import type { ViewHistoryRecord } from './view-history';

export type OpeningViewSource = 'live' | 'sibling' | 'saved' | 'defaults';

function clampPage(page: number, pageCount: number): number {
  const last = Math.max(1, Math.floor(Number.isFinite(pageCount) ? pageCount : 1));
  if (!Number.isFinite(page)) return 1;
  return Math.min(last, Math.max(1, Math.floor(page)));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(READING_ZOOM_PERCENT_MAX, Math.max(READING_ZOOM_PERCENT_MIN, value));
}

function stateOf(s: ReadingViewState): ReadingViewState {
  return {
    zoomMode: s.zoomMode,
    zoomPercent: s.zoomPercent,
    layoutMode: s.layoutMode,
    coverAlone: s.coverAlone,
    scrollMode: s.scrollMode,
    page: s.page,
  };
}

/** The global opening view from Preferences ▸ Viewing. */
export function defaultsFromSettings(s: Settings): ReadingViewState {
  return {
    zoomMode: s.viewZoomMode,
    zoomPercent: s.viewZoomMode === 'custom' ? clampPercent(s.viewZoomPercent) : 100,
    layoutMode: s.viewLayoutMode,
    coverAlone: false,
    scrollMode: s.viewScrollMode,
    page: 1,
  };
}

export interface OpeningViewInput {
  /** This pane's own live snapshot: a remount within the session. */
  live: ReadingViewSnapshot | null;
  /** Pane a's live snapshot, consulted for a new split pane only. */
  siblingLive: ReadingViewSnapshot | null;
  saved: ViewHistoryRecord | null;
  defaults: ReadingViewState;
  pageCount: number;
  /** The document being opened within its file. A saved row for another
   * document of the same file restores the axes but not its page number. */
  docIndex?: number;
}

/** Live, then the sibling pane, then the saved row, then the defaults. The
 * page is always clamped to the current page count. */
export function resolveOpeningView(i: OpeningViewInput): {
  state: ReadingViewState;
  source: OpeningViewSource;
} {
  const pick = (s: ReadingViewState, source: OpeningViewSource) => ({
    state: { ...stateOf(s), page: clampPage(s.page, i.pageCount) },
    source,
  });
  if (i.live) return pick(i.live, 'live');
  if (i.siblingLive) return pick(i.siblingLive, 'sibling');
  if (i.saved) {
    const samePart = (i.docIndex ?? 0) === i.saved.docIndex;
    return pick(
      {
        zoomMode: i.saved.zoomMode,
        zoomPercent: clampPercent(i.saved.zoomPercent),
        layoutMode: i.saved.layoutMode,
        coverAlone: i.saved.coverAlone,
        scrollMode: i.saved.scrollMode,
        page: samePart ? i.saved.page : 1,
      },
      'saved',
    );
  }
  return pick(i.defaults, 'defaults');
}

// ISO 32000-2 §7.7.2 Table 29 (PageLayout). "…Right" places odd pages on the
// right, which in a grid is page 1 alone on the first row.
const LAYOUT_SEED: Record<
  Exclude<PageLayoutValue, 'default'>,
  Pick<ReadingViewState, 'layoutMode' | 'scrollMode' | 'coverAlone'>
> = {
  'single-page': { layoutMode: 'single', scrollMode: 'paged', coverAlone: false },
  'one-column': { layoutMode: 'single', scrollMode: 'continuous', coverAlone: false },
  'two-column-left': { layoutMode: 'grid', scrollMode: 'continuous', coverAlone: false },
  'two-column-right': { layoutMode: 'grid', scrollMode: 'continuous', coverAlone: true },
  'two-page-left': { layoutMode: 'grid', scrollMode: 'paged', coverAlone: false },
  'two-page-right': { layoutMode: 'grid', scrollMode: 'paged', coverAlone: true },
};

// ISO 32000-2 §12.3.2.2 Table 149, as the engine names the destination forms:
// Fit → fit-page, FitH/FitBH → fit-width, FitV/FitBV → fit-height,
// FitB → fit-visible, XYZ with a positive zoom → percent, FitR → custom.
// FitR and an XYZ without a zoom state no magnification this view reproduces.
const ZOOM_SEED: Partial<Record<ZoomValue, ReadingViewState['zoomMode']>> = {
  'fit-page': 'fitPage',
  'fit-visible': 'fitPage',
  'fit-width': 'fitWidth',
  'fit-height': 'fitHeight',
};

/** A document's initial view as a seed carrying only the axes it states, or
 * null when it states none. */
export function seedFromInitialView(v: InitialView): ReadingViewSeed | null {
  const state: Partial<ReadingViewState> = {};
  const layout = v.page_layout === 'default' ? null : LAYOUT_SEED[v.page_layout];
  if (layout) Object.assign(state, layout);
  const fit = ZOOM_SEED[v.zoom];
  if (fit) {
    state.zoomMode = fit;
  } else if (v.zoom === 'percent' && v.zoom_percent !== null && Number.isFinite(v.zoom_percent) && v.zoom_percent > 0) {
    state.zoomMode = 'custom';
    state.zoomPercent = clampPercent(v.zoom_percent);
  }
  if (v.open_page !== null && Number.isFinite(v.open_page) && v.open_page >= 1) {
    state.page = v.pages > 0 ? clampPage(v.open_page, v.pages) : Math.floor(v.open_page);
  }
  if (Object.keys(state).length === 0) return null;
  const columnsHint = layout?.layoutMode === 'grid' && state.zoomMode === undefined ? 2 : null;
  return { state, columnsHint };
}

/** The history row for a pane's settled view. */
export function recordFromSnapshot(s: ReadingViewSnapshot, docIndex: number, now: number): ViewHistoryRecord {
  return {
    page: clampPage(s.page, s.pageCount),
    docIndex: Number.isFinite(docIndex) ? Math.max(0, Math.floor(docIndex)) : 0,
    zoomMode: s.zoomMode,
    zoomPercent: clampPercent(s.zoomPercent),
    layoutMode: s.layoutMode,
    coverAlone: s.coverAlone,
    scrollMode: s.scrollMode,
    pageCount: Number.isFinite(s.pageCount) ? Math.max(0, Math.floor(s.pageCount)) : 0,
    savedAt: now,
  };
}
