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
  setReactInputValue,
  openParagraphEditor,
  scrollIntoReach,
} from '../support/harness.js';

// Paragraph split (Enter mid-text) + merge (Backspace at the
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
  await openParagraphEditor(pageId, index);
}

/** Place the REAL caret (collapsed) at a CODE-POINT offset. The editor is a
 * contentEditable rich surface — the harness walks the styled
 * segments to find the spot. */
async function setEditorCaret(offset: number): Promise<void> {
  await setParagraphSelection(offset, offset);
}

/** Wait for a page to carry a paragraph listing and RETURN its id, captured
 * inside the predicate. Waiting for a listing and then reading the id back
 * separately is two reads: an ordinary reindex empties and republishes the
 * listing, and the second read can land in the gap. */
async function waitForListedParas(timeoutMsg: string): Promise<string> {
  let landed = '';
  await browser.waitUntil(
    async () => {
      const cur = await browser.execute<{ pageId: string; count: number } | null, []>(function () {
        const h = (window as any).__SPECTRA_TEST__;
        const ids = h.editTextPageIds();
        if (ids.length === 0) return null;
        return { pageId: ids[0], count: h.editParagraphs(ids[0]).length };
      });
      if (!cur || cur.count === 0) return false;
      landed = cur.pageId;
      return true;
    },
    { timeout: 30_000, interval: 250, timeoutMsg },
  );
  return landed;
}

/** Wait for the op's reindex to publish a NEW generation whose paragraphs
 * satisfy `test`, and RETURN the page id that satisfied it. The id is captured
 * inside the predicate: re-reading it afterwards is a second, independent read
 * that can land in the next rotation's window, so a wait that proves a value
 * and then goes and fetches it again proves nothing. The id and the paragraphs
 * are read together in ONE in-page call for the same reason. */
async function waitForReindexedParas(
  preOpId: string,
  test: (paras: { index: number; text: string; lineCount: number }[]) => boolean,
  timeoutMsg: string,
): Promise<string> {
  let landed = '';
  await browser.waitUntil(
    async () => {
      const cur = await browser.execute<
        { pageId: string; paras: { index: number; text: string; lineCount: number }[] } | null,
        []
      >(function () {
        const h = (window as any).__SPECTRA_TEST__;
        const ids = h.editTextPageIds();
        if (ids.length === 0) return null;
        return { pageId: ids[0], paras: h.editParagraphs(ids[0]) };
      });
      if (!cur || cur.pageId === preOpId) return false;
      if (!test(cur.paras)) return false;
      landed = cur.pageId;
      return true;
    },
    { timeout: 30_000, timeoutMsg },
  );
  return landed;
}

