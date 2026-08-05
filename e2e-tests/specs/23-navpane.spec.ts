import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, getWorkspacePageIds } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// The left navigation pane + Pages (thumbnails) panel. Drives
// the real DOM — the icon strip, the virtualized thumbnails (rendered through
// the same pdf.js proxy the board uses), click-to-select, and the F4 toggle.

async function getSelectedPageIds(): Promise<string[]> {
  return await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.getSelectedCanvasPageIds();
  });
}

// The nav-pane open state persists in localStorage, so a prior run could
// leave it open — drive it to a known "Pages open" state via aria-pressed
// (true only when the pane is open on that panel) rather than assuming closed.
async function ensurePagesOpen(): Promise<void> {
  const pressed = await $('[data-testid="navicon-pages"]').getAttribute('aria-pressed');
  if (pressed !== 'true') await $('[data-testid="navicon-pages"]').click();
  await $('[data-testid="nav-panel-body"]').waitForDisplayed({ timeoutMsg: 'nav pane did not open on Pages' });
}

describe('navigation pane — Pages panel', () => {
  it('opens the pane on the Pages panel and renders thumbnails', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]); // focuses the doc tab
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });

    // The always-docked icon strip is present; drive to Pages open.
    await expect($('[data-testid="nav-icon-strip"]')).toBeDisplayed();
    await ensurePagesOpen();
    await expect($('[data-testid="pages-panel"]')).toBeDisplayed();

    // Thumbnails render (sample.pdf has 5 pages; the window covers the top).
    await $('[data-testid="thumb"]').waitForDisplayed({ timeoutMsg: 'no thumbnails rendered' });
    const thumbs = await $$('[data-testid="thumb"]');
    expect(thumbs.length).toBeGreaterThan(0);
  });

  it('clicking a thumbnail selects that page (shared selection)', async () => {
    const firstThumb = $('[data-testid="thumb"]');
    const pageId = await firstThumb.getAttribute('data-page-id');
    await firstThumb.click();
    await browser.waitUntil(
      async () => (await getSelectedPageIds()).includes(pageId),
      { timeoutMsg: 'thumbnail click did not select the page' },
    );
  });

  it('F4 toggles the pane closed and open', async () => {
    await browser.keys(['F4']);
    await $('[data-testid="nav-panel-body"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'F4 did not close the nav pane',
    });
    await browser.keys(['F4']);
    await $('[data-testid="nav-panel-body"]').waitForDisplayed({
      timeoutMsg: 'F4 did not reopen the nav pane',
    });
  });

  it('drag-reorders a thumbnail (real W3C pointer drag → page tier)', async () => {
    await ensurePagesOpen();
    const ids = await getWorkspacePageIds();
    expect(ids.length).toBe(5); // sample.pdf

    // Grab thumb 0's center; drop at thumb 1's lower edge (always on-screen —
    // the 2nd row) → an insertion after page 1.
    const rects = (await browser.execute(function (a: string, b: string) {
      const byId = (id: string): DOMRect =>
        Array.from(document.querySelectorAll('[data-testid="thumb"]'))
          .find((e) => e.getAttribute('data-page-id') === id)!
          .getBoundingClientRect();
      const ra = byId(a);
      const rb = byId(b);
      return {
        a: { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 },
        drop: { x: rb.left + rb.width / 2, y: rb.bottom - 6 },
      };
    }, ids[0], ids[1])) as { a: { x: number; y: number }; drop: { x: number; y: number } };

    // Trusted pointer events through the panel's window listeners (the
    // 20-release-gates canvas-drag mechanism).
    // Interpolated from the threshold point to the drop, rather than one jump:
    // a single large pointermove is the most load-fragile input for the
    // window-level drag listeners (this leg went red in a v2.8.3 release-gate
    // run and passed isolated). The assertion is unchanged — the pages still
    // have to actually reorder.
    const x0 = Math.round(rects.a.x);
    const y0 = Math.round(rects.a.y) + 12; // cross the 6px threshold
    const STEPS = 5;
    let act = browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(rects.a.x), y: Math.round(rects.a.y) })
      .down()
      .pause(80)
      .move({ x: x0, y: y0 })
      .pause(80);
    for (let i = 1; i <= STEPS; i++) {
      act = act
        .move({
          x: Math.round(x0 + ((rects.drop.x - x0) * i) / STEPS),
          y: Math.round(y0 + ((rects.drop.y - y0) * i) / STEPS),
        })
        .pause(40);
    }
    await act.pause(120).up().perform();

    // Page 0 is no longer first — it moved down (page tier; robust to the exact
    // landing index).
    await browser.waitUntil(
      async () => {
        const order = await getWorkspacePageIds();
        return order.length === 5 && order[0] !== ids[0] && order.includes(ids[0]);
      },
      { timeout: 10_000, timeoutMsg: 'the thumbnail drag never reordered the pages' },
    );
  });
});
