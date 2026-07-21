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
  setParagraphSelection,
} from '../support/harness.js';

// Phase 9.A5c — per-span size on the paragraph editor: select a word, set a
// bigger size, and only that range grows (its line gains leading; the rest
// keep theirs). Asserted via the re-listing (the paragraph lists back with
// the larger size among its runs — the working copy stream is compressed, so
// the listing round-trip is the on-disk proof), plus undo removing it. Waits
// key on the page id advancing past the pre-op id (the A3 timing rule — a
// pure restyle keeps the text identical).

interface Para {
  index: number;
  text: string;
  lineCount: number;
  colors: string[];
  sizes: number[];
}

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editParagraphs(pageId: string): Promise<Para[]> {
  return await browser.execute<Para[], [string]>(function (p) {
    return (window as any).__SPECTRA_TEST__.editParagraphs(p);
  }, pageId);
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

/** Select a CODE-POINT range in the paragraph editor. The editor is a
 * contentEditable rich surface (9.A5-tails-b), so this delegates to the
 * harness helper that walks the rendered style segments' text nodes. */
async function selectRange(start: number, end: number): Promise<void> {
  await setParagraphSelection(start, end);
}

async function waitForParagraphs(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const ids = await editTextPageIds();
      if (ids.length === 0) return false;
      return (await editParagraphs(ids[0])).length > 0;
    },
    { timeout: 30_000, timeoutMsg: 'paragraphs never loaded' },
  );
}

async function waitForReindexed(
  preOpId: string,
  test: (paras: Para[]) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const ids = await editTextPageIds();
      if (ids.length === 0 || ids[0] === preOpId) return false;
      return test(await editParagraphs(ids[0]));
    },
    { timeout: 30_000, timeoutMsg },
  );
}

describe('restyle span size (Phase 9.A5c)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-spansize-'));
    pdfPath = resolve(tmp, 'span-size.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Alpha beta gamma delta words', { x: 40, y: 200, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('enlarges a selected word (lists back at the larger size); undo removes it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('span-size.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await waitForParagraphs();
    const pageId = (await editTextPageIds())[0];
    const para = (await editParagraphs(pageId))[0];
    expect(para.text).toContain('Alpha beta gamma delta');
    // Pristine: one size (~14) across the paragraph.
    expect(para.sizes.some((s) => s >= 28)).toBe(false);

    // Open the editor, select "gamma" (chars 11..16), set size 28.
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    expect(para.text.slice(11, 16)).toBe('gamma');
    await selectRange(11, 16);
    await setReactInputValue('[data-testid="edit-para-size"]', '28');
    await browser.keys(['Enter']);

    // The reindexed listing carries the larger size among the runs AND the
    // ORIGINAL ~14 size for the rest — a per-span resize, not a whole-para
    // one (which would list only 28). `sizes` is a structured field, so this
    // stronger check costs nothing (round-34 LOW; unlike spec 56's byte-grep).
    await waitForReindexed(
      pageId,
      (paras) =>
        paras.some(
          (p) => p.text === para.text && p.sizes.some((s) => s >= 28) && p.sizes.some((s) => s < 20),
        ),
      'the enlarged span never listed back as a per-span resize',
    );

    // Undo restores the single-size listing.
    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexed(
      preUndoId,
      (paras) => paras.some((p) => p.text === para.text && !p.sizes.some((s) => s >= 28)),
      'undo did not remove the enlarged span',
    );
  });
});
