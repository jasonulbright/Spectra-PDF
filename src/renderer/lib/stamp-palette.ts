/** The ink colours a page stamp can be drawn in — watermarks, headers and
 * footers, and anything else the product writes onto the page as furniture.
 *
 * ONE list, because a colour picker is a language and three pickers offering
 * three different four-colour palettes teach nothing. The audit found exactly
 * that: white / grey-blue / red / blue in one panel and grey / red / blue /
 * green in another, so "the second swatch" meant a different colour depending
 * on which tool the reader had open.
 *
 * This is deliberately NOT `ANNOTATION_PALETTE`. Annotation hues exist to be
 * seen AS markup; stamp ink is meant to sit on the page as part of it, so the
 * two ends of the list are a near-black and a mid grey rather than a
 * highlighter yellow. A panel keeps its own DEFAULT — a watermark that
 * defaults to grey and a footer that defaults to near-black are both right —
 * and takes the choices from here.
 */
export const STAMP_PALETTE: readonly string[] = [
  '#16161a', // near-black
  '#5b6270', // slate
  '#808080', // mid grey
  '#e0393e', // red
  '#2f6fed', // blue
  '#2fbf71', // green
];
