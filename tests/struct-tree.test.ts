import { describe, expect, it } from 'vitest';
import {
  flattenReadingOrder,
  mcidTextFromItems,
  nodePreview,
  pathKey,
  sameParent,
  subtreePages,
  type MarkedTextItem,
  type StructNode,
} from '../src/renderer/lib/struct-tree';

function node(
  type: string,
  path: number[],
  content: StructNode['content'] = [],
  children: StructNode[] = [],
): StructNode {
  return { path, type, title: '', alt: '', actual_text: '', lang: '', content, children };
}

describe('path helpers', () => {
  it('keys and sibling checks', () => {
    expect(pathKey([0, 2, 1])).toBe('0.2.1');
    expect(sameParent([0, 1], [0, 3])).toBe(true);
    expect(sameParent([0, 1], [1, 1])).toBe(false);
    expect(sameParent([0, 1], [0, 1, 0])).toBe(false);
    expect(sameParent([0], [2])).toBe(true); // both top-level
  });
});

describe('flattenReadingOrder', () => {
  const tree = [
    node('Document', [0], [], [
      node('H1', [0, 0], [{ page: 1, mcid: 0 }]),
      node('Sect', [0, 1], [], [
        node('P', [0, 1, 0], [{ page: 1, mcid: 1 }, { page: 2, mcid: 0 }]),
        node('Link', [0, 1, 1], [{ page: 2, kind: 'objr' }]),
      ]),
      node('P', [0, 2], [{ page: 1, mcid: 2 }]),
    ]),
  ];

  it('lists nodes with direct content on the page, in tree order', () => {
    const order = flattenReadingOrder(tree, 1);
    expect(order.map((e) => e.node.type)).toEqual(['H1', 'P', 'P']);
    expect(order.map((e) => e.mcids)).toEqual([[0], [1], [2]]);
  });

  it('containers without direct content are absent; objr counts as content', () => {
    const order = flattenReadingOrder(tree, 2);
    expect(order.map((e) => e.node.type)).toEqual(['P', 'Link']);
    expect(order[1].hasObjr).toBe(true);
    expect(order[1].mcids).toEqual([]);
  });

  it('empty for a page nothing references', () => {
    expect(flattenReadingOrder(tree, 3)).toEqual([]);
  });
});

describe('subtreePages', () => {
  it('collects descendant pages, sorted unique', () => {
    const n = node('Sect', [0], [{ page: 3, mcid: 0 }], [
      node('P', [0, 0], [{ page: 1, mcid: 1 }, { page: 3, mcid: 2 }]),
    ]);
    expect(subtreePages(n)).toEqual([1, 3]);
  });
});

describe('mcidTextFromItems', () => {
  it('attributes text to the nearest enclosing MCID marker', () => {
    const items: MarkedTextItem[] = [
      { type: 'beginMarkedContentProps', id: 'p1R_mc0' },
      { str: 'Heading' },
      { type: 'endMarkedContent' },
      { type: 'beginMarkedContentProps', id: 'p1R_mc1' },
      { str: 'Body ' },
      // Nested marker WITHOUT an mcid (an artifact span) — text inside it
      // still belongs to the enclosing MCID 1.
      { type: 'beginMarkedContent', id: null },
      { str: 'more' },
      { type: 'endMarkedContent' },
      { type: 'endMarkedContent' },
      // Text outside any marker is unattributed.
      { str: 'loose' },
    ];
    const texts = mcidTextFromItems(items);
    expect(texts.get(0)).toBe('Heading');
    expect(texts.get(1)).toBe('Body more');
    expect(texts.size).toBe(2);
  });

  it('nested mcids attribute to the inner one; hasEOL adds a space', () => {
    const items: MarkedTextItem[] = [
      { type: 'beginMarkedContentProps', id: 'p1R_mc4' },
      { str: 'outer', hasEOL: true },
      { type: 'beginMarkedContentProps', id: 'p1R_mc5' },
      { str: 'inner' },
      { type: 'endMarkedContent' },
      { str: 'again' },
      { type: 'endMarkedContent' },
    ];
    const texts = mcidTextFromItems(items);
    expect(texts.get(4)).toBe('outer again');
    expect(texts.get(5)).toBe('inner');
  });

  it('unbalanced end markers do not throw', () => {
    const texts = mcidTextFromItems([
      { type: 'endMarkedContent' },
      { type: 'beginMarkedContentProps', id: 'p1R_mc2' },
      { str: 'ok' },
    ]);
    expect(texts.get(2)).toBe('ok');
  });
});

describe('nodePreview', () => {
  const texts = new Map<number, Map<number, string>>([
    [1, new Map([[0, 'Alpha  beta'], [1, 'gamma']])],
  ]);

  it('joins direct content text and collapses whitespace', () => {
    const n = node('P', [0], [{ page: 1, mcid: 0 }, { page: 1, mcid: 1 }]);
    expect(nodePreview(n, texts)).toBe('Alpha beta gamma');
  });

  it('marks annotations and truncates long text', () => {
    const n = node('Link', [0], [{ page: 1, kind: 'objr' }]);
    expect(nodePreview(n, texts)).toBe('[annotation]');
    const long = node('P', [0], [{ page: 1, mcid: 0 }]);
    const wide = new Map([[1, new Map([[0, 'x'.repeat(200)]])]]);
    expect(nodePreview(long, wide, 20)).toHaveLength(20);
    expect(nodePreview(long, wide, 20).endsWith('…')).toBe(true);
  });

  it('missing text or unresolved pages yield an empty preview', () => {
    const n = node('P', [0], [{ page: 9, mcid: 0 }, { page: null, kind: 'objr' }]);
    expect(nodePreview(n, texts)).toBe('');
  });
});
