// Redaction marks from a text selection (issue 110).
//
// The reading view lays pdf.js's text layer over the page, so the browser
// already knows the selection as a Range. `Range.getClientRects()` returns one
// rect per text fragment, and fragments of one line differ a little in height
// (a bold word, a larger font). A hand-drawn band has the same problem, and the
// reporter's complaint was that marks on a text-heavy page looked untidy. So
// the fragments of one line are merged into ONE mark per line, with the line's
// own top and bottom.
//
// Pure: client rects in, page-normalized rects out, in the same frame the
// drawn band uses (fractions of the page element's box), so both producers
// travel the one `onAddRedactionMark` path.
import { quadFromRect, type RectLike } from './text-selection-markup';

export interface MarkRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Line {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Two fragments are on one line when they overlap vertically by at least this
 *  share of the shorter one. Line boxes of neighbouring lines touch or overlap
 *  by a hair; half a fragment is far from that. */
const SAME_LINE_OVERLAP = 0.5;

const sameLine = (line: Line, q: number[]): boolean => {
  const overlap = Math.min(line.y1, q[3]) - Math.max(line.y0, q[1]);
  if (overlap <= 0) return false;
  const shorter = Math.min(line.y1 - line.y0, q[3] - q[1]);
  return overlap >= shorter * SAME_LINE_OVERLAP;
};

/**
 * One mark per text line of the selection, inside the page box.
 *
 * `rects` are `Range.getClientRects()` values; `box` is the page element's
 * client rect. Rects whose centre lies outside the box belong to another page
 * and are skipped, so every page can call this with the whole selection.
 */
export function redactionRectsFromSelection(rects: RectLike[], box: RectLike): MarkRect[] {
  const quads: number[][] = [];
  for (const r of rects) {
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
    const quad = quadFromRect(r, box);
    if (quad) quads.push(quad);
  }
  // Top to bottom, then left to right, so a line is built in one pass.
  quads.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines: Line[] = [];
  for (const q of quads) {
    const line = lines.find((l) => sameLine(l, q));
    if (line) {
      line.x0 = Math.min(line.x0, q[0]);
      line.y0 = Math.min(line.y0, q[1]);
      line.x1 = Math.max(line.x1, q[2]);
      line.y1 = Math.max(line.y1, q[3]);
    } else {
      lines.push({ x0: q[0], y0: q[1], x1: q[2], y1: q[3] });
    }
  }
  return lines
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map((l) => ({ x: l.x0, y: l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 }));
}
