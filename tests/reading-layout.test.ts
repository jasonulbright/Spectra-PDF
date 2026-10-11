import { describe, expect, it } from 'vitest';
import {
  anchoredScroll,
  columnsFor,
  fitAvailable,
  fitAvailableHeight,
  fitZoom,
  FIT_WIDTH_GUTTER,
  gridGeometry,
  hitTest,
  jumpTop,
  linkQuadGeometry,
  pagedRowAt,
  pagedTarget,
  pageInView,
  pageRect,
  pagesInRowOf,
  quadLinkAxes,
  rowOfPage,
  steppedZoom,
  viewportCentre,
  wheelDeltaPx,
  wheelStep,
  WHEEL_STEP_LOCK_MS,
  WHEEL_STEP_THRESHOLD,
  widestOf,
  zoomForColumns,
  type GridInput,
} from '../src/renderer/canvas/reading-layout';
import {
  maxZoomFor,
  MAX_ZOOM,
  MIN_ZOOM,
  READING_BASE_HEIGHT,
  READING_PAGE_GAP,
  realTopFor,
  SAFE_ELEMENT_EXTENT,
  scrollMapFor,
  virtualTopOf,
} from '../src/renderer/canvas/reading-page';

const LETTER_W1 = READING_BASE_HEIGHT * (612 / 792);
const LANDSCAPE_W1 = READING_BASE_HEIGHT * (792 / 612);

function input(over: Partial<GridInput> = {}): GridInput {
  return {
    pageWidthsAt1: Array.from({ length: 10 }, () => LETTER_W1),
    zoom: 0.5,
    layoutMode: 'grid',
    coverAlone: false,
    direction: 'l2r',
    scrollMode: 'continuous',
    viewportW: 1600,
    viewportH: 900,
    ...over,
  };
}