describe('paragraph split + merge', () => {
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
    const pageId = await waitForListedParas('paragraphs never loaded');
    const para = (await editParagraphs(pageId))[0];
    const joined = `${LINE1} ${LINE2}`;
    expect(para.text).toBe(joined);

    // SPLIT: caret right before "flowing" (the grouped text joins the two
    // fixture lines with a space; split at the space boundary).
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(joined.indexOf('flowing'));
    await browser.keys(['Enter']);
    let nowId = await waitForReindexedParas(
      pageId,
      (paras) =>
        paras.length === 2 && paras[0].text === LINE1 && paras[1].text === LINE2,
      'the split never produced two paragraphs',
    );

    // MERGE: open the SECOND paragraph, caret at 0, Backspace (unchanged
    // editor — the merge precondition).
    const second = (await editParagraphs(nowId)).find((p) => p.text === LINE2)!;
    await editParagraphOpen(nowId, second.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(0);
    await browser.keys(['Backspace']);
    let preUndoId = await waitForReindexedParas(
      nowId,
      (paras) => paras.length === 1 && paras[0].text === joined,
      'the merge never rejoined the paragraphs',
    );

    // UNDO the merge → two paragraphs again.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    preUndoId = await waitForReindexedParas(
      preUndoId,
      (paras) => paras.length === 2,
      'undo did not restore the split state',
    );
    // UNDO the split → the original single paragraph.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (paras) => paras.length === 1 && paras[0].text === joined,
      'undo did not restore the original paragraph',
    );
  });

  // The geometry round: a user-chosen split gap, Delete-at-end
  // merging the NEXT paragraph, an EDITED editor merging without dropping
  // its edit, and a grip-drag resize that really rewraps. Same fixture;
  // the previous test's undos leave it back at one paragraph.
  it('Custom split gap, Delete-merge, edited-merge, grip resize', async function () {
    this.timeout(240_000);
    const joined = `${LINE1} ${LINE2}`;
    let nowId = await waitForListedParas('paragraphs never re-listed after the undos');
    const para0 = (await editParagraphs(nowId))[0];
    expect(para0.text).toBe(joined);

    // SPLIT with a 3× gap set on the editor's control.
    await editParagraphOpen(nowId, para0.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setReactInputValue('[data-testid="edit-para-splitgap"]', '3');
    await setEditorCaret(joined.indexOf('flowing'));
    await browser.keys(['Enter']);
    nowId = await waitForReindexedParas(
      nowId,
      (paras) =>
        paras.length === 2 && paras[0].text === LINE1 && paras[1].text === LINE2,
      'the gap split never produced two paragraphs',
    );

    // DELETE at the END of the FIRST paragraph folds the next back in.
    const first = (await editParagraphs(nowId)).find((p) => p.text === LINE1)!;
    await editParagraphOpen(nowId, first.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(Array.from(LINE1).length);
    await browser.keys(['Delete']);
    nowId = await waitForReindexedParas(
      nowId,
      (paras) => paras.length === 1 && paras[0].text === joined,
      'Delete at the end never merged the next paragraph in',
    );

    // EDITED merge: split again (default gap), append to the SECOND's
    // text, then Backspace at 0 — the edit must survive the merge.
    const paraA = (await editParagraphs(nowId))[0];
    await editParagraphOpen(nowId, paraA.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(joined.indexOf('flowing'));
    await browser.keys(['Enter']);
    nowId = await waitForReindexedParas(
      nowId,
      (paras) => paras.length === 2,
      'the re-split never happened',
    );
    const second = (await editParagraphs(nowId)).find((p) => p.text === LINE2)!;
    await editParagraphOpen(nowId, second.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(Array.from(LINE2).length);
    await browser.keys([...' extra']);
    // Typing is asserted BEFORE the merge, on the editor's own text. A render
    // that replaces the surface's nodes without restoring the caret sends
    // every character after the first to offset 0, and the merge then fails
    // for a reason that has nothing to do with merging.
    expect(
      await $('[data-testid="edit-para-input"]').getText(),
    ).toBe(`${LINE2} extra`);
    await setEditorCaret(0);
    await browser.keys(['Backspace']);
    nowId = await waitForReindexedParas(
      nowId,
      (paras) => paras.length === 1 && paras[0].text === `${joined} extra`,
      'the edited merge dropped the edit or never merged',
    );

    // RESTYLE-ON-MERGE: split once more, set the editor's Size to 20, then
    // Backspace-merge — one op must both join AND resize.
    const paraR = (await editParagraphs(nowId))[0];
    await editParagraphOpen(nowId, paraR.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorCaret(joined.indexOf('flowing'));
    await browser.keys(['Enter']);
    nowId = await waitForReindexedParas(nowId, (paras) => paras.length === 2, 'restyle re-split failed');
    const secondR = (await editParagraphs(nowId)).find((p) => p.text !== LINE1)!;
    await editParagraphOpen(nowId, secondR.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setReactInputValue('[data-testid="edit-para-size"]', '20');
    await setEditorCaret(0);
    await browser.keys(['Backspace']);
    const preSizeId = nowId;
    await browser.waitUntil(
      async () => {
        const cur = await browser.execute<
          { pageId: string; paras: { index: number; text: string; sizes: number[] }[] } | null,
          []
        >(function () {
          const h = (window as any).__SPECTRA_TEST__;
          const ids = h.editTextPageIds();
          if (ids.length === 0) return null;
          return { pageId: ids[0], paras: h.editParagraphs(ids[0]) };
        });
        if (!cur || cur.pageId === preSizeId) return false;
        const paras = cur.paras;
        if (
          paras.length !== 1 ||
          paras[0].text !== `${joined} extra` ||
          paras[0].sizes.length !== 1 ||
          Math.round(paras[0].sizes[0]) !== 20
        ) {
          return false;
        }
        nowId = cur.pageId;
        return true;
      },
      { timeout: 30_000, interval: 250, timeoutMsg: 'the merge did not carry the size restyle' },
    );

    // RESIZE: drag the END grip inward ~40% of the card — the paragraph
    // must rewrap to more lines.
    const paraB = (await editParagraphs(nowId))[0];
    const preLines = paraB.lineCount;
    await editParagraphOpen(nowId, paraB.index);
    const grip = $('[data-testid="edit-para-grip-end"]');
    await grip.waitForDisplayed({ timeout: 10_000 });
    // The canvas scrolls; W3C pointer coordinates are viewport-bound, so
    // the grip must actually be on screen before the drag is composed. The
    // point comes back from the same poll that proved it hit-testable —
    // reading the geometry again afterwards would reopen the window the
    // scroll just closed.
    const { x: cx, y: cy } = await scrollIntoReach('[data-testid="edit-para-grip-end"]');
    const card = $('.page-editpara-editor');
    const cardW = (await card.getSize()).width;
    await browser.performActions([
      {
        type: 'pointer',
        id: 'p1',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, x: cx, y: cy },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 150, x: Math.max(10, cx - Math.round(cardW * 0.4)), y: cy },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await waitForReindexedParas(
      nowId,
      (paras) => paras.length >= 1 && paras[0].lineCount > preLines,
      'the grip resize never rewrapped the paragraph',
    );
  });
});
