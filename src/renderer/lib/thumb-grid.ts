/**
 * The Pages panel's layout math: how many thumbnail columns a given panel
 * width carries, where each page sits, and which slot a pointer is over.
 *
 * The panel was a fixed single column at any width, so widening the pane only
 * grew one thumbnail until it hit its height cap and then added empty band on
 * both sides — the pane resized and the panel did not use it. The arithmetic
 * lives here rather than in the component because there is no DOM test
 * environment, and every one of these numbers feeds a drag that moves pages.
 */

/** Height of one row: thumbnail area plus the page-number label. */
export const ROW_H = 172;
/** Horizontal padding inside the scroller, per side. */
export const SIDE_PAD = 16;
/** Narrowest a column may be before a column is dropped instead. Below this a
 * thumbnail is too small to tell two pages apart, which is the panel's only
 * job. */
export const MIN_COL_W = 124;

export interface ThumbGrid {
  columns: number;
  /** Width of one column, including its share of the leftover space. */
  columnWidth: number;
  rows: number;
}

export function thumbGrid(viewportWidth: number, count: number): ThumbGrid {
  const available = Math.max(MIN_COL_W, viewportWidth - SIDE_PAD * 2);
  const columns = Math.max(1, Math.floor(available / MIN_COL_W));
  return {
    columns,
    columnWidth: available / columns,
    rows: Math.ceil(Math.max(0, count) / columns),
  };
}

/** Where item `index` sits, in scroller coordinates. */
export function thumbSlot(
  index: number,
  grid: ThumbGrid,
): { top: number; left: number; width: number } {
  const row = Math.floor(index / grid.columns);
  const col = index % grid.columns;
  return {
    top: row * ROW_H,
    left: SIDE_PAD + col * grid.columnWidth,
    width: grid.columnWidth,
  };
}

/** The half-open range of item indices a scroll window covers, padded by
 * `overscan` ROWS on each side. */
export function thumbWindow(
  scrollTop: number,
  viewportHeight: number,
  grid: ThumbGrid,
  count: number,
  overscan: number,
): { start: number; end: number } {
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
  const lastRow = Math.ceil((scrollTop + viewportHeight) / ROW_H) + overscan;
  return {
    start: Math.min(count, firstRow * grid.columns),
    end: Math.min(count, Math.max(0, lastRow * grid.columns)),
  };
}

/**
 * The INSERTION index a pointer names — 0..count, the gaps between items, not
 * the items themselves. Reading order: a pointer past the last column of a row
 * names the gap before the next row's first item, which is the same position
 * the drop indicator draws.
 */
export function thumbDropIndex(
  x: number,
  y: number,
  grid: ThumbGrid,
  count: number,
): number {
  const row = Math.max(0, Math.floor(y / ROW_H));
  const within = (x - SIDE_PAD) / grid.columnWidth;
  const col = Math.max(0, Math.min(grid.columns, Math.round(within)));
  return Math.max(0, Math.min(count, row * grid.columns + col));
}
