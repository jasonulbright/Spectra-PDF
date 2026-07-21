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
  setParagraphSelection,
} from '../support/harness.js';

// Phase 9.A4 — paragraph split (Enter mid-text) + merge (Backspace at the
// start of an unchanged editor) against the built binary. Engine layout
// and the caret-domain conversion are unit-tested; this proves the wire:
// real editor keys → real ops → re-listed paragraph structure → undo.
// Waits are generation-keyed (README §Adding-a-spec 4).

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

/** Place the REAL caret (collapsed) at a CODE-POINT offset. The editor is a
 * contentEditable rich surface (9.A5-tails-b) — the harness walks the styled
 * segments to find the spot. */
async function setEditorCaret(offset: number): Promise<void> {
  await setParagraphSelection(offset, offset);
}

async function waitForReindexedParas(
  preOpId: string,
  test: (paras: { index: number; text: string }[]) => boolean,
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

describe('paragraph split + merge (Phase 9.A4)', () => {
  let tmp: string;
  let pdfPath: string;
  const LINE1 = 'Alpha beta gamma delta words';
  const LINE2 = 'flowing on the second line';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-splitmerge-'));
    pdfPath = resolve(tmp, 'split-merge.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText(LINE1, { x: 60, y: 200, size: 14, font });
    page.drawText(LINE2, { x: 60, y: 186, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('Enter mid-text splits into two paragraphs; Backspace-at-start merges back; undo each', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('split-merge.pdf'),
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
    const joined = `${LINE1} ${LINE2}`;
    expect(para.text).toBe(joined);

    // SPLIT: caret right before "flowing" (the grouped text joins the two
    // fixture lines with a space; split at the space boundary).
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(joined.indexOf('flowing'));
    await browser.keys(['Enter']);
    await waitForReindexedParas(
      pageId,
      (paras) =>
        paras.length === 2 && paras[0].text === LINE1 && paras[1].text === LINE2,
      'the split never produced two paragraphs',
    );

    // MERGE: open the SECOND paragraph, caret at 0, Backspace (unchanged
    // editor — the merge precondition).
    let nowId = (await editTextPageIds())[0];
    const second = (await editParagraphs(nowId)).find((p) => p.text === LINE2)!;
    await editParagraphOpen(nowId, second.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(0);
    await browser.keys(['Backspace']);
    await waitForReindexedParas(
      nowId,
      (paras) => paras.length === 1 && paras[0].text === joined,
      'the merge never rejoined the paragraphs',
    );

    // UNDO the merge → two paragraphs again.
    let preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (paras) => paras.length === 2,
      'undo did not restore the split state',
    );
    // UNDO the split → the original single paragraph.
    preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (paras) => paras.length === 1 && paras[0].text === joined,
      'undo did not restore the original paragraph',
    );
  });
});
