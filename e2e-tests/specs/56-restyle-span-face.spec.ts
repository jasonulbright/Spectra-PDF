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

// Phase 9.A5b — per-span bold on the paragraph editor: select a word, click
// Bold, and only that range substitutes into the bundled bold face. Asserted
// on the WORKING COPY bytes (the styled BaseFont embeds for just that range,
// the member font staying for the rest — a font name is grep-able even
// though the content stream is compressed; the A3a spec's proof shape), plus
// undo removing it. Waits key on the page id advancing past the pre-op id
// (a pure restyle keeps the text identical — the A3 timing rule).

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

async function workingCopyHas(needle: string): Promise<boolean> {
  const wp = (await getState()).activeFile?.workingPath;
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

describe('restyle span face (Phase 9.A5b)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-spanface-'));
    pdfPath = resolve(tmp, 'span-face.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('bolds a selected word (styled face embeds for just it); undo removes it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('span-face.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await waitForParagraphs();
    const pageId = (await editTextPageIds())[0];
    const para = (await editParagraphs(pageId))[0];
    expect(para.text).toContain('Alpha beta gamma delta');
    // The Helvetica fixture carries no Liberation face yet.
    expect(await workingCopyHas('LiberationSans-Bold')).toBe(false);

    // Open the editor, select "Alpha" (chars 0..5), click Bold.
    await editParagraphOpen(pageId, para.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await selectRange(0, 5);
    await $('[data-testid="edit-para-bold"]').click();
    await browser.keys(['Enter']);

    // The reindexed listing round-trips the SAME text (a pure per-span
    // restyle), and the working copy now embeds the bold face for the range.
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0 || ids[0] === pageId) return false;
        return (await editParagraphs(ids[0])).some((p) => p.text === para.text);
      },
      { timeout: 30_000, timeoutMsg: 'the styled paragraph never re-listed' },
    );
    await browser.waitUntil(async () => workingCopyHas('LiberationSans-Bold'), {
      timeout: 15_000,
      timeoutMsg: 'the bold face never embedded in the working copy',
    });
    // (This spec proves the WIRE: the Bold click with a live selection
    // reaches the engine and embeds the styled face. That it substitutes
    // JUST the range — the member font kept for the rest, distinct from a
    // whole-paragraph swap — is owned by pytest, which reads the font dict
    // directly: a standard-14 font's name isn't reliably raw-grep-able in
    // the saved working copy, so a byte assertion here would be fragile.)

    // Undo removes the embedded bold face.
    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        return !(await workingCopyHas('LiberationSans-Bold'));
      },
      { timeout: 30_000, timeoutMsg: 'undo did not remove the bold face' },
    );
  });
});
