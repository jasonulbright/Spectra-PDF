import { describe, expect, it } from 'vitest';
import {
  boundaryAt,
  holdSelection,
  restoredBoundaries,
  selectionIsForward,
  textOffsetOf,
  type NodeLike,
  type PositionedNode,
} from '../src/renderer/lib/text-layer-selection';

interface Fake extends NodeLike {
  name: string;
  childNodes: Fake[];
  textContent: string | null;
}

function text(value: string, name = value): Fake {
  return { name, nodeType: 3, nodeValue: value, childNodes: [], textContent: value };
}
function el(name: string, ...children: Fake[]): Fake {
  return {
    name, nodeType: 1, nodeValue: null, childNodes: children,
    get textContent() { return children.map(c => c.textContent ?? '').join(''); },
  };
}
const br = () => el('br');

/** A pdf.js layer: spans of text runs and a line break between lines. */
function layer(...lines: string[][]): Fake {
  const nodes: Fake[] = [];
  lines.forEach((runs, i) => {
    if (i > 0) nodes.push(br());
    for (const run of runs) nodes.push(el(`span:${run}`, text(run)));
  });
  return el('layer', ...nodes);
}

function selection(anchor: { node: Fake; offset: number }, focus: { node: Fake; offset: number }) {
  return {
    rangeCount: 1,
    isCollapsed: anchor.node === focus.node && anchor.offset === focus.offset,
    anchorNode: anchor.node, anchorOffset: anchor.offset,
    focusNode: focus.node, focusOffset: focus.offset,
  };
}

describe('text offsets in a text layer', () => {
  const root = layer(['Hello ', 'world'], ['Second']);
  const [hello, world, , second] = root.childNodes;

  it('counts text nodes in document order, for text and element boundaries', () => {
    expect(textOffsetOf(root, { node: hello.childNodes[0], offset: 2 })).toBe(2);
    expect(textOffsetOf(root, { node: world.childNodes[0], offset: 0 })).toBe(6);
    expect(textOffsetOf(root, { node: world, offset: 1 })).toBe(11);
    expect(textOffsetOf(root, { node: second, offset: 0 })).toBe(11);
    expect(textOffsetOf(root, { node: root, offset: 4 })).toBe(17);
  });

  it('a node outside the layer has no offset', () => {
    expect(textOffsetOf(root, { node: text('elsewhere'), offset: 0 })).toBeNull();
  });

  it('a seam between two runs resolves into the later run for a start and the earlier for an end', () => {
    expect(boundaryAt(root, 6, 'start')).toEqual({ node: world.childNodes[0], offset: 0 });
    expect(boundaryAt(root, 6, 'end')).toEqual({ node: hello.childNodes[0], offset: 6 });
    expect(boundaryAt(root, 17, 'start')).toEqual({ node: second.childNodes[0], offset: 6 });
    expect(boundaryAt(root, 18, 'end')).toBeNull();
    expect(boundaryAt(el('empty'), 0, 'start')).toBeNull();
  });
});

