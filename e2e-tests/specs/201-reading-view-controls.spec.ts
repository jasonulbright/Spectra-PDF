import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  focusTab,
  getState,
  setView,
  invokeAppCommand,
  setReactInputValue,
  clearViewHistory,
  getReadingView,
  readingViewDom,
  waitForReadingView,
  waitForPressed,
  setReadingZoomPercent,
  readingPageBox,
  readingCells,
  readingWheel,
  type ReadingViewDom,
} from '../support/harness.js';

// The reading view's control group in the status bar: zoom steppers around a
// percent box, the Fit presets, the page layout and the scrolling mode. Every
// assertion reads what the pane states about itself (its data attributes and
// geometry) or what the reading-view store holds, never the controls' own
// labels. Split-pane links are covered in 73-split-view and 85-spreadsheet-split.

/** US Letter: at 100% a page measures 612 by 792 CSS pixels. */
const LETTER: [number, number] = [612, 792];

async function makeLetterPdf(path: string, pages: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage(LETTER);
    page.drawText(`Page ${i}`, { x: 72, y: 700, size: 48, font });
  }
  writeFileSync(path, await doc.save());
}

/** The current page's box, re-resolving the page id on every read. */
async function currentPageBox(): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const id = (await getState()).currentPageId;
  return id ? await readingPageBox(id) : null;
}

async function waitForPage(
  predicate: (
    page: { left: number; top: number; width: number; height: number },
    view: ReadingViewDom,
  ) => boolean,
  timeoutMsg: string,
): Promise<void> {
  let last: unknown = null;
  try {
    await browser.waitUntil(
      async () => {
        const view = await readingViewDom();
        const page = await currentPageBox();
        last = { view, page };
        return view !== null && page !== null && predicate(page, view);
      },
      { timeout: 10_000, interval: 100 },
    );
  } catch {
    throw new Error(`${timeoutMsg}; last read: ${JSON.stringify(last)}`);
  }
}

/** The page sits inside the pane's client box on both axes. */
function inside(page: { left: number; top: number; width: number; height: number }, view: ReadingViewDom): boolean {
  return (
    page.left >= view.box.left - 1 &&
    page.left + page.width <= view.box.left + view.box.width + 1 &&
    page.top >= view.box.top - 1 &&
    page.top + page.height <= view.box.top + view.box.height + 1
  );
}

/** Equal space on both sides of the page inside the pane. */
function centredHorizontally(
  page: { left: number; width: number },
  view: ReadingViewDom,
): boolean {
  const before = page.left - view.box.left;
  const after = view.box.left + view.box.width - (page.left + page.width);
  return Math.abs(before - after) <= 2;
}

async function goToPage(n: number): Promise<void> {
  await $('[data-testid="page-nav-box"]').click();
  await setReactInputValue('[data-testid="page-nav-box"]', String(n));
  await browser.keys(['Enter']);
  await waitForReadingView((v) => v.currentPage === n, `the pane never reached page ${n}`);
}

async function pickFit(testid: string): Promise<void> {
  await $('[data-testid="reading-fit-menu"]').click();
  await $(`[data-testid="${testid}"]`).waitForDisplayed({ timeout: 5_000 });
  await $(`[data-testid="${testid}"]`).click();
  await $('[data-testid="reading-fit-popover"]').waitForExist({
    reverse: true,
    timeout: 5_000,
    timeoutMsg: 'choosing a fit did not close the Fit menu',
  });
}

