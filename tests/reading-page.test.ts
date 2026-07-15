import { describe, it, expect } from 'vitest';
import {
  anchorHolds,
  currentPageFor,
  type JumpAnchor,
  type ReadingMetrics,
} from '../src/renderer/canvas/reading-page';

// Mirrors DocumentView's real constants so these cases are the ones a user hits.
const READING_BASE_HEIGHT = 960;
const PAGE_GAP = 24;

/** Build metrics the way DocumentView derives them, for a given zoom. */
function metrics(opts: {
  zoom: number;
  pageCount: number;
  viewportH: number;
  scrollTop: number;
}): ReadingMetrics {
  const pageHeight = READING_BASE_HEIGHT * opts.zoom;
  const rowH = pageHeight + PAGE_GAP * opts.zoom;
  return {
    scrollTop: opts.scrollTop,
    viewportH: opts.viewportH,
    rowH,
    pageHeight,
    pageCount: opts.pageCount,
    contentHeight: opts.pageCount * rowH,
  };
}

/** What DocumentView's centerOn does: centre the page, clamped at 0. */
function scrollTopForCenterOn(page1Based: number, m: ReadingMetrics, viewportH: number): number {
  const top = (page1Based - 1) * m.rowH;
  const offset = Math.max(0, (viewportH - m.pageHeight) / 2);
  return Math.max(0, top - offset);
}

describe('currentPageFor — reading view current page', () => {
  describe('one page taller than / filling the viewport (the ordinary case)', () => {
    it('reports the page that dominates the viewport', () => {
      // zoom 1: page 960 tall, viewport 800 — page 2 mostly fills it.
      const m = metrics({ zoom: 1, pageCount: 50, viewportH: 800, scrollTop: 984 + 100 });
      expect(currentPageFor(m)).toBe(2);
    });

    it('reports page 1 at the very top', () => {
      const m = metrics({ zoom: 1, pageCount: 50, viewportH: 800, scrollTop: 0 });
      expect(currentPageFor(m)).toBe(1);
    });
  });

  describe('several pages fully visible at once (all tie on overlap)', () => {
    // zoom ~0.233: page ~223 tall, rowH ~229 — three-plus pages fit an 800px pane.
    const zoom = 0.233;
    const pageCount = 50;
    const viewportH = 800;

    // NOTE: this one does not discriminate the tie-break fix (the old
    // topmost-wins code also said 1 here). It pins the OTHER regression
    // direction: a pure centre-proximity rule reports 2 at the top of the doc.
    it('reports page 1 at the top, not the centred page', () => {
      const m = metrics({ zoom, pageCount, viewportH, scrollTop: 0 });
      expect(currentPageFor(m)).toBe(1);
    });

    it('reports the LAST page when scrolled to the end, not the topmost visible', () => {
      // Regression: the old strict `>` tie-break returned the first of the
      // visible group (e.g. 48) while the user was scrolled fully to page 50.
      const base = metrics({ zoom, pageCount, viewportH, scrollTop: 0 });
      const maxScroll = base.contentHeight - viewportH;
      const m = metrics({ zoom, pageCount, viewportH, scrollTop: maxScroll });
      expect(currentPageFor(m)).toBe(pageCount);
    });

    it('reports N after a mid-doc centred jump to N (jump-to-N must not snap back)', () => {
      // Regression: neighbours become fully visible and tied, and the old
      // tie-break returned N-1, so typing 25 + Enter snapped the box to 24.
      const base = metrics({ zoom, pageCount, viewportH, scrollTop: 0 });
      for (const target of [10, 25, 33]) {
        const scrollTop = scrollTopForCenterOn(target, base, viewportH);
        const m = metrics({ zoom, pageCount, viewportH, scrollTop });
        expect(currentPageFor(m)).toBe(target);
      }
    });

    it('a jump to the last page reports the last page', () => {
      const base = metrics({ zoom, pageCount, viewportH, scrollTop: 0 });
      const wanted = scrollTopForCenterOn(pageCount, base, viewportH);
      const scrollTop = Math.min(wanted, base.contentHeight - viewportH);
      const m = metrics({ zoom, pageCount, viewportH, scrollTop });
      expect(currentPageFor(m)).toBe(pageCount);
    });
  });

  describe('degenerate input', () => {
    it('returns 1 for an empty doc or an unmeasured viewport', () => {
      expect(currentPageFor(metrics({ zoom: 1, pageCount: 0, viewportH: 800, scrollTop: 0 }))).toBe(1);
      expect(currentPageFor(metrics({ zoom: 1, pageCount: 10, viewportH: 0, scrollTop: 0 }))).toBe(1);
    });

    it('reports page 1 when the whole doc fits (both extremes true at once)', () => {
      const m = metrics({ zoom: 0.233, pageCount: 3, viewportH: 800, scrollTop: 0 });
      expect(currentPageFor(m)).toBe(1);
    });

    it('handles a single-page doc', () => {
      expect(currentPageFor(metrics({ zoom: 1, pageCount: 1, viewportH: 800, scrollTop: 0 }))).toBe(1);
    });
  });
});