describe('a selection carried across a rebuild', () => {
  it('lands on the same characters in the new spans when the text is unchanged', () => {
    const old = layer(['Selectable ', 'sentence'], ['next']);
    const span = old.childNodes[1];
    const held = holdSelection(old, selection({ node: span, offset: 0 }, { node: span, offset: 1 }), true);
    expect(held).toEqual({
      text: 'Selectable sentencenext', forward: true,
      anchor: { inLayer: true, offset: 11 }, focus: { inLayer: true, offset: 19 },
    });

    const rebuilt = layer(['Selectable ', 'sentence'], ['next']);
    const ends = restoredBoundaries(rebuilt, held!);
    expect(ends).toEqual({
      anchor: { node: rebuilt.childNodes[1].childNodes[0], offset: 0 },
      focus: { node: rebuilt.childNodes[1].childNodes[0], offset: 8 },
    });
  });

  it('keeps the direction of a backward selection', () => {
    const old = layer(['abc', 'def']);
    const held = holdSelection(old, selection(
      { node: old.childNodes[1].childNodes[0], offset: 2 },
      { node: old.childNodes[0].childNodes[0], offset: 1 },
    ), false)!;
    expect(held).toMatchObject({ forward: false, anchor: { offset: 5 }, focus: { offset: 1 } });
    const rebuilt = layer(['abc', 'def']);
    expect(restoredBoundaries(rebuilt, held)).toEqual({
      anchor: { node: rebuilt.childNodes[1].childNodes[0], offset: 2 },
      focus: { node: rebuilt.childNodes[0].childNodes[0], offset: 1 },
    });
  });

  it('a rebuild whose runs split differently still restores by characters', () => {
    const old = layer(['Hello world']);
    const held = holdSelection(old, selection(
      { node: old.childNodes[0].childNodes[0], offset: 6 },
      { node: old.childNodes[0].childNodes[0], offset: 11 },
    ), true)!;
    const rebuilt = layer(['Hello ', 'world']);
    expect(restoredBoundaries(rebuilt, held)).toEqual({
      anchor: { node: rebuilt.childNodes[1].childNodes[0], offset: 0 },
      focus: { node: rebuilt.childNodes[1].childNodes[0], offset: 5 },
    });
  });

  it('changed text is not restored', () => {
    const old = layer(['abc']);
    const held = holdSelection(old, selection(
      { node: old.childNodes[0].childNodes[0], offset: 0 },
      { node: old.childNodes[0].childNodes[0], offset: 2 },
    ), true)!;
    expect(restoredBoundaries(layer(['abd']), held)).toBeNull();
  });

  it('holds nothing for a collapsed selection, an empty one, or one with no end in the layer', () => {
    const old = layer(['abc']);
    const node = old.childNodes[0].childNodes[0];
    const elsewhere = text('other page');
    expect(holdSelection(old, null, true)).toBeNull();
    expect(holdSelection(old, selection({ node, offset: 1 }, { node, offset: 1 }), true)).toBeNull();
    expect(holdSelection(old, { ...selection({ node, offset: 0 }, { node, offset: 2 }), rangeCount: 0 }, true)).toBeNull();
    expect(holdSelection(old, selection({ node: elsewhere, offset: 0 }, { node: elsewhere, offset: 3 }), true)).toBeNull();
  });
});

describe('a selection across two layers', () => {
  // Page 1 ends "First page", page 2 starts "Second page". A drag from page 1
  // to page 2 has its anchor in one layer and its focus in the other.
  it('the start end in the rebuilt layer is found again; the end in the other layer is kept', () => {
    const page1 = layer(['First ', 'page']);
    const page2 = layer(['Second ', 'page']);
    const focusNode = page2.childNodes[0].childNodes[0];
    const held = holdSelection(page1, selection(
      { node: page1.childNodes[1].childNodes[0], offset: 0 },
      { node: focusNode, offset: 6 },
    ), true)!;
    expect(held).toEqual({
      text: 'First page', forward: true,
      anchor: { inLayer: true, offset: 6 }, focus: { inLayer: false, node: focusNode, offset: 6 },
    });
    const rebuilt1 = layer(['First ', 'page']);
    expect(restoredBoundaries(rebuilt1, held)).toEqual({
      anchor: { node: rebuilt1.childNodes[1].childNodes[0], offset: 0 },
      focus: { node: focusNode, offset: 6 },
    });
  });

  it('the end in the rebuilt layer is found again; the start in the other layer is kept', () => {
    const page1 = layer(['First ', 'page']);
    const page2 = layer(['Second ', 'page']);
    const anchorNode = page1.childNodes[1].childNodes[0];
    const held = holdSelection(page2, selection(
      { node: anchorNode, offset: 0 },
      { node: page2.childNodes[0].childNodes[0], offset: 6 },
    ), true)!;
    expect(held).toEqual({
      text: 'Second page', forward: true,
      anchor: { inLayer: false, node: anchorNode, offset: 0 }, focus: { inLayer: true, offset: 6 },
    });
    const rebuilt2 = layer(['Second ', 'page']);
    expect(restoredBoundaries(rebuilt2, held)).toEqual({
      anchor: { node: anchorNode, offset: 0 },
      focus: { node: rebuilt2.childNodes[0].childNodes[0], offset: 6 },
    });
  });

  it('a seam end of a one-sided selection takes the side its direction gives it', () => {
    const page1 = layer(['First ', 'page']);
    const outside = text('Second page');
    // Forward: the layer end is the start, so the seam at 6 resolves into "page".
    const forward = holdSelection(page1, selection(
      { node: page1.childNodes[0].childNodes[0], offset: 6 }, { node: outside, offset: 3 },
    ), true)!;
    const rebuiltA = layer(['First ', 'page']);
    expect(restoredBoundaries(rebuiltA, forward)!.anchor).toEqual({ node: rebuiltA.childNodes[1].childNodes[0], offset: 0 });
    // Backward: the layer end is the end of the range, so it resolves into "First ".
    const backward = holdSelection(page1, selection(
      { node: page1.childNodes[0].childNodes[0], offset: 6 }, { node: outside, offset: 3 },
    ), false)!;
    const rebuiltB = layer(['First ', 'page']);
    expect(restoredBoundaries(rebuiltB, backward)!.anchor).toEqual({ node: rebuiltB.childNodes[0].childNodes[0], offset: 6 });
  });

  it('a layer whose text changed is not restored, so the selection is cleared rather than moved', () => {
    const page1 = layer(['First ', 'page']);
    const held = holdSelection(page1, selection(
      { node: page1.childNodes[1].childNodes[0], offset: 0 }, { node: text('Second page'), offset: 6 },
    ), true)!;
    expect(restoredBoundaries(layer(['First ', 'pages']), held)).toBeNull();
  });
});

