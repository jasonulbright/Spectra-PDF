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

  it('toggles back to the board', async () => {
    await $('[data-testid="toggle-doc-view"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="document-view"]').isExisting()), {
      timeout: 10_000,
      timeoutMsg: 'reading view did not close on toggle-back',
    });
  });
});
