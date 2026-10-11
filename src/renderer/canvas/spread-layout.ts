// Row layout math for the reading view — PURE, because the reading column's
// virtualizer/jump/current-page machinery is the most regression-prone surface
// in the app and every mapping here must be testable without a DOM.
//
// The reading view lays pages in uniform-height ROWS of `columns` pages each.
// One column is the identity (row r holds page r), so the single-page column
// cannot regress by construction. With more than one column, `coverAlone`
// puts page 0 by itself on the first row and the rest follow in groups of
// `columns`, so two columns pair (1,2), (3,4)… like a bound book's
// verso/recto. With one column `coverAlone` is inert.

/** Whether page 0 sits alone on row 0 under this column count. */
export function coverActive(columns: number, coverAlone: boolean): boolean {
  return coverAlone && columns > 1;
}

function cols(columns: number): number {
  return Math.max(1, Math.floor(columns));
}

/** How many rows a document occupies. */
export function rowCountOf(pageCount: number, columns: number, coverAlone: boolean): number {
  if (pageCount <= 0) return 0;
  const c = cols(columns);
  if (!coverActive(c, coverAlone)) return Math.ceil(pageCount / c);
  return 1 + Math.ceil((pageCount - 1) / c);
}

/** The row a page (0-based) sits in. */
export function rowOfPage(pageIndex: number, columns: number, coverAlone: boolean): number {
  const c = cols(columns);
  if (!coverActive(c, coverAlone)) return Math.floor(pageIndex / c);
  return pageIndex <= 0 ? 0 : 1 + Math.floor((pageIndex - 1) / c);
}

/** The 0-based page indexes a row shows, in reading order (1..columns entries). */
export function pagesInRow(
  row: number,
  columns: number,
  coverAlone: boolean,
  pageCount: number,
): number[] {
  if (row < 0 || pageCount <= 0) return [];
  const c = cols(columns);
  let firstPage: number;
  let size = c;
  if (!coverActive(c, coverAlone)) {
    firstPage = row * c;
  } else if (row === 0) {
    firstPage = 0;
    size = 1;
  } else {
    firstPage = 1 + (row - 1) * c;
  }
  const out: number[] = [];
  for (let i = firstPage; i < firstPage + size && i < pageCount; i++) out.push(i);
  return out;
}
