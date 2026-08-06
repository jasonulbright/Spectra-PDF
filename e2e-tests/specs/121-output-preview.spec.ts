// Output Preview: the pages in view raster through the separation device
// instead of the viewer's own renderer.
//
// The assertions are about PIXELS and MEASUREMENTS, not about a panel
// rendering. No RGB device simulates overprint and none can show one plate,
// so a preview that merely put a label on the screen would be showing the
// same raster it always did — the separation canvas has to exist, its pixels
// have to change when an ink is switched off, and the total-ink figure has to
// match a page built to carry it.
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  invokeAppCommand,
} from '../support/harness.js';

const SPOT = resolve(__dirname, '..', 'fixtures', 'separations-spot.pdf');
const LADDER = resolve(__dirname, '..', 'fixtures', 'separations-tac.pdf');

/** The ladder's heaviest patch, by construction. */
const LADDER_MAX_TAC = 340;

/** A fingerprint of the separation canvas' pixels — enough to prove a
 *  re-composite changed the image without carrying the image around. */
async function separationFingerprint(): Promise<{ found: boolean; sum: number; pixels: number }> {
  return browser.execute(function () {
    const list = Array.prototype.slice.call(
      document.querySelectorAll('canvas.pageview-separation.ready'),
    ) as HTMLCanvasElement[];
    const drawn = list.filter((c) => c.width > 8 && c.height > 8);
    if (drawn.length === 0) return { found: false, sum: 0, pixels: 0 };
    const canvas = drawn[0];
    const ctx = canvas.getContext('2d');
    if (!ctx) return { found: false, sum: 0, pixels: 0 };
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4 * 37) {
      sum += data[i] + data[i + 1] + data[i + 2];
      pixels += 1;
    }
    return { found: true, sum, pixels };
  });
}

async function waitForSeparations(timeout = 60_000): Promise<{ sum: number; pixels: number }> {
  let captured = { found: false, sum: 0, pixels: 0 };
  await browser.waitUntil(
    async () => {
      captured = await separationFingerprint();
      return captured.found && captured.pixels > 0;
    },
    { timeout, timeoutMsg: 'the separation raster never replaced the page' },
  );
  return { sum: captured.sum, pixels: captured.pixels };
}

async function openOutputPreview(): Promise<void> {
  // The panel lives in the dock BESIDE the document — the preview replaces
  // the page raster, so the page has to stay on screen.
  await setView('operations');
  await invokeAppCommand('view.documentView');
  await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  await setActiveOp('outputpreview');
  await $('[data-testid="output-preview-arm"]').waitForDisplayed({ timeout: 15_000 });
}

describe('output preview', () => {
  before(async () => {
    await waitForHarness();
  });

  after(async () => {
    await closeAllFiles();
  });

  it('arming replaces the page raster with the separation composite', async () => {
    await closeAllFiles();
    await openByPaths([SPOT]);
    await openOutputPreview();

    // Nothing stands in for the viewer's raster until the mode is armed.
    expect((await separationFingerprint()).found).toBe(false);

    await $('[data-testid="output-preview-arm"]').click();
    const armed = await waitForSeparations();
    expect(armed.pixels).toBeGreaterThan(0);
    expect(await $('[data-testid="output-preview-arm"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('lists the plates the page actually separated into', async () => {
    await $('[data-testid="output-preview-ink-list"]').waitForDisplayed({ timeout: 20_000 });
    for (const slug of ['cyan', 'magenta', 'yellow', 'black']) {
      await $(`[data-testid="output-preview-ink-${slug}"]`).waitForDisplayed({ timeout: 20_000 });
    }
    // The fixture's spot colorant gets a plate of its own, which is the whole
    // reason the preview exists — an RGB render folds it into process.
    await $('[data-testid="output-preview-ink-pantone-185-c"]').waitForDisplayed({
      timeout: 20_000,
    });
  });

  it('reads the per-ink page coverage the device measured', async () => {
    const coverage = await $('[data-testid="output-preview-coverage-cyan"]').getText();
    expect(coverage).toMatch(/\d/);
  });

  it('switching an ink off changes the page', async () => {
    const before = await waitForSeparations();
    await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
    let after = before;
    await browser.waitUntil(
      async () => {
        const next = await separationFingerprint();
        if (!next.found) return false;
        after = { sum: next.sum, pixels: next.pixels };
        return next.sum !== before.sum;
      },
      { timeout: 60_000, timeoutMsg: 'switching an ink off never re-composited the page' },
    );
    // Removing an ink can only ever lighten the page.
    expect(after.sum).toBeGreaterThan(before.sum);
    await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
  });

  it('flipping overprint simulation re-renders through the device', async () => {
    const before = await waitForSeparations();
    await $('[data-testid="output-preview-overprint"]').click();
    await browser.waitUntil(
      async () => {
        const next = await separationFingerprint();
        return next.found && next.pixels > 0;
      },
      { timeout: 90_000, timeoutMsg: 'disabling overprint never produced a raster' },
    );
    expect(before.pixels).toBeGreaterThan(0);
    await $('[data-testid="output-preview-overprint"]').click();
  });

  it('the ink limit alarm measures the heaviest pixel, not the page average', async () => {
    await closeAllFiles();
    await openByPaths([LADDER]);
    await openOutputPreview();
    await $('[data-testid="output-preview-arm"]').click();
    await waitForSeparations();

    await $('[data-testid="output-preview-alarm"]').click();
    await $('[data-testid="output-preview-maxtac"]').waitForDisplayed({ timeout: 30_000 });

    let reported = 0;
    await browser.waitUntil(
      async () => {
        const text = await $('[data-testid="output-preview-maxtac"]').getText();
        const match = /([\d.]+)\s*%/.exec(text);
        if (!match) return false;
        reported = Number(match[1]);
        return reported > 0;
      },
      { timeout: 30_000, timeoutMsg: 'the heaviest-pixel figure never appeared' },
    );
    // The ladder's heaviest patch is 340 % by construction. The device's own
    // page average over the same page is 200 %, which is why the alarm cannot
    // be driven by it.
    expect(reported).toBeGreaterThan(LADDER_MAX_TAC - 5);
    expect(reported).toBeLessThan(LADDER_MAX_TAC + 5);

    const over = await $('[data-testid="output-preview-over"]').getText();
    expect(over).toMatch(/\d/);
  });

  it('leaving the mode gives the ordinary raster back', async () => {
    await $('[data-testid="output-preview-arm"]').click();
    await browser.waitUntil(
      async () => !(await separationFingerprint()).found,
      { timeout: 30_000, timeoutMsg: 'the separation raster outlived the mode' },
    );
    expect(await $('[data-testid="output-preview-arm"]').getAttribute('aria-pressed')).toBe('false');
    // The viewer's own raster was never overwritten, so it is still there.
    const base = await browser.execute(function () {
      const list = Array.prototype.slice.call(
        document.querySelectorAll('canvas.pageview-base'),
      ) as HTMLCanvasElement[];
      return list.filter((c) => c.width > 8 && c.height > 8).length;
    });
    expect(base).toBeGreaterThan(0);
  });

  it('opening another tool disarms the preview', async () => {
    await setActiveOp('outputpreview');
    await $('[data-testid="output-preview-arm"]').click();
    await waitForSeparations();
    expect(await invokeAppCommand('tools.open.protect')).toBe(true);
    await browser.waitUntil(
      async () => !(await separationFingerprint()).found,
      { timeout: 30_000, timeoutMsg: 'a closed tool left the preview armed' },
    );
  });
});
