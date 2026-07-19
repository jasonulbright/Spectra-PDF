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
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

// Phase 9.A3a — family swap on the paragraph editor, end to end: the
// family dropdown substitutes the WHOLE paragraph into the chosen
// bundled Liberation face. Asserted at three layers: the re-listing
// round-trips the text (the swapped output stays one editable
// paragraph), the WORKING COPY's bytes carry the embedded Liberation
// BaseFont (the substitution really happened on disk), and undo removes
// it again. Plus the validation hand-off: with a family chosen the
// members' own coverage no longer applies, so a char the original font
// lacks (but Liberation has) commits without the error line.
//
// TIMING RULE (learned here the hard way): a PURE restyle keeps the text
// IDENTICAL, so a text-match wait after commit/undo is satisfiable by
// the STALE pre-op listing — the byte restore is synchronous but the
// REINDEX is async, and page ids are generation-tagged (#gN). Every wait
// that follows an engine op therefore keys on the page id ADVANCING past
// the captured pre-op id as well as the text. Racing past that let a
// late reindex land mid-editor-open and (by durable-identity design)
// invalidate the open editor.

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

async function firstParagraph(): Promise<{
  pageId: string;
  para: { index: number; text: string; lineCount: number };
}> {
  const pageId = (await editTextPageIds())[0];
  const paras = await editParagraphs(pageId);
  expect(paras.length).toBeGreaterThan(0);
  return { pageId, para: paras[0] };
}

async function workingCopyHas(needle: string): Promise<boolean> {
  const state = await getState();
  const wp = state.activeFile?.workingPath;
  if (!wp || !existsSync(wp)) return false;
  return readFileSync(wp).includes(needle);
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

/** Wait until the reindex after an engine op has LANDED (first page id
 * advanced past `preOpId`) and the fresh listing satisfies `test`. */
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

describe('restyle family (Phase 9.A3a)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-family-'));
    pdfPath = resolve(tmp, 'family-swap.pdf');
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

  it('swaps a paragraph into Liberation Serif; the text round-trips; undo removes the embed', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('family-swap.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await waitForParagraphs();
    const { pageId, para } = await firstParagraph();
    expect(para.text).toContain('Alpha beta gamma delta words');
    // The fixture is sans (Helvetica) — no Liberation face on disk yet.
    expect(await workingCopyHas('LiberationSerif')).toBe(false);

    // Pure restyle: family only, text untouched.
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setReactSelectValue('[data-testid="edit-para-family"]', 'serif');
    await browser.keys(['Enter']);

    // The re-listing (post-commit reindex — id advanced) round-trips the
    // SAME text: the swapped paragraph is still one editable block…
    await waitForReindexedListing(
      pageId,
      (paras) => paras.some((p) => p.text === para.text),
      'swapped paragraph never re-listed with its text',
    );
    // …and the working copy now embeds the serif face.
    await browser.waitUntil(async () => workingCopyHas('LiberationSerif'), {
      timeout: 15_000,
      timeoutMsg: 'LiberationSerif never appeared in the working copy',
    });

    // Undo restores the un-swapped bytes. The listing wait keys on the id
    // advancing past the POST-SWAP generation (see the timing rule above).
    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => !(await workingCopyHas('LiberationSerif')), {
      timeout: 15_000,
      timeoutMsg: 'undo did not remove the serif embed from the working copy',
    });
    await waitForReindexedListing(
      preUndoId,
      (paras) => paras.some((p) => p.text === para.text),
      'undo did not restore the paragraph listing',
    );
  });

  it('with a family chosen, a char outside the original font commits without the error line', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await waitForParagraphs();
    const { pageId, para } = await firstParagraph();

    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    // The arrow is outside the fixture's WinAnsi font — WITHOUT a family
    // this text blocks (spec 43 pins that). With Liberation chosen the
    // run inventory no longer applies: no error line, and Enter commits.
    const withArrow = `${para.text} →`;
    await setReactInputValue('[data-testid="edit-para-input"]', withArrow);
    await $('[data-testid="edit-para-error"]').waitForDisplayed({ timeout: 5_000 });
    await setReactSelectValue('[data-testid="edit-para-family"]', 'sans');
    // The error line disappears the moment the family bypasses the
    // run-inventory check.
    await browser.waitUntil(
      async () => !(await $('[data-testid="edit-para-error"]').isDisplayed()),
      { timeout: 5_000, timeoutMsg: 'error line did not clear when a family was chosen' },
    );
    await browser.keys(['Enter']);
    await waitForReindexedListing(
      pageId,
      (paras) => paras.some((p) => p.text.includes('→')),
      'family-swapped edit with the arrow never re-listed',
    );
    await browser.waitUntil(async () => workingCopyHas('LiberationSans'), {
      timeout: 15_000,
      timeoutMsg: 'LiberationSans never appeared in the working copy',
    });

    // Leave the file clean: undo the swap (id keyed past the post-commit
    // generation).
    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedListing(
      preUndoId,
      (paras) => paras.some((p) => p.text === para.text),
      'undo did not restore the original paragraph',
    );
  });
});
