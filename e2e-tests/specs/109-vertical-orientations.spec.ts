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
} from '../support/harness.js';

// Phase 9.T13 (brief 39 slice B) — the ORIENTATION model against the built
// binary. The committed fixture (fixtures/vertical-orientations.pdf,
// generated with pikepdf — pdf-lib can author neither an /Identity-V font
// nor a rotated run) carries two paragraphs that the shipped engine could
// not produce at all:
//
//   * a CJK column with a 90°-CW-rotated LATIN run inside it. Before T13
//     the column grouped WITHOUT the Latin — a reflow moved the CJK over
//     text that never moved. Now both members transpose into one frame and
//     list as ONE paragraph.
//   * a standalone rotated block near no CJK at all, which the old
//     page-space admission test dropped to the run-box surface.
//
// This proves the wire: listing (with orientation) → editor → retype →
// re-listed → undo. Waits are generation-keyed (README §Adding-a-spec 4).

const COLUMN = 'あいうPDF';
// The fixture's Identity-V font encodes あ/い/う only, so the retype
// re-uses them — the point is the LENGTH change and the reflow, not
// which kana it is.
const COLUMN_RETYPED = 'あいういPDF';
const BLOCK = 'Rotated block';
const BLOCK_RETYPED = 'Turned';

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
  await browser.execute<void, [string, number]>(
    function (p, i) {
      (window as any).__SPECTRA_TEST__.editParagraphOpen(p, i);
    },
    pageId,
    index,
  );
}

/** Replace the editor's text wholesale — WebDriver key injection is
 * unreliable for CJK on Windows (spec 54's reason), and the editor is a
 * contentEditable rich surface, so this goes through the harness helper,
 * which fires the same `input` event and leaves the caret at the END so
 * Enter commits rather than splitting. */
async function setEditorValue(text: string): Promise<void> {
  await setContentEditableValue('[data-testid="edit-para-input"]', text);
}

async function waitForReindexedParas(
  preOpId: string,
  test: (paras: { index: number; text: string; orientation: string }[]) => boolean,
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

describe('rotated-glyph vertical forms (Phase 9.T13)', () => {
  let tmp: string;
  let pdfPath: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-orient-'));
    pdfPath = resolve(tmp, 'vertical-orientations.pdf');
    copyFileSync(resolve(__dirname, '../fixtures/vertical-orientations.pdf'), pdfPath);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists a mixed column and a rotated block with their orientations', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () =>
        ((await getState()).activeFile?.path ?? '').includes('vertical-orientations.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        return (await editParagraphs(ids[0])).length >= 2;
      },
      { timeout: 30_000, timeoutMsg: 'paragraphs never loaded' },
    );
    const paras = await editParagraphs((await editTextPageIds())[0]);
    const column = paras.find((p) => p.text === COLUMN);
    const block = paras.find((p) => p.text === BLOCK);
    expect(column).toBeDefined();
    expect(block).toBeDefined();
    // The column HOLDS a vertical-writing member, so it is a column…
    expect(column!.orientation).toBe('vertical-rl');
    expect(column!.vertical).toBe(true);
    // …while the block is a horizontal font merely turned, and says so.
    expect(block!.orientation).toBe('rotated-cw');
    expect(block!.vertical).toBe(false);
  });

  it('retypes and reflows the standalone rotated block, then undoes', async function () {
    this.timeout(180_000);
    const pageId = (await editTextPageIds())[0];
    const paras = await editParagraphs(pageId);
    const block = paras.find((p) => p.text === BLOCK)!;
    await editParagraphOpen(pageId, block.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorValue(BLOCK_RETYPED);
    await browser.keys(['Enter']);
    await waitForReindexedParas(
      pageId,
      (now) =>
        now.some((p) => p.text === BLOCK_RETYPED && p.orientation === 'rotated-cw'),
      'the rotated block never reflowed',
    );

    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (now) => now.some((p) => p.text === BLOCK),
      'undo did not restore the rotated block',
    );
  });

  it('retypes the column that carries a sideways run and stays a column', async function () {
    this.timeout(180_000);
    const pageId = (await editTextPageIds())[0];
    const paras = await editParagraphs(pageId);
    const column = paras.find((p) => p.text === COLUMN)!;
    await editParagraphOpen(pageId, column.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setEditorValue(COLUMN_RETYPED);
    await browser.keys(['Enter']);
    await waitForReindexedParas(
      pageId,
      (now) =>
        now.some((p) => p.text === COLUMN_RETYPED && p.orientation === 'vertical-rl'),
      'the mixed column never reflowed',
    );

    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (now) => now.some((p) => p.text === COLUMN),
      'undo did not restore the column',
    );
  });
});
