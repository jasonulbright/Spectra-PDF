// Sizing for the inline page-number fields (bookmark rows and any other
// per-row page target editor). The width follows the document's page count so
// a 5-digit total is not clipped; it is never a constant derived from one
// document. The digit count is uncapped: the renderer opens any page count
// pdf.js can index (the engine's 50 000-page validate guard gates engine ops
// only), so a cap would clip the widest page number of a larger document.

/**
 * Non-glyph width of the editable field: horizontal padding (4px + 4px) plus
 * both borders (1px + 1px) plus 4px of slack, so the last digit never touches
 * the border at any renderer rounding.
 */
const FIELD_CHROME_PX = 14;

/** The read-only label carries padding only (2px + 2px) plus 2px of slack. */
const LABEL_CHROME_PX = 6;

/** Decimal digits needed to render any page number in a document of `pageCount` pages. */
export function pageDigits(pageCount: number): number {
  if (!Number.isFinite(pageCount)) return 1;
  const n = Math.floor(pageCount);
  if (n <= 1) return 1;
  return String(n).length;
}

/**
 * CSS width for the page-number input. `ch` is the advance of "0", so the
 * field's font must be tabular for this to hold — `.bookmark-page-input` sets
 * `font-variant-numeric: tabular-nums`. Native spinners are suppressed in CSS
 * (arrow keys still step the value), so nothing overlays the digits.
 */
export function pageFieldWidth(pageCount: number): string {
  return `calc(${pageDigits(pageCount)}ch + ${FIELD_CHROME_PX}px)`;
}

/** CSS min-width for the greyed source-page label shown beside the input. */
export function pageLabelWidth(pageCount: number): string {
  return `calc(${pageDigits(pageCount)}ch + ${LABEL_CHROME_PX}px)`;
}
