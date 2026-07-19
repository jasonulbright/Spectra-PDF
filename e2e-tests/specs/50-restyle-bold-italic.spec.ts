import { resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
} from '../support/harness.js';

// Phase 9.A3b — bold/italic substitution end to end: the B toggle
// substitutes the whole paragraph into the bundled Bold face. Waits are
// generation-keyed (see e2e README §Adding-a-spec 4 and spec 49's
// timing rule — a pure restyle keeps the text identical, so content
// waits alone are satisfiable by the stale pre-op listing).

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editParagraphs(
  pageId: string,
): Promise<{ index: number; text: string; lineCount: number }[]> {
  return await browser.execute<{ index: number; text: string; lineCount: number }[], [string]>(
    function (p) {
      return (window as any).__SPECTRA_TEST__.editParagraphs(p);
    },
    pageId,
  );
}

async function editParagraphOpen(pageId: string, index: number): Promise<void> {
  await browser.execute<void, [string, number]>(
    function (p, i) {
      (window as any).__SPECTRA_TEST__.editParagraphOpen(p, i);
    },
    pageId,
    index,
  );
}

async function workingCopyHas(needle: string): Promise<boolean> {
  const state = await getState();
  const wp = state.activeFile?.workingPath;
  if (!wp || !existsSync(wp)) return false;
  return readFileSync(wp).includes(needle);
}

async function waitForReindexedListing(
  preOpId: string,
  test: (paras: { index: number; text: string; lineCount: number }[]) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const ids = await editTextPageIds();
      if (ids.length === 0 || ids[0] === preOpId) return false; // stale listing
      return test(await editParagraphs(ids[0]));
    },
    { timeout: 30_000, timeoutMsg },
  );
}

describe('restyle bold/italic (Phase 9.A3b)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-bolditalic-'));
    pdfPath = resolve(tmp, 'style-swap.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 14, font });
    page.drawText('flowing on the second line', { x: 60, y: 186, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('bold toggle substitutes the Bold face; undo removes it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('style-swap.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        return (await editParagraphs(ids[0])).length > 0;
      },
      { timeout: 30_000, timeoutMsg: 'paragraphs never loaded' },
    );
    const pageId = (await editTextPageIds())[0];
    const para = (await editParagraphs(pageId))[0];
    expect(await workingCopyHas('LiberationSans-Bold')).toBe(false);

    // Pure restyle: toggle B (seeded off for the Helvetica fixture), text
    // untouched, Enter commits.
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    const boldBtn = await $('[data-testid="edit-para-bold"]');
    expect(await boldBtn.getAttribute('aria-pressed')).toBe('false');
    await boldBtn.click();
    await browser.waitUntil(async () => (await boldBtn.getAttribute('aria-pressed')) === 'true', {
      timeout: 5_000,
      timeoutMsg: 'bold toggle never pressed',
    });
    await browser.keys(['Enter']);

    await waitForReindexedListing(
      pageId,
      (paras) => paras.some((p) => p.text === para.text),
      'bold-swapped paragraph never re-listed with its text',
    );
    await browser.waitUntil(async () => workingCopyHas('LiberationSans-Bold'), {
      timeout: 15_000,
      timeoutMsg: 'LiberationSans-Bold never appeared in the working copy',
    });

    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => !(await workingCopyHas('LiberationSans-Bold')), {
      timeout: 15_000,
      timeoutMsg: 'undo did not remove the bold embed from the working copy',
    });
    await waitForReindexedListing(
      preUndoId,
      (paras) => paras.some((p) => p.text === para.text),
      'undo did not restore the paragraph listing',
    );
  });

  it('re-opening the swapped paragraph seeds the bold toggle ON', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        return (await editParagraphs(ids[0])).length > 0;
      },
      { timeout: 30_000, timeoutMsg: 'paragraphs never loaded' },
    );
    let pageId = (await editTextPageIds())[0];
    const para = (await editParagraphs(pageId))[0];

    // Swap to bold again (same flow as it1)…
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="edit-para-bold"]').click();
    await browser.keys(['Enter']);
    await waitForReindexedListing(
      pageId,
      (paras) => paras.some((p) => p.text === para.text),
      'bold swap never re-listed',
    );
    await browser.waitUntil(async () => workingCopyHas('LiberationSans-Bold'), {
      timeout: 15_000,
      timeoutMsg: 'LiberationSans-Bold never appeared in the working copy',
    });

    // …then the editor on the SWAPPED paragraph seeds B pressed — the
    // engine classified the embedded Bold face, round-tripping the style
    // through the listing (the pytest pins the classification; this pins
    // the seed reaching the real control).
    pageId = (await editTextPageIds())[0];
    const swapped = (await editParagraphs(pageId))[0];
    await editParagraphOpen(pageId, swapped.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="edit-para-bold"]').getAttribute('aria-pressed')).toBe('true');
    await browser.keys(['Escape']);

    // Leave the file clean for any later spec.
    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedListing(
      preUndoId,
      (paras) => paras.some((p) => p.text === para.text),
      'undo did not restore the original paragraph',
    );
  });
});
