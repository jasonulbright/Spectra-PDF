// Reading-view state: three independent axes plus a zoom value, held per
// document per pane. Leaf module: types and constants only.

export type ZoomMode = 'custom' | 'actual' | 'fitPage' | 'fitWidth' | 'fitHeight';
/** `grid` is the responsive grid: the column count follows the pane width. */
export type LayoutMode = 'single' | 'grid';
export type ScrollMode = 'continuous' | 'paged';
export type ReadingPaneId = 'a' | 'b' | 'c' | 'd';

export const ZOOM_MODES: readonly ZoomMode[] = ['custom', 'actual', 'fitPage', 'fitWidth', 'fitHeight'];
export const LAYOUT_MODES: readonly LayoutMode[] = ['single', 'grid'];
export const SCROLL_MODES: readonly ScrollMode[] = ['continuous', 'paged'];
export const READING_PANE_IDS: readonly ReadingPaneId[] = ['a', 'b', 'c', 'd'];

/** localStorage key of the per-document view history. Shared across windows,
 * never suffixed with a window label. */
export const VIEW_HISTORY_KEY = 'spectra-view-history';

/** The range of `ReadingViewState.zoomPercent`. */
export const READING_ZOOM_PERCENT_MIN = 1;
export const READING_ZOOM_PERCENT_MAX = 6400;

export interface ReadingViewState {
  zoomMode: ZoomMode;
  /** Percent of ACTUAL size of `page` (100 = 1 pt per CSS px), 1..6400.
   * Authoritative for `custom`; for the other modes it is the last resolved
   * value and is informational only. */
  zoomPercent: number;
  layoutMode: LayoutMode;
  /** Grid only: page 1 alone on the first row. */
  coverAlone: boolean;
  scrollMode: ScrollMode;
  /** 1-based, within the focused document. A page NUMBER, never a page id. */
  page: number;
}

export interface ReadingViewSnapshot extends ReadingViewState {
  /** Resolved responsive column count (1 in `single`). */
  columns: number;
  pageCount: number;
  /** 0-based position of the shown document among its file's documents (a
   * .pdfx partition); 0 for an ordinary PDF. Live views are keyed by it, so
   * one partition never opens with another's page. */
  docIndex: number;
}

/** A document's own initial view, mapped onto the reading-view axes. */
export interface ReadingViewSeed {
  /** Only the axes the document states. */
  state: Partial<ReadingViewState>;
  /** A two-column or two-page layout with no stated zoom asks for 2 columns. */
  columnsHint: number | null;
}

export const DEFAULT_READING_VIEW: ReadingViewState = {
  zoomMode: 'fitPage',
  zoomPercent: 100,
  layoutMode: 'single',
  coverAlone: false,
  scrollMode: 'continuous',
  page: 1,
};
