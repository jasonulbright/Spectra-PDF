import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setReactInputValue,
  setParagraphSelection,
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

describe('restyle span colour (Phase 9.A5a)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-spancolor-'));
    pdfPath = resolve(tmp, 'span-color.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    // Blue base text: a per-span red then leaves the REST blue, so the
    // re-listing carries BOTH colours — proof the recolour hit just the
    // range, not the whole paragraph (a default-black base would omit its
    // colour from the listing, making per-span and whole-para look alike).
    page.drawText('Alpha beta gamma delta words', {
      x: 60,
      y: 200,
      size: 14,
      font,
      color: rgb(0, 0, 1),
    });
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
    // Pristine: the blue base, no red yet. Capture the base hex (exact value
    // is the engine's round-trip of rgb(0,0,1)) to assert it survives.
    expect(para.colors).not.toContain('#ff0000');
    const baseColor = para.colors[0];
    expect(baseColor).toBeDefined();

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
      // Red for the range AND the ORIGINAL base colour for the rest — a
      // per-span recolour, not a whole-paragraph one (which would recolour
      // every span red and drop the base entirely).
      (paras) =>
        paras.some(
          (p) =>
            p.text === para.text && p.colors.includes('#ff0000') && p.colors.includes(baseColor),
        ),
      'the recoloured span never listed back as a per-span recolour',
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
