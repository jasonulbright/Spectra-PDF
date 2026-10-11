import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  clearViewHistory,
  closeAllFiles,
  readingViewDom,
  waitForReadingView,
  type ReadingViewDom,
} from '../support/harness.js';

// Split view uses two stacked panes over the
// SAME document, each with its own scroll/zoom; the ACTIVE pane owns the
// page readout and the camera commands. Split state is session-scoped and
// this file toggles it off at the end (specs share one workspace per file —
// the cross-spec-leak rule).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function paneSpacerHeight(pane: 'a' | 'b'): Promise<number> {
  return await browser.execute(function (p: string) {
    const el = document.querySelector(
      `[data-testid="doc-pane-${p}"] .docview-spacer`,
    ) as HTMLElement | null;
    return el ? el.offsetHeight : -1;
  }, pane);
}

describe('split view', () => {
  before(async () => {
    await waitForHarness();
    await clearViewHistory();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  after(async () => {
    // Never leak split state, or a remembered view, into the next spec file.
    if ((await getState()).splitView) await invokeAppCommand('window.split');
    await closeAllFiles();
    await clearViewHistory();
  });

  it('Window ▸ Split shows two panes over the same document', async () => {
    expect((await getState()).splitView).toBe(false);
    expect(await invokeAppCommand('window.split')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitView, {
      timeoutMsg: 'window.split did not set ui.splitView',
    });

    await $('[data-testid="doc-pane-a"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="doc-pane-b"]').waitForDisplayed({ timeout: 10_000 });
    await expect($('[data-testid="split-divider"]')).toBeDisplayed();
    // Both panes render a full reading view of the SAME document.
    await expect($('[data-testid="doc-pane-a"] [data-testid="document-view"]')).toBeDisplayed();
    await expect($('[data-testid="doc-pane-b"] [data-testid="document-view"]')).toBeDisplayed();
    // Pane A starts active.
    expect(await $('[data-testid="doc-pane-a"]').getAttribute('data-active')).toBe('true');
  });

  it('the inactive pane scrolls silently; activating it takes over the readout', async () => {
    const before = (await getState()).currentPageId;
    expect(before).not.toBeNull();

    // Scroll pane B (inactive) to its far end — a real scroll event stream.
    await browser.execute(function () {
      const el = document.querySelector(
        '[data-testid="doc-pane-b"] .docview-scroll',
      ) as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await browser.pause(400); // give scroll-tracking a beat to (not) publish
    expect((await getState()).currentPageId).toBe(before);

    // Click pane B → it becomes active and its page takes the readout.
    await $('[data-testid="doc-pane-b"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="doc-pane-b"]').getAttribute('data-active')) === 'true',
      { timeoutMsg: 'clicking pane B did not activate it' },
    );
    await browser.waitUntil(
      async () => (await getState()).currentPageId !== before,
      { timeout: 10_000, timeoutMsg: 'activating pane B did not move the page readout' },
    );
  });

  it('camera commands land in the ACTIVE pane only', async () => {
    // Pane B is active from the previous leg. Zooming must grow B's spacer
    // and leave A's untouched (zoom is per-pane state).
    const aBefore = await paneSpacerHeight('a');
    const bBefore = await paneSpacerHeight('b');
    expect(aBefore).toBeGreaterThan(0);
    expect(bBefore).toBeGreaterThan(0);

    expect(await invokeAppCommand('view.zoomIn')).toBe(true);
    await browser.waitUntil(
      async () => (await paneSpacerHeight('b')) > bBefore,
      { timeoutMsg: 'zoom did not reach the active pane' },
    );
    expect(await paneSpacerHeight('a')).toBe(aBefore);
  });

  it('page layout and scrolling change the ACTIVE pane only', async () => {
    // Pane B is still active. Two panes are two independent views of the
    // document; only the quad links its panes.
    const A = '[data-testid="doc-pane-a"]';
    const B = '[data-testid="doc-pane-b"]';
    expect(await invokeAppCommand('view.multiPage')).toBe(true);
    expect(await invokeAppCommand('view.scrollPaged')).toBe(true);
    await waitForReadingView(
      (v) => v.layoutMode === 'grid' && v.scrollMode === 'paged',
      'layout and scrolling did not reach the active pane, or the status bar did not read it',
      // The status bar reads the active pane through the store.
      { scope: B, store: (st) => st?.layoutMode === 'grid' && st.scrollMode === 'paged' },
    );
    await waitForReadingView(
      (v) => v.layoutMode === 'single' && v.scrollMode === 'continuous',
      'layout and scrolling leaked into the inactive pane',
      { scope: A },
    );

    expect(await invokeAppCommand('view.singlePage')).toBe(true);
    expect(await invokeAppCommand('view.scrollContinuous')).toBe(true);
    await waitForReadingView(
      (v) => v.layoutMode === 'single' && v.scrollMode === 'continuous',
      'pane B did not return to single continuous',
      { scope: B },
    );
  });

  it('a marquee zoom in one pane leaves the other pane at its own zoom', async () => {
    const A = '[data-testid="doc-pane-a"]';
    const B = '[data-testid="doc-pane-b"]';
    expect(await invokeAppCommand('tools.zoommarquee')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'zoommarquee', {
      timeoutMsg: 'the marquee zoom tool did not arm',
    });
    // The visible part of the first page cell in pane A: the band must start on a page.
    const visible = await browser.execute(function () {
      const view = document.querySelector(
        '[data-testid="doc-pane-a"] [data-testid="document-view"]',
      ) as HTMLElement | null;
      if (!view) return null;
      const v = view.getBoundingClientRect();
      for (const cell of Array.from(view.querySelectorAll('[data-page-id]')) as HTMLElement[]) {
        const r = cell.getBoundingClientRect();
        const left = Math.max(r.left, v.left);
        const top = Math.max(r.top, v.top);
        const right = Math.min(r.right, v.left + view.clientWidth);
        const bottom = Math.min(r.bottom, v.top + view.clientHeight);
        if (right - left > 60 && bottom - top > 60) return { left, top, width: right - left, height: bottom - top };
      }
      return null;
    });
    expect(visible).not.toBeNull();
    const before = await browser.execute(function () {
      const read = (p: string) => {
        const el = document.querySelector(`[data-testid="doc-pane-${p}"] [data-testid="document-view"]`);
        return el ? { mode: el.getAttribute('data-zoom-mode'), percent: Number(el.getAttribute('data-zoom-percent')) } : null;
      };
      return { a: read('a'), b: read('b') };
    });
    expect(before.a).not.toBeNull();
    expect(before.b).not.toBeNull();
    const v = visible!;
    const from = { x: Math.round(v.left + v.width * 0.35), y: Math.round(v.top + v.height * 0.35) };
    const to = { x: Math.round(v.left + v.width * 0.55), y: Math.round(v.top + v.height * 0.55) };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(from)
      .down()
      .pause(60)
      .move({ x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) })
      .pause(60)
      .move(to)
      .pause(150)
      .up()
      .perform();
    let last: unknown = null;
    try {
      await browser.waitUntil(
        async () => {
          const a = await readingViewDom(A);
          const b = await readingViewDom(B);
          last = { a, b };
          return (
            a !== null &&
            b !== null &&
            a.zoomPercent > before.a!.percent &&
            b.zoomMode === before.b!.mode &&
            b.zoomPercent === before.b!.percent
          );
        },
        { timeout: 10_000, interval: 100 },
      );
    } catch {
      throw new Error(`the marquee did not zoom pane A alone; last read: ${JSON.stringify(last)}`);
    }
    await browser.pause(400);
    await waitForReadingView(
      (b) => b.zoomMode === before.b!.mode && b.zoomPercent === before.b!.percent,
      'pane B changed zoom after the marquee in pane A settled',
      { scope: B },
    );
    expect(await invokeAppCommand('tools.select')).toBe(true);
  });

  it('a divider drag resizes the two panes and leaves them unlinked', async () => {
    const A = '[data-testid="doc-pane-a"]';
    const B = '[data-testid="doc-pane-b"]';
    const geometry = await browser.execute(function () {
      const divider = document.querySelector('[data-testid="split-divider"]') as HTMLElement | null;
      const container = document.querySelector('[data-testid="split-container"]') as HTMLElement | null;
      if (!divider || !container) return null;
      const d = divider.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      return { x: d.left + d.width / 2, y: d.top + d.height / 2, top: c.top, height: c.height };
    });
    expect(geometry).not.toBeNull();
    const from = { x: Math.round(geometry!.x), y: Math.round(geometry!.y) };
    const toY = Math.round(geometry!.top + geometry!.height * 0.3);
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: from.x, y: from.y })
      .down()
      .pause(60)
      .move({ x: from.x, y: Math.round((from.y + toY) / 2) })
      .pause(60)
      .move({ x: from.x, y: toY })
      .pause(150)
      .up()
      .perform();
    await browser.waitUntil(
      async () => {
        const a = await readingViewDom(A);
        const b = await readingViewDom(B);
        return a !== null && b !== null && a.clientHeight > 0 && a.clientHeight * 1.5 < b.clientHeight;
      },
      { timeout: 10_000, timeoutMsg: 'the divider drag did not make pane A shorter than pane B' },
    );
    await browser.pause(400);
    const aBefore = (await readingViewDom(A))!;
    const bBefore = (await readingViewDom(B))!;

    // Two panes are independent views: scrolling B moves neither A's scroll nor A's page.
    await browser.execute(function (toTop: boolean) {
      const el = document.querySelector(
        '[data-testid="doc-pane-b"] [data-testid="document-view"]',
      ) as HTMLElement | null;
      if (el) el.scrollTop = toTop ? 0 : el.scrollHeight;
    }, bBefore.currentPage > 1);
    const unchanged = (a: ReadingViewDom): boolean =>
      a.currentPage === aBefore.currentPage &&
      a.scrollTop === aBefore.scrollTop &&
      a.zoomPercent === aBefore.zoomPercent;
    let last: unknown = null;
    try {
      await browser.waitUntil(
        async () => {
          const a = await readingViewDom(A);
          const b = await readingViewDom(B);
          last = { a, b };
          return a !== null && b !== null && b.currentPage !== bBefore.currentPage && unchanged(a);
        },
        { timeout: 10_000, interval: 100 },
      );
    } catch {
      throw new Error(`scrolling pane B did not leave pane A in place; last read: ${JSON.stringify(last)}`);
    }
    await browser.pause(400);
    await waitForReadingView(unchanged, 'pane A moved after pane B settled', { scope: A });
  });

  it('toggling split off returns the single view, readout back on pane A', async () => {
    expect(await invokeAppCommand('window.split')).toBe(true);
    await browser.waitUntil(async () => !(await getState()).splitView, {
      timeoutMsg: 'window.split did not clear ui.splitView',
    });
    await $('[data-testid="doc-pane-b"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'pane B survived toggling split off',
    });
    const views = await $$('[data-testid="document-view"]').getElements();
    expect(views.length).toBe(1);
  });
});
