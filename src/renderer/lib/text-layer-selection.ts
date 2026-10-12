// A text layer rebuilt over the same page geometry replaces every span the
// browser selection points into, and a selection whose nodes leave the
// document collapses. These helpers carry the selection across the swap as
// character offsets into the layer's text, so a rebuild with unchanged text
// leaves the selection where the user put it.

const TEXT_NODE = 3;

/** The parts of a DOM node the offset walk reads. */
export interface NodeLike {
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<NodeLike>;
}

/** A selection boundary: a text node and a character index, or an element and
 * a child index. */
export interface Boundary<N extends NodeLike = NodeLike> {
  node: N;
  offset: number;
}

function textLength(node: NodeLike): number {
  if (node.nodeType === TEXT_NODE) return node.nodeValue?.length ?? 0;
  let total = 0;
  for (let i = 0; i < node.childNodes.length; i++) total += textLength(node.childNodes[i]);
  return total;
}

/**
 * The character offset of `boundary` in the text of `root`, counting text nodes
 * in document order. Null when the boundary node is not `root` or inside it.
 */
export function textOffsetOf(root: NodeLike, boundary: Boundary): number | null {
  let before = 0;
  const visit = (node: NodeLike): number | null => {
    if (node === boundary.node) {
      if (node.nodeType === TEXT_NODE) return before + Math.min(boundary.offset, node.nodeValue?.length ?? 0);
      let inner = before;
      const end = Math.min(boundary.offset, node.childNodes.length);
      for (let i = 0; i < end; i++) inner += textLength(node.childNodes[i]);
      return inner;
    }
    if (node.nodeType === TEXT_NODE) {
      before += node.nodeValue?.length ?? 0;
      return null;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const found = visit(node.childNodes[i]);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(root);
}

/**
 * The text-node boundary at character `offset` of `root`'s text. An offset on
 * the seam between two text nodes resolves into the later node for `'start'`
 * and the earlier one for `'end'`, so a restored range covers no empty node.
 * Null when `root` holds fewer characters than `offset`, or no text at all.
 */
export function boundaryAt<N extends NodeLike>(root: N, offset: number, side: 'start' | 'end'): Boundary<N> | null {
  if (offset < 0) return null;
  let before = 0;
  let last: Boundary<N> | null = null;
  const visit = (node: N): Boundary<N> | null => {
    if (node.nodeType === TEXT_NODE) {
      const length = node.nodeValue?.length ?? 0;
      if (length === 0) return null;
      const inside = side === 'start' ? offset < before + length : offset <= before + length;
      if (offset >= before && inside) return { node, offset: offset - before };
      before += length;
      last = { node, offset: length };
      return null;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const found = visit(node.childNodes[i] as N);
      if (found) return found;
    }
    return null;
  };
  const found = visit(root);
  if (found) return found;
  // The very end of the text, asked for as a start.
  return last !== null && offset === before ? last : null;
}

/** One end of a selection: a character offset into the layer's text when the
 * end lies in the layer, else the boundary itself, which a swap of this layer
 * does not move. */
export type HeldEnd =
  | { inLayer: true; offset: number }
  | { inLayer: false; node: unknown; offset: number };

/** A selection held across one layer's swap. `forward` is true when the
 * anchor precedes the focus in the document. */
export interface HeldSelection {
  text: string;
  forward: boolean;
  anchor: HeldEnd;
  focus: HeldEnd;
}

export interface SelectionLike {
  rangeCount: number;
  isCollapsed: boolean;
  anchorNode: unknown;
  anchorOffset: number;
  focusNode: unknown;
  focusOffset: number;
}

function holdEnd(root: NodeLike, node: unknown, offset: number): HeldEnd {
  const inLayer = textOffsetOf(root, { node: node as NodeLike, offset });
  return inLayer === null ? { inLayer: false, node, offset } : { inLayer: true, offset: inLayer };
}

/**
 * The selection's ends as offsets into `root`'s text where they lie in `root`,
 * and as their own boundaries where they do not. Null when the selection
 * selects nothing or has no end in `root`. `forward` is read from the
 * selection's range and decides, for an end in the layer, which side of a
 * seam between two runs it lands on.
 */
export function holdSelection(
  root: NodeLike & { textContent: string | null },
  selection: SelectionLike | null,
  forward: boolean,
): HeldSelection | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const anchor = holdEnd(root, selection.anchorNode, selection.anchorOffset);
  const focus = holdEnd(root, selection.focusNode, selection.focusOffset);
  if (!anchor.inLayer && !focus.inLayer) return null;
  const direction = anchor.inLayer && focus.inLayer ? anchor.offset < focus.offset : forward;
  return { text: root.textContent ?? '', forward: direction, anchor, focus };
}

/**
 * The anchor and focus boundaries of `held` after `root` was rebuilt: an end
 * held in the layer is found again by its offset, an end held outside keeps
 * its boundary. Null when `root`'s text is not the text the selection was held
 * against; the selection then covers characters it did not cover.
 */
export function restoredBoundaries<N extends NodeLike & { textContent: string | null }>(
  root: N,
  held: HeldSelection,
): { anchor: Boundary<N>; focus: Boundary<N> } | null {
  if ((root.textContent ?? '') !== held.text) return null;
  // A layer with no text holds an end only at its own start.
  const empty = held.text === '';
  const place = (end: HeldEnd, side: 'start' | 'end'): Boundary<N> | null =>
    !end.inLayer ? { node: end.node as N, offset: end.offset }
      : boundaryAt(root, end.offset, side) ?? (empty && end.offset === 0 ? { node: root, offset: 0 } : null);
  const anchor = place(held.anchor, held.forward ? 'start' : 'end');
  const focus = place(held.focus, held.forward ? 'end' : 'start');
  return anchor && focus ? { anchor, focus } : null;
}

/**
 * The ends of `held` after `root` lost the text the selection covered in it:
 * an end held outside keeps its boundary, and the end held in the layer moves
 * to the layer's edge that faces the outside end, so the selection keeps
 * covering what it covers on other pages and none of this layer. Null when
 * both ends were in the layer; nothing outside it is left to cover.
 */
export function edgeBoundaries<N extends NodeLike>(
  root: N,
  held: HeldSelection,
): { anchor: Boundary<N>; focus: Boundary<N> } | null {
  const { anchor, focus } = held;
  if (anchor.inLayer && focus.inLayer) return null;
  // The outside end precedes the layer when it is the anchor of a forward
  // selection or the focus of a backward one.
  const outsideFirst = focus.inLayer === held.forward;
  const edge: Boundary<N> = { node: root, offset: outsideFirst ? 0 : root.childNodes.length };
  if (!anchor.inLayer) return { anchor: { node: anchor.node as N, offset: anchor.offset }, focus: edge };
  if (!focus.inLayer) return { anchor: edge, focus: { node: focus.node as N, offset: focus.offset } };
  return null;
}

function placeSelection(selection: Selection, ends: { anchor: Boundary; focus: Boundary } | null): void {
  if (!ends) {
    selection.removeAllRanges();
    return;
  }
  selection.setBaseAndExtent(
    ends.anchor.node as unknown as Node, ends.anchor.offset,
    ends.focus.node as unknown as Node, ends.focus.offset,
  );
}

function holdLayerSelection(live: HTMLElement, selection: Selection | null): HeldSelection | null {
  if (!selection || selection.rangeCount === 0) return null;
  return holdSelection(live as unknown as NodeLike & { textContent: string | null }, selection,
    selectionIsForward(selection as unknown as DirectedSelection));
}

/** The parts of a DOM node the direction test reads. */
export interface PositionedNode {
  parentNode: PositionedNode | null;
  childNodes: ArrayLike<PositionedNode>;
  compareDocumentPosition(other: PositionedNode): number;
}

export interface DirectedSelection {
  anchorNode: PositionedNode | null;
  anchorOffset: number;
  focusNode: PositionedNode | null;
  focusOffset: number;
}

const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_CONTAINS = 8;
const DOCUMENT_POSITION_CONTAINED_BY = 16;

/** The index in `ancestor` of the child that holds `node`. */
function childIndexHolding(ancestor: PositionedNode, node: PositionedNode): number {
  let child = node;
  while (child.parentNode && child.parentNode !== ancestor) child = child.parentNode;
  return Array.prototype.indexOf.call(ancestor.childNodes, child) as number;
}

/**
 * Whether the selection's anchor comes before its focus in the document, read
 * from the anchor and focus themselves. A range the browser normalised (an
 * element boundary moved into the text node inside it) no longer starts at
 * the anchor, so comparing the range with the anchor misreads the direction.
 */
export function selectionIsForward(selection: DirectedSelection): boolean {
  const { anchorNode: anchor, focusNode: focus, anchorOffset, focusOffset } = selection;
  if (!anchor || !focus) return true;
  if (anchor === focus) return anchorOffset <= focusOffset;
  const position = anchor.compareDocumentPosition(focus);
  // The focus lies inside the anchor's node: the anchor precedes it when it
  // sits at or before the child holding the focus.
  if (position & DOCUMENT_POSITION_CONTAINED_BY) return anchorOffset <= childIndexHolding(anchor, focus);
  // The anchor lies inside the focus's node.
  if (position & DOCUMENT_POSITION_CONTAINS) return childIndexHolding(focus, anchor) < focusOffset;
  return (position & DOCUMENT_POSITION_PRECEDING) === 0;
}

/**
 * Replaces `live`'s children with `staged`'s in one step, with the layer
 * styles and the rotation attribute pdf.js wrote on `staged`. A selection with
 * an end in the old spans keeps its ends when the new spans spell the same
 * text. When they do not, its ends in this layer go (`edgeBoundaries`):
 * removing the old spans would otherwise leave it covering other characters.
 */
export function swapTextLayer(live: HTMLElement, staged: HTMLElement): void {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  const held = holdLayerSelection(live, selection);
  for (let i = 0; i < staged.style.length; i++) {
    const name = staged.style.item(i);
    live.style.setProperty(name, staged.style.getPropertyValue(name));
  }
  const rotation = staged.getAttribute('data-main-rotation');
  if (rotation === null) live.removeAttribute('data-main-rotation');
  else live.setAttribute('data-main-rotation', rotation);
  delete live.dataset.ocrLayer;
  live.replaceChildren(...Array.from(staged.childNodes));
  if (!held || !selection) return;
  const root = live as unknown as NodeLike & { textContent: string | null };
  placeSelection(selection, restoredBoundaries(root, held) ?? edgeBoundaries(root, held));
}

/** Empties `live`. A selection with an end in it loses that end
 * (`edgeBoundaries`): removing the spans would otherwise leave it covering
 * other characters. */
export function clearTextLayer(live: HTMLElement): void {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  const held = holdLayerSelection(live, selection);
  live.replaceChildren();
  if (!held || !selection) return;
  placeSelection(selection, edgeBoundaries(live as unknown as NodeLike, held));
}
