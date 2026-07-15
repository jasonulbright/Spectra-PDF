import { describe, it, expect } from 'vitest';
import {
  actualSizeZoom,
  anchorHolds,
  currentPageFor,
  fitWidthZoom,
  naturalDisplayHeight,
  visibleRange,
  type JumpAnchor,
  type ReadingMetrics,
} from '../src/renderer/canvas/reading-page';
import { BASE_PAGE_HEIGHT, displayWidthOf } from '../src/renderer/canvas/layout';

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

    // Round-6/7 regression. scrollTop is state fed by the scroll EVENT, but a
    // page-tier delete shrinks pageCount/contentHeight SYNCHRONOUSLY, so for one
    // render the offset points past the end of the shorter content.
    //
    // This case is chosen to DISCRIMINATE: round 6's first attempt at a test used
    // a tail-delete that still overflowed the pane, where the old code's
    // `Math.min(pageCount, vFirst+1)` cap happened to give the right answer
    // anyway — it passed against the unclamped code and proved nothing (caught by
    // round 7, which reverted the fix and re-ran the suite). The divergence is
    // real only when the SHRUNKEN doc now fits the pane: unclamped, the stale
    // nonzero offset skips the at-top branch and names the LAST page, while the
    // pane is (once the browser clamps) showing page 1 at the top.
    it('clamps a stale scrollTop when the shrunken doc now fits the pane', () => {
      // A 10-page doc at 50% zoom in a 1000px pane, scrolled to the bottom...
      const before = metrics({ zoom: 0.5, pageCount: 10, viewportH: 1000, scrollTop: 0 });
      const wasAtBottom = before.contentHeight - 1000; // 3920
      // ...then all but 2 pages are deleted. The remaining doc (984px) now FITS
      // the 1000px pane, so the only reachable offset is 0 — but state still says 3920.
      const m = metrics({ zoom: 0.5, pageCount: 2, viewportH: 1000, scrollTop: wasAtBottom });
      expect(m.contentHeight).toBeLessThan(m.viewportH); // the whole doc fits now
      expect(currentPageFor(m)).toBe(1); // unclamped code answered 2 (the last page)
    });

    it('clamps a negative scrollTop (elastic/overscroll)', () => {
      expect(currentPageFor(metrics({ zoom: 1, pageCount: 5, viewportH: 800, scrollTop: -120 }))).toBe(1);
    });
  });
});

