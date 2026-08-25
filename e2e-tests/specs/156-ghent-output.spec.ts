// The Ghent PDF Output Suite 5.0, through the real viewer and Output Preview.
//
// INTERNAL REGRESSION EVIDENCE ONLY. Passing here is not a Ghent Workgroup
// conformance certification; that programme has its own process and this
// product is not in it.
//
// The suite's own verdict is visual — a clear X, or a patch that stops
// matching the reference beside it — and no automated assertion pronounces it.
// What this spec proves is the half a machine can: the assembled pages reach
// the screen, Output Preview separates them into the plates the documentation
// says they carry, the spot plates are there and are switchable, and the
// overprint simulation the whole suite is built on actually re-renders. The
// engine-side table of documented expectations is `tests/ghent-expected.tsv`;
// the human half is these pages beside `..._ALL_REFERENCE.pdf`.
//
// The corpus is gitignored and fetched (`scripts/fetch-ghent-suite.py`), so
// every case skips by NAME on a tree that has not fetched it — the skip tests
// for the FILES, never for a directory that a workflow may have created empty.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  setView,
  setActiveOp,
  closeAllFiles,
  invokeAppCommand,
  waitForDisplayedSelector,
} from '../support/harness.js';

const CORPUS = resolve(__dirname, '..', '..', 'ghent-corpus');
const PAGES = resolve(
  CORPUS,
  'testpages',
  'Ghent_PDF_Output_Suite_V50_Testpages',
  'Ghent_PDF-Output-Test-V50_ALL_X4.pdf',
);
const CATEGORIES = resolve(
  CORPUS,
  'patches',
  'Ghent_PDF_Output_Suite_V50_Patches',
  'Categories',
);
const SPOT_PAGE = resolve(
  CATEGORIES,
  '2-SPOT',
  'Test page',
  'Ghent_PDF-Output-Test-V50_SPOT_X4.pdf',
);
const OPTIONAL_CONTENT = resolve(
  CATEGORIES,
  '1-CMYK',
  'Patches',
  'GWG150_OptionalContent-OCCD_X4.pdf',
);

/** The assembled suite is six A4 pages, by the suite's own documentation. */
const ASSEMBLED_PAGES = 6;

/** The two spots the SPOT category page prints, named as the files name them. */
const SPOT_INKS = [
  { slug: 'gwg-green', name: 'GWG Green' },
  { slug: 'pantone-265-c', name: 'PANTONE 265 C' },
];

interface SeparationSample {
  found: boolean;
  sum: number;
  pixels: number;
}

/** A fingerprint of the separation composite — enough to prove a re-render
 *  changed the image without carrying the image around. */
async function separationFingerprint(): Promise<SeparationSample> {
  return browser.execute(function () {
    const list = Array.prototype.slice.call(
      document.querySelectorAll('canvas.pageview-separation.ready'),
    ) as HTMLCanvasElement[];
    const drawn = list.filter((c) => c.width > 8 && c.height > 8);
    if (drawn.length === 0) return { found: false, sum: 0, pixels: 0 };
    const ctx = drawn[0].getContext('2d');
    if (!ctx) return { found: false, sum: 0, pixels: 0 };
    const data = ctx.getImageData(0, 0, drawn[0].width, drawn[0].height).data;
    let sum = 0;
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4 * 37) {
      sum += data[i] + data[i + 1] + data[i + 2];
      pixels += 1;
    }
    return { found: true, sum, pixels };
  });
}

async function waitForSeparations(timeout = 90_000): Promise<SeparationSample> {
  let captured: SeparationSample = { found: false, sum: 0, pixels: 0 };
  await browser.waitUntil(
    async () => {
      captured = await separationFingerprint();
      return captured.found && captured.pixels > 0;
    },
    { timeout, timeoutMsg: 'the separation composite never arrived', interval: 300 },
  );
  return captured;
}

async function renderedPages(): Promise<number> {
  return browser.execute(function () {
    const list = Array.prototype.slice.call(
      document.querySelectorAll('canvas.pageview-base'),
    ) as HTMLCanvasElement[];
    return list.filter((c) => c.width > 8 && c.height > 8).length;
  });
}

async function openOutputPreview(): Promise<void> {
  await setView('operations');
  await invokeAppCommand('view.documentView');
  await waitForDisplayedSelector('[data-testid="document-view"]', { timeout: 15_000 });
  await setActiveOp('outputpreview');
  await waitForDisplayedSelector('[data-testid="output-preview-arm"]', { timeout: 15_000 });
}

/** The one reason a case here is skipped, named as an axis. */
function corpusPresent(...files: string[]): boolean {
  return files.every((file) => existsSync(file));
}

