import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, closeAllFiles, setView } from '../support/harness.js';

// Phase 4 M4.1: the continuous reading Document view. Default is the Organize
// board; a pill toggles to the reading column, which hosts the SAME PageCells
// (the reuse seam). This proves the toggle both ways and that pages actually
// render (raster) in the column.
const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

describe('document view (M4.1)', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });
    await setView('canvas');
  });

  it('defaults to the Organize board (no reading column)', async () => {
    expect(await $('[data-testid="document-view"]').isExisting()).toBe(false);
  });

  it('toggles to the reading view and renders pages', async () => {
    await $('[data-testid="toggle-doc-view"]').click();
    await $('[data-testid="document-view"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'reading view did not appear',
    });
    // A page's raster cell mounts in the column (PageView renders when near).
    await browser.waitUntil(
      async () => (await $$('[data-testid="document-view"] .pageview')).length > 0,
      { timeout: 15_000, timeoutMsg: 'no page rendered in the reading view' },
    );
  });

  it('the floating zoom buttons resize pages in the reading view', async () => {
    // Discriminates the routing fix: the on-screen zoom cluster references the
    // ACTIVE view's handle, not the (unmounted, null) board camera — without it
    // the button is a silent no-op in Read mode and the page never resizes.
    const pageWidth = () =>
      browser.execute(() => {
        const el = document.querySelector('[data-testid="document-view"] .pageview');
        return el ? Math.round((el as HTMLElement).getBoundingClientRect().width) : 0;
      });
    const before = await pageWidth();
    expect(before).toBeGreaterThan(0);
    await $('button[title="Zoom in"]').click();
    await browser.waitUntil(async () => (await pageWidth()) > before, {
      timeout: 10_000,
      timeoutMsg: 'Zoom+ did not enlarge the page — the button is not routed to the reading view',
    });
  });

  it('toggles back to the board', async () => {
    await $('[data-testid="toggle-doc-view"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="document-view"]').isExisting()), {
      timeout: 10_000,
      timeoutMsg: 'reading view did not close on toggle-back',
    });
  });
});