// Round-7's "blank pane" bug lived inline in DocumentView, so no test could
// reach it; the window is pure now precisely so this is covered.
describe('visibleRange — the rendered window', () => {
  const OVERSCAN = 2;

  it('never inverts when a delete leaves scrollTop stale past the end (blank-pane regression)', () => {
    // 10 pages @ zoom 1 in an 800px pane, scrolled to the bottom...
    const before = metrics({ zoom: 1, pageCount: 10, viewportH: 800, scrollTop: 0 });
    const wasAtBottom = before.contentHeight - 800; // 9040
    // ...then the last 3 are multi-select deleted; scrollTop lags for one render.
    const m = metrics({ zoom: 1, pageCount: 7, viewportH: 800, scrollTop: wasAtBottom });
    const { first, last } = visibleRange(m, OVERSCAN);
    // Unclamped this produced first=7 > last=6 -> the row loop emitted NOTHING.
    expect(first).toBeLessThanOrEqual(last);
    // ...and the window must contain the page the readout names.
    const reported = currentPageFor(m);
    expect(reported - 1).toBeGreaterThanOrEqual(first);
    expect(reported - 1).toBeLessThanOrEqual(last);
  });

  it('covers the visible pages in the ordinary case', () => {
    const m = metrics({ zoom: 1, pageCount: 50, viewportH: 800, scrollTop: 984 * 10 });
    const { first, last } = visibleRange(m, OVERSCAN);
    expect(first).toBeLessThanOrEqual(10);
    expect(last).toBeGreaterThanOrEqual(10);
    expect(last).toBeLessThanOrEqual(49);
  });

  it('reports an empty window for an empty doc', () => {
    const { first, last } = visibleRange(metrics({ zoom: 1, pageCount: 0, viewportH: 800, scrollTop: 0 }), OVERSCAN);
    expect(last).toBeLessThan(first);
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

  // Documented, intended degradation (round-5 review). A commit rebuilds the
  // file and the async reindex reassigns every id positionally from the new
  // buffer (lib/workspace.ts), so an anchor taken while an earlier in-memory
  // delete had "gapped" the ids can't match afterwards — and NO field survives a
  // rebuild to match on (sourcePageIndex is renumbered too). Trusting position
  // across a reindex would be unsound (a reindex can legitimately re-compose the
  // doc). So it drops and the scroll-derived answer takes over: still the
  // documented at-top contract, just less specific than the remembered jump.
  it('drops across a commit reindex (ids renumber) and falls back to the honest scroll answer', () => {
    // Pre-commit: page 1 was deleted in memory, so slot 1 holds id `p2`.
    const gapped = idsFor(pageCount).slice(1);
    const a: JumpAnchor = { scrollTop: 0, page: 2, pageId: gapped[1], rowH: base.rowH, viewportH };
    expect(a.pageId).toBe('f.pdf#p2');
    const m = metrics({ zoom, pageCount: pageCount - 1, viewportH, scrollTop: 0 });
    expect(anchorHolds(a, m, pagesAt(gapped, a))).toBe(true); // holds before the commit
    // Post-commit reindex: ids are reassigned contiguously from 0 off the new file.
    const reindexed = idsFor(pageCount - 1);
    expect(pagesAt(reindexed, a)).toBe('f.pdf#p1'); // same physical page, new id
    expect(anchorHolds(a, m, pagesAt(reindexed, a))).toBe(false);
    expect(currentPageFor(m)).toBe(1); // fails safe to the at-top contract
  });

  // Round-8: deleting pages AFTER the anchored page leaves the anchor's slot and
  // identity intact and can leave scrollTop bit-identical to where the jump
  // landed — while that offset is now past the end of the shorter document. The
  // anchor must not hold over a position the pane can no longer be at.
  it('drops when trailing deletes put the anchored offset out of reach (identity intact)', () => {
    const z = 0.25;
    const vh = 800;
    const big = metrics({ zoom: z, pageCount: 50, viewportH: vh, scrollTop: 0 });
    const landed = scrollTopForCenterOn(25, big, vh);
    const a: JumpAnchor = {
      scrollTop: landed,
      page: 25,
      pageId: 'f.pdf#p24',
      rowH: big.rowH,
      viewportH: vh,
    };
    // Delete the trailing pages: page 25 itself is untouched, so its id still
    // sits in slot 25 and only the clamp can catch this.
    const m = metrics({ zoom: z, pageCount: 26, viewportH: vh, scrollTop: landed });
    expect(landed).toBeGreaterThan(m.contentHeight - vh); // genuinely out of reach now
    expect(anchorHolds(a, m, 'f.pdf#p24')).toBe(false);
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

// Zoom presets (M4.1d). `zoom` is relative to the reading view's base page
// height (960), NOT to the PDF's natural size — so 100% is not zoom 1.
describe('zoom presets — Actual Size / Fit Width', () => {
  const READING_BASE_HEIGHT = 960;
  const LETTER = { id: 'p', width: 612, height: 792, rotation: 0 as const }; // 72dpi points
  const A4 = { id: 'p', width: 595, height: 842, rotation: 0 as const };

  describe('naturalDisplayHeight', () => {
    it('is the page height when upright', () => {
      expect(naturalDisplayHeight(LETTER)).toBe(792);
    });

    it('is the page WIDTH when quarter-turned (that edge runs vertically now)', () => {
      expect(naturalDisplayHeight({ ...LETTER, rotation: 90 })).toBe(612);
      expect(naturalDisplayHeight({ ...LETTER, rotation: 270 })).toBe(612);
      expect(naturalDisplayHeight({ ...LETTER, rotation: 180 })).toBe(792);
    });

    it('falls back to US Letter for a page whose dimensions have not resolved (0x0)', () => {
      expect(naturalDisplayHeight({ width: 0, height: 0 })).toBe(792);
    });
  });

  describe('actualSizeZoom', () => {
    it('renders a Letter page at its true 792pt height', () => {
      const z = actualSizeZoom(LETTER, READING_BASE_HEIGHT);
      expect(z).toBeCloseTo(792 / 960, 6);
      expect(READING_BASE_HEIGHT * z).toBeCloseTo(792, 6); // the point of the preset
    });

    it('differs per page size and per rotation (why it acts on the CURRENT page)', () => {
      expect(actualSizeZoom(A4, READING_BASE_HEIGHT)).not.toBeCloseTo(
        actualSizeZoom(LETTER, READING_BASE_HEIGHT),
        4,
      );
      expect(READING_BASE_HEIGHT * actualSizeZoom({ ...LETTER, rotation: 90 }, READING_BASE_HEIGHT))
        .toBeCloseTo(612, 6);
    });
  });

  describe('fitWidthZoom', () => {
    // The reading view renders width = displayWidthOf(page) * pageHeight / BASE_PAGE_HEIGHT,
    // so a correct fit is the zoom whose resulting width equals the pane.
    function renderedWidth(page: Parameters<typeof displayWidthOf>[0], zoom: number): number {
      return displayWidthOf(page) * ((READING_BASE_HEIGHT * zoom) / BASE_PAGE_HEIGHT);
    }

    it('produces exactly the available width', () => {
      const available = 900;
      const z = fitWidthZoom(available, displayWidthOf(LETTER), BASE_PAGE_HEIGHT, READING_BASE_HEIGHT);
      expect(renderedWidth(LETTER, z)).toBeCloseTo(available, 4);
    });

    it('accounts for rotation (a quarter-turned page is wider, so it fits smaller)', () => {
      const available = 900;
      const upright = fitWidthZoom(available, displayWidthOf(LETTER), BASE_PAGE_HEIGHT, READING_BASE_HEIGHT);
      const turned = fitWidthZoom(
        available,
        displayWidthOf({ ...LETTER, rotation: 90 }),
        BASE_PAGE_HEIGHT,
        READING_BASE_HEIGHT,
      );
      expect(turned).toBeLessThan(upright);
      expect(renderedWidth({ ...LETTER, rotation: 90 }, turned)).toBeCloseTo(available, 4);
    });

    it('returns 0 for an unmeasured pane so the caller leaves the zoom alone', () => {
      expect(fitWidthZoom(0, displayWidthOf(LETTER), BASE_PAGE_HEIGHT, READING_BASE_HEIGHT)).toBe(0);
      expect(fitWidthZoom(-5, displayWidthOf(LETTER), BASE_PAGE_HEIGHT, READING_BASE_HEIGHT)).toBe(0);
      expect(fitWidthZoom(900, 0, BASE_PAGE_HEIGHT, READING_BASE_HEIGHT)).toBe(0);
    });
  });
});