describe('ghent output suite', function () {
  // The suite timeout is set HERE, never per case: wdio reads the runnable's
  // timeout BEFORE the test body runs, so a `this.timeout()` written inside a
  // case is captured too late to raise anything. One separation render of an
  // assembled page outlives the 60 s default.
  this.timeout(240_000);

  before(async () => {
    await waitForHarness();
  });

  after(async () => {
    await closeAllFiles();
  });

  it('opens the six assembled pages in the viewer', async function () {
    if (!corpusPresent(PAGES)) {
      // Ghent-corpus axis: the suite is not fetched on this machine.
      this.skip();
      return;
    }
    await closeAllFiles();
    await openByPaths([PAGES]);
    await invokeAppCommand('view.documentView');
    await browser.waitUntil(async () => (await renderedPages()) > 0, {
      timeout: 60_000,
      timeoutMsg: 'no assembled page reached the screen',
    });
    const state = await getState();
    expect(state.activeFile?.pageCount).toBe(ASSEMBLED_PAGES);
  });

  it('separates the assembled pages into the four process plates', async function () {
    if (!corpusPresent(PAGES)) {
      this.skip();
      return;
    }
    await openOutputPreview();
    await $('[data-testid="output-preview-arm"]').click();
    const armed = await waitForSeparations();
    expect(armed.pixels).toBeGreaterThan(0);
    await waitForDisplayedSelector('[data-testid="output-preview-ink-list"]', {
      timeout: 60_000,
    });
    for (const slug of ['cyan', 'magenta', 'yellow', 'black']) {
      await waitForDisplayedSelector(`[data-testid="output-preview-ink-${slug}"]`, {
        timeout: 60_000,
      });
    }
  });

  it('lists both spot plates of the SPOT category page', async function () {
    if (!corpusPresent(SPOT_PAGE)) {
      this.skip();
      return;
    }
    await closeAllFiles();
    await openByPaths([SPOT_PAGE]);
    await openOutputPreview();
    await $('[data-testid="output-preview-arm"]').click();
    await waitForSeparations();
    for (const ink of SPOT_INKS) {
      const entry = await $(`[data-testid="output-preview-ink-${ink.slug}"]`);
      await entry.waitForDisplayed({ timeout: 60_000 });
      // An ink name is document content and is never translated.
      expect(await entry.getText()).toContain(ink.name);
    }
  });

  it('switching a spot plate off changes the composite', async function () {
    if (!corpusPresent(SPOT_PAGE)) {
      this.skip();
      return;
    }
    const before = await waitForSeparations();
    await $(`[data-testid="output-preview-toggle-${SPOT_INKS[0].slug}"]`).click();
    await browser.waitUntil(
      async () => {
        const next = await separationFingerprint();
        return next.found && next.sum !== before.sum;
      },
      { timeout: 90_000, timeoutMsg: 'switching a spot plate off changed nothing' },
    );
    await $(`[data-testid="output-preview-toggle-${SPOT_INKS[0].slug}"]`).click();
  });

  it('flipping overprint simulation re-renders the spot page', async function () {
    if (!corpusPresent(SPOT_PAGE)) {
      this.skip();
      return;
    }
    // Every overprint patch in the suite depends on this setting doing
    // something; a simulation that changes no pixel would make the whole
    // category unreadable while looking healthy.
    const before = await waitForSeparations();
    await $('[data-testid="output-preview-overprint"]').click();
    await browser.waitUntil(
      async () => {
        const next = await separationFingerprint();
        return next.found && next.sum !== before.sum;
      },
      { timeout: 90_000, timeoutMsg: 'overprint simulation changed no pixel' },
    );
    await $('[data-testid="output-preview-overprint"]').click();
    await waitForSeparations();
  });

  it('shows the optional-content patch its own layers', async function () {
    if (!corpusPresent(OPTIONAL_CONTENT)) {
      this.skip();
      return;
    }
    // Patch 15.0's documented expectation is that the DEFAULT configuration
    // is what renders; the panel has to report the groups for that to be
    // checkable at all.
    await closeAllFiles();
    await openByPaths([OPTIONAL_CONTENT]);
    await setView('operations');
    await setActiveOp('layers');
    await waitForDisplayedSelector('[data-testid="layers-list"]', { timeout: 30_000 });
    await waitForDisplayedSelector('[data-testid="layer-0"]', { timeout: 30_000 });
    const rows = await $$('[data-testid^="layer-toggle-"]');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('leaving the preview gives the ordinary raster back', async function () {
    if (!corpusPresent(SPOT_PAGE)) {
      this.skip();
      return;
    }
    await closeAllFiles();
    await openByPaths([SPOT_PAGE]);
    await openOutputPreview();
    await $('[data-testid="output-preview-arm"]').click();
    await waitForSeparations();
    await $('[data-testid="output-preview-arm"]').click();
    await browser.waitUntil(async () => !(await separationFingerprint()).found, {
      timeout: 60_000,
      timeoutMsg: 'the separation raster outlived the mode',
    });
    expect(await renderedPages()).toBeGreaterThan(0);
  });
});
