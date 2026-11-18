import type { RectLike } from './text-selection-markup';

/**
 * The client rects of the TEXT in a selection range, and only text inside a
 * page's text layer.
 *
 * `Range.getClientRects()` also returns the border box of every element that
 * lies wholly inside the range: the raster of the next page, an annotation
 * layer, a link region. Those are not selected text, and a redaction mark made
 * from one would cover content nobody selected. So this walks the text nodes,
 * cuts each to the ends of the range, and asks for the rects of that piece.
 * `vertical` is true when the text layer is turned a quarter-turn.
 *
 * `within` limits the text to one page element. A document shown in two panes
 * mounts the same page twice, and a page scrolled out of one pane can sit
 * behind the other, so on-screen position alone cannot say whose text it is.
 */
export function textLayerRects(
  range: Range,
  within?: Element | null,
): { rects: RectLike[]; vertical: boolean } {
  const out: RectLike[] = [];
  let vertical = false;
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
  for (const node of nodes) {
    if (!node.parentElement?.closest('.textLayer')) continue;
    if (within && !within.contains(node)) continue;
    // A page turned a quarter-turn lays its lines out as columns on screen.
    const turn = node.parentElement.closest<HTMLElement>('.textLayer')?.dataset.mainRotation;
    if (turn === '90' || turn === '270') vertical = true;
    const piece = document.createRange();
    piece.selectNodeContents(node);
    if (node === range.startContainer) piece.setStart(node, range.startOffset);
    if (node === range.endContainer) piece.setEnd(node, range.endOffset);
    if (piece.collapsed) continue;
    for (const r of piece.getClientRects()) {
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return { rects: out, vertical };
}