describe('a layer with no text', () => {
  it('an end at the start of an empty layer is restored there, not cleared', () => {
    const page1 = el('layer');
    const outside = text('Second page');
    const held = holdSelection(page1, selection({ node: page1, offset: 0 }, { node: outside, offset: 6 }), true)!;
    expect(held).toEqual({
      text: '', forward: true,
      anchor: { inLayer: true, offset: 0 }, focus: { inLayer: false, node: outside, offset: 6 },
    });
    // The live container keeps its identity; its (empty) children are replaced.
    expect(restoredBoundaries(page1, held)).toEqual({
      anchor: { node: page1, offset: 0 },
      focus: { node: outside, offset: 6 },
    });
  });

  it('an empty layer that gained text is not restored', () => {
    const page1 = el('layer');
    const held = holdSelection(page1, selection({ node: page1, offset: 0 }, { node: text('elsewhere'), offset: 2 }), true)!;
    expect(restoredBoundaries(layer(['now text']), held)).toBeNull();
  });
});

describe('the direction of a selection', () => {
  interface Tree extends PositionedNode {
    parentNode: Tree | null;
    childNodes: Tree[];
  }
  /** A node tree whose document positions follow pre-order. */
  function tree(children: Tree[] = []): Tree {
    const node: Tree = {
      parentNode: null,
      childNodes: children,
      compareDocumentPosition(other: PositionedNode): number {
        const order: Tree[] = [];
        let top: Tree = node;
        while (top.parentNode) top = top.parentNode;
        const walk = (n: Tree) => { order.push(n); n.childNodes.forEach(walk); };
        walk(top);
        const contains = (a: Tree, b: Tree): boolean => {
          for (let p = b.parentNode; p; p = p.parentNode) if (p === a) return true;
          return false;
        };
        const o = other as Tree;
        if (contains(node, o)) return 16 | 4;
        if (contains(o, node)) return 8 | 2;
        return order.indexOf(o) > order.indexOf(node) ? 4 : 2;
      },
    };
    for (const child of children) child.parentNode = node;
    return node;
  }
  const textA = tree();
  const textB = tree();
  const spanA = tree([textA]);
  const spanB = tree([textB]);
  tree([spanA, spanB]);
  const at = (anchorNode: Tree, anchorOffset: number, focusNode: Tree, focusOffset: number) =>
    selectionIsForward({ anchorNode, anchorOffset, focusNode, focusOffset });

  it('reads the anchor against the focus, not the range a browser may have normalised', () => {
    // Anchored at an element boundary that a browser reports as (textA, 0) in
    // the range: still forward.
    expect(at(spanA, 0, textB, 3)).toBe(true);
    expect(at(textB, 3, spanA, 0)).toBe(false);
  });

  it('compares offsets on one node', () => {
    expect(at(textA, 1, textA, 4)).toBe(true);
    expect(at(textA, 4, textA, 1)).toBe(false);
  });

  it('compares an element boundary with a point inside that element', () => {
    expect(at(spanA, 0, textA, 2)).toBe(true);
    expect(at(spanA, 1, textA, 2)).toBe(false);
    expect(at(textA, 2, spanA, 1)).toBe(true);
    expect(at(textA, 2, spanA, 0)).toBe(false);
  });
});
