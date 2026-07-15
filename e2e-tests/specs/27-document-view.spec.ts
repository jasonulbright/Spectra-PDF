import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  focusTab,
  setView,
  setReactInputValue,
} from '../support/harness.js';

/** A tiny born-digital PDF with known text — so Find has something real to hit. */
async function makeTextPdf(path: string, lines: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  let y = 350;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 16, font });
    y -= 30;
  }
  writeFileSync(path, await doc.save());
}

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

  it('shows a page indicator matching the document, and jumping scrolls', async () => {
    const pageCount = (await getState()).activeFile?.pageCount ?? 0;
    expect(pageCount).toBeGreaterThan(0);
    // The indicator's total matches the document.
    expect(await $('[data-testid="page-nav-total"]').getText()).toContain(`/ ${pageCount}`);
    if (pageCount < 2) return; // single-page fixture — no page below the fold to jump to
    const scrollTop = () =>
      browser.execute(
        () => (document.querySelector('[data-testid="document-view"]') as HTMLElement | null)?.scrollTop ?? 0,
      );
    const before = await scrollTop();
    await $('[data-testid="page-nav-box"]').click();
    await setReactInputValue('[data-testid="page-nav-box"]', String(pageCount));
    await browser.keys(['Enter']);
    await browser.waitUntil(async () => (await scrollTop()) > before, {
      timeout: 10_000,
      timeoutMsg: 'jumping to the last page did not scroll the reading view',
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

// M4.1c gate: the reading view shows exactly ONE document, but Find matches
// workspace-wide. A match in ANOTHER open file must bring that file to the front
// and land on it — the bug this closed was a silent no-op while Find's own
// counter advanced, so the assertion has to be that the VIEW actually moved, not
// merely that Find found something.
describe('reading view: a Find match in another open file (M4.1c)', () => {
  let tmp: string;
  let fileA: string;
  let fileB: string;
  const NEEDLE = 'ZYGOTEMARKER';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'opds-e2e-xdoc-'));
    fileA = resolve(tmp, 'alpha.pdf');
    fileB = resolve(tmp, 'beta.pdf');
    // Only file B contains the needle.
    await makeTextPdf(fileA, ['ALPHA ONLY', 'NOTHING TO SEE']);
    await makeTextPdf(fileB, ['BETA DOCUMENT', NEEDLE]);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([fileA, fileB]);
    await browser.waitUntil(async () => (await getState()).fileCount === 2, {
      timeout: 10_000,
      timeoutMsg: 'both files never opened',
    });
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('focuses the other file and lands on the match, instead of silently doing nothing', async () => {
    // Read file A...
    await focusTab({ doc: fileA });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === fileA, {
      timeout: 10_000,
      timeoutMsg: 'file A never became active',
    });
    if (!(await $('[data-testid="document-view"]').isExisting())) {
      await $('[data-testid="toggle-doc-view"]').click();
    }
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 10_000 });

    // ...then Find a term that only exists in file B, and navigate to it.
    await $('[data-testid="toggle-find"]').click();
    await $('[data-testid="find-input"]').waitForDisplayed({ timeout: 10_000 });
    await setReactInputValue('[data-testid="find-input"]', NEEDLE);
    await browser.waitUntil(
      async () => (await $('[data-testid="find-count"]').getText()).match(/[1-9]/) !== null,
      { timeout: 15_000, timeoutMsg: 'Find never matched the needle in the other file' },
    );
    await $('[data-testid="find-next"]').click();

    // THE ASSERTION: the reading view actually moved to file B. Before M4.1c the
    // counter advanced while centerOn silently returned (the page belonged to a
    // document this view wasn't showing).
    await browser.waitUntil(async () => (await getState()).activeFile?.path === fileB, {
      timeout: 10_000,
      timeoutMsg: 'the Find jump did not bring the other file to the front — it no-oped',
    });
    // ...and it is still the reading view that is showing it.
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });
});
