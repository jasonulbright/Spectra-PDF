// T20 — rich paste, the whole wire: a synthetic clipboard paste carrying
// text/html lands in the paragraph editor as per-span overlays (the same
// vocabulary the toolbar writes), and the commit drives them through the
// engine's span_styles into the relisted page. Styles asserted from the
// LISTING (sizes/colors), the fidelity authority — not from editor DOM.
import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

interface ParaSnapshot {
  index: number;
  text: string;
  sizes: number[];
  colors: string[];
}

async function editParagraphs(pageId: string): Promise<ParaSnapshot[]> {
  return await browser.execute<ParaSnapshot[], [string]>(function (p) {
    return (window as any).__SPECTRA_TEST__.editParagraphs(p);
  }, pageId);
}

describe('rich paste (T20)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-richpaste-'));
    pdfPath = resolve(tmp, 'rich-paste.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Replace me entirely today', { x: 60, y: 200, size: 14, font });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('pasted HTML styling survives to the committed page', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('rich-paste.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        return ids.length > 0 && (await editParagraphs(ids[0])).length > 0;
      },
      { timeout: 30_000, timeoutMsg: 'paragraphs never loaded' },
    );
    const pageId = (await editTextPageIds())[0];
    const para = (await editParagraphs(pageId))[0];
    await browser.execute<void, [string, number]>(
      function (p, i) {
        (window as any).__SPECTRA_TEST__.editParagraphOpen(p, i);
      },
      pageId,
      para.index,
    );
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });

    // The editor opens with everything selected, so the paste REPLACES the
    // paragraph — deterministic offsets for the styled ranges.
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="edit-para-input"]')!;
      const dt = new DataTransfer();
      dt.setData(
        'text/html',
        '<span>plain </span><b>bolded</b><span> then </span>' +
          '<span style="color:#ff0000">crimson</span><span> and </span>' +
          '<span style="font-size:24px">grown</span>',
      );
      dt.setData('text/plain', 'plain bolded then crimson and grown');
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    // Commit (caret sits at the end after a paste — the shipped commit).
    await browser.keys(['Enter']);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0 || ids[0] === pageId) return false;
        const paras = await editParagraphs(ids[0]);
        if (paras.length !== 1) return false;
        const p = paras[0];
        return (
          p.text === 'plain bolded then crimson and grown' &&
          p.colors.some((c) => c.toLowerCase() === '#ff0000') &&
          p.sizes.some((s) => Math.round(s) === 18)
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: 'the pasted styling never reached the committed listing',
      },
    );
  });
});
