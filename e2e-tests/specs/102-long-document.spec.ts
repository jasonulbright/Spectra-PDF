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

// P12 (brief 36): a long document past the browser element-height ceiling.
// The reading view's spacer caps at SAFE_ELEMENT_EXTENT (30M px) and rows
// translate under it — so zoom is no longer bounded by page count (the old
// mitigation rendered long docs SMALL), and the tail stays reachable: the
// page box lands the LAST page, and scrolling to the bottom reports it.
//
// The fixture: 600 blank pages. At max zoom (64) the true extent is
// 600 × 984 × 64 ≈ 37.8M px — past the cap. The OLD ceiling clamped zoom to
// ~50× here (pages rendered ~20% small); the NEW path keeps the full zoom
// (page height ~61,440px — the discriminating assert) while the spacer stays
// under the cap and page 600 still lands.

const PAGE_COUNT = 600;

describe('long documents past the element ceiling (P12)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-longdoc-'));
    pdfPath = resolve(tmp, 'long.pdf');
    const doc = await PDFDocument.create();
    for (let i = 0; i < PAGE_COUNT; i++) doc.addPage([400, 500]);
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

    // Drive zoom to the ceiling (1.2^n saturates at MAX_ZOOM = 64).
    for (let i = 0; i < 25; i++) await invokeAppCommand('view.zoomIn');

    // The spacer must stay under the element cap...
    const spacerH = await browser.execute(
      () =>
        (document.querySelector('[data-testid="document-view"] .docview-spacer') as HTMLElement)
          .offsetHeight,
    );
    expect(spacerH).toBeLessThanOrEqual(30_000_000);

    // ...while the page renders at the FULL zoom — the old pageCount ceiling
    // clamped this fixture to ~50× (~48,800px); the translated window keeps
    // 64× (~61,440px). This is the "long docs render small" fix, observed.
    await browser.waitUntil(
      async () => {
        const h = await browser.execute(() => {
          const el = document.querySelector(
            '[data-testid="document-view"] .docview-row',
          ) as HTMLElement | null;
          return el ? el.offsetHeight : 0;
        });
        return h > 55_000;
      },
      { timeout: 20_000, timeoutMsg: 'zoom stayed clamped below the honest maximum' },
    );

    // The tail is reachable: jump to the LAST page and the box must HOLD it
    // (the old failure read e.g. "600 / 600" over page ~532, durably).
    await $('[data-testid="page-nav-box"]').click();
    await setReactInputValue('[data-testid="page-nav-box"]', String(PAGE_COUNT));
    await browser.keys(['Enter']);
    await browser.waitUntil(
      async () => {
        const v = await $('[data-testid="page-nav-box"]').getValue();
        const rows = await $$('[data-testid="document-view"] .docview-row');
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
