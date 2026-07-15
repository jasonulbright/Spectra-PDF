import { describe, it, expect } from 'vitest';
import { currentPageFor, type ReadingMetrics } from '../src/renderer/canvas/reading-page';

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

    it('never exceeds the page count when the whole doc fits', () => {
      const m = metrics({ zoom: 0.233, pageCount: 3, viewportH: 800, scrollTop: 0 });
      const p = currentPageFor(m);
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(3);
    });
  });
});
