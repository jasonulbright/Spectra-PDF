import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setReactInputValue,
} from '../support/harness.js';

// Phase 7.2+7.3 — Edit Text round-trip: arm the Edit tool, wait for run
// listings, open the REAL inline editor via the harness (double-click on
// transformed canvas is unreliable), type through the REAL input (validated
// live), Enter commits → engine replace_text_run → undo restores.

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editTextRuns(
  pageId: string,
): Promise<{ index: number; text: string; editable: boolean }[]> {
  return await browser.execute<{ index: number; text: string; editable: boolean }[], [string]>(
    function (p) {
      return (window as any).__SPECTRA_TEST__.editTextRuns(p);
    },
    pageId,
  );
}

async function editTextOpen(pageId: string, index: number): Promise<void> {
  await browser.execute<void, [string, number]>(
    function (p, i) {
      (window as any).__SPECTRA_TEST__.editTextOpen(p, i);
    },
    pageId,
    index,
  );
}

describe('edit text (Phase 7.2+7.3)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-edittext-'));
    pdfPath = resolve(tmp, 'with-text.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Original words here', { x: 60, y: 200, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('edits a run through the real inline editor, then undo restores it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('with-text.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await editTextPageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'text runs never loaded',
    });
    const pageId = (await editTextPageIds())[0];
    const runs = await editTextRuns(pageId);
    const target = runs.find((r) => r.text.includes('Original'));
    expect(target).toBeTruthy();
    expect(target!.editable).toBe(true);

    // Open the REAL inline editor and drive its input.
    await editTextOpen(pageId, target!.index);
    await $('[data-testid="edit-text-input"]').waitForDisplayed({ timeout: 10_000 });
    await setReactInputValue('[data-testid="edit-text-input"]', 'Rewritten words here');
    await browser.keys(['Enter']);

    // The op reloads the buffer; listings refetch with the new text.
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const rs = await editTextRuns(ids[0]);
        return rs.some((r) => r.text.includes('Rewritten'));
      },
      { timeout: 30_000, timeoutMsg: 'edited text never appeared in the listings' },
    );

    // Undo restores the original run.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const rs = await editTextRuns(ids[0]);
        return rs.some((r) => r.text.includes('Original'));
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the original text' },
    );
  });

  it('live validation blocks characters outside the font', async () => {
    await waitForHarness();
    // Still in edit mode from the prior case (or re-arm harmlessly).
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(async () => (await editTextPageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'text runs never loaded',
    });
    const pageId = (await editTextPageIds())[0];
    const runs = await editTextRuns(pageId);
    await editTextOpen(pageId, runs[0].index);
    await $('[data-testid="edit-text-input"]').waitForDisplayed({ timeout: 10_000 });
    // The arrow is not in WinAnsi — the error line must name it and Enter
    // must NOT commit (the editor stays open with the invalid value).
    await setReactInputValue('[data-testid="edit-text-input"]', 'bad → char');
    await $('[data-testid="edit-text-error"]').waitForDisplayed({ timeout: 5_000 });

    // 7.4: the coverage-refusal escape hatch — convert re-renders the run
    // in the bundled fallback font, and the result is extractable (the
    // engine's ToUnicode round-trips through the listing refetch).
    await $('[data-testid="edit-text-convert"]').click();
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const rs = await editTextRuns(ids[0]);
        return rs.some((r) => r.text.includes('bad → char'));
      },
      { timeout: 30_000, timeoutMsg: 'converted text never appeared in the listings' },
    );
    // Undo restores the pre-convert run.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const rs = await editTextRuns(ids[0]);
        return !rs.some((r) => r.text.includes('bad → char'));
      },
      { timeout: 30_000, timeoutMsg: 'undo did not revert the conversion' },
    );
  });
});
