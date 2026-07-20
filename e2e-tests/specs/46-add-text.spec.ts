import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  placeAddText,
  commitAddText,
} from '../support/harness.js';

// Phase 9.A2 — Add Text round-trip against the real binary: arm the Edit
// tool's Add-Text mode, place a box (harness injects the placement the band
// would have drawn — transformed-canvas-space is undrivable, the new-field
// precedent), author text through the REAL card→buildSignatureAppearance→
// engine path, and confirm the authored text lists back as an ORDINARY
// editable paragraph (the subset-embed makes it re-editable with no special
// case). Undo removes it.

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editTextRuns(
  pageId: string,
): Promise<{ index: number; text: string; editable: boolean }[]> {
  return await browser.execute<{ index: number; text: string; editable: boolean }[], [string]>(
    function (p) {
      return (window as any).__SPECTRA_TEST__.editTextRuns(p);
    },
    pageId,
  );
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

// The authored paragraph, once the post-commit re-index lists it.
async function authoredParagraph(
  needle: string,
): Promise<{ pageId: string; text: string; lineCount: number } | null> {
  for (const pageId of await editTextPageIds()) {
    const para = (await editParagraphs(pageId)).find((p) => p.text.includes(needle));
    if (para) return { pageId, text: para.text, lineCount: para.lineCount };
  }
  return null;
}

describe('add text (Phase 9.A2)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-addtext-'));
    pdfPath = resolve(tmp, 'blank.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]); // one blank Letter page — nothing to edit yet
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('authors a new text object that lists back as an editable paragraph, then undo removes it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('blank.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    // Open Edit, then arm its Add-Text sub-mode (proves the mode/command wiring).
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    expect(await invokeAppCommand('tools.addtext')).toBe(true);

    // Place the box (retries until the workspace indexer produced a page), then
    // the card appears and we author through the real commit path.
    await placeAddText({ x: 0.15, y: 0.08, w: 0.62, h: 0.16 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'Hello authored end to end world';
    await commitAddText({ text: phrase, size: 18, color: [0.85, 0.1, 0.1], family: 'serif' });

    // Back to select-content Edit mode so the paragraph indexer re-lists the
    // reloaded buffer — the authored run must appear as an ordinary paragraph.
    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the authored text never appeared as an editable paragraph',
    });

    // Undo drops the authored text back off the page.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the authored text',
    });
  });

  it('authors ROTATED text (90°) that lists as a run box, not a paragraph; undo removes', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    await placeAddText({ x: 0.7, y: 0.2, w: 0.12, h: 0.4 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'Sideways label';
    // A2-tail: rotate rides the same authored-op path; the engine wraps
    // the block in one rotation frame. Rotated text NEVER groups into a
    // paragraph (the shipped boundary), so the proof is: the phrase
    // lists on the RUN-BOX layer and no paragraph carries it.
    await commitAddText({ text: phrase, size: 14, rotate: 90 });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        for (const id of await editTextPageIds()) {
          const runs = await editTextRuns(id);
          if (runs.some((r) => r.text.includes('Sideways'))) {
            const para = await authoredParagraph('Sideways');
            return para === null;
          }
        }
        return false;
      },
      { timeout: 30_000, timeoutMsg: 'the rotated authored run never listed on the run-box layer' },
    );

    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        for (const id of await editTextPageIds()) {
          if ((await editTextRuns(id)).some((r) => r.text.includes('Sideways'))) return false;
        }
        return true;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not remove the rotated authored text' },
    );
  });

  it('wraps a long line inside a narrow box (multi-line author)', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    // A narrow box forces the greedy wrapper to break across lines.
    await placeAddText({ x: 0.12, y: 0.4, w: 0.24, h: 0.3 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'one two three four five six seven eight nine ten eleven twelve';
    await commitAddText({ text: phrase, size: 14 });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        const para = await authoredParagraph('one two three');
        return para !== null && para.lineCount > 1;
      },
      { timeout: 30_000, timeoutMsg: 'the wrapped multi-line authored text never appeared' },
    );

    expect(await invokeAppCommand('edit.undo')).toBe(true);
  });
});
