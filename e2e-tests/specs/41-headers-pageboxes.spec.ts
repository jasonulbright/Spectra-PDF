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

async function makeFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`BODY ${i}`, { x: 50, y: 400, size: 18, font });
  }
  writeFileSync(path, await doc.save());
}

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = (await (await pdf.getPage(i)).getTextContent()) as { items: { str?: string }[] };
    out.push(content.items.map((it) => it.str ?? '').join(' '));
  }
  await pdf.loadingTask.destroy();
  return out;
}

async function cropBox(path: string, pageNum: number): Promise<number[]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const view = (await pdf.getPage(pageNum)).view as number[]; // the crop box [x0,y0,x1,y1]
  await pdf.loadingTask.destroy();
  return view;
}

async function applyAndSave(dest: string): Promise<void> {
  await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
    timeout: 20_000,
    timeoutMsg: 'apply never marked the file dirty',
  });
  await saveActiveAs(dest);
  expect(existsSync(dest)).toBe(true);
}

describe('header/footer + page-box panels (P5)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p5-'));
    source = resolve(tmp, 'src.pdf');
    await makeFixture(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('stamps a page-number footer on every page through the engine', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('headerfooter');
    await setReactInputValue('[data-testid="hf-bc"]', 'Page {page}');
    await $('[data-testid="hf-apply"]').click();
    const dest = resolve(tmp, 'stamped.pdf');
    await applyAndSave(dest);
    const texts = await pageTexts(dest);
    expect(texts[0]).toContain('Page 1');
    expect(texts[1]).toContain('Page 2');
    expect(texts[0]).toContain('BODY 1'); // original content preserved
  });

  it('crops the page via the page-box panel', async () => {
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('pagebox');
    await setReactInputValue('[data-testid="pagebox-top"]', '100');
    await $('[data-testid="pagebox-apply"]').click();
    const dest = resolve(tmp, 'cropped.pdf');
    await applyAndSave(dest);
    const box = await cropBox(dest, 1);
    // 792 tall, trimmed 100 off the top → crop box height 692.
    expect(Math.round(box[3] - box[1])).toBe(692);
    expect(Math.round(box[2] - box[0])).toBe(612);
  });

  it('sets a page label range through the page-labels panel', async () => {
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('pagelabels');
    // Add one range starting at page 1, roman lower-case.
    await $('[data-testid="pagelabel-add"]').click();
    await $('[data-testid="pagelabel-style-0"]').waitForDisplayed({ timeout: 10_000 });
    await browser.execute(() => {
      const sel = document.querySelector('[data-testid="pagelabel-style-0"]') as HTMLSelectElement;
      if (sel) {
        sel.value = 'r';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await $('[data-testid="pagelabel-apply"]').click();
    const dest = resolve(tmp, 'labeled.pdf');
    await applyAndSave(dest);
    // Verify the /PageLabels tree via pdf.js (getPageLabels returns per-page).
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(dest)), isEvalSupported: false }).promise;
    const labels = await pdf.getPageLabels();
    await pdf.loadingTask.destroy();
    expect(labels).toEqual(['i', 'ii']);
  });
});
