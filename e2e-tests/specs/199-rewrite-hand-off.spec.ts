import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  addRedactionMark,
  invokeAppCommand,
  closeAllFiles,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// A document moved to another window while an operation on it runs: the move
// waits for the operation, writes its result over the user's file, and only
// then hands the document over. The harness holds the operation at the start
// of its engine step, so the move is asked for while the step runs.

async function pageText(path: string): Promise<string> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const page = await pdf.getPage(1);
  const content = (await page.getTextContent()) as { items: { str?: string }[] };
  await pdf.loadingTask.destroy();
  return content.items.map((it) => it.str ?? '').join(' ');
}

const hold = () => browser.execute(() => { (window as any).__SPECTRA_TEST__.holdRewriteEngineSteps(); });
const release = () => browser.execute(() => { (window as any).__SPECTRA_TEST__.releaseRewriteEngineSteps(); });
const waiting = () => browser.execute(() => (window as any).__SPECTRA_TEST__.rewriteEngineStepsWaiting() as number);

describe('a document moved to a new window during an operation on it', () => {
  let tmp: string;
  let source: string;
  let mainHandle: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-rewrite-hand-off-'));
    source = resolve(tmp, 'moved-during-redaction.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('SECRET TOP LINE', { x: 50, y: 700, size: 24, font });
    page.drawText('KEEP ME BOTTOM', { x: 50, y: 100, size: 24, font });
    writeFileSync(source, await doc.save());
    await waitForHarness();
    mainHandle = await browser.getWindowHandle();
  });
  after(async () => {
    await browser.switchToWindow(mainHandle);
    await release();
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('arrives with the operation\'s result written over the user\'s file', async () => {
    await openByPaths([source]);
    await setView('canvas');
    await addRedactionMark({ x: 0, y: 0, w: 1, h: 0.25 });

    await hold();
    await browser.execute(() => {
      const w = window as any;
      w.__p43Redact = { done: false, error: null as string | null };
      w.__SPECTRA_TEST__.applyRedactions()
        .then(() => { w.__p43Redact.done = true; })
        .catch((e: unknown) => { w.__p43Redact = { done: true, error: String(e) }; });
    });
    await browser.waitUntil(async () => (await waiting()) === 1, { timeoutMsg: 'the redaction never reached its engine step' });

    expect(await invokeAppCommand('window.moveToNewWindow')).toBe(true);
    // The move waits for the operation: the document is still here, and the
    // user's file is untouched.
    expect((await getState()).fileCount).toBe(1);
    expect(await pageText(source)).toContain('SECRET TOP LINE');

    await release();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2,
      { timeoutMsg: 'the document never moved to a new window' });
    const redact = await browser.execute(() => (window as any).__p43Redact) as { done: boolean; error: string | null };
    expect(redact.done).toBe(true);
    expect(redact.error).toBeNull();
    await browser.waitUntil(async () => (await getState()).fileCount === 0,
      { timeoutMsg: 'the moved document never left this window' });

    // Written over the user's file before the hand-off.
    const text = await pageText(source);
    expect(text).not.toContain('SECRET TOP LINE');
    expect(text).toContain('KEEP ME BOTTOM');

    const second = (await browser.getWindowHandles()).find((h) => h !== mainHandle)!;
    await browser.switchToWindow(second);
    await waitForHarness(30_000);
    await browser.waitUntil(async () => (await getState()).fileCount === 1,
      { timeoutMsg: 'the document never arrived in its new window' });
    expect((await getState()).activeFile?.path.toLowerCase()).toBe(source.toLowerCase());
    expect((await getState()).activeFile?.dirty).toBe(false);
    await closeAllFiles();
    await browser.closeWindow();
    await browser.switchToWindow(mainHandle);
  });
});
