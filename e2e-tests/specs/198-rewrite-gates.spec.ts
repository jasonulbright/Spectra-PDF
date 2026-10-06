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
  placeNewField,
  closeAllFiles,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// A rewrite of a document runs its engine step outside the publication lane.
// A user operation asked for during that step (a save, a second write) must
// see the rewrite's result. The harness holds every rewrite at the start of
// its engine step, so each case decides what happens during the step without
// a timer.

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

/** Starts a harness call without waiting for it; `settled` reads its outcome. */
async function start(name: string, call: string, ...args: unknown[]): Promise<void> {
  await browser.execute((n: string, c: string, a: unknown[]) => {
    const w = window as any;
    w.__p43 = w.__p43 ?? {};
    w.__p43[n] = { done: false, error: null as string | null };
    Promise.resolve(w.__SPECTRA_TEST__[c](...a))
      .then(() => { w.__p43[n].done = true; })
      .catch((e: unknown) => { w.__p43[n] = { done: true, error: String(e) }; });
  }, name, call, args);
}
const settled = (name: string) => browser.execute((n: string) => (window as any).__p43?.[n] ?? null, name) as
  Promise<{ done: boolean; error: string | null } | null>;

describe('user operations asked for during a rewrite see its result', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-rewrite-gates-'));
    await waitForHarness();
  });
  after(async () => {
    await release();
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });
  afterEach(async () => { await release(); });

  it('a save asked for during a redaction writes the redacted bytes', async () => {
    source = resolve(tmp, 'redact-then-save.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('SECRET TOP LINE', { x: 50, y: 700, size: 24, font });
    page.drawText('KEEP ME BOTTOM', { x: 50, y: 100, size: 24, font });
    writeFileSync(source, await doc.save());
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');

    await addRedactionMark({ x: 0, y: 0, w: 1, h: 0.25 });
    await hold();
    await start('redact', 'applyRedactions');
    await browser.waitUntil(async () => (await waiting()) === 1, { timeoutMsg: 'the redaction never reached its engine step' });

    // Save waits for the redaction: until it is released nothing is written.
    expect(await invokeAppCommand('file.save')).toBe(true);
    expect(await pageText(source)).toContain('SECRET TOP LINE');

    await release();
    await browser.waitUntil(async () => (await settled('redact'))?.done === true, { timeoutMsg: 'the redaction never settled' });
    expect((await settled('redact'))!.error).toBeNull();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === false,
      { timeoutMsg: 'the save never wrote the redacted document' });
    const text = await pageText(source);
    expect(text).not.toContain('SECRET TOP LINE');
    expect(text).toContain('KEEP ME BOTTOM');
  });

  it('a second form field placed during the first one is created on the first one\'s result', async () => {
    source = resolve(tmp, 'two-fields.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writeFileSync(source, await doc.save());
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    const working = (await getState()).activeFile!.workingPath;

    await hold();
    await placeNewField({ x: 0.1, y: 0.1, w: 0.3, h: 0.05 });
    await start('first', 'createPlacedField', { name: 'first', type: 'text' });
    await browser.waitUntil(async () => (await waiting()) === 1, { timeoutMsg: 'the first field never reached its engine step' });
    await placeNewField({ x: 0.1, y: 0.3, w: 0.3, h: 0.05 });
    await start('second', 'createPlacedField', { name: 'second', type: 'text' });

    await release();
    await browser.waitUntil(async () => (await settled('first'))?.done === true && (await settled('second'))?.done === true,
      { timeoutMsg: 'the two field creations never settled' });
    expect((await settled('first'))!.error).toBeNull();
    expect((await settled('second'))!.error).toBeNull();
    const names = (await PDFDocument.load(readFileSync(working))).getForm().getFields().map((f) => f.getName()).sort();
    expect(names).toEqual(['first', 'second']);
  });
});
