import { describe, expect, it } from 'vitest';
import {
  flattenOutline,
  isPathPrefix,
  restRows,
  clampDropDepth,
  moveOutlineNode,
  outlinesEqual,
  type OutlineNode,
} from '../src/renderer/lib/outline-reorder';

// Compact tree builder + serializer for readable assertions.
// n('A', [n('B')]) → A with child B. ser → "A[B]".
function n(title: string, children: OutlineNode[] = [], page: number | null = null): OutlineNode {
  return { title, page, children };
}
function ser(nodes: OutlineNode[]): string {
  return nodes
    .map((node) => (node.children.length ? `${node.title}[${ser(node.children)}]` : node.title))
    .join(',');
}

describe('flattenOutline', () => {
  it('emits pre-order rows with index paths and depths', () => {
    const tree = [n('A', [n('B'), n('C', [n('D')])]), n('E')];
    const flat = flattenOutline(tree);
    expect(flat.map((f) => f.node.title)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(flat.map((f) => f.path)).toEqual([[0], [0, 0], [0, 1], [0, 1, 0], [1]]);
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 1, 2, 0]);
  });
});

describe('isPathPrefix / restRows', () => {
  it('recognizes ancestor-or-self paths', () => {
    expect(isPathPrefix([0], [0, 1])).toBe(true);
    expect(isPathPrefix([0], [0])).toBe(true);
    expect(isPathPrefix([0, 1], [0])).toBe(false);
    expect(isPathPrefix([1], [0, 1])).toBe(false);
  });

  it('restRows drops the dragged node and its whole subtree', () => {
    const tree = [n('A', [n('B'), n('C', [n('D')])]), n('E')];
    const rest = restRows(flattenOutline(tree), [0]);
    expect(rest.map((f) => f.node.title)).toEqual(['E']); // A, B, C, D all lifted
  });
});

describe('clampDropDepth', () => {
  const tree = [n('A', [n('B')]), n('C')];
  // rest after lifting C: [A(d0), B(d1)]
  const rest = restRows(flattenOutline(tree), [1]);

  it('caps at one deeper than the row above, floors at the row below', () => {
    // Drop at the end (after B): prev=B(d1) → max 2, no next → min 0.
    expect(clampDropDepth(rest, 2, 5)).toBe(2);
    expect(clampDropDepth(rest, 2, -3)).toBe(0);
    // Drop at the very top (before A): no prev → max 0.
    expect(clampDropDepth(rest, 0, 3)).toBe(0);
  });
});

describe('moveOutlineNode', () => {
  it('reorders siblings at the root (move A, with its subtree, after C)', () => {
    const tree = [n('A', [n('B')]), n('C')];
    // Lift A → rest = [C]; drop after C (overIndex 1) at root depth 0.
    expect(ser(moveOutlineNode(tree, [0], 1, 0))).toBe('C,A[B]');
  });

  it('nests a root as the last child of another root (C under A after B)', () => {
    const tree = [n('A', [n('B')]), n('C')];
    // Lift C → rest = [A(d0), B(d1)]; drop after B (overIndex 2) at depth 1.
    expect(ser(moveOutlineNode(tree, [1], 2, 1))).toBe('A[B,C]');
  });

  it('nests deeper (C as a child of B) when the depth allows', () => {
    const tree = [n('A', [n('B')]), n('C')];
    expect(ser(moveOutlineNode(tree, [1], 2, 2))).toBe('A[B[C]]');
  });

  it('un-nests a child to the root level (B out from under A, between A and C)', () => {
    const tree = [n('A', [n('B')]), n('C')];
    // Lift B → rest = [A(d0), C(d0)]; drop between them (overIndex 1) at depth 0.
    expect(ser(moveOutlineNode(tree, [0, 0], 1, 0))).toBe('A,B,C');
  });

  it('carries the dragged node\'s entire subtree with it', () => {
    const tree = [n('A', [n('B', [n('C')])]), n('D')];
    // Move A (with B and B's child C) to after D at root.
    expect(ser(moveOutlineNode(tree, [0], 1, 0))).toBe('D,A[B[C]]');
  });

  it('clamps an over-deep desired depth to a valid nesting', () => {
    const tree = [n('A'), n('B')];
    // Lift B → rest = [A(d0)]; drop after A (overIndex 1) with an absurd depth.
    // max = A.depth+1 = 1, so B nests directly under A, not deeper.
    expect(ser(moveOutlineNode(tree, [1], 1, 99))).toBe('A[B]');
  });

  it('rejects a stale/empty dragged path (returns the input unchanged)', () => {
    const tree = [n('A'), n('B')];
    expect(moveOutlineNode(tree, [], 0, 0)).toBe(tree);
    expect(moveOutlineNode(tree, [5], 0, 0)).toBe(tree); // no such node
  });

  it('preserves opaque 2l action-preservation fields through a reorder', () => {
    const tree: OutlineNode[] = [
      { title: 'Link', page: null, children: [], action: { s: 'https://x' }, action_lossy: false },
      n('Plain', [], 3),
    ];
    // Move the URI-action node below the plain one; its `action`/`action_lossy`
    // must survive untouched (reconstructing {title,page,children} would drop them).
    const moved = moveOutlineNode(tree, [0], 2, 0);
    expect(ser(moved)).toBe('Plain,Link');
    const link = moved[1];
    expect(link.action).toEqual({ s: 'https://x' });
    expect(link.action_lossy).toBe(false);
    expect(link.page).toBeNull();
  });

  it('does not mutate the input tree', () => {
    const tree = [n('A', [n('B')]), n('C')];
    const snapshot = ser(tree);
    moveOutlineNode(tree, [1], 2, 1);
    expect(ser(tree)).toBe(snapshot); // original intact
  });
});

describe('outlinesEqual (no-op detection without delimiter collisions — review #2)', () => {
  it('is true only for a structurally identical tree', () => {
    expect(outlinesEqual([n('A', [n('B')]), n('C')], [n('A', [n('B')]), n('C')])).toBe(true);
    expect(outlinesEqual([n('B'), n('A')], [n('A'), n('B')])).toBe(false); // sibling order
    expect(outlinesEqual([n('A', [n('B')])], [n('A'), n('B')])).toBe(false); // nesting
    expect(outlinesEqual([n('A'), n('B', [], 2)], [n('A'), n('B')])).toBe(false); // page differs
  });

  it('a permutation of truly-identical siblings is a structural no-op', () => {
    expect(outlinesEqual([n('X'), n('X')], [n('X'), n('X')])).toBe(true);
  });

  it('distinguishes a real reorder that a delimited string encoding would collide', () => {
    // The old `${title}:${page}(children)` join was non-injective: bookmark
    // titles are free-form, so `:` `(` `)` `,` in a title could reproduce the
    // structural delimiters. This exact tree + move serialized identically
    // under that scheme yet is a genuine nesting change.
    const tree = [
      n(',', [n('():('), n('()', [n(''), n('(,)', [], 3), n('),')])]),
    ];
    const moved = moveOutlineNode(tree, [0, 0], 3, 2);
    // '():(' nests under '()': ',' drops from 2 children to 1, '()' gains one.
    expect(moved[0].children.length).toBe(1);
    expect(moved[0].children[0].title).toBe('()');
    expect(moved[0].children[0].children.map((c) => c.title)).toEqual(['', '():(', '(,)', '),']);
    expect(outlinesEqual(moved, tree)).toBe(false); // the old delimited encoding said "equal"
  });
});
