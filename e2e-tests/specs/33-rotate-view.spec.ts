import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getWorkspacePageIds,
  commitPendingEdits,
  saveActiveAs,
  invokeAppCommand,
  getFirstAnnotation,
  consumeLastError,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// M6.1: Rotate View — render-only quarter-turns of the reading display.
// The page tier and the committed file must never turn; overlays drawn WHILE
// rotated must land where the user drew them.

/** Bounding box of the first rendered page cell. */
async function firstCellBox(): Promise<{ x: number; y: number; w: number; h: number }> {
  return (await browser.execute(() => {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as { x: number; y: number; w: number; h: number };
}

describe('rotate view (M6.1)', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ops-e2e-rotview-'));
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('View ▸ Rotate View ▸ Clockwise swaps the displayed aspect', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 5, {
      timeoutMsg: 'sample never indexed',
    });
    await browser.waitUntil(async () => (await firstCellBox()) !== null, {
      timeoutMsg: 'no page cell rendered',
    });

    const upright = await firstCellBox();
    // Letter portrait: taller than wide.
    expect(upright.h).toBeGreaterThan(upright.w);

    await $('[data-testid="menu-view"]').click();
    await $('[data-testid="submenu-view-rotate"]').click();
    const cw = $('[data-testid="menuitem-view-rotate-cw"]');
    await cw.waitForDisplayed({ timeoutMsg: 'no Rotate View ▸ Clockwise item' });
    await cw.click();

    await browser.waitUntil(
      async () => {
        const b = await firstCellBox();
        return b !== null && b.w > b.h;
      },
      { timeoutMsg: 'the displayed page never turned landscape' },
    );
  });

  it('Ctrl+Shift+Plus / Ctrl+Shift+Minus step the turn (the zoom keys stay shiftless)', async () => {
    // At 90 now. Another CW quarter → 180: portrait aspect again.
    await browser.keys(['Control', 'Shift', '+']);
    await browser.waitUntil(
      async () => {
        const b = await firstCellBox();
        return b !== null && b.h > b.w;
      },
      { timeoutMsg: 'Ctrl+Shift+Plus did not rotate to 180' },
    );
    // CCW back to 90: landscape.
    await browser.keys(['Control', 'Shift', '_']);
    await browser.waitUntil(
      async () => {
        const b = await firstCellBox();
        return b !== null && b.w > b.h;
      },
      { timeoutMsg: 'Ctrl+Shift+Minus did not rotate back to 90' },
    );
  });

  it('a highlight drawn ON THE ROTATED VIEW lands where the user drew it', async () => {
    // Still at 90 (clockwise). Draw over the displayed rect x∈[.1,.3],
    // y∈[.1,.3] of the TURNED page. Un-projected into the stored frame
    // (270°: x'=y, y'=1-(x+w)) that is x'∈[.1,.3], y'∈[.7,.9] — in PDF
    // points on Letter: x 61.2..183.6, y 79.2..237.6. A missing or doubled
    // projection puts the rect in a different quadrant entirely.
    await invokeAppCommand('tools.highlight');
    const cell = await firstCellBox();
    const from = { x: Math.round(cell.x + 0.1 * cell.w), y: Math.round(cell.y + 0.1 * cell.h) };
    const to = { x: Math.round(cell.x + 0.3 * cell.w), y: Math.round(cell.y + 0.3 * cell.h) };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: from.x, y: from.y })
      .down()
      .pause(60)
      .move({ x: to.x, y: to.y })
      .pause(60)
      .up()
      .perform();
    // Bisect: the annotation must exist in STATE before the commit question
    // is even asked.
    const inState = await getFirstAnnotation(5_000);
    expect(inState?.kind).toBe('highlight');
    await invokeAppCommand('tools.select');

    await commitPendingEdits();
    expect(await consumeLastError()).toBeNull();
    const dest = resolve(tmp, 'rotated-highlight.pdf');
    await saveActiveAs(dest);

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(dest)),
      isEvalSupported: false,
    }).promise;
    const page = await doc.getPage(1);
    // The highlight tool draws translucent BOXES — committed as /Square
    // (the 2c.1 design; text-markup /Highlight needs QuadPoints on text).
    const annots = (await page.getAnnotations()) as { subtype: string; rect: number[] }[];
    const highlights = annots.filter((a) => a.subtype === 'Square');
    expect(highlights.length).toBe(1);
    const [x0, y0, x1, y1] = highlights[0].rect;
    // Small padding is applied by the builder; assert within a loose band.
    expect(x0).toBeGreaterThan(61.2 - 15);
    expect(x1).toBeLessThan(183.6 + 15);
    expect(y0).toBeGreaterThan(79.2 - 15);
    expect(y1).toBeLessThan(237.6 + 15);
    // And it is genuinely THAT quadrant, not a mis-projection into another.
    expect(x1).toBeLessThan(612 / 2);
    expect(y1).toBeLessThan(792 / 2 + 40);
    expect(y0).toBeGreaterThan(792 * 0.05);
    await doc.loadingTask.destroy();

    // THE view-only guarantee: the committed pages themselves are unrotated.
    const committed = await PDFDocument.load(readFileSync(dest));
    for (let i = 0; i < committed.getPageCount(); i++) {
      expect(committed.getPage(i).getRotation().angle).toBe(0);
    }
  });

  it('rotating back upright restores the original aspect', async () => {
    await $('[data-testid="menu-view"]').click();
    await $('[data-testid="submenu-view-rotate"]').click();
    const ccw = $('[data-testid="menuitem-view-rotate-ccw"]');
    await ccw.waitForDisplayed();
    await ccw.click();
    await browser.waitUntil(
      async () => {
        const b = await firstCellBox();
        return b !== null && b.h > b.w;
      },
      { timeoutMsg: 'the view never came back upright' },
    );
  });
});
