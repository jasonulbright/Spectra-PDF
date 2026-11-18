// Redaction marks from a text selection (issue 110).
//
// The reading view lays pdf.js's text layer over the page, so the browser
// already knows the selection as a Range. The rects of the TEXT in that range
// (see `textLayerRects`) are one per text fragment, and fragments of one line
// differ a little in height (a bold word, a larger font). A hand-drawn band has
// the same problem, and the reporter's complaint was that marks on a text-heavy
// page looked untidy. So the fragments of one line are merged into ONE mark per
// line, with the line's own extent.
//
// Text can run across the page too: a page turned a quarter-turn shows each
// line as a tall, narrow column. The caller says so (`vertical`), from the text
// layer's own rotation. The shape of a fragment cannot say: a bullet or a
// one-glyph fragment is taller than wide on an upright page. Vertical lines
// group by overlap across the page's width, horizontal ones by overlap across
// its height.
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
  vertical: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Two fragments are on one line when they overlap, across the line, by at
 *  least this share of the shorter one. Line boxes of neighbouring lines touch
 *  or overlap by a hair; half a fragment is far from that. */
const SAME_LINE_OVERLAP = 0.5;

/** A merged line may cover at most this multiple of the area of the fragments
 *  it holds. Fragments of one line sit side by side, so the union is about the
 *  sum. A union far larger means the fragments are not one line (rotated or
 *  diagonal text), and merging them would cover text nobody selected. */
const MAX_UNION_FILL = 2;

/** A single fragment bigger than this share of the page is an element box (an
 *  image, a container), not text. */
const MAX_FRAGMENT_AREA = 0.5;

const area = (x0: number, y0: number, x1: number, y1: number): number => (x1 - x0) * (y1 - y0);

const overlapAcross = (line: Line, q: number[]): number => {
  const [a0, a1, b0, b1] = line.vertical
    ? [line.x0, line.x1, q[0], q[2]]
    : [line.y0, line.y1, q[1], q[3]];
  const overlap = Math.min(a1, b1) - Math.max(a0, b0);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a1 - a0, b1 - b0);
};

/**
 * One mark per text line of the selection, inside the page box.
 *
 * `rects` are the client rects of the selected text; `box` is the page
 * element's client rect. Rects whose centre lies outside the box belong to
 * another page and are skipped, so every page can call this with the whole
 * selection.
 */
export function redactionRectsFromSelection(
  rects: RectLike[],
  box: RectLike,
  vertical = false,
): MarkRect[] {
  const quads: { q: number[] }[] = [];
  for (const r of rects) {
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
    const q = quadFromRect(r, box);
    if (!q || area(q[0], q[1], q[2], q[3]) > MAX_FRAGMENT_AREA) continue;
    quads.push({ q });
  }
  // Reading order for each direction, so a line is built in one pass.
  quads.sort((a, b) =>
    vertical ? a.q[0] - b.q[0] || a.q[1] - b.q[1] : a.q[1] - b.q[1] || a.q[0] - b.q[0],
  );
  const lines: Line[] = [];
  for (const { q } of quads) {
    const line = lines.find((l) => {
      if (overlapAcross(l, q) < SAME_LINE_OVERLAP) return false;
      const ux0 = Math.min(l.x0, q[0]);
      const uy0 = Math.min(l.y0, q[1]);
      const ux1 = Math.max(l.x1, q[2]);
      const uy1 = Math.max(l.y1, q[3]);
      const held = area(l.x0, l.y0, l.x1, l.y1) + area(q[0], q[1], q[2], q[3]);
      return area(ux0, uy0, ux1, uy1) <= held * MAX_UNION_FILL;
    });
    if (line) {
      line.x0 = Math.min(line.x0, q[0]);
      line.y0 = Math.min(line.y0, q[1]);
      line.x1 = Math.max(line.x1, q[2]);
      line.y1 = Math.max(line.y1, q[3]);
    } else {
      lines.push({ vertical, x0: q[0], y0: q[1], x1: q[2], y1: q[3] });
    }
  }
  return lines
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map((l) => ({ x: l.x0, y: l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 }));
}

/** Marks that no existing mark already covers, within a small tolerance. A word
 *  then a line, or the same text twice, adds nothing the second time. */
export function marksNotCovered(marks: MarkRect[], existing: MarkRect[], tolerance = 0.003): MarkRect[] {
  return marks.filter(
    (m) =>
      !existing.some(
        (e) =>
          e.x <= m.x + tolerance &&
          e.y <= m.y + tolerance &&
          e.x + e.w >= m.x + m.w - tolerance &&
          e.y + e.h >= m.y + m.h - tolerance,
      ),
  );
}
