import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  saveActiveAs,
  setReactInputValue,
  ocrReadyCount,
  applyOcr,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Committed image-only fixture: one page reading "INVOICE 4200 / Amount Due"
// rendered to a JPEG — ZERO extractable text (verified at fixture build).
const SCANNED = resolve(__dirname, '..', 'fixtures', 'scanned.pdf');

/** Open the find bar if it isn't already (the toolbar button TOGGLES, and
 * find state survives across specs in the same app session). */
async function ensureFindOpen(): Promise<void> {
  const input = $('[data-testid="find-input"]');
  if (await input.isDisplayed().catch(() => false)) return;
  await $('[data-testid="toggle-find"]').click();
  await input.waitForDisplayed({ timeout: 10_000 });
}

async function extractAllText(path: string): Promise<string> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) if ('str' in item) out += item.str + ' ';
  }
  await pdf.loadingTask.destroy();
  return out;
}

describe('find + OCR (2m)', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-ocr-'));
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('finds text in a born-digital document and reports matches', async () => {
    const textPdf = resolve(tmp, 'digital.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('The quarterly PAYMENT schedule', { x: 40, y: 200, size: 14, font });
    writeFileSync(textPdf, await doc.save());

    await waitForHarness();
    await openByPaths([textPdf]);
    await setView('canvas');

    await ensureFindOpen();
    await setReactInputValue('[data-testid="find-input"]', 'payment');

    await browser.waitUntil(
      async () => (await $('[data-testid="find-count"]').getText()).includes('1 match'),
      { timeout: 20_000, timeoutMsg: 'born-digital find never matched' },
    );
  });

  it('advanced Find modes: match-case, whole-word, regex, and invalid-pattern (P4)', async () => {
    const p = resolve(tmp, 'modes.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([500, 300]);
    // "cat" appears as: Cat, cats, CAT, concatenate  → 4 substring hits;
    // 2 case-sensitive ("cats","concatenate"); 2 whole-word ("Cat","CAT").
    page.drawText('Cat cats CAT concatenate 2024', { x: 30, y: 200, size: 14, font });
    // A long run of one letter, for the catastrophic-backtracking leg below.
    page.drawText('a'.repeat(40), { x: 30, y: 160, size: 14, font });
    writeFileSync(p, await doc.save());

    await waitForHarness();
    await openByPaths([p]);
    await setView('canvas');
    await ensureFindOpen();

    const countHas = (needle: string, msg: string) =>
      browser.waitUntil(
        async () => (await $('[data-testid="find-count"]').getText()).includes(needle),
        { timeout: 20_000, timeoutMsg: msg },
      );

    await setReactInputValue('[data-testid="find-input"]', 'cat');
    await countHas('4 match', 'default case-insensitive substring should find 4');

    // Match case → "cats", "concatenate" (lowercase "cat") = 2.
    await $('[data-testid="find-case"]').click();
    await countHas('2 match', 'match-case should narrow to 2');
    await $('[data-testid="find-case"]').click(); // off

    // Whole word → "Cat", "CAT" = 2 (not "cats"/"concatenate").
    await $('[data-testid="find-word"]').click();
    await countHas('2 match', 'whole-word should find 2');
    await $('[data-testid="find-word"]').click(); // off

    // Regex → a 4-digit run matches "2024".
    await $('[data-testid="find-regex"]').click();
    await setReactInputValue('[data-testid="find-input"]', '\\d{4}');
    await countHas('1 match', 'regex \\d{4} should find 2024');

    // Invalid regex surfaces a clear label instead of a bare "No results".
    await setReactInputValue('[data-testid="find-input"]', 'inv(');
    await countHas('Invalid pattern', 'invalid regex should report Invalid pattern');

    // Reset modes + query so the shared find session doesn't leak into later specs.
    await $('[data-testid="find-regex"]').click(); // off
    await setReactInputValue('[data-testid="find-input"]', '');
  });

  it('a catastrophically backtracking regex is killed, not allowed to freeze the app', async () => {
    // ReDoS hardening: regex-mode scans run in a worker under a time budget.
    // `(a+)+b` over a 40-character run of "a" with no "b" is the classic
    // exponential backtrack — on the render thread it was an unrecoverable
    // hang. Here it must report a timeout AND leave the app fully usable.
    const p = resolve(tmp, 'redos.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([500, 300]);
    page.drawText('a'.repeat(40), { x: 30, y: 200, size: 14, font });
    page.drawText('invoice 2024', { x: 30, y: 160, size: 14, font });
    writeFileSync(p, await doc.save());

    await waitForHarness();
    await openByPaths([p]);
    await setView('canvas');
    await ensureFindOpen();

    const countHas = (needle: string, msg: string) =>
      browser.waitUntil(
        async () => (await $('[data-testid="find-count"]').getText()).includes(needle),
        { timeout: 30_000, timeoutMsg: msg },
      );

    await $('[data-testid="find-regex"]').click();
    await setReactInputValue('[data-testid="find-input"]', '(a+)+b');
    await countHas('Pattern too slow', 'the pathological regex should time out, not hang');

    // The render thread was never blocked and the replacement worker gets
    // re-seeded: a normal regex still answers correctly right afterwards.
    // (A token unique to THIS fixture — earlier specs' documents stay open in
    // the same shared workspace index.)
    await setReactInputValue('[data-testid="find-input"]', 'invoi\\w+');
    await countHas('1 match', 'regex search must still work after a timeout');

    await $('[data-testid="find-regex"]').click(); // off
    await setReactInputValue('[data-testid="find-input"]', '');
  });

  it('OCRs a scanned document in-app, finds the text, and "Make searchable" persists it (2m acceptance)', async function () {
    this.timeout(180_000); // real in-webview OCR (first run loads core+lang)
    await waitForHarness();
    await openByPaths([SCANNED]);
    // The scanned fixture must actually become the active file.
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('scanned.pdf'),
      {
        timeout: 15_000,
        timeoutMsg:
          'scanned.pdf never became active — state: ' + JSON.stringify(await getState()),
      },
    );
    await setView('canvas');

    // The real tesseract.js worker runs INSIDE the webview against the
    // bundled offline assets — first run loads core+language, so be patient.
    // Wait on the real OCR signal (word boxes ready to persist), not the find
    // count (which the born-digital spec's leftover query could satisfy).
    await browser.waitUntil(async () => (await ocrReadyCount()) > 0, {
      timeout: 120_000,
      interval: 1_000,
      timeoutMsg: 'OCR words never became ready to persist',
    });

    // Find now surfaces the recognized text too.
    await ensureFindOpen();
    await setReactInputValue('[data-testid="find-input"]', 'invoice');
    await browser.waitUntil(
      async () => (await $('[data-testid="find-count"]').getText()).includes('match'),
      { timeout: 20_000, timeoutMsg: 'OCR text not findable' },
    );

    // Persist via the same flow the "Make searchable" button runs (driven
    // through the harness, not the async-gated button — same pattern as
    // redaction/signature canvas actions): apply_ocr_layer → UPDATE_FILE.
    await applyOcr();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
      timeout: 60_000,
      timeoutMsg: 'OCR apply never marked the file dirty',
    });

    const dest = resolve(tmp, 'searchable.pdf');
    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    // THE acceptance criterion: the SAVED file is genuinely searchable —
    // an independent reader extracts the recognized text.
    const text = (await extractAllText(dest)).toUpperCase();
    expect(text).toContain('INVOICE');
  });
});