describe('reading view controls', () => {
  let tmp = '';
  let letter = '';
  let second = '';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-reading-'));
    letter = resolve(tmp, 'letter-12.pdf');
    second = resolve(tmp, 'second.pdf');
    await makeLetterPdf(letter, 12);
    await makeLetterPdf(second, 3);
    await waitForHarness();
    await closeAllFiles();
    await clearViewHistory();
    await openByPaths([letter]);
    await setView('canvas');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(async () => (await getReadingView()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the reading view never published its state',
    });
  });

  after(async () => {
    if ((await getState()).splitView) await invokeAppCommand('window.split');
    await closeAllFiles();
    await clearViewHistory();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('opens at Fit Page: the whole page inside the pane, centred', async () => {
    await waitForReadingView(
      (v) =>
        v.zoomMode === 'fitPage' &&
        v.layoutMode === 'single' &&
        v.scrollMode === 'continuous' &&
        v.columns === 1 &&
        v.currentPage === 1,
      'a never-seen document did not open at Fit Page, single, continuous',
      { store: (st) => st?.zoomMode === 'fitPage' && st.pageCount === 12 },
    );
    await waitForPage(
      (page, view) => inside(page, view) && centredHorizontally(page, view) && view.scrollWidth <= view.clientWidth + 1,
      'Fit Page did not show the whole page centred',
    );
  });

  it('Fit Width fills the pane width with no horizontal overflow', async () => {
    await pickFit('reading-fit-width');
    await waitForReadingView((v) => v.zoomMode === 'fitWidth', 'Fit Width was not selected');
    await waitForPage(
      (page, view) =>
        view.scrollWidth <= view.clientWidth + 1 &&
        page.width <= view.clientWidth &&
        page.width >= view.clientWidth - 16 - 3 &&
        centredHorizontally(page, view),
      'Fit Width did not size the page to the pane width',
    );
    expect(await $('[data-testid="reading-fit-menu"]').getAttribute('aria-expanded')).toBe('false');
  });

  it('Fit Height fits the page height to the pane', async () => {
    await pickFit('reading-fit-height');
    await waitForReadingView((v) => v.zoomMode === 'fitHeight', 'Fit Height was not selected');
    await waitForPage(
      (page, view) => page.height <= view.clientHeight && page.height >= view.clientHeight * 0.8,
      'Fit Height did not size the page to the pane height',
    );
  });

  it('Actual Size and 100% both show the page at its true size', async () => {
    await pickFit('reading-fit-actual');
    await waitForReadingView((v) => v.zoomMode === 'actual' && v.zoomPercent === 100, 'Actual Size was not selected');
    await waitForPage(
      (page) => Math.abs(page.width - LETTER[0]) <= 2 && Math.abs(page.height - LETTER[1]) <= 2,
      'Actual Size did not render 1 pt as 1 CSS pixel',
    );

    await setReadingZoomPercent('150');
    await waitForReadingView((v) => v.zoomMode === 'custom' && v.zoomPercent === 150, '150% did not take');
    await setReadingZoomPercent('100');
    await waitForReadingView((v) => v.zoomMode === 'custom' && v.zoomPercent === 100, '100% did not take');
    await waitForPage(
      (page) => Math.abs(page.width - LETTER[0]) <= 2 && Math.abs(page.height - LETTER[1]) <= 2,
      '100% is not the actual size',
    );
  });

  it('the percent box shows the zoom through the locale and refuses a non-number', async () => {
    await setReadingZoomPercent('150 %');
    await waitForReadingView((v) => v.zoomMode === 'custom' && v.zoomPercent === 150, '"150 %" did not take');
    const shown = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }).format(1.5);
    await browser.waitUntil(
      async () => (await $('[data-testid="reading-zoom-percent"]').getValue()) === shown,
      { timeout: 5_000, timeoutMsg: `the percent box never showed ${shown}` },
    );
    await setReadingZoomPercent('abc');
    await browser.waitUntil(
      async () => (await $('[data-testid="reading-zoom-percent"]').getValue()) === shown,
      { timeout: 5_000, timeoutMsg: 'a refused entry did not restore the shown zoom' },
    );
    expect((await readingViewDom())?.zoomPercent).toBe(150);
  });

  it('the steppers zoom in and out and leave the fit modes', async () => {
    await pickFit('reading-fit-page');
    await waitForReadingView((v) => v.zoomMode === 'fitPage', 'Fit Page was not selected');
    const start = (await readingViewDom())!.zoomPercent;
    await $('[data-testid="reading-zoom-in"]').click();
    const bigger = await waitForReadingView(
      (v) => v.zoomMode === 'custom' && v.zoomPercent > start,
      'Zoom in did not enlarge from the fitted zoom',
    );
    await $('[data-testid="reading-zoom-out"]').click();
    await waitForReadingView(
      (v) => v.zoomMode === 'custom' && v.zoomPercent < bigger.zoomPercent,
      'Zoom out did not shrink',
    );
  });

  it('the percent box, the steppers and the wheel hold the zoom between 1% and 6400%', async () => {
    await setReadingZoomPercent('1');
    await waitForReadingView(
      (v) => v.zoomMode === 'custom' && v.zoomPercent === 1,
      'a requested 1% did not render at 1%',
    );

    await setReadingZoomPercent('5000');
    await waitForReadingView((v) => v.zoomMode === 'custom' && v.zoomPercent === 5000, '5000% did not take');
    for (let i = 0; i < 8; i++) {
      const now = (await readingViewDom())!.zoomPercent;
      if (now >= 6400) break;
      await $('[data-testid="reading-zoom-in"]').click();
      await waitForReadingView((v) => v.zoomPercent > now, `zoom in did not step up from ${now}%`);
    }
    await waitForReadingView((v) => v.zoomPercent === 6400, 'stepping in did not stop at 6400%');
    await $('[data-testid="reading-zoom-in"]').click();
    await browser.pause(400);
    await waitForReadingView((v) => v.zoomPercent === 6400, 'zoom in passed the 6400% ceiling');

    const view = (await readingViewDom())!;
    const path = await readingWheel({
      x: view.box.left + view.box.width / 2,
      y: view.box.top + view.box.height / 2,
      deltaY: -100,
      modifier: 'ctrl',
    });
    console.log(`Ctrl+wheel at the ceiling delivered through the ${path} path`);
    await browser.pause(400);
    await waitForReadingView((v) => v.zoomPercent === 6400, 'Ctrl+wheel passed the 6400% ceiling');

    await pickFit('reading-fit-page');
    await waitForReadingView((v) => v.zoomMode === 'fitPage', 'Fit Page did not return after the ceiling');
  });

  it('Escape and a click outside close the Fit menu', async () => {
    const menu = $('[data-testid="reading-fit-menu"]');
    await menu.click();
    await $('[data-testid="reading-fit-popover"]').waitForDisplayed({ timeout: 5_000 });
    expect(await menu.getAttribute('aria-expanded')).toBe('true');
    await browser.keys(['Escape']);
    await $('[data-testid="reading-fit-popover"]').waitForExist({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: 'Escape did not close the Fit menu',
    });
    await menu.click();
    await $('[data-testid="reading-fit-popover"]').waitForDisplayed({ timeout: 5_000 });
    await $('[data-testid="document-view"]').click();
    await $('[data-testid="reading-fit-popover"]').waitForExist({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: 'a click outside did not close the Fit menu',
    });
  });

  it('the layout and scrolling segments press the mode they select', async () => {
    const grid = $('[data-testid="reading-layout-grid"]');
    const single = $('[data-testid="reading-layout-single"]');
    const paged = $('[data-testid="reading-scroll-paged"]');
    const continuous = $('[data-testid="reading-scroll-continuous"]');
    await grid.click();
    await waitForReadingView((v) => v.layoutMode === 'grid', 'Multiple did not select the grid');
    // The buttons render from the store, which follows the DOM on the settle beat.
    await waitForPressed(
      { 'reading-layout-grid': true, 'reading-layout-single': false },
      'Multiple is not the pressed layout',
    );
    await paged.click();
    await waitForReadingView((v) => v.scrollMode === 'paged', 'Paged did not select paged scrolling');
    await waitForPressed(
      { 'reading-scroll-paged': true, 'reading-scroll-continuous': false },
      'Paged is not the pressed scrolling mode',
    );
    await single.click();
    await continuous.click();
    await waitForReadingView(
      (v) => v.layoutMode === 'single' && v.scrollMode === 'continuous' && v.columns === 1,
      'Single and Continuous did not come back',
    );
    await waitForPressed(
      {
        'reading-layout-single': true,
        'reading-layout-grid': false,
        'reading-scroll-continuous': true,
        'reading-scroll-paged': false,
      },
      'Single and Continuous are not the pressed modes',
    );
  });

  /**
   * The grid's column count is the most whole columns the pane width holds:
   * the block of columns fits, and one more column would not. Measured from
   * the first row: its cell count, the column pitch and the cell width.
   */
  async function gridHolds(): Promise<{ columns: number; clientWidth: number }> {
    let result = { columns: 0, clientWidth: 0 };
    let last: unknown = null;
    try {
      await browser.waitUntil(
        async () => {
          const view = await readingViewDom();
          const cells = await readingCells();
          last = { view, cells: cells.slice(0, 8) };
          if (!view || view.layoutMode !== 'grid' || cells.length < 2) return false;
          const first = cells.filter((c) => c.top === cells[0].top);
          if (first.length !== view.columns) return false;
          if (view.columns === 1) {
            result = { columns: 1, clientWidth: view.clientWidth };
            return 2 * cells[0].width > view.clientWidth - 16;
          }
          const pitch = first[1].left - first[0].left;
          const colW = first[0].width;
          const gap = pitch - colW;
          const block = view.columns * colW + (view.columns - 1) * gap;
          const oneMore = block + pitch;
          const full = view.columns === 12 || oneMore > view.clientWidth - 16 - 2;
          result = { columns: view.columns, clientWidth: view.clientWidth };
          return block <= view.clientWidth + 2 && full;
        },
        { timeout: 10_000, interval: 150 },
      );
    } catch {
      throw new Error(`the grid does not hold the most columns that fit; last read: ${JSON.stringify(last)}`);
    }
    return result;
  }

  it('the grid fits as many columns as the pane holds, and follows the pane width', async () => {
    await setReadingZoomPercent('25');
    await waitForReadingView((v) => v.zoomMode === 'custom' && v.zoomPercent === 25, '25% did not take');
    await $('[data-testid="reading-layout-grid"]').click();
    const wide = await gridHolds();
    expect(wide.columns).toBeGreaterThan(1);

    // The navigation pane takes width from the reading pane (or gives it
    // back); the column count follows the change.
    expect(await invokeAppCommand('view.navPane')).toBe(true);
    await browser.waitUntil(
      async () => Math.abs(((await readingViewDom())?.clientWidth ?? wide.clientWidth) - wide.clientWidth) > 100,
      { timeout: 10_000, timeoutMsg: 'toggling the navigation pane did not change the pane width' },
    );
    const toggled = await gridHolds();
    if (toggled.clientWidth < wide.clientWidth) expect(toggled.columns).toBeLessThanOrEqual(wide.columns);
    else expect(toggled.columns).toBeGreaterThanOrEqual(wide.columns);
    expect(toggled.columns).not.toBe(wide.columns);

    expect(await invokeAppCommand('view.navPane')).toBe(true);
    await browser.waitUntil(async () => (await readingViewDom())?.clientWidth === wide.clientWidth, {
      timeout: 10_000,
      timeoutMsg: 'the pane width did not come back',
    });
    expect((await gridHolds()).columns).toBe(wide.columns);

    // A page as wide as the pane leaves room for one column only.
    expect(await invokeAppCommand('view.fitWidth')).toBe(true);
    await waitForReadingView(
      (v) => v.zoomMode === 'fitWidth' && v.layoutMode === 'grid' && v.columns === 1,
      'the grid did not drop to one column at Fit Width',
    );
  });

  it('pages and the block of columns are centred when narrower than the pane', async () => {
    await setReadingZoomPercent('25');
    await waitForReadingView(
      (v) => v.zoomMode === 'custom' && v.zoomPercent === 25 && v.layoutMode === 'grid' && v.columns > 1,
      'the 25% grid did not come back',
    );
    let last: unknown = null;
    try {
      await browser.waitUntil(
        async () => {
          const view = await readingViewDom();
          const cells = await readingCells();
          last = { view, cells: cells.slice(0, 8) };
          if (!view || cells.length < 2) return false;
          const first = cells.filter((c) => c.top === cells[0].top);
          const blockLeft = first[0].left;
          const blockRight = first[first.length - 1].left + first[first.length - 1].width;
          return (
            Math.abs(blockLeft - view.box.left - (view.box.left + view.box.width - blockRight)) <= 2
          );
        },
        { timeout: 10_000, interval: 150 },
      );
    } catch {
      throw new Error(`the grid block is not centred; last read: ${JSON.stringify(last)}`);
    }

    // The last row, when partial, keeps to the column grid from the
    // reading-start side instead of centring on its own.
    const view = (await readingViewDom())!;
    if (12 % view.columns !== 0) {
      const firstLeft = (await readingCells())[0].left;
      await browser.execute(function () {
        const el = document.querySelector('[data-testid="document-view"]') as HTMLElement;
        el.scrollTop = el.scrollHeight;
      });
      await browser.waitUntil(
        async () => {
          const cells = await readingCells();
          if (cells.length === 0) return false;
          const lastTop = cells[cells.length - 1].top;
          const lastRow = cells.filter((c) => c.top === lastTop);
          return lastRow.length === 12 % view.columns && Math.abs(lastRow[0].left - firstLeft) <= 1;
        },
        { timeout: 10_000, timeoutMsg: 'the partial last row is not aligned to the column grid' },
      );
    }

    await $('[data-testid="reading-layout-single"]').click();
    await setReadingZoomPercent('50');
    await waitForReadingView(
      (v) => v.layoutMode === 'single' && v.zoomMode === 'custom' && v.zoomPercent === 50,
      'single 50% did not take',
    );
    await waitForPage(
      (page, v) => centredHorizontally(page, v),
      'a page narrower than the pane is not centred',
    );
  });

  it('Ctrl+wheel zooms about the cursor: the point under it stays within 2 px', async () => {
    await setReadingZoomPercent('200');
    await waitForReadingView((v) => v.zoomMode === 'custom' && v.zoomPercent === 200, '200% did not take');
    await browser.pause(400);
    const view = (await readingViewDom())!;
    const x = Math.round(view.box.left + view.box.width * 0.4);
    const y = Math.round(view.box.top + view.box.height * 0.6);
    const hit = await browser.execute(
      function (px: number, py: number) {
        const el = document.elementFromPoint(px, py);
        const cell = el ? (el.closest('[data-page-id]') as HTMLElement | null) : null;
        if (!cell) return null;
        const page = (cell.querySelector('.pageview') as HTMLElement | null) ?? cell;
        const r = page.getBoundingClientRect();
        return { id: cell.dataset.pageId as string, u: (px - r.left) / r.width, v: (py - r.top) / r.height };
      },
      x,
      y,
    );
    expect(hit).not.toBeNull();

    const path = await readingWheel({ x, y, deltaY: -100, modifier: 'ctrl' });
    console.log(`Ctrl+wheel delivered through the ${path} path`);
    await waitForReadingView(
      (v) => v.zoomMode === 'custom' && v.zoomPercent > 200,
      'Ctrl+wheel did not zoom in',
    );
    await browser.pause(400);
    let last: unknown = null;
    try {
      await browser.waitUntil(
        async () => {
          const box = await readingPageBox(hit!.id);
          if (!box) return false;
          const ax = box.left + hit!.u * box.width;
          const ay = box.top + hit!.v * box.height;
          last = { ax, ay, x, y };
          return Math.abs(ax - x) <= 2 && Math.abs(ay - y) <= 2;
        },
        { timeout: 10_000, interval: 150 },
      );
    } catch {
      throw new Error(`the point under the cursor moved; last read: ${JSON.stringify(last)}`);
    }
  });

  it('Alt+wheel scrolls sideways only, and releasing Alt opens no menu', async () => {
    const before = (await readingViewDom())!;
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
    const x = Math.round(before.box.left + before.box.width / 2);
    const y = Math.round(before.box.top + before.box.height / 2);
    const path = await readingWheel({ x, y, deltaY: 120, modifier: 'alt' });
    console.log(`Alt+wheel delivered through the ${path} path`);
    const after = await waitForReadingView(
      (v) => v.scrollLeft !== before.scrollLeft,
      'Alt+wheel did not scroll sideways',
    );
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
    expect(after.zoomPercent).toBe(before.zoomPercent);
    expect(after.zoomMode).toBe(before.zoomMode);
    await browser.pause(300);
    const menuOpen = await browser.execute(function () {
      const bar = document.querySelector('[data-testid="menubar"]');
      if (!bar) return false;
      return (
        bar.querySelector('[aria-expanded="true"]') !== null ||
        bar.contains(document.activeElement) ||
        document.querySelector('[role="menu"]') !== null
      );
    });
    expect(menuOpen).toBe(false);
  });

  it('paged scrolling: PageDown and the wheel move one row, a scroll between rows snaps', async () => {
    expect(await invokeAppCommand('view.fit')).toBe(true);
    await $('[data-testid="reading-scroll-paged"]').click();
    await waitForReadingView(
      (v) => v.zoomMode === 'fitPage' && v.layoutMode === 'single' && v.scrollMode === 'paged',
      'paged Fit Page did not take',
    );
    await goToPage(1);

    await browser.execute(function () {
      (document.querySelector('[data-testid="document-view"]') as HTMLElement).focus();
    });
    await browser.keys(['PageDown']);
    await waitForReadingView((v) => v.currentPage === 2, 'PageDown did not move to the next row');
    await browser.pause(500);
    expect((await readingViewDom())?.currentPage).toBe(2);

    const view = (await readingViewDom())!;
    const path = await readingWheel({
      x: view.box.left + view.box.width / 2,
      y: view.box.top + view.box.height / 2,
      deltaY: 120,
    });
    console.log(`the paged wheel step was delivered through the ${path} path`);
    await waitForReadingView((v) => v.currentPage === 3, 'one wheel notch did not move one row');
    await browser.pause(500);
    expect((await readingViewDom())?.currentPage).toBe(3);

    // A scrollbar drag ends between rows; the pane snaps to the row holding
    // the viewport centre. Each row's slot is one pane high at Fit Page.
    const h = view.clientHeight;
    await browser.execute(function (top: number) {
      (document.querySelector('[data-testid="document-view"]') as HTMLElement).scrollTop = top;
    }, Math.round(h * 4.4));
    await waitForReadingView(
      (v) => Math.abs(v.scrollTop - 4 * v.clientHeight) <= 2 && v.currentPage === 5,
      'a scroll that ended between rows did not snap to the row at the viewport centre',
    );

    await $('[data-testid="reading-scroll-continuous"]').click();
    await waitForReadingView((v) => v.scrollMode === 'continuous', 'continuous scrolling did not come back');
  });

  it('two open documents keep independent views', async () => {
    await openByPaths([second]);
    await browser.waitUntil(async () => (await getState()).fileCount === 2, {
      timeout: 10_000,
      timeoutMsg: 'the second document never opened',
    });

    await focusTab({ doc: letter });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === letter, {
      timeout: 10_000,
      timeoutMsg: 'the first document never came to the front',
    });
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="reading-layout-grid"]').click();
    await $('[data-testid="reading-scroll-paged"]').click();
    await waitForReadingView(
      (v) => v.layoutMode === 'grid' && v.scrollMode === 'paged',
      'the first document did not take grid and paged',
      { store: (st) => st?.layoutMode === 'grid' && st.scrollMode === 'paged' },
    );

    await focusTab({ doc: second });
    await browser.waitUntil(
      async () => {
        const view = await getReadingView();
        return (
          (await getState()).activeFile?.path === second &&
          view?.pageCount === 3 &&
          view.layoutMode === 'single' &&
          view.scrollMode === 'continuous' &&
          view.zoomMode === 'fitPage'
        );
      },
      { timeout: 15_000, timeoutMsg: 'the second document did not open with its own default view' },
    );
    await pickFit('reading-fit-width');
    await waitForReadingView((v) => v.zoomMode === 'fitWidth', 'Fit Width did not reach the second document');

    await focusTab({ doc: letter });
    await browser.waitUntil(
      async () => {
        const view = await getReadingView();
        return (
          view?.pageCount === 12 &&
          view.layoutMode === 'grid' &&
          view.scrollMode === 'paged' &&
          view.zoomMode !== 'fitWidth'
        );
      },
      { timeout: 15_000, timeoutMsg: 'the first document lost its own view across a document switch' },
    );

    await $('[data-testid="reading-layout-single"]').click();
    await $('[data-testid="reading-scroll-continuous"]').click();
    await waitForReadingView(
      (v) => v.layoutMode === 'single' && v.scrollMode === 'continuous',
      'the first document did not return to single continuous',
    );
  });

  it('in two-pane split, Ctrl+wheel zooms only the pane under the cursor', async () => {
    expect(await invokeAppCommand('window.split')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitView, {
      timeoutMsg: 'window.split did not set ui.splitView',
    });
    for (const [wheeled, other] of [
      ['b', 'a'],
      ['a', 'b'],
    ] as const) {
      const W = `[data-testid="doc-pane-${wheeled}"]`;
      const O = `[data-testid="doc-pane-${other}"]`;
      await waitForReadingView((v) => v.clientHeight > 0, `pane ${wheeled} never rendered`, { scope: W });
      await waitForReadingView((v) => v.clientHeight > 0, `pane ${other} never rendered`, { scope: O });
      await browser.pause(400);
      const target = (await readingViewDom(W))!;
      const still = (await readingViewDom(O))!;
      const unchanged = (v: ReadingViewDom): boolean =>
        v.zoomMode === still.zoomMode &&
        v.zoomPercent === still.zoomPercent &&
        v.currentPage === still.currentPage &&
        v.scrollTop === still.scrollTop &&
        v.scrollLeft === still.scrollLeft;
      const path = await readingWheel({
        x: target.box.left + target.box.width / 2,
        y: target.box.top + target.box.height / 2,
        deltaY: -100,
        modifier: 'ctrl',
        scope: W,
      });
      console.log(`two-pane Ctrl+wheel in pane ${wheeled} delivered through the ${path} path`);
      let last: unknown = null;
      try {
        await browser.waitUntil(
          async () => {
            const w = await readingViewDom(W);
            const o = await readingViewDom(O);
            last = { wheeled: w, other: o };
            return (
              w !== null &&
              o !== null &&
              w.zoomMode === 'custom' &&
              w.zoomPercent > target.zoomPercent &&
              unchanged(o)
            );
          },
          { timeout: 10_000, interval: 100 },
        );
      } catch {
        throw new Error(
          `Ctrl+wheel in pane ${wheeled} did not zoom it alone; last read: ${JSON.stringify(last)}`,
        );
      }
      await browser.pause(400);
      await waitForReadingView(unchanged, `pane ${other} moved after pane ${wheeled} settled`, { scope: O });
    }
    expect(await invokeAppCommand('window.split')).toBe(true);
    await browser.waitUntil(async () => !(await getState()).splitView, {
      timeoutMsg: 'window.split did not clear ui.splitView',
    });
  });
});