describe('columnsFor', () => {
  it('is never 0 and never more than the page count', () => {
    for (const n of [0, 1, 2, 3, 7, 50]) {
      for (const w of [-100, 0, 10, 500, 5000, 1e6]) {
        const c = columnsFor(w, 100, 10, n);
        expect(c).toBeGreaterThanOrEqual(1);
        expect(c).toBeLessThanOrEqual(Math.max(1, n));
      }
    }
  });

  it('is monotone non-decreasing in the available width', () => {
    let prev = 0;
    for (let w = 0; w <= 5000; w += 7) {
      const c = columnsFor(w, 300, 12, 40);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it('follows floor((availW + gap) / (colW + gap))', () => {
    expect(columnsFor(310, 100, 5, 9)).toBe(3); // (310+5)/105 = 3
    expect(columnsFor(309, 100, 5, 9)).toBe(2);
    expect(columnsFor(1000, 0, 0, 9)).toBe(1); // degenerate pitch
  });
});

describe('gridGeometry', () => {
  it('single layout is one column whatever the width', () => {
    const g = gridGeometry(input({ layoutMode: 'single', viewportW: 10_000 }));
    expect(g.columns).toBe(1);
    expect(g.rowCount).toBe(10);
  });

  it('grid columns grow with the viewport and drop to 1 when narrow', () => {
    const narrow = gridGeometry(input({ viewportW: 300 }));
    const wide = gridGeometry(input({ viewportW: 3000 }));
    expect(narrow.columns).toBe(1);
    expect(wide.columns).toBeGreaterThan(1);
  });

  it('rows: ceil(n/c), and 1 + ceil((n-1)/c) with the cover alone', () => {
    const vw = 2 * LETTER_W1 * 0.5 + READING_PAGE_GAP * 0.5 + FIT_WIDTH_GUTTER + 1;
    const g = gridGeometry(input({ viewportW: vw }));
    expect(g.columns).toBe(2);
    expect(g.rowCount).toBe(5);
    const gc = gridGeometry(input({ viewportW: vw, coverAlone: true }));
    expect(gc.rowCount).toBe(6);
  });

  it('paged slots are at least one viewport tall; continuous slots are one row', () => {
    const c = gridGeometry(input({ zoom: 0.3 }));
    expect(c.slotH).toBe(c.rowH);
    const p = gridGeometry(input({ zoom: 0.3, scrollMode: 'paged' }));
    expect(p.slotH).toBe(900);
    expect(p.contentH).toBe(p.rowCount * 900);
    const tall = gridGeometry(input({ zoom: 2, scrollMode: 'paged' }));
    expect(tall.slotH).toBe(tall.rowH);
  });

  it('content is at least the viewport wide, and the block plus the gutter when wider', () => {
    const g = gridGeometry(input({ layoutMode: 'single', zoom: 4, viewportW: 800 }));
    expect(g.contentW).toBeCloseTo(LETTER_W1 * 4 + FIT_WIDTH_GUTTER, 9);
    const small = gridGeometry(input({ layoutMode: 'single', zoom: 0.2, viewportW: 800 }));
    expect(small.contentW).toBe(800);
  });

  it('a zero-page document has no rows and a viewport-sized content box', () => {
    const g = gridGeometry(input({ pageWidthsAt1: [] }));
    expect(g.columns).toBe(1);
    expect(g.rowCount).toBe(0);
    expect(g.contentH).toBe(0);
    expect(g.contentW).toBe(1600);
    expect(hitTest(g, input({ pageWidthsAt1: [] }), 10, 10)).toBeNull();
    expect(pagedRowAt(g, 0, 900)).toBe(0);
    expect(pageRect(g, input({ pageWidthsAt1: [] }), 0)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe('partition and round trip over columns, cover and n', () => {
  it('every page lies in the row that lists it, and rows tile the document in order', () => {
    for (let vw = 200; vw <= 4000; vw += 450) {
      for (const cover of [false, true]) {
        for (let n = 0; n <= 23; n++) {
          const i = input({ pageWidthsAt1: Array.from({ length: n }, () => LETTER_W1), viewportW: vw, coverAlone: cover });
          const g = gridGeometry(i);
          const seen: number[] = [];
          for (let r = 0; r < g.rowCount; r++) {
            const pages = pagesInRowOf(g, r, cover, n);
            expect(pages.length).toBeGreaterThan(0);
            expect(pages.length).toBeLessThanOrEqual(g.columns);
            for (const p of pages) {
              expect(rowOfPage(g, p, cover)).toBe(r);
              seen.push(p);
            }
          }
          expect(seen).toEqual([...Array(n).keys()]);
          expect(pagesInRowOf(g, g.rowCount, cover, n)).toEqual([]);
        }
      }
    }
  });
});

describe('pageRect — centring', () => {
  const vw = 3 * LETTER_W1 * 0.5 + 2 * READING_PAGE_GAP * 0.5 + FIT_WIDTH_GUTTER + 200;

  it('centres the block of columns in the content', () => {
    const i = input({ viewportW: vw });
    const g = gridGeometry(i);
    expect(g.columns).toBe(3);
    const first = pageRect(g, i, 0);
    const last = pageRect(g, i, 2);
    const leftMargin = first.left;
    const rightMargin = g.contentW - (last.left + last.width);
    expect(leftMargin).toBeCloseTo(rightMargin, 9);
  });

  it('centres a narrower page inside its column', () => {
    const widths = [LANDSCAPE_W1, LETTER_W1, LETTER_W1];
    const i = input({ pageWidthsAt1: widths, viewportW: 4000 });
    const g = gridGeometry(i);
    expect(g.columns).toBe(3);
    const r = pageRect(g, i, 1);
    const blockLeft = (g.contentW - g.blockW) / 2;
    const cellLeft = blockLeft + (g.colW + g.gap);
    expect(r.left - cellLeft).toBeCloseTo(cellLeft + g.colW - (r.left + r.width), 9);
  });

  it('single layout centres every page on the content', () => {
    const widths = [LETTER_W1, LANDSCAPE_W1];
    const i = input({ pageWidthsAt1: widths, layoutMode: 'single', viewportW: 1200 });
    const g = gridGeometry(i);
    for (const p of [0, 1]) {
      const r = pageRect(g, i, p);
      expect(r.left + r.width / 2).toBeCloseTo(g.contentW / 2, 9);
    }
  });

  it('centres the cover alone on the content', () => {
    const i = input({ viewportW: vw, coverAlone: true });
    const g = gridGeometry(i);
    const r = pageRect(g, i, 0);
    expect(r.left + r.width / 2).toBeCloseTo(g.contentW / 2, 9);
    expect(pageRect(g, i, 1).top).toBeCloseTo(g.slotH, 9);
  });

  it('aligns a partial last row to the column grid from the reading-start side', () => {
    const i = input({ viewportW: vw, pageWidthsAt1: Array.from({ length: 4 }, () => LETTER_W1) });
    const g = gridGeometry(i);
    expect(g.columns).toBe(3);
    expect(pageRect(g, i, 3).left).toBeCloseTo(pageRect(g, i, 0).left, 9);
    const rtl = { ...i, direction: 'r2l' as const };
    const gr = gridGeometry(rtl);
    expect(pageRect(gr, rtl, 3).left).toBeCloseTo(pageRect(gr, rtl, 0).left, 9);
    expect(pageRect(gr, rtl, 0).left).toBeCloseTo(pageRect(g, i, 2).left, 9);
  });

  it('right-to-left mirrors the column order', () => {
    const i = input({ viewportW: vw });
    const rtl = { ...i, direction: 'r2l' as const };
    const g = gridGeometry(i);
    for (const p of [0, 1, 2, 3, 4, 5]) {
      const a = pageRect(g, i, p);
      const b = pageRect(g, rtl, p);
      expect(b.left + b.width / 2).toBeCloseTo(g.contentW - (a.left + a.width / 2), 9);
      expect(b.top).toBe(a.top);
    }
  });

  it('paged rows centre a page shorter than the viewport in its slot', () => {
    const i = input({ scrollMode: 'paged', zoom: 0.4 });
    const g = gridGeometry(i);
    const r = pageRect(g, i, 0);
    expect(r.top).toBeCloseTo((900 - g.pageH) / 2, 9);
    const row1 = pageRect(g, i, g.columns);
    expect(row1.top - r.top).toBeCloseTo(g.slotH, 9);
  });
});

describe('fitZoom', () => {
  const { availW, availH } = fitAvailable(1000, 800);

  it('Fit Width makes the widest page fill the available width', () => {
    const z = fitZoom('fitWidth', availW, availH, LETTER_W1);
    expect(LETTER_W1 * z).toBeCloseTo(availW, 9);
    const g = gridGeometry(input({ layoutMode: 'single', zoom: z, viewportW: 1000, viewportH: 800 }));
    expect(g.contentW).toBeCloseTo(1000, 9);
  });

  it('Fit Height makes one page fill the available height', () => {
    const z = fitZoom('fitHeight', availW, availH, LETTER_W1);
    expect(READING_BASE_HEIGHT * z).toBeCloseTo(800 - 2 * READING_PAGE_GAP, 9);
  });

  it('Fit Page is the smaller of the two', () => {
    const z = fitZoom('fitPage', availW, availH, LANDSCAPE_W1);
    expect(z).toBeCloseTo(
      Math.min(fitZoom('fitWidth', availW, availH, LANDSCAPE_W1), fitZoom('fitHeight', availW, availH, LANDSCAPE_W1)),
      12,
    );
  });

  it('clamps into the shared zoom range', () => {
    expect(fitZoom('fitWidth', 1e9, 800, 1)).toBeLessThanOrEqual(Math.min(MAX_ZOOM, maxZoomFor(1, 1)));
    expect(fitZoom('fitHeight', 1, 1, LETTER_W1)).toBe(MIN_ZOOM);
    const huge = fitZoom('fitHeight', 1e9, 1e9, LETTER_W1);
    expect(huge).toBe(MAX_ZOOM);
  });

  it('answers 0 before the pane is measured', () => {
    expect(fitZoom('fitWidth', -16, -48, LETTER_W1)).toBe(0);
    expect(fitZoom('fitPage', 500, -48, LETTER_W1)).toBe(0);
    expect(fitZoom('fitWidth', 500, 500, 0)).toBe(0);
  });
});

describe('zoomForColumns', () => {
  it('zoomForColumns(2) yields exactly 2 columns', () => {
    for (const vw of [600, 977, 1280, 1920, 3841]) {
      const { availW } = fitAvailable(vw, 900);
      for (const w1 of [LETTER_W1, LANDSCAPE_W1, 333.3]) {
        const z = zoomForColumns(2, availW, w1);
        const g = gridGeometry(input({ pageWidthsAt1: [w1, w1, w1, w1], zoom: z, viewportW: vw }));
        expect(g.columns).toBe(2);
      }
    }
  });

  it('answers 0 for degenerate input', () => {
    expect(zoomForColumns(0, 900, LETTER_W1)).toBe(0);
    expect(zoomForColumns(2, 0, LETTER_W1)).toBe(0);
    expect(zoomForColumns(2, 900, 0)).toBe(0);
  });
});

describe('hitTest + anchoredScroll — cursor-anchored zoom', () => {
  const widths = [LETTER_W1, LANDSCAPE_W1, LETTER_W1, LETTER_W1, LANDSCAPE_W1, LETTER_W1, LETTER_W1];

  function anchorRoundTrip(before: GridInput, after: GridInput, pointer: { x: number; y: number }, scroll: { left: number; top: number }) {
    const g0 = gridGeometry(before);
    const hit = hitTest(g0, before, scroll.left + pointer.x, scroll.top + pointer.y)!;
    const g1 = gridGeometry(after);
    const res = anchoredScroll(g1, after, hit, pointer, { w: after.viewportW, h: after.viewportH });
    return { g0, g1, hit, res };
  }

  it('keeps the document point under the pointer exactly when the column count is unchanged', () => {
    const before = input({ pageWidthsAt1: widths, layoutMode: 'single', zoom: 1, viewportW: 900, viewportH: 700 });
    const after = { ...before, zoom: 1.37 };
    const pointer = { x: 412, y: 233 };
    const scroll = { left: 40, top: 1500 };
    const { g0, g1, hit, res } = anchorRoundTrip(before, after, pointer, scroll);
    expect(g0.columns).toBe(g1.columns);
    const r1 = pageRect(g1, after, hit.pageIndex);
    expect(r1.left + hit.u * r1.width - res.left).toBeCloseTo(pointer.x, 6);
    expect(r1.top + hit.v * r1.height - res.topVirtual).toBeCloseTo(pointer.y, 6);
  });

  it('is exact vertically in a multi-column grid when the zoom keeps the column count', () => {
    const before = input({ pageWidthsAt1: [...widths, ...widths, ...widths, ...widths], zoom: 0.3, viewportW: 1400, viewportH: 800 });
    const after = { ...before, zoom: 0.31 };
    const pointer = { x: 700, y: 400 };
    const scroll = { left: 0, top: 200 };
    const { g0, g1, hit, res } = anchorRoundTrip(before, after, pointer, scroll);
    expect(g0.columns).toBe(3);
    expect(g1.columns).toBe(3);
    const r1 = pageRect(g1, after, hit.pageIndex);
    expect(r1.top + hit.v * r1.height - res.topVirtual).toBeCloseTo(pointer.y, 6);
    // The grid fits the pane, so there is no horizontal range to anchor in.
    expect(g1.contentW).toBe(1400);
    expect(res.left).toBe(0);
  });

  it('keeps the anchored page under the pointer across a reflow', () => {
    const before = input({ pageWidthsAt1: widths, zoom: 0.3, viewportW: 1400, viewportH: 800 });
    const after = { ...before, zoom: 0.45 };
    const pointer = { x: 700, y: 300 };
    const { g0, g1, hit, res } = anchorRoundTrip(before, after, pointer, { left: 0, top: 0 });
    expect(g1.columns).toBeLessThan(g0.columns);
    const r1 = pageRect(g1, after, hit.pageIndex);
    const y = pointer.y + res.topVirtual;
    expect(y).toBeGreaterThanOrEqual(r1.top - 1e-6);
    expect(y).toBeLessThanOrEqual(r1.top + r1.height + 1e-6);
  });

  it('clamps to the scrollable range', () => {
    const before = input({ pageWidthsAt1: widths, layoutMode: 'single', zoom: 1, viewportW: 900, viewportH: 700 });
    const after = { ...before, zoom: 0.1 };
    const { g1, res } = anchorRoundTrip(before, after, { x: 450, y: 350 }, { left: 0, top: 4000 });
    expect(res.left).toBe(0);
    expect(res.topVirtual).toBeGreaterThanOrEqual(0);
    expect(res.topVirtual).toBeLessThanOrEqual(Math.max(0, g1.contentH - 700));
  });

  it('a point in a gap resolves to the nearest page, with an unclamped offset', () => {
    const i = input({ pageWidthsAt1: widths, layoutMode: 'single', zoom: 1, viewportW: 2000 });
    const g = gridGeometry(i);
    const hitGap = hitTest(g, i, g.contentW / 2, g.pageH + 2)!;
    expect(hitGap.pageIndex).toBe(0);
    expect(hitGap.v).toBeGreaterThan(1);
    const hitNext = hitTest(g, i, g.contentW / 2, g.rowH - 2)!;
    expect(hitNext.pageIndex).toBe(1);
    expect(hitNext.v).toBeLessThan(0);
    const left = hitTest(g, i, 0, 10)!;
    expect(left.u).toBeLessThan(0);
  });
});

describe('pagedRowAt', () => {
  it('names the slot that holds the viewport centre, clamped to the rows', () => {
    const i = input({ scrollMode: 'paged', zoom: 0.4, viewportW: 600 });
    const g = gridGeometry(i);
    expect(pagedRowAt(g, 0, 900)).toBe(0);
    expect(pagedRowAt(g, 900, 900)).toBe(1);
    expect(pagedRowAt(g, 900 + 449, 900)).toBe(1);
    expect(pagedRowAt(g, 900 + 451, 900)).toBe(2);
    expect(pagedRowAt(g, -500, 900)).toBe(0);
    expect(pagedRowAt(g, 1e9, 900)).toBe(g.rowCount - 1);
  });
});

describe('wheelStep — paged hysteresis', () => {
  it('accumulates small deltas until the threshold, then steps once', () => {
    let s = { acc: 0, lockedUntil: 0 };
    let steps = 0;
    for (let t = 0; t < 5; t++) {
      const r = wheelStep(s, 15, 1000 + t * 10);
      s = r.s;
      steps += Math.abs(r.step);
    }
    expect(steps).toBe(1);
  });

  it('ignores deltas during the lock, then steps again', () => {
    const a = wheelStep({ acc: 0, lockedUntil: 0 }, 120, 1000);
    expect(a.step).toBe(1);
    const b = wheelStep(a.s, 120, 1000 + WHEEL_STEP_LOCK_MS - 1);
    expect(b.step).toBe(0);
    const c = wheelStep(b.s, 120, 1000 + WHEEL_STEP_LOCK_MS + 1);
    expect(c.step).toBe(1);
  });

  it('steps backward on negative deltas, and a reversal restarts the count', () => {
    const a = wheelStep({ acc: 0, lockedUntil: 0 }, WHEEL_STEP_THRESHOLD - 1, 0);
    expect(a.step).toBe(0);
    const b = wheelStep(a.s, -(WHEEL_STEP_THRESHOLD - 1), 10);
    expect(b.step).toBe(0);
    const c = wheelStep(b.s, -2, 20);
    expect(c.step).toBe(-1);
  });

  it('an idle pause forgets the partial distance', () => {
    const a = wheelStep({ acc: 0, lockedUntil: 0 }, 40, 0);
    const b = wheelStep(a.s, 40, 10_000);
    expect(b.step).toBe(0);
  });

  it('normalizes line and page delta modes', () => {
    expect(wheelDeltaPx(3, 0, 800)).toBe(3);
    expect(wheelDeltaPx(3, 1, 800)).toBe(48);
    expect(wheelDeltaPx(1, 2, 800)).toBe(800);
  });
});

describe('the scaled-map round trip', () => {
  it('slotted content past the element cap converts virtual ↔ real with exact endpoints', () => {
    const n = 40_000;
    const i = input({ pageWidthsAt1: Array.from({ length: n }, () => LETTER_W1), layoutMode: 'single', scrollMode: 'paged', zoom: 1, viewportH: 900 });
    const g = gridGeometry(i);
    expect(g.contentH).toBeGreaterThan(SAFE_ELEMENT_EXTENT);
    const map = scrollMapFor(g.contentH, 900);
    expect(map.k).toBeGreaterThan(1);
    for (const r of [0, 1, 17, n / 2, n - 1]) {
      const top = r * g.slotH;
      const real = realTopFor(top, map);
      expect(virtualTopOf(real, map)).toBeCloseTo(top, 3);
      expect(pagedRowAt(g, virtualTopOf(real, map), 900)).toBe(r);
    }
    expect(realTopFor(g.contentH - 900, map)).toBeCloseTo(map.spacerHeight - 900, 3);
  });

  it('widestOf is 0 for no pages and the maximum otherwise', () => {
    expect(widestOf([])).toBe(0);
    expect(widestOf([3, 9, 1])).toBe(9);
  });
});

describe('pagedTarget — paged moves', () => {
  // zoom 2: rowH = 1968 > viewport 900, so every slot is a tall row.
  const tall = input({ layoutMode: 'single', scrollMode: 'paged', zoom: 2, viewportW: 2000, pageWidthsAt1: [LETTER_W1, LETTER_W1, LETTER_W1] });
  const gt = gridGeometry(tall);
  const lastTop = 2 * gt.slotH;
  const lastEnd = lastTop + gt.slotH - 900;

  it('a forward step at the bottom of the last tall row stays at its bottom', () => {
    expect(pagedTarget(gt, lastEnd, 900, 1, 0)).toBe(lastEnd);
    expect(pagedTarget(gt, lastEnd, 900, 1, 810)).toBe(lastEnd);
  });

  it('a back step at the top of the first row stays at its top', () => {
    expect(pagedTarget(gt, 0, 900, -1, 0)).toBe(0);
    expect(pagedTarget(gt, 0, 900, -1, 810)).toBe(0);
  });

  it('scrolls inside a tall row before stepping, clamped to the row', () => {
    expect(pagedTarget(gt, 0, 900, 1, 810)).toBe(810);
    expect(pagedTarget(gt, gt.slotH - 950, 900, 1, 810)).toBe(gt.slotH - 900);
    expect(pagedTarget(gt, gt.slotH - 900, 900, 1, 810)).toBe(gt.slotH);
  });

  it('stepping back into a tall row lands at its end', () => {
    expect(pagedTarget(gt, gt.slotH, 900, -1, 0)).toBe(gt.slotH - 900);
  });

  it('short rows step slot to slot; Home and End go to the ends', () => {
    const short = input({ layoutMode: 'single', scrollMode: 'paged', zoom: 0.4, viewportW: 600 });
    const g = gridGeometry(short);
    expect(pagedTarget(g, 0, 900, 1, 810)).toBe(900);
    expect(pagedTarget(g, 900, 900, -1, 810)).toBe(0);
    expect(pagedTarget(g, (g.rowCount - 1) * 900, 900, 1, 0)).toBe((g.rowCount - 1) * 900);
    expect(pagedTarget(g, 4000, 900, 'home', 0)).toBe(0);
    expect(pagedTarget(g, 0, 900, 'end', 0)).toBe((g.rowCount - 1) * 900);
  });

  it('answers null for an empty document', () => {
    const empty = input({ pageWidthsAt1: [], scrollMode: 'paged' });
    expect(pagedTarget(gridGeometry(empty), 0, 900, 1, 0)).toBeNull();
  });
});

describe('fitAvailableHeight — a fixed point under a horizontal scrollbar', () => {
  const BAR = 8;

  it('keeps the full height when the fitted page fits the width', () => {
    expect(fitAvailableHeight(900, 2000, LETTER_W1, BAR)).toBe(900 - 2 * READING_PAGE_GAP);
  });

  it('reserves the scrollbar when the fitted page would overflow the width', () => {
    expect(fitAvailableHeight(900, 300, LANDSCAPE_W1, BAR)).toBe(900 - 2 * READING_PAGE_GAP - BAR);
  });

  it('the solved page always fits the height the scrollbar it causes leaves', () => {
    for (let vw = 300; vw <= 1600; vw += 1) {
      const z = fitZoom('fitHeight', vw - FIT_WIDTH_GUTTER, fitAvailableHeight(900, vw, LANDSCAPE_W1, BAR), LANDSCAPE_W1);
      const overflows = LANDSCAPE_W1 * z + FIT_WIDTH_GUTTER > vw + 0.5;
      const clientH = 900 - (overflows ? BAR : 0);
      expect(READING_BASE_HEIGHT * z + 2 * READING_PAGE_GAP).toBeLessThanOrEqual(clientH + 1e-9);
    }
  });
});

describe('pageInView — the page a view is on', () => {
  const widths = Array.from({ length: 12 }, () => LETTER_W1);

  it('continuous: the leading page of the row nearest the viewport centre', () => {
    const i = input({ pageWidthsAt1: widths, layoutMode: 'single', zoom: 0.5, viewportW: 900, viewportH: 600 });
    const g = gridGeometry(i);
    expect(pageInView(g, i, 0, null, null)).toEqual({ page: 1, anchored: false });
    expect(pageInView(g, i, 5 * g.slotH, null, null).page).toBe(6);
  });

  it('paged: the leading page of the row whose slot holds the viewport centre', () => {
    const i = input({ pageWidthsAt1: widths, zoom: 0.3, viewportW: 1400, viewportH: 600, scrollMode: 'paged', coverAlone: true });
    const g = gridGeometry(i);
    expect(g.columns).toBeGreaterThan(1);
    expect(pageInView(g, i, g.slotH, null, null).page).toBe(2);
    expect(pageInView(g, i, 2 * g.slotH, null, null).page).toBe(2 + g.columns);
  });

  it('a holding jump anchor wins; one whose page moved does not', () => {
    const i = input({ pageWidthsAt1: widths, layoutMode: 'single', zoom: 0.5, viewportW: 900, viewportH: 600 });
    const g = gridGeometry(i);
    const anchor = { scrollTop: 0, page: 2, pageId: 'p2', rowH: g.slotH, viewportH: 600 };
    expect(pageInView(g, i, 0, anchor, 'p2')).toEqual({ page: 2, anchored: true });
    expect(pageInView(g, i, 0, anchor, 'other')).toEqual({ page: 1, anchored: false });
  });

  it('an empty or unmeasured view is on page 1', () => {
    const e = input({ pageWidthsAt1: [] });
    expect(pageInView(gridGeometry(e), e, 0, null, null)).toEqual({ page: 1, anchored: false });
    const u = input({ viewportH: 0 });
    expect(pageInView(gridGeometry(u), u, 0, null, null)).toEqual({ page: 1, anchored: false });
  });
});

describe('linked quad geometry', () => {
  const n = 20;
  const pages = Array.from({ length: n }, () => LETTER_W1);
  // A dragged divider: 800 px and 300 px wide panes, 400 and 230 px tall rows.
  const box = (w: number, h: number) => ({ viewportW: w, viewportH: h });
  const basisOf = (w: number, h: number) => {
    const { availW } = fitAvailable(w, h);
    return { availW, availH: fitAvailableHeight(h, w, LETTER_W1, 8), viewportH: h };
  };
  const bases = { a: basisOf(800, 400), b: basisOf(300, 400), c: basisOf(800, 230), d: basisOf(300, 230) };
  const shared = linkQuadGeometry(bases)!;
  const paneInput = (p: 'a' | 'b' | 'c' | 'd', w: number, h: number, over: Partial<GridInput>): GridInput => {
    const fitZ = fitZoom('fitWidth', shared[p].availW, shared[p].availH, LETTER_W1);
    return input({
      pageWidthsAt1: pages,
      zoom: fitZ,
      ...box(w, h),
      linked: { availW: shared[p].availW, slotViewportH: shared[p].slotViewportH },
      ...over,
    });
  };
  const vertical = (g: ReturnType<typeof gridGeometry>) => ({
    columns: g.columns,
    colW: g.colW,
    gap: g.gap,
    pageH: g.pageH,
    rowH: g.rowH,
    slotH: g.slotH,
    rowCount: g.rowCount,
    contentH: g.contentH,
  });

  it('is null until all four panes are measured', () => {
    expect(linkQuadGeometry({ a: bases.a, b: bases.b, c: bases.c })).toBeNull();
    expect(linkQuadGeometry({ ...bases, d: { availW: 0, availH: 10, viewportH: 10 } })).toBeNull();
  });

  it('shares the smallest fit box with all four panes and the shorter height with each row', () => {
    expect(shared.a.availW).toBe(bases.b.availW);
    expect(shared.d.availW).toBe(bases.b.availW);
    expect(shared.a.availH).toBe(Math.min(bases.a.availH, bases.b.availH, bases.c.availH, bases.d.availH));
    expect(shared.a.slotViewportH).toBe(400);
    expect(shared.b.slotViewportH).toBe(400);
    expect(shared.c.slotViewportH).toBe(230);
    expect(shared.d.slotViewportH).toBe(230);
  });

  it('row partners of different widths get identical vertical geometry and the same page at a mirrored scrollTop', () => {
    for (const layoutMode of ['single', 'grid'] as const) {
      for (const scrollMode of ['continuous', 'paged'] as const) {
        for (const coverAlone of [false, true]) {
          const over = { layoutMode, scrollMode, coverAlone, zoom: 0.3 };
          const ia = paneInput('a', 800, 400, over);
          const ib = paneInput('b', 300, 392, over);
          const ga = gridGeometry(ia);
          const gb = gridGeometry(ib);
          expect(vertical(gb)).toEqual(vertical(ga));
          for (let p = 0; p < n; p++) expect(pageRect(gb, ib, p).top).toBe(pageRect(ga, ia, p).top);
          for (const top of [0, 3 * ga.slotH, 885.6, ga.contentH / 2]) {
            expect(pageInView(gb, ib, top, null, null).page).toBe(pageInView(ga, ia, top, null, null).page);
          }
        }
      }
    }
  });

  it('a broadcast fit resolves to one zoom in every pane', () => {
    for (const mode of ['fitWidth', 'fitHeight', 'fitPage'] as const) {
      const zs = (['a', 'b', 'c', 'd'] as const).map((p) =>
        fitZoom(mode, shared[p].availW, shared[p].availH, LETTER_W1),
      );
      expect(new Set(zs).size).toBe(1);
      // No pane overflows a shared fit.
      expect(zs[0] * LETTER_W1).toBeLessThanOrEqual(bases.b.availW + 1e-9);
    }
  });

  it('column partners of different heights get identical horizontal geometry', () => {
    for (const coverAlone of [false, true]) {
      const ia = paneInput('a', 800, 400, { coverAlone, zoom: 2 });
      const ic = paneInput('c', 800, 230, { coverAlone, zoom: 2 });
      const ga = gridGeometry(ia);
      const gc = gridGeometry(ic);
      expect(gc.contentW).toBe(ga.contentW);
      expect(gc.columns).toBe(ga.columns);
      for (let p = 0; p < n; p++) expect(pageRect(gc, ic, p).left).toBe(pageRect(ga, ia, p).left);
    }
  });

  it('without the link the same divider gives unequal rows (the defect the link removes)', () => {
    const left = input({ pageWidthsAt1: pages, zoom: 0.3, ...box(800, 400) });
    const right = input({ pageWidthsAt1: pages, zoom: 0.3, ...box(300, 400) });
    expect(gridGeometry(left).columns).not.toBe(gridGeometry(right).columns);
  });
});

describe('quadLinkAxes', () => {
  it('row partners share y, column partners share x, diagonals share nothing', () => {
    expect(quadLinkAxes('a', 'b')).toEqual({ x: false, y: true });
    expect(quadLinkAxes('c', 'd')).toEqual({ x: false, y: true });
    expect(quadLinkAxes('a', 'c')).toEqual({ x: true, y: false });
    expect(quadLinkAxes('d', 'b')).toEqual({ x: true, y: false });
    expect(quadLinkAxes('a', 'd')).toEqual({ x: false, y: false });
    expect(quadLinkAxes('b', 'c')).toEqual({ x: false, y: false });
  });
});

describe('linked zoom — following a sibling keeps the mirrored axis equal', () => {
  // The origin anchors at its pointer; a follower anchors on the origin's hit
  // and pointer on the axis it mirrors and at its own centre on the other.
  // Same geometry on the mirrored axis gives the same offset there.
  const pages = Array.from({ length: 20 }, () => LETTER_W1);
  const linked = { availW: 284, slotViewportH: 400 };
  const pre = (w: number, h: number): GridInput =>
    input({ pageWidthsAt1: pages, zoom: 0.5, coverAlone: true, viewportW: w, viewportH: h, linked });

  it('a row partner lands on the origin scrollTop; a column partner on its scrollLeft', () => {
    const z1 = 0.9;
    // Origin a: 800 × 400; row partner b: 300 × 400; column partner c: 800 × 250.
    const ia = pre(800, 400);
    const ga = gridGeometry(ia);
    const scroll = { left: 40, top: 700 };
    const pointer = { x: 610, y: 123 };
    const hit = hitTest(ga, ia, scroll.left + pointer.x, scroll.top + pointer.y)!;
    const ia1 = { ...ia, zoom: z1 };
    const resA = anchoredScroll(gridGeometry(ia1), ia1, hit, pointer, { w: 800, h: 400 });

    const ib1 = { ...pre(300, 400), zoom: z1 };
    const resB = anchoredScroll(gridGeometry(ib1), ib1, hit, { x: 150, y: pointer.y }, { w: 300, h: 400 });
    expect(resB.topVirtual).toBe(resA.topVirtual);

    const ic1 = { ...pre(800, 250), zoom: z1 };
    const resC = anchoredScroll(gridGeometry(ic1), ic1, hit, { x: pointer.x, y: 125 }, { w: 800, h: 250 });
    expect(resC.left).toBe(resA.left);
  });
});

describe('steppedZoom — monotonic steppers', () => {
  const range = { min: 0.01, max: 50 };

  it('steps inside the range', () => {
    expect(steppedZoom(1, 1.2, range)).toBeCloseTo(1.2, 12);
    expect(steppedZoom(1, 1 / 1.2, range)).toBeCloseTo(1 / 1.2, 12);
  });

  it('clamps a step that crosses a bound to that bound', () => {
    expect(steppedZoom(0.011, 0.5, range)).toBe(0.01);
    expect(steppedZoom(45, 2, range)).toBe(50);
  });

  it('a zoom out from at or below the floor keeps the zoom', () => {
    // A Fit Page of an extreme page renders below the 1% floor.
    expect(steppedZoom(0.004, 1 / 1.2, range)).toBe(0.004);
    expect(steppedZoom(0.01, 1 / 1.2, range)).toBe(0.01);
  });

  it('a zoom in from at or above the ceiling keeps the zoom', () => {
    expect(steppedZoom(80, 1.2, range)).toBe(80);
    expect(steppedZoom(50, 1.2, range)).toBe(50);
  });

  it('a step from outside the range toward it moves in the step direction', () => {
    expect(steppedZoom(0.004, 1.2, range)).toBe(0.01);
    expect(steppedZoom(80, 1 / 1.2, range)).toBe(50);
  });

  it('never moves against the step', () => {
    for (const base of [0.001, 0.004, 0.01, 0.3, 1, 49, 50, 80, 1000]) {
      for (const f of [1.2, 2, 1 / 1.2, 0.5]) {
        const z = steppedZoom(base, f, range);
        if (f > 1) expect(z).toBeGreaterThanOrEqual(base);
        else expect(z).toBeLessThanOrEqual(base);
      }
    }
  });
});

describe('viewportCentre — the zoom anchor of quad row partners', () => {
  // Pane c (822 px) has no horizontal scrollbar at Actual Size; pane d
  // (315 px) has one, so their client heights differ by its thickness.
  const pages = Array.from({ length: 24 }, () => LETTER_W1);
  const shared = { availW: 299, availH: 196, slotViewportH: 244 };
  const pane = (w: number, h: number, zoom: number): GridInput =>
    input({
      pageWidthsAt1: pages,
      layoutMode: 'single',
      zoom,
      viewportW: w,
      viewportH: h,
      linked: { availW: shared.availW, slotViewportH: shared.slotViewportH },
    });
  const zoomAtCentre = (w: number, h: number, centre: { x: number; y: number }, top: number): number => {
    const before = pane(w, h, 0.825);
    const hit = hitTest(gridGeometry(before), before, 0 + centre.x, top + centre.y)!;
    const after = pane(w, h, 0.825 * 2.83);
    return anchoredScroll(gridGeometry(after), after, hit, centre, { w, h }).topVirtual;
  };

  it('row partners anchor at the same height and land on the same offset', () => {
    const c = viewportCentre(822, 252, shared);
    const d = viewportCentre(315, 244, shared);
    expect(c.y).toBe(d.y);
    expect(zoomAtCentre(822, 252, c, 7000)).toBe(zoomAtCentre(315, 244, d, 7000));
  });

  it('their own client heights would drift apart by the scrollbar times the zoom ratio', () => {
    const c = viewportCentre(822, 252);
    const d = viewportCentre(315, 244);
    const drift = zoomAtCentre(822, 252, c, 7000) - zoomAtCentre(315, 244, d, 7000);
    expect(Math.abs(drift)).toBeGreaterThan(6);
  });

  it('an unlinked pane anchors at its own centre', () => {
    expect(viewportCentre(800, 600)).toEqual({ x: 400, y: 300 });
    expect(viewportCentre(800, 600, null)).toEqual({ x: 400, y: 300 });
  });
});

describe('jumpTop + pageInView — a jump reads the page it meant', () => {
  // The 34-hand-tool fixture: five Letter pages, continuous, Fit Page in a
  // pane about one page tall.
  const pages = Array.from({ length: 5 }, () => LETTER_W1);
  const at = (vh: number, zoom: number, scrollMode: 'continuous' | 'paged' = 'continuous'): GridInput =>
    input({ pageWidthsAt1: pages, layoutMode: 'single', zoom, viewportW: 1200, viewportH: vh, scrollMode });
  const fitPage = (vh: number): number =>
    fitZoom('fitPage', 1200 - FIT_WIDTH_GUTTER, vh - 2 * READING_PAGE_GAP, LETTER_W1);

  it('every unclamped landing names its page, without an anchor', () => {
    for (const vh of [500, 600, 640, 700, 786, 900]) {
      for (const scrollMode of ['continuous', 'paged'] as const) {
        const i = at(vh, fitPage(vh), scrollMode);
        const g = gridGeometry(i);
        for (let p = 0; p < 5; p++) {
          const top = jumpTop(g, i, p, vh);
          if (top <= 0 || top >= g.contentH - vh) continue; // the extremes need the jump anchor
          expect(pageInView(g, i, top, null, null).page).toBe(p + 1);
        }
      }
    }
  });

  it('a viewport top exactly on a row boundary names the row that starts there', () => {
    const vh = 700;
    const i = at(vh, fitPage(vh));
    const g = gridGeometry(i);
    expect(pageInView(g, i, 2 * g.rowH, null, null).page).toBe(3);
    expect(pageInView(g, i, 2 * g.rowH - 1, null, null).page).toBe(3);
    expect(pageInView(g, i, g.rowH + 1, null, null).page).toBe(2);
  });

  it('an offset computed before the fit resolved lands a page late (why an unmeasured jump waits)', () => {
    const vh = 700;
    const unmeasured = at(vh, 1);
    const top = jumpTop(gridGeometry(unmeasured), unmeasured, 2, vh);
    const measured = at(vh, fitPage(vh));
    expect(pageInView(gridGeometry(measured), measured, top, null, null).page).toBe(4);
    expect(pageInView(gridGeometry(measured), measured, jumpTop(gridGeometry(measured), measured, 2, vh), null, null).page).toBe(3);
  });
});
