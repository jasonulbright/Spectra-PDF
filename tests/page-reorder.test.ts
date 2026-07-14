// The linear-list reorder math for the Pages panel (Phase 4 M3.1b). Maps a
// flat drop index to the (toDocId, toIndex) MOVE_PAGE/MOVE_PAGES expect — the
// target index counted against the doc's pages AFTER the moving ones are
// removed (the reducer's frame). The risky part of panel reorder, so unit it.
import { describe, expect, it } from 'vitest';
import { computeReorderTarget, type ReorderItem } from '../src/renderer/lib/page-reorder';

// Single-doc file: pages p0..p4 all in doc 'd'.
const single: ReorderItem[] = Array.from({ length: 5 }, (_, i) => ({ docId: 'd', pageId: `p${i}` }));

describe('computeReorderTarget — single document', () => {
  it('moving one page down: index counts against post-removal pages', () => {
    // Move p0 to flat index 3 (between p2 and p3). After removing p0, the rest
    // is p1,p2,p3,p4; the drop sits before rest[2] = p3 → local index 2.
    expect(computeReorderTarget(single, ['p0'], 3)).toEqual({ toDocId: 'd', toIndex: 2 });
  });

  it('moving one page up', () => {
    // Move p3 to flat index 1 (before p1). Rest = p0,p1,p2,p4; drop before
    // rest[1] = p1 → local index 1.
    expect(computeReorderTarget(single, ['p3'], 1)).toEqual({ toDocId: 'd', toIndex: 1 });
  });

  it('drop at the very top', () => {
    expect(computeReorderTarget(single, ['p2'], 0)).toEqual({ toDocId: 'd', toIndex: 0 });
  });

  it('drop at the very end appends after the last rest page', () => {
    // Move p1 to the end (flat index 5). Rest = p0,p2,p3,p4 → append at 4.
    expect(computeReorderTarget(single, ['p1'], 5)).toEqual({ toDocId: 'd', toIndex: 4 });
  });

  it('multi-page move: the gap skips all moving pages', () => {
    // Move p0,p1 to flat index 4 (after p3). Rest = p2,p3,p4; gap above index 4
    // counts non-moving pages in [0..3] = p2,p3 → g=2 → before rest[2]=p4 → 2.
    expect(computeReorderTarget(single, ['p0', 'p1'], 4)).toEqual({ toDocId: 'd', toIndex: 2 });
  });

  it('returns null when every page is moving (no anchor)', () => {
    expect(computeReorderTarget(single, ['p0', 'p1', 'p2', 'p3', 'p4'], 2)).toBeNull();
  });
});

describe('computeReorderTarget — multi-document file (manifest partitions)', () => {
  // File split into doc A (a0,a1) then doc B (b0,b1).
  const multi: ReorderItem[] = [
    { docId: 'A', pageId: 'a0' },
    { docId: 'A', pageId: 'a1' },
    { docId: 'B', pageId: 'b0' },
    { docId: 'B', pageId: 'b1' },
  ];

  it('dropping into the second partition targets that doc with a local index', () => {
    // Move a0 to flat index 3 (between b0 and b1). Rest = a1,b0,b1; gap g=2 →
    // rest[2] = b1 which is local index 1 within doc B.
    expect(computeReorderTarget(multi, ['a0'], 3)).toEqual({ toDocId: 'B', toIndex: 1 });
  });

  it('dropping at a partition boundary targets the next doc at local 0', () => {
    // Move a0 to flat index 2 (start of doc B). Rest = a1,b0,b1; g=1 →
    // rest[1] = b0, local index 0 within doc B.
    expect(computeReorderTarget(multi, ['a0'], 2)).toEqual({ toDocId: 'B', toIndex: 0 });
  });

  it('dropping at the very end appends to the last doc', () => {
    expect(computeReorderTarget(multi, ['a0'], 4)).toEqual({ toDocId: 'B', toIndex: 2 });
  });
});
