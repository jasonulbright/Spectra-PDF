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
  setContentEditableValue,
} from '../support/harness.js';

// Phase 7.5 — paragraph reflow round-trip against the real binary: a
// two-line paragraph groups into ONE paragraph box; the REAL paragraph
// editor commits a longer text; the engine rewraps at the measured box
// width (line count grows in the re-listing); undo restores. Plus the
// live-validation + convert-to-fallback flow at paragraph scale.

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editParagraphs(
  pageId: string,
): Promise<{ index: number; text: string; lineCount: number; alignment: string }[]> {
  return await browser.execute<
    { index: number; text: string; lineCount: number; alignment: string }[],
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

async function firstParagraph(): Promise<{
  pageId: string;
  para: { index: number; text: string; lineCount: number; alignment: string };
}> {
  const pageId = (await editTextPageIds())[0];
  const paras = await editParagraphs(pageId);
  expect(paras.length).toBeGreaterThan(0);
  return { pageId, para: paras[0] };
}

describe('edit paragraph (Phase 7.5)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-editpara-'));
    pdfPath = resolve(tmp, 'with-paragraph.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    // Two lines, 14pt leading — the grouping heuristics join them.
    page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 14, font });
    page.drawText('flowing on the second line', { x: 60, y: 186, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('rewraps a grown paragraph inside its box, then undo restores it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('with-paragraph.pdf'),
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
    const { pageId, para } = await firstParagraph();
    // The two fixture lines grouped into one logical text.
    expect(para.text).toContain('Alpha beta gamma delta words');
    expect(para.text).toContain('flowing on the second line');
    expect(para.lineCount).toBe(2);

    // Open the REAL paragraph editor and grow the text.
    const grown = `${para.text} plus several appended growth words`;
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setContentEditableValue('[data-testid="edit-para-input"]', grown);
    await browser.keys(['Enter']);

    // The op reloads the buffer; the re-listing regroups the REWRAPPED
    // paragraph: same text, more lines — the reflow, observed end to end.
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const paras = await editParagraphs(ids[0]);
        return paras.some((p) => p.text === grown && p.lineCount > 2);
      },
      { timeout: 30_000, timeoutMsg: 'the rewrapped paragraph never appeared in the listings' },
    );

    // Undo restores the original two-line paragraph.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const paras = await editParagraphs(ids[0]);
        return paras.some((p) => p.text === para.text && p.lineCount === 2);
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the original paragraph' },
    );
  });

  it('live validation blocks unencodable chars; convert renders them in the fallback font', async function () {
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
    const { pageId, para } = await firstParagraph();

    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    // The arrow is outside WinAnsi — the error line names it and Enter
    // must NOT commit (the editor holds open with the invalid value).
    const withArrow = `${para.text} →`;
    await setContentEditableValue('[data-testid="edit-para-input"]', withArrow);
    await $('[data-testid="edit-para-error"]').waitForDisplayed({ timeout: 5_000 });
    await browser.keys(['Enter']);
    expect(await $('[data-testid="edit-para-input"]').isDisplayed()).toBe(true);

    // Convert: only the arrow renders in the bundled fallback; the
    // paragraph stays one editable block and the text round-trips.
    await $('[data-testid="edit-para-convert"]').click();
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const paras = await editParagraphs(ids[0]);
        return paras.some((p) => p.text.includes('→'));
      },
      { timeout: 30_000, timeoutMsg: 'converted paragraph never appeared in the listings' },
    );
    // Undo reverts the conversion.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const paras = await editParagraphs(ids[0]);
        return paras.length > 0 && !paras.some((p) => p.text.includes('→'));
      },
      { timeout: 30_000, timeoutMsg: 'undo did not revert the conversion' },
    );
  });

  it('A1 restyle: raising the size rewraps the paragraph, undo restores it', async function () {
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
    const { pageId, para } = await firstParagraph();
    const beforeLines = para.lineCount;

    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    // Bump the size well above the fixture's — the same box must wrap more.
    await setReactInputValue('[data-testid="edit-para-size"]', '30');
    await browser.keys(['Enter']);

    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const paras = await editParagraphs(ids[0]);
        return paras.some((p) => p.text === para.text && p.lineCount > beforeLines);
      },
      { timeout: 30_000, timeoutMsg: 'the size bump never rewrapped the paragraph' },
    );

    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        const paras = await editParagraphs(ids[0]);
        return paras.some((p) => p.text === para.text && p.lineCount === beforeLines);
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the original size/wrap' },
    );
  });
});
