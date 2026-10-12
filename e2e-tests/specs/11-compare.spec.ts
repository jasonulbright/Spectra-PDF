import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  getState,
  invokeAppCommand,
  getActiveDocPages,
  deleteCanvasPagesAndWait,
  commitPendingEdits,
  selectCanvasPages,
  rotateSelectedCanvasPages,
  holdReaderCopies,
  releaseReaderCopies,
  readerCopiesWaiting,
} from '../support/harness.js';

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

/** One page per entry, each drawing its lines. */
async function makePagedPdf(path: string, pages: string[][]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([400, 400]);
    let y = 350;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 16, font });
      y -= 30;
    }
  }
  writeFileSync(path, await doc.save());
}

const DOCUMENT_CHANGED = 'The document changed after this tool read it.';

async function documentChangedShown(): Promise<boolean> {
  return await browser.execute((text) => document.body.innerText.includes(text), DOCUMENT_CHANGED);
}

describe('compare panel diffs two open PDFs', () => {
  let tmp: string;
  let a: string;
  let b: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-compare-'));
    a = resolve(tmp, 'a.pdf');
    b = resolve(tmp, 'b.pdf');
    await makeTextPdf(a, ['ALPHA', 'BETA', 'GAMMA']);
    await makeTextPdf(b, ['ALPHA', 'BETA', 'GAMMA', 'DELTA']); // one extra line
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the differing line between two open files', async () => {
    await waitForHarness();
    await openByPaths([a, b]); // both open; the compare panel picks the other as target
    await setView('operations');
    await setActiveOp('compare');

    const target = $('[data-testid="compare-target"]');
    await target.waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="compare-run"]').click();

    const summary = $('[data-testid="compare-summary"]');
    await summary.waitForDisplayed({ timeout: 20_000 });
    // The two files genuinely differ, so it must not report "identical".
    expect(await summary.getText()).not.toContain('identical');

    const rows = $('[data-testid="compare-rows"]');
    await rows.waitForDisplayed({ timeout: 20_000 });
    expect(await rows.getText()).toContain('DELTA');

    // The SIGN, not merely the presence of the line. The panel passes the
    // TARGET as the engine's baseline and the ACTIVE document as the changed
    // side, so a line present only in the active document is an `add` and a
    // line present only in the target is a `remove`. Asserting only that
    // DELTA appears somewhere passes just as happily with the polarity
    // inverted, which is exactly the bug the wiring above was fixed for.
    // The expected sign is derived from which file the target select holds,
    // so the assertion does not depend on which of the two opened first.
    // Paths are canonicalized at the Rust boundary, so the select's value is
    // matched by basename rather than by the string this spec wrote.
    const targetIsA = (await target.getValue()).replace(/\\/g, '/').endsWith('/a.pdf');
    const expected = targetIsA ? 'add' : 'remove';
    const deltaRow = $(`[data-testid="compare-rows"] [data-diff-type="${expected}"]`);
    await deltaRow.waitForDisplayed({ timeout: 10_000 });
    expect(await deltaRow.getText()).toContain('DELTA');
    // And it is not ALSO reported with the opposite sign.
    const opposite = await $$(
      `[data-testid="compare-rows"] [data-diff-type="${expected === 'add' ? 'remove' : 'add'}"]`,
    );
    for (const el of opposite) {
      expect(await el.getText()).not.toContain('DELTA');
    }
  });

  it('visual mode pixel-diffs the pair and lists differing pages', async () => {
    // Same two files: the extra DELTA line is also a *visual* difference on
    // the page raster, so the visual pass must flag page pair 1. This drives
    // the real engine `compare_visual` (bundled Ghostscript raster) end to
    // end through the panel.
    await waitForHarness();
    await openByPaths([a, b]);
    await setView('operations');
    await setActiveOp('compare');

    const target = $('[data-testid="compare-target"]');
    await target.waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="compare-mode-visual"]').click();
    await $('[data-testid="compare-run"]').click();

    const summary = $('[data-testid="compare-visual-summary"]');
    await summary.waitForDisplayed({ timeout: 30_000 });
    expect(await summary.getText()).toContain('1 of 1 page pair differ');

    // The differing pair is listed and auto-selected; both page renders with
    // overlay hosts appear.
    const pairItem = $('[data-testid="compare-visual-pair-1"]');
    await pairItem.waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="compare-visual-page-A"]').waitForDisplayed({ timeout: 20_000 });
    await $('[data-testid="compare-visual-page-B"]').waitForDisplayed({ timeout: 20_000 });
  });

  it('never draws a visual result over pages that moved while it ran, or after', async function () {
    this.timeout(180_000);
    // Visual comparison reads reader copies, so a commit lands while it runs.
    // Its regions are drawn at the result's page numbers over the CURRENT
    // bytes: page 1 deleted and committed during the run would carry the old
    // page 1's regions onto the new page 1.
    const active = resolve(tmp, 'moving.pdf');
    const target = resolve(tmp, 'baseline.pdf');
    await makePagedPdf(active, [['ALPHA', 'DELTA'], ['OMEGA']]);
    await makePagedPdf(target, [['ALPHA'], ['OMEGA']]);
    await closeAllFiles();
    await openByPaths([target]);
    await openByPaths([active]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').replace(/\\/g, '/').toLowerCase().endsWith('/moving.pdf'),
      { timeout: 15_000, timeoutMsg: 'the two-page document never became active' },
    );
    await setView('canvas');
    expect(await invokeAppCommand('tools.panel.compare')).toBe(true);
    await $('[data-testid="compare-target"]').waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="compare-mode-visual"]').click();
    const pages = await getActiveDocPages();
    expect(pages.length).toBe(2);

    await holdReaderCopies();
    try {
      await $('[data-testid="compare-run"]').click();
      await browser.waitUntil(async () => (await readerCopiesWaiting()) === 1, {
        timeout: 30_000,
        interval: 200,
        timeoutMsg: 'the comparison never reached its engine step on its copies',
      });
      await deleteCanvasPagesAndWait([pages[0].id]);
      await commitPendingEdits();
    } finally {
      await releaseReaderCopies();
    }

    await browser.waitUntil(documentChangedShown, {
      timeout: 60_000,
      timeoutMsg: 'the comparison that read the old page 1 was never refused',
    });
    expect(await $('[data-testid="compare-visual-summary"]').isExisting()).toBe(false);
    expect((await $$('[data-testid="compare-visual-region"]').getElements()).length).toBe(0);

    // Run again over the committed bytes: OMEGA against ALPHA differs on page 1.
    await $('[data-testid="compare-run"]').click();
    await $('[data-testid="compare-visual-summary"]').waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(async () => ((await $$('[data-testid="compare-visual-region"]').getElements()).length) > 0, {
      timeout: 20_000,
      timeoutMsg: 'the fresh comparison drew no regions',
    });
    expect(await documentChangedShown()).toBe(false);

    // A page edit after the result is shown takes it down with the notice.
    const [onlyPage] = await getActiveDocPages();
    await selectCanvasPages([onlyPage.id]);
    await rotateSelectedCanvasPages(90);
    await browser.waitUntil(documentChangedShown, {
      timeout: 15_000,
      timeoutMsg: 'the shown result was not taken down after a page edit',
    });
    expect(await $('[data-testid="compare-visual-summary"]').isExisting()).toBe(false);
    expect((await $$('[data-testid="compare-visual-region"]').getElements()).length).toBe(0);
  });
});
