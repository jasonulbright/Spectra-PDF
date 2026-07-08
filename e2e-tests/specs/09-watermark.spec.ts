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
  setActiveOp,
  getState,
  saveActiveAs,
  setReactInputValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function makeTextFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`BODY TEXT PAGE ${i}`, { x: 50, y: 400, size: 18, font });
  }
  writeFileSync(path, await doc.save());
}

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = (await page.getTextContent()) as { items: { str?: string }[] };
    texts.push(content.items.map((it) => it.str ?? '').join(' '));
  }
  await pdf.loadingTask.destroy();
  return texts;
}

describe('watermark panel stamps text through the real engine round trip', () => {
  let tmp: string;
  let source: string;
  let dest: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-wm-'));
    source = resolve(tmp, 'watermark-me.pdf');
    dest = resolve(tmp, 'watermarked.pdf');
    await makeTextFixture(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('applies the panel form to every page of the saved file', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('watermark');

    // NOT setValue — see setReactInputValue for why (controlled-input clear
    // race + WebView2 keystroke drops, both observed live in this spec).
    await setReactInputValue('[data-testid="watermark-text"]', 'E2E-WATERMARK');
    await $('[data-testid="watermark-apply"]').click();

    // UPDATE_FILE marks the file dirty once the engine round trip lands.
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
      timeout: 20_000,
      timeoutMsg: 'watermark apply never marked the file dirty',
    });

    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    const texts = await pageTexts(dest);
    expect(texts).toHaveLength(2);
    for (const [i, text] of texts.entries()) {
      expect(text).toContain('E2E-WATERMARK');
      expect(text).toContain(`BODY TEXT PAGE ${i + 1}`);
    }
  });
});
