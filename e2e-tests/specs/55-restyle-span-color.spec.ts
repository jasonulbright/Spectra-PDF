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

// Phase 9.A5a — per-span colour on the paragraph editor: select a word in
// the textarea, pick a colour, and only that range recolours. Asserted via
// the re-listing (the recoloured range seeds its colour back into the
// paragraph's spans — the working copy stream is compressed, so the listing
// round-trip is the on-disk proof), plus undo removing it. Waits key on the
// page id advancing past the pre-op id (the generation-tagged reindex; a
// pure restyle keeps the text identical, so a text-only wait false-passes
// on the stale listing — the A3 timing rule).

interface Para {
  index: number;
  text: string;
  lineCount: number;
  colors: string[];
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

/** Set the textarea selection to a UTF-16 range and fire `select` so the
 * editor captures it (the colour swatch reads the captured selection). */
async function selectRange(start: number, end: number): Promise<void> {
  await browser.execute<void, [number, number]>(
    function (s, e) {
      const ta = document.querySelector(
        '[data-testid="edit-para-input"]',
      ) as HTMLTextAreaElement | null;
      if (!ta) throw new Error('paragraph editor not open');
      ta.focus();
      ta.setSelectionRange(s, e);
      ta.dispatchEvent(new Event('select', { bubbles: true }));
    },
    start,
    end,
  );
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

describe('restyle span colour (Phase 9.A5a)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-spancolor-'));
    pdfPath = resolve(tmp, 'span-color.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('recolours a selected word; the colour round-trips; undo removes it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('span-color.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await waitForParagraphs();
    const pageId = (await editTextPageIds())[0];
    const para = (await editParagraphs(pageId))[0];
    expect(para.text).toContain('Alpha beta gamma delta');
    // Pristine: no non-default span colours.
    expect(para.colors.filter((c) => c !== '#000000')).toHaveLength(0);

    // Open the editor, select "Alpha" (chars 0..5), pick red on the swatch.
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await selectRange(0, 5);
    await setReactInputValue('[data-testid="edit-para-color"]', '#ff0000');
    await browser.keys(['Enter']);

    // The reindexed listing seeds the red back onto the paragraph's spans,
    // with the text unchanged (a pure per-span restyle).
    await waitForReindexed(
      pageId,
      (paras) => paras.some((p) => p.text === para.text && p.colors.includes('#ff0000')),
      'the recoloured span never listed back red',
    );

    // Undo restores the pristine (no red) listing.
    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexed(
      preUndoId,
      (paras) => paras.some((p) => p.text === para.text && !p.colors.includes('#ff0000')),
      'undo did not remove the recoloured span',
    );
  });
});
