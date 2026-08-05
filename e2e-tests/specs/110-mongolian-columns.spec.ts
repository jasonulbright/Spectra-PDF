import { resolve } from 'node:path';
import { copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setContentEditableValue,
  openParagraphEditor,
} from '../support/harness.js';

// LEFT-TO-RIGHT vertical columns against
// the built binary. The committed fixture (fixtures/mongolian-columns.pdf,
// generated with pikepdf — nothing in the app authors a rotated run, and
// there is no vertical writing mode on the authoring surface at all)
// carries two Mongolian columns, each a 90°-CW-rotated run of a HORIZONTAL
// font. That is what a real Mongolian producer emits and the only honest
// representation: the script's reference face carries no `vmtx`, so an
// /Identity-V embed would have to invent its /W2.
//
// Two things are proved here that nothing else can prove:
//   * the LEFT column reads first — the exact opposite of the CJK
//     convention spec 54 pins;
//   * a retype comes BACK as the characters that were typed. Mongolian
//     joins cursively and a PDF viewer never shapes, so the re-emission
//     goes through a shaped subset; a shaped edit that cannot be read back
//     is a one-way trip, and only a round trip through the
//     real binary shows it is not.
//
// Waits are generation-keyed (README §Adding-a-spec 4).

const MONGOL = 'ᠮᠣᠩᠭᠣᠯ';
const NARAN = 'ᠨᠠᠷᠠᠨ';
const COLUMNS = `${MONGOL} ${NARAN}`;
// The words swapped: a different string built from the SAME characters, so
// a failure is about the round trip rather than about coverage.
const SWAPPED = `${NARAN} ${MONGOL}`;
// Long enough to need a third column.
const LONGER = [MONGOL, NARAN, MONGOL, NARAN, MONGOL, NARAN].join(' ');

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editParagraphs(
  pageId: string,
): Promise<
  { index: number; text: string; lineCount: number; vertical: boolean; orientation: string }[]
> {
  return await browser.execute<
    { index: number; text: string; lineCount: number; vertical: boolean; orientation: string }[],
    [string]
  >(function (p) {
    return (window as any).__SPECTRA_TEST__.editParagraphs(p);
  }, pageId);
}

async function editParagraphOpen(pageId: string, index: number): Promise<void> {
  await openParagraphEditor(pageId, index);
}

/** Replace the editor's text wholesale — WebDriver key injection is
 * unreliable for these scripts on Windows (spec 54's reason), and the editor
 * is a contentEditable rich surface, so this goes through the harness
 * helper, which fires the same `input` event and leaves the caret at the END
 * so Enter commits rather than splitting. */
async function setEditorValue(text: string): Promise<void> {
  await setContentEditableValue('[data-testid="edit-para-input"]', text);
}

async function waitForReindexedParas(
  preOpId: string,
  test: (paras: { index: number; text: string; orientation: string; lineCount: number }[]) => boolean,
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

describe('Mongolian left-to-right columns', () => {
  let tmp: string;
  let pdfPath: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-mongolian-'));
    pdfPath = resolve(tmp, 'mongolian-columns.pdf');
    copyFileSync(resolve(__dirname, '../fixtures/mongolian-columns.pdf'), pdfPath);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the leftmost column first', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('mongolian-columns.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        return (await editParagraphs(ids[0])).length >= 1;
      },
      { timeout: 30_000, timeoutMsg: 'paragraphs never loaded' },
    );
    const paras = await editParagraphs((await editTextPageIds())[0]);
    const column = paras.find((p) => p.text === COLUMNS);
    expect(column).toBeDefined();
    // The frame is the reflecting one — columns advance rightward.
    expect(column!.orientation).toBe('vertical-lr');
    // The writing MODE is horizontal: the column is the matrix's doing, not
    // a `-V` CMap's. That distinction is why the orientation model has to
// come from the frame rather than from the writing mode.
    expect(column!.vertical).toBe(false);
    expect(column!.lineCount).toBe(2);
  });

  it('retypes and comes back as the characters that were typed', async function () {
    this.timeout(180_000);
    const pageId = (await editTextPageIds())[0];
    const paras = await editParagraphs(pageId);
    const column = paras.find((p) => p.text === COLUMNS)!;
    await editParagraphOpen(pageId, column.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorValue(SWAPPED);
    await browser.keys(['Enter']);
    await waitForReindexedParas(
      pageId,
      (now) => now.some((p) => p.text === SWAPPED && p.orientation === 'vertical-lr'),
      'the Mongolian column never reflowed',
    );

    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (now) => now.some((p) => p.text === COLUMNS),
      'undo did not restore the column',
    );
  });

  it('grows a new column when the text no longer fits', async function () {
    this.timeout(180_000);
    const pageId = (await editTextPageIds())[0];
    const paras = await editParagraphs(pageId);
    const column = paras.find((p) => p.text === COLUMNS)!;
    await editParagraphOpen(pageId, column.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorValue(LONGER);
    await browser.keys(['Enter']);
    await waitForReindexedParas(
      pageId,
      (now) =>
        now.some(
          (p) =>
            p.text === LONGER &&
            p.orientation === 'vertical-lr' &&
            p.lineCount > column.lineCount,
        ),
      'the column never grew',
    );

    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (now) => now.some((p) => p.text === COLUMNS),
      'undo did not restore the column',
    );
  });
});
