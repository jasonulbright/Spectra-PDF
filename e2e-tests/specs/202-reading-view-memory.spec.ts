import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
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
  waitForReadingView,
  setReadingZoomPercent,
  tabDragDrop,
  VIEW_HISTORY_KEY,
  type PhysicalScreenPoint,
  type ReadingViewSnapshot,
} from '../support/harness.js';

// The reading view remembers each document's view: closing and reopening a
// file restores its page, zoom, layout and scrolling. A file never seen
// before opens with the Preferences ▸ Viewing defaults, or with the
// document's own initial view when it states one and the preference allows
// it. A remembered view outranks the document's own. The history is shared
// across windows, so a document moved to another window keeps its view.

async function makePdf(path: string, pages: number, pageLayout?: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i}`, { x: 72, y: 700, size: 48, font });
  }
  if (pageLayout) doc.catalog.set(PDFName.of('PageLayout'), PDFName.of(pageLayout));
  writeFileSync(path, await doc.save());
}

async function openReading(path: string): Promise<void> {
  await openByPaths([path]);
  await browser.waitUntil(async () => (await getState()).activeFile?.path.toLowerCase() === path.toLowerCase(), {
    timeout: 15_000,
    timeoutMsg: `${path} never became the active document`,
  });
  await setView('canvas');
  await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
}

/** Wait until the store's view of the active pane satisfies `predicate`. */
async function waitForStore(
  predicate: (v: ReadingViewSnapshot) => boolean,
  timeoutMsg: string,
): Promise<ReadingViewSnapshot> {
  let last: ReadingViewSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        last = await getReadingView();
        return last !== null && predicate(last);
      },
      { timeout: 15_000, interval: 150 },
    );
  } catch {
    throw new Error(`${timeoutMsg}; last view: ${JSON.stringify(last)}`);
  }
  return last!;
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
}

async function storedHistoryPaths(): Promise<string[]> {
  return await browser.execute(function (key: string) {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> };
      return Object.keys(parsed.entries ?? {});
    } catch {
      return [];
    }
  }, VIEW_HISTORY_KEY);
}

/** Whether the history holds a row for `path`. Rows are keyed by the
 * canonical path, which may differ from the spelling a spec built in case. */
async function remembers(path: string): Promise<boolean> {
  return (await storedHistoryPaths()).some((p) => p.toLowerCase() === path.toLowerCase());
}

/** Open Preferences on Viewing and apply `edit` to its fields. */
async function editViewingPreferences(
  edit: (fields: {
    zoom: ChainablePromiseElement;
    layout: ChainablePromiseElement;
    scroll: ChainablePromiseElement;
    honour: ChainablePromiseElement;
  }) => Promise<void>,
): Promise<void> {
  expect(await invokeAppCommand('edit.preferences')).toBe(true);
  const cat = $('[data-testid="prefs-cat-viewing"]');
  await cat.waitForDisplayed({ timeout: 10_000 });
  await cat.click();
  await $('[data-testid="prefs-body-viewing"]').waitForDisplayed({ timeout: 5_000 });
  await edit({
    zoom: $('[data-testid="pref-view-zoom-mode"]'),
    layout: $('[data-testid="pref-view-layout-mode"]'),
    scroll: $('[data-testid="pref-view-scroll-mode"]'),
    honour: $('[data-testid="pref-view-honour-initial"]'),
  });
  await $('[data-testid="prefs-close"]').click();
  await $('[data-testid="prefs-body-viewing"]').waitForExist({ reverse: true, timeout: 5_000 });
}

type ChainablePromiseElement = ReturnType<typeof $>;

async function storedSetting(field: string): Promise<unknown> {
  return await browser.execute(
    (f: string) => JSON.parse(localStorage.getItem('spectra-settings') ?? '{}')[f],
    field,
  );
}

async function restoreViewingDefaults(): Promise<void> {
  await editViewingPreferences(async ({ zoom, layout, scroll, honour }) => {
    await zoom.selectByAttribute('value', 'fitPage');
    await layout.selectByAttribute('value', 'single');
    await scroll.selectByAttribute('value', 'continuous');
    if (!(await honour.isSelected())) await honour.click();
    await browser.waitUntil(
      async () =>
        (await storedSetting('viewZoomMode')) === 'fitPage' &&
        (await storedSetting('viewLayoutMode')) === 'single' &&
        (await storedSetting('viewScrollMode')) === 'continuous' &&
        (await storedSetting('viewHonourDocumentView')) === true,
      { timeout: 5_000, timeoutMsg: 'the Viewing defaults never came back' },
    );
  });
}

describe('reading view memory', () => {
  let tmp = '';
  let plain = '';
  let fresh = '';
  let twoPage = '';
  let keep = '';
  let torn = '';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-view-memory-'));
    plain = resolve(tmp, 'plain.pdf');
    fresh = resolve(tmp, 'fresh.pdf');
    twoPage = resolve(tmp, 'two-page-left.pdf');
    keep = resolve(tmp, 'keep.pdf');
    torn = resolve(tmp, 'torn.pdf');
    await makePdf(plain, 8);
    await makePdf(fresh, 4);
    await makePdf(twoPage, 6, 'TwoPageLeft');
    await makePdf(keep, 3);
    await makePdf(torn, 6);
    await waitForHarness();
    await closeAllFiles();
    await clearViewHistory();
  });

  after(async () => {
    await closeAllFiles();
    await clearViewHistory();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('close and reopen restores the page, the zoom, the layout and the scrolling', async () => {
    await openReading(plain);
    await setReadingZoomPercent('150');
    await $('[data-testid="reading-scroll-paged"]').click();
    await waitForReadingView(
      (v) => v.zoomMode === 'custom' && v.zoomPercent === 150 && v.scrollMode === 'paged',
      '150% paged did not take',
    );
    await goToPage(4);
    // The history records the store snapshot, which follows the DOM on the
    // settle beat; close only once the store holds the view to remember.
    await waitForStore(
      (v) => v.zoomMode === 'custom' && v.zoomPercent === 150 && v.scrollMode === 'paged' && v.page === 4,
      'the store never held page 4 at 150% paged',
    );
    await closeAllFiles();
    expect(await remembers(plain)).toBe(true);

    await openReading(plain);
    await waitForReadingView(
      (v) =>
        v.zoomMode === 'custom' &&
        v.zoomPercent === 150 &&
        v.layoutMode === 'single' &&
        v.scrollMode === 'paged' &&
        v.currentPage === 4,
      'the reopened document did not restore its page, zoom and scrolling',
    );

    // A fit mode is remembered as the mode, not as the zoom it resolved to.
    await pickFit('reading-fit-width');
    await $('[data-testid="reading-layout-grid"]').click();
    await $('[data-testid="reading-scroll-continuous"]').click();
    await waitForReadingView(
      (v) => v.zoomMode === 'fitWidth' && v.layoutMode === 'grid' && v.scrollMode === 'continuous',
      'Fit Width, grid, continuous did not take',
    );
    await waitForStore(
      (v) => v.zoomMode === 'fitWidth' && v.layoutMode === 'grid' && v.scrollMode === 'continuous',
      'the store never held Fit Width, grid, continuous',
    );
    await closeAllFiles();
    await openReading(plain);
    await waitForReadingView(
      (v) => v.zoomMode === 'fitWidth' && v.layoutMode === 'grid' && v.scrollMode === 'continuous',
      'the reopened document did not restore Fit Width and the grid',
    );
    // The next test reopens this document and expects this view remembered.
    await waitForStore(
      (v) => v.zoomMode === 'fitWidth' && v.layoutMode === 'grid' && v.scrollMode === 'continuous',
      'the store never held the restored Fit Width, grid, continuous',
    );
    await closeAllFiles();
  });

  it('a never-seen document opens with the Viewing defaults', async () => {
    await editViewingPreferences(async ({ zoom, layout, scroll }) => {
      await zoom.selectByAttribute('value', 'fitWidth');
      await layout.selectByAttribute('value', 'grid');
      await scroll.selectByAttribute('value', 'paged');
      await browser.waitUntil(
        async () =>
          (await storedSetting('viewZoomMode')) === 'fitWidth' &&
          (await storedSetting('viewLayoutMode')) === 'grid' &&
          (await storedSetting('viewScrollMode')) === 'paged',
        { timeout: 5_000, timeoutMsg: 'the Viewing choices never reached storage' },
      );
    });
    try {
      await openReading(fresh);
      await waitForStore(
        (v) => v.zoomMode === 'fitWidth' && v.layoutMode === 'grid' && v.scrollMode === 'paged',
        'a never-seen document did not open with the Viewing defaults',
      );
      // A remembered document keeps its own view over the new defaults.
      await closeAllFiles();
      await openReading(plain);
      await waitForStore(
        (v) => v.zoomMode === 'fitWidth' && v.layoutMode === 'grid' && v.scrollMode === 'continuous',
        'the defaults overrode a remembered view',
      );
      await closeAllFiles();
    } finally {
      await restoreViewingDefaults();
    }
  });

  it('a remembered view outranks the document’s own initial view', async () => {
    await clearViewHistory();
    await openReading(twoPage);
    await waitForStore(
      (v) => v.layoutMode === 'grid' && v.scrollMode === 'paged',
      'the document’s /PageLayout /TwoPageLeft did not reach a fresh view',
    );
    await $('[data-testid="reading-layout-single"]').click();
    await $('[data-testid="reading-scroll-continuous"]').click();
    await waitForStore(
      (v) => v.layoutMode === 'single' && v.scrollMode === 'continuous',
      'single continuous did not take',
    );
    await closeAllFiles();

    await openReading(twoPage);
    await waitForStore(
      (v) => v.layoutMode === 'single' && v.scrollMode === 'continuous',
      'the document’s initial view overrode the remembered one',
    );
    // Held, not a frame that the document's seed replaces a moment later.
    await browser.pause(800);
    const view = await getReadingView();
    expect(view?.layoutMode).toBe('single');
    expect(view?.scrollMode).toBe('continuous');
    await closeAllFiles();
  });

  it('with the preference off, a document’s own initial view is ignored', async () => {
    await clearViewHistory();
    await editViewingPreferences(async ({ honour }) => {
      expect(await honour.isSelected()).toBe(true);
      await honour.click();
      await browser.waitUntil(async () => (await storedSetting('viewHonourDocumentView')) === false, {
        timeout: 5_000,
        timeoutMsg: 'the preference never reached storage',
      });
    });
    try {
      await openReading(twoPage);
      await waitForStore(
        (v) => v.zoomMode === 'fitPage' && v.layoutMode === 'single' && v.scrollMode === 'continuous',
        'the document did not open with the defaults',
      );
      await browser.pause(800);
      const view = await getReadingView();
      expect(view?.layoutMode).toBe('single');
      expect(view?.scrollMode).toBe('continuous');
      await closeAllFiles();
    } finally {
      await restoreViewingDefaults();
    }
  });

  it('Clear Recent forgets every remembered view', async () => {
    await clearViewHistory();
    await openReading(fresh);
    await $('[data-testid="reading-layout-grid"]').click();
    await waitForStore((v) => v.layoutMode === 'grid', 'the grid did not take');
    // An open document records its view again on its next change and on
    // close, so it is closed before the history is cleared.
    await closeAllFiles();
    expect(await remembers(fresh)).toBe(true);

    expect(await invokeAppCommand('file.clearRecent')).toBe(true);
    await browser.waitUntil(async () => (await storedHistoryPaths()).length === 0, {
      timeout: 10_000,
      timeoutMsg: 'Clear Recent left remembered views behind',
    });

    await openReading(fresh);
    await waitForStore(
      (v) => v.layoutMode === 'single' && v.zoomMode === 'fitPage',
      'the document reopened with a view Clear Recent should have forgotten',
    );
    await closeAllFiles();
  });

  // Last in the file: it leaves a second window open, and the session ends
  // with the spec file.
  it('a document moved to another window keeps its view', async () => {
    await clearViewHistory();
    const handles = await browser.getWindowHandles();
    expect(handles).toHaveLength(1);
    const mainHandle = handles[0];

    await openByPaths([keep, torn]);
    await browser.waitUntil(async () => (await getState()).fileCount === 2, {
      timeout: 15_000,
      timeoutMsg: 'both documents never opened',
    });
    await focusTab({ doc: torn });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === torn, {
      timeout: 10_000,
      timeoutMsg: 'the document to move never came to the front',
    });
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await setReadingZoomPercent('50');
    await $('[data-testid="reading-layout-grid"]').click();
    await $('[data-testid="reading-scroll-paged"]').click();
    await waitForStore(
      (v) =>
        v.zoomMode === 'custom' && v.zoomPercent === 50 && v.layoutMode === 'grid' && v.scrollMode === 'paged',
      'the view to carry did not take',
    );

    // A drop half way down the window's content tears the tab off into a new
    // window at that point.
    const point = await browser.execute(function () {
      const dpr = window.devicePixelRatio || 1;
      return {
        x: Math.round((window.screenX + window.innerWidth / 2) * dpr),
        y: Math.round((window.screenY + window.innerHeight / 2) * dpr),
      };
    });
    expect(await tabDragDrop(torn, point as PhysicalScreenPoint)).toBe(true);
    let secondHandle = '';
    await browser.waitUntil(
      async () => {
        const now = await browser.getWindowHandles();
        secondHandle = now.find((h) => h !== mainHandle) ?? '';
        return now.length === 2 && secondHandle !== '';
      },
      { timeout: 30_000, interval: 250, timeoutMsg: 'the torn-off window never appeared' },
    );

    await browser.switchToWindow(secondHandle);
    try {
      await waitForHarness(30_000);
      await browser.waitUntil(async () => (await getState()).activeFile?.path.toLowerCase() === torn.toLowerCase(), {
        timeout: 30_000,
        timeoutMsg: 'the moved document never arrived in its new window',
      });
      await waitForStore(
        (v) =>
          v.zoomMode === 'custom' &&
          v.zoomPercent === 50 &&
          v.layoutMode === 'grid' &&
          v.scrollMode === 'paged',
        'the moved document did not keep its view in the new window',
      );
    } finally {
      await browser.switchToWindow(mainHandle);
    }
  });
});
