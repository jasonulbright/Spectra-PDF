import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  setReactInputValue,
  invokeAppCommand,
} from '../support/harness.js';

// A long document past the browser element-height ceiling.
// The reading view's spacer caps at SAFE_ELEMENT_EXTENT (30M px) and rows
// translate under it — so zoom is no longer bounded by page count (the old
// mitigation rendered long docs SMALL), and the tail stays reachable: the
// page box lands the LAST page, and scrolling to the bottom reports it.
//
// The fixture: 600 blank 400 × 1000 pt pages. The zoom ceiling is 6400% of
// the current page (`readingZoomRange`; the width-axis render cap is far
// above it here), so a page renders 64,000 px tall and the true extent is
// 38.4M px — past the cap. A page-count ceiling would clamp the zoom below
// 6400%; the translated window keeps it while the spacer stays under the cap
// and page 600 still lands.

const PAGE_COUNT = 600;
const PAGE_PT: [number, number] = [400, 1000];
const CEILING_PERCENT = 6400;
const PAGE_PX_AT_CEILING = (PAGE_PT[1] * CEILING_PERCENT) / 100;

describe('long documents past the element ceiling', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-longdoc-'));
    pdfPath = resolve(tmp, 'long.pdf');
    const doc = await PDFDocument.create();
    for (let i = 0; i < PAGE_COUNT; i++) doc.addPage(PAGE_PT);
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps every page reachable at FULL zoom on a document past the cap', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([pdfPath]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeout: 20_000,
      timeoutMsg: 'the long document never opened',
    });
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(
      async () => (await $('[data-testid="page-nav-total"]').getText()).includes(`/ ${PAGE_COUNT}`),
      { timeout: 30_000, timeoutMsg: 'the page total never reflected the fixture' },
    );

    const zoomPercent = async (): Promise<number> =>
      Number(
        await browser.execute(
          () => document.querySelector('[data-testid="document-view"]')?.getAttribute('data-zoom-percent') ?? 'NaN',
        ),
      );
    for (let i = 0; i < 60 && (await zoomPercent()) < CEILING_PERCENT; i++) {
      const before = await zoomPercent();
      await invokeAppCommand('view.zoomIn');
      await browser.waitUntil(async () => (await zoomPercent()) > before, {
        timeout: 10_000,
        timeoutMsg: `zoom in did not step up from ${before}%`,
      });
    }

    // The spacer must stay under the element cap...
    const spacerH = await browser.execute(
      () =>
        (document.querySelector('[data-testid="document-view"] .docview-spacer') as HTMLElement)
          .offsetHeight,
    );
    expect(spacerH).toBeLessThanOrEqual(30_000_000);

    // ...while the page renders at the full 6400%: a row is one page tall.
    let last: unknown = null;
    try {
      await browser.waitUntil(
        async () => {
          const read = await browser.execute(() => {
            const view = document.querySelector('[data-testid="document-view"]');
            const row = view?.querySelector('.docview-row') as HTMLElement | null;
            return {
              percent: Number(view?.getAttribute('data-zoom-percent') ?? 'NaN'),
              rowH: row ? row.offsetHeight : 0,
            };
          });
          last = read;
          return read.percent === CEILING_PERCENT && Math.abs(read.rowH - PAGE_PX_AT_CEILING) <= 2;
        },
        { timeout: 20_000, interval: 200 },
      );
    } catch {
      throw new Error(`zoom stayed clamped below the 6400% ceiling; last read: ${JSON.stringify(last)}`);
    }

    // The tail is reachable: jump to the LAST page and the box must HOLD it
    // (the old failure read e.g. "600 / 600" over page ~532, durably).
    await $('[data-testid="page-nav-box"]').click();
    await setReactInputValue('[data-testid="page-nav-box"]', String(PAGE_COUNT));
    await browser.keys(['Enter']);
    await browser.waitUntil(
      async () => {
        const v = await $('[data-testid="page-nav-box"]').getValue();
        const rows = await $$('[data-testid="document-view"] .docview-row').getElements();
        return v === String(PAGE_COUNT) && rows.length > 0;
      },
      { timeout: 20_000, timeoutMsg: 'the jump to the last page did not land' },
    );

    // And scrolling hard to the REAL bottom reports the last page — the
    // endpoint mapping is exact (real bottom == virtual bottom).
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="document-view"]') as HTMLElement;
      el.scrollTop = el.scrollHeight;
    });
    await browser.waitUntil(
      async () => (await $('[data-testid="page-nav-box"]').getValue()) === String(PAGE_COUNT),
      { timeout: 20_000, timeoutMsg: 'scrolling to the bottom did not report the last page' },
    );
  });
});
