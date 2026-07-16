import { resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getState,
  getWorkspacePageIds,
  setReactInputValue,
} from '../support/harness.js';

// § 6.5's 1,000-page checkpoint (M4.3(e), owned by M7): virtualized window
// over the existing raster pipeline — smooth scroll, bounded DOM, first
// paint not held for the tail. Wall-clock numbers vary per box, so the
// STRUCTURAL claims carry the gate (the render window stays bounded no
// matter where you are in the document) with generous time caps as the
// regression tripwire; the measured numbers are recorded in the phase doc.

async function renderedCellCount(): Promise<number> {
  return (await browser.execute(
    () => document.querySelectorAll('[data-testid="document-view"] [data-page-id]').length,
  )) as number;
}

describe('1,000-page checkpoint (§ 6.5)', () => {
  let tmp: string;
  let bigPdf: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ops-e2e-1k-'));
    bigPdf = resolve(tmp, 'thousand.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 1000; i++) {
      doc.addPage([612, 792]).drawText(`Page ${i}`, { x: 50, y: 700, size: 24, font });
    }
    writeFileSync(bigPdf, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('opens and indexes 1,000 pages without holding first paint', async () => {
    await waitForHarness();
    await closeAllFiles();
    const t0 = Date.now();
    await openByPaths([bigPdf]);
    await browser.waitUntil(async () => (await getState()).fileCount === 1, {
      timeout: 30_000,
    });
    // First paint: SOME cells render long before the tail indexes.
    await browser.waitUntil(async () => (await renderedCellCount()) > 0, {
      timeout: 30_000,
      timeoutMsg: 'no page cell rendered',
    });
    const firstPaintMs = Date.now() - t0;
    console.log(`1k first cells: ${firstPaintMs}ms`);
    expect(firstPaintMs).toBeLessThan(30_000);

    await browser.waitUntil(
      async () => (await getWorkspacePageIds()).length === 1000,
      { timeout: 60_000, timeoutMsg: 'the indexer never finished 1,000 pages' },
    );
    console.log(`1k fully indexed: ${Date.now() - t0}ms`);
  });

  it('the reading view is VIRTUALIZED: the DOM window stays bounded', async () => {
    const atTop = await renderedCellCount();
    expect(atTop).toBeGreaterThan(0);
    expect(atTop).toBeLessThan(50); // ±N window, not 1,000 mounted cells

    // Jump deep via the real go-to-page UI.
    await browser.keys(['Control', 'Shift', 'n']);
    await setReactInputValue('[data-testid="page-nav-box"]', '900');
    await browser.keys(['Enter']);
    const pages = await getWorkspacePageIds();
    await browser.waitUntil(
      async () => (await getState()).currentPageId === pages[899],
      { timeout: 20_000, timeoutMsg: 'go-to-page 900 never landed' },
    );
    const deep = await renderedCellCount();
    expect(deep).toBeLessThan(50);
    console.log(`1k window: top=${atTop} deep=${deep}`);
  });

  it('scrolling a long stretch keeps tracking and stays bounded', async () => {
    const t0 = Date.now();
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="document-view"]');
      if (el) el.scrollTop = el.scrollTop - 20_000; // ~25 pages back
    });
    await browser.waitUntil(
      async () => {
        const id = (await getState()).currentPageId;
        const pages = await getWorkspacePageIds();
        return id !== null && pages.indexOf(id) < 890;
      },
      { timeout: 10_000, timeoutMsg: 'scroll tracking never caught up' },
    );
    console.log(`1k scroll+track: ${Date.now() - t0}ms`);
    expect(await renderedCellCount()).toBeLessThan(50);
  });
});
