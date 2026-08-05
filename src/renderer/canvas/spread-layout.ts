// Two-up spread layout math (I.6 view-mode tail) — PURE, because the reading
// column's virtualizer/jump/current-page machinery is the most regression-prone
// surface in the app and every mapping here must be testable without a DOM.
//
// The reading view lays pages in uniform-height ROWS. Single layout: one page
// per row (the shipped behavior — every function below is the identity for it,
// so single mode cannot regress by construction). Two-up: two facing pages per
// row, optionally with the first page alone to follow the bound-book convention,
// so spreads pair as (2,3), (4,5)…
// exactly like a bound book's verso/recto.

export type PageLayout = 'single' | 'two';

/** How many rows a document occupies. */
export function rowCountOf(pageCount: number, layout: PageLayout, coverAlone: boolean): number {
  if (pageCount <= 0) return 0;
  if (layout === 'single') return pageCount;
  if (!coverAlone) return Math.ceil(pageCount / 2);
  return 1 + Math.ceil((pageCount - 1) / 2);
}

/** The row a page (0-based) sits in. */
export function rowOfPage(pageIndex: number, layout: PageLayout, coverAlone: boolean): number {
  if (layout === 'single') return pageIndex;
  if (!coverAlone) return Math.floor(pageIndex / 2);
  return pageIndex === 0 ? 0 : Math.ceil(pageIndex / 2);
}

/** The 0-based page indexes a row shows, in reading order (1 or 2 entries). */
export function pagesInRow(
  row: number,
  layout: PageLayout,
  coverAlone: boolean,
  pageCount: number,
): number[] {
  if (row < 0 || pageCount <= 0) return [];
  if (layout === 'single') return row < pageCount ? [row] : [];
  let firstPage: number;
  if (!coverAlone) {
    firstPage = row * 2;
  } else if (row === 0) {
    return [0];
  } else {
    firstPage = row * 2 - 1;
  }
  const out: number[] = [];
  if (firstPage < pageCount) out.push(firstPage);
  if (firstPage + 1 < pageCount) out.push(firstPage + 1);
  return out;
}