// The scroll-derived rules above CANNOT answer a boundary-adjacent jump: centring
// page 2 wants a negative scrollTop and centring page 49/50 overshoots maxScroll,
// so both land on exactly the scroll offset that "scrolled to the top/bottom"
// occupies. The jump anchor records intent so those report what the user asked
// for. (Round-3 review caught the clamps reopening the snap-back here.)
describe('anchorHolds — a jump wins until the user scrolls away', () => {
  const zoom = 0.233;
  const pageCount = 50;
  const viewportH = 800;
  const base = metrics({ zoom, pageCount, viewportH, scrollTop: 0 });
  const maxScroll = base.contentHeight - viewportH;

  /** centerOn's real landing spot: centre, clamped to the scrollable range. */
  function landOn(page: number): number {
    return Math.min(maxScroll, scrollTopForCenterOn(page, base, viewportH));
  }

  /** Page ids the way the reducer makes them (positional: `path#pN`). */
  const idsFor = (n: number): string[] => Array.from({ length: n }, (_, i) => `f.pdf#p${i}`);
  const pagesAt = (ids: string[], anchor: JumpAnchor): string | undefined => ids[anchor.page - 1];

  function anchorFor(page: number): JumpAnchor {
    return {
      scrollTop: landOn(page),
      page,
      pageId: idsFor(pageCount)[page - 1],
      rowH: base.rowH,
      viewportH,
    };
  }

  const ids = idsFor(pageCount);

  it('a jump to page 2 clamps to the very top — scroll math says 1, the anchor says 2', () => {
    const scrollTop = landOn(2);
    expect(scrollTop).toBe(0); // it really does saturate
    const m = metrics({ zoom, pageCount, viewportH, scrollTop });
    expect(currentPageFor(m)).toBe(1); // why the anchor is needed
    const a = anchorFor(2);
    expect(anchorHolds(a, m, pagesAt(ids, a))).toBe(true);
  });

  it('a jump to page 49 saturates at maxScroll — scroll math says 50, the anchor says 49', () => {
    const scrollTop = landOn(49);
    expect(scrollTop).toBe(maxScroll); // it really does saturate
    const m = metrics({ zoom, pageCount, viewportH, scrollTop });
    expect(currentPageFor(m)).toBe(50); // why the anchor is needed
    const a = anchorFor(49);
    expect(anchorHolds(a, m, pagesAt(ids, a))).toBe(true);
  });

  it('drops once the user scrolls away from where the jump landed', () => {
    const a = anchorFor(25);
    const moved = metrics({ zoom, pageCount, viewportH, scrollTop: a.scrollTop + 40 });
    expect(anchorHolds(a, moved, pagesAt(ids, a))).toBe(false);
  });

  it('survives a sub-pixel scroll settle', () => {
    const a = anchorFor(25);
    const jitter = metrics({ zoom, pageCount, viewportH, scrollTop: a.scrollTop + 0.5 });
    expect(anchorHolds(a, jitter, pagesAt(ids, a))).toBe(true);
  });

  it('is invalidated by a zoom or a resize (the layout it was taken under is gone)', () => {
    const a = anchorFor(25);
    const zoomed = metrics({ zoom: 0.5, pageCount, viewportH, scrollTop: a.scrollTop });
    expect(anchorHolds(a, zoomed, pagesAt(ids, a))).toBe(false);
    const resized = metrics({ zoom, pageCount, viewportH: 600, scrollTop: a.scrollTop });
    expect(anchorHolds(a, resized, pagesAt(ids, a))).toBe(false);
  });

  it('rejects a stale anchor pointing past the current doc', () => {
    const shorter = metrics({ zoom, pageCount: 3, viewportH, scrollTop: 0 });
    const stale: JumpAnchor = {
      scrollTop: 0,
      page: 40,
      pageId: 'f.pdf#p39',
      rowH: shorter.rowH,
      viewportH,
    };
    expect(anchorHolds(stale, shorter, undefined)).toBe(false);
    expect(anchorHolds(null, shorter, undefined)).toBe(false);
  });

  // Round-4 regression: a page-tier edit renumbers pages WITHOUT remounting the
  // reading view and can leave scrollTop untouched, so layout+scroll both still
  // "match" while a different page now occupies the slot.
  it('drops when a page-tier delete renumbers the page out from under it', () => {
    // Jump to page 2 (lands at scrollTop 0), then delete the page above it.
    const a = anchorFor(2);
    expect(a.scrollTop).toBe(0);
    const afterDelete = idsFor(pageCount).slice(1); // page 1 removed; ids shift up
    const m = metrics({ zoom, pageCount: pageCount - 1, viewportH, scrollTop: 0 });
    // scrollTop is still 0 and the layout is identical — only identity catches it.
    expect(anchorHolds(a, m, pagesAt(afterDelete, a))).toBe(false);
    // ...and the view now correctly speaks for itself: that slot IS page 1.
    expect(currentPageFor(m)).toBe(1);
  });

  it('drops when a reorder swaps a different page into the anchored slot', () => {
    const a = anchorFor(25);
    const reordered = idsFor(pageCount);
    [reordered[24], reordered[30]] = [reordered[30], reordered[24]];
    const m = metrics({ zoom, pageCount, viewportH, scrollTop: a.scrollTop });
    expect(anchorHolds(a, m, pagesAt(reordered, a))).toBe(false);
  });

  it('still holds when pages change in a way that keeps the slot (e.g. an annotation edit)', () => {
    // The pages ARRAY is a new reference after any page-tier dispatch, so the
    // guard must compare identity, not reference — else every annotation edit
    // would needlessly drop a valid anchor and reopen the snap-back.
    const a = anchorFor(2);
    const sameOrderNewArray = idsFor(pageCount).map((s) => `${s}`);
    const m = metrics({ zoom, pageCount, viewportH, scrollTop: a.scrollTop });
    expect(anchorHolds(a, m, pagesAt(sameOrderNewArray, a))).toBe(true);
  });
});
