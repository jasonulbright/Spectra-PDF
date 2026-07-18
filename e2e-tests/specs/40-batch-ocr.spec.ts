import { resolve } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
} from 'node:fs';
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
  invokeAppCommand,
  batchOcrSetFolders,
  batchOcrStart,
  batchOcrSnapshot,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Phase 6 — Batch OCR folder mirror (20-phase6-batch-ocr.md § Testing):
// fixture tree {a/scan.pdf (committed image-only fixture), born.pdf
// (generated born-digital), broken.pdf (garbage bytes)} → run the dialog's
// real flow with injected folders → assert the mirror: scanned output
// extractable by an independent reader, born-digital byte-identical,
// broken reported skipped, run completed. Recognition is the REAL
// tesseract.js worker inside the webview (14-ocr-find precedent).

const SCANNED = resolve(__dirname, '..', 'fixtures', 'scanned.pdf');

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

describe('batch OCR folder mirror (Phase 6)', () => {
  let tmp: string;
  let src: string;
  let dest: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-batch-ocr-'));
    src = resolve(tmp, 'source');
    dest = resolve(tmp, 'mirror');
    mkdirSync(resolve(src, 'a'), { recursive: true });
    // Scanned page in a SUBFOLDER — proves the mirror recreates structure.
    copyFileSync(SCANNED, resolve(src, 'a', 'scan.pdf'));
    // Born-digital sibling at the root.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText('Born digital text', { x: 40, y: 200, size: 14, font });
    writeFileSync(resolve(src, 'born.pdf'), await doc.save());
    // Garbage wearing a .pdf extension.
    writeFileSync(resolve(src, 'broken.pdf'), 'not a pdf at all');
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('mirrors a folder: OCRs the scanned file, copies the born-digital one, reports the broken one', async function () {
    this.timeout(240_000); // real in-webview OCR (first run loads core+lang)
    await waitForHarness();

    // Open the dialog through its registered command (the menu's entry).
    const enabled = await invokeAppCommand('tools.batchOcr');
    expect(enabled).toBe(true);
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });

    // Inject folders through the dialog's real selection flow; enumeration
    // runs on selectSource, so the count appears once scanning finishes.
    await batchOcrSetFolders(src, dest);
    await browser.waitUntil(
      async () => (await batchOcrSnapshot())?.fileCount === 3,
      { timeout: 15_000, timeoutMsg: 'enumeration never found the 3 fixture PDFs' },
    );

    await batchOcrStart();
    await browser.waitUntil(
      async () => (await batchOcrSnapshot())?.phase === 'done',
      {
        timeout: 200_000,
        interval: 1_000,
        timeoutMsg: 'batch run never reached done — snapshot: ' + JSON.stringify(await batchOcrSnapshot()),
      },
    );

    const snapshot = await batchOcrSnapshot();
    const report = snapshot?.report;
    expect(report).toBeTruthy();
    expect(report!.cancelled).toBe(false);
    const byRel = new Map(report!.results.map((r) => [r.rel, r]));
    expect(byRel.get('a\\scan.pdf')?.status).toBe('ocr');
    expect(byRel.get('born.pdf')?.status).toBe('copied');
    expect(byRel.get('broken.pdf')?.status).toBe('skipped');

    // The mirror on disk: structure recreated; born-digital byte-identical;
    // broken absent; scanned output independently extractable (the same
    // acceptance bar as 2m: genuinely searchable ON DISK).
    const mirroredScan = resolve(dest, 'a', 'scan.pdf');
    const mirroredBorn = resolve(dest, 'born.pdf');
    expect(existsSync(mirroredScan)).toBe(true);
    expect(existsSync(mirroredBorn)).toBe(true);
    expect(existsSync(resolve(dest, 'broken.pdf'))).toBe(false);
    expect(readFileSync(mirroredBorn).equals(readFileSync(resolve(src, 'born.pdf')))).toBe(true);
    const text = (await extractAllText(mirroredScan)).toUpperCase();
    expect(text).toContain('INVOICE');
    // Sources untouched: the original scanned file still has no text layer.
    const originalText = (await extractAllText(resolve(src, 'a', 'scan.pdf'))).trim();
    expect(originalText).toBe('');

    await $('[data-testid="batch-ocr-close"]').click();
  });

  it('refuses a destination inside the source folder', async () => {
    await waitForHarness();
    await invokeAppCommand('tools.batchOcr');
    await $('[data-testid="batch-ocr-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await batchOcrSetFolders(src, resolve(src, 'nested-out'));
    await $('[data-testid="batch-ocr-conflict"]').waitForDisplayed({ timeout: 10_000 });
    const startBtn = $('[data-testid="batch-ocr-start"]');
    expect(await startBtn.isEnabled()).toBe(false);

    await $('[data-testid="batch-ocr-cancel"]').click();
  });
});
