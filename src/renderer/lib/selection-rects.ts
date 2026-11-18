import type { RectLike } from './text-selection-markup';

/** A text rect with the direction its text runs on screen. */
export interface TextRect extends RectLike {
  /** True when the text runs mostly up or down the screen (a column). */
  vertical: boolean;
}

/** The rect of one character of a text node. */
const charRect = (node: Text, index: number): DOMRect | null => {
  const r = document.createRange();
  r.setStart(node, index);
  r.setEnd(node, index + 1);
  const rects = r.getClientRects();
  return rects.length > 0 ? rects[0] : null;
};

/**
 * Which way a text node runs on screen, from where its own first and last
 * characters sit. The layout says it all at once: the page's turn, the text
 * layer's turn and a span's own angle (`--rotate`) all end up in the rects, so
 * there is nothing to add up. Null when the node is too short to tell.
 */
function runsVertically(node: Text, from: number, to: number): boolean | null {
  if (to - from < 2) return null;
  const a = charRect(node, from);
  const b = charRect(node, to - 1);
  if (!a || !b) return null;
  const dx = Math.abs(b.left + b.width / 2 - (a.left + a.width / 2));
  const dy = Math.abs(b.top + b.height / 2 - (a.top + a.height / 2));
  if (dx === 0 && dy === 0) return null;
  return dy > dx;
}

/**
 * The client rects of the TEXT in a selection range, and only text inside a
 * page's text layer.
 *
 * `Range.getClientRects()` also returns the border box of every element that
 * lies wholly inside the range: the raster of the next page, an annotation
 * layer, a link region. Those are not selected text, and a redaction mark made
 * from one would cover content nobody selected. So this walks the text nodes,
 * cuts each to the ends of the range, and asks for the rects of that piece.
 *
 * `within` limits the text to one page element. A document shown in two panes
 * mounts the same page twice, and a page scrolled out of one pane can sit
 * behind the other, so on-screen position alone cannot say whose text it is.
 *
 * Each rect carries the direction its text runs (see `runsVertically`). A node
 * of one character takes the direction of the rest of the selection, then the
 * shape of its rect.
 */
export function textLayerRects(range: Range, within?: Element | null): TextRect[] {
  const root: Node = range.commonAncestorContainer;
  const nodes: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) {
    nodes.push(root as Text);
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (range.intersectsNode(n)) nodes.push(n as Text);
    }
  }
  const pieces: { rects: DOMRect[]; vertical: boolean | null }[] = [];
  for (const node of nodes) {
    if (!node.parentElement?.closest('.textLayer')) continue;
    if (within && !within.contains(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.length;
    const piece = document.createRange();
    piece.setStart(node, from);
    piece.setEnd(node, to);
    if (piece.collapsed) continue;
    pieces.push({ rects: Array.from(piece.getClientRects()), vertical: runsVertically(node, from, to) });
  }
  // A one-character piece follows the other pieces; with none to follow, its own shape.
  const known = pieces.filter((p) => p.vertical !== null);
  const majority = known.length > 0 ? known.filter((p) => p.vertical).length * 2 > known.length : null;
  const out: TextRect[] = [];
  for (const p of pieces) {
    for (const r of p.rects) {
      const vertical = p.vertical ?? majority ?? r.bottom - r.top > r.right - r.left;
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, vertical });
    }
  }
  return out;
}
