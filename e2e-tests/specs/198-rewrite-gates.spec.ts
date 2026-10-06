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

    // Save is offered only for a document with unsaved changes, so the
    // document carries one before the redaction starts: a form field.
    await placeNewField({ x: 0.5, y: 0.5, w: 0.3, h: 0.05 });
    await start('field', 'createPlacedField', { name: 'kept', type: 'text' });
    await browser.waitUntil(async () => (await settled('field'))?.done === true, { timeoutMsg: 'the field was never created' });
    expect((await settled('field'))!.error).toBeNull();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true,
      { timeoutMsg: 'the field left the document clean' });

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

  // The canvas creates one field at a time (its create button is disabled
  // while one is created), so the second write here is a field placed and
  // created while a redaction of the same document is held.
  it('a form field created during a redaction is created on the redacted result', async () => {
    source = resolve(tmp, 'redact-then-field.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('SECRET TOP LINE', { x: 50, y: 700, size: 24, font });
    page.drawText('KEEP ME BOTTOM', { x: 50, y: 100, size: 24, font });
    writeFileSync(source, await doc.save());
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    const working = (await getState()).activeFile!.workingPath;

    await addRedactionMark({ x: 0, y: 0, w: 1, h: 0.25 });
    await hold();
    await start('redact', 'applyRedactions');
    await browser.waitUntil(async () => (await waiting()) === 1, { timeoutMsg: 'the redaction never reached its engine step' });
    await placeNewField({ x: 0.1, y: 0.5, w: 0.3, h: 0.05 });
    await start('field', 'createPlacedField', { name: 'second', type: 'text' });

    await release();
    await browser.waitUntil(async () => (await settled('redact'))?.done === true && (await settled('field'))?.done === true,
      { timeoutMsg: 'the redaction and the field creation never settled' });
    expect((await settled('redact'))!.error).toBeNull();
    expect((await settled('field'))!.error).toBeNull();
    const names = (await PDFDocument.load(readFileSync(working))).getForm().getFields().map((f) => f.getName());
    expect(names).toEqual(['second']);
    const text = await pageText(working);
    expect(text).not.toContain('SECRET TOP LINE');
    expect(text).toContain('KEEP ME BOTTOM');
  });
});
