import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  focusTab,
  invokeAppCommand,
  commandEnabled,
  closeAllFiles,
  saveActiveAs,
  waitForActiveCanvasPageIds,
  deleteCanvasPagesAndWait,
  holdReaderCopies,
  releaseReaderCopies,
  readerCopiesWaiting,
  readerFolders,
} from '../support/harness.js';

// A long engine read (an export, a print, a conversion) runs on a private copy
// of the document's working copy, so the document stays editable and savable
// while it runs. The harness holds every call that runs on a copy after its
// copy exists and before its engine step, so each case decides what happens
// during a long read without a timer.

async function twoPagePdf(path: string, first: string, second: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(first, { x: 50, y: 700, size: 24, font });
  doc.addPage([612, 792]).drawText(second, { x: 50, y: 700, size: 24, font });
  writeFileSync(path, await doc.save());
}

/** Starts a harness call without waiting for it; `settled` reads its outcome.
 * The key is not `error`: an object with an `error` key read back through
 * WebDriver is taken for a protocol error. */
async function start(name: string, call: string, ...args: unknown[]): Promise<void> {
  await browser.execute((n: string, c: string, a: unknown[]) => {
    const w = window as any;
    w.__readerRuns = w.__readerRuns ?? {};
    w.__readerRuns[n] = { done: false, failure: null as string | null };
    Promise.resolve(w.__SPECTRA_TEST__[c](...a))
      .then(() => { w.__readerRuns[n].done = true; })
      .catch((e: unknown) => { w.__readerRuns[n] = { done: true, failure: String(e) }; });
  }, name, call, args);
}
const settled = (name: string) => browser.execute((n: string) => (window as any).__readerRuns?.[n] ?? null, name) as
  Promise<{ done: boolean; failure: string | null } | null>;

async function waitForHandles(count: number): Promise<string[]> {
  let handles: string[] = [];
  await browser.waitUntil(async () => {
    handles = await browser.getWindowHandles();
    return handles.length === count;
  }, { timeout: 30_000, interval: 250, timeoutMsg: `never saw ${count} window handles` });
  return handles;
}

describe('a long reader runs on a private copy of the working copy', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-reader-copy-'));
    await waitForHarness();
  });
  after(async () => {
    await releaseReaderCopies();
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });
  afterEach(async () => { await releaseReaderCopies(); });

  it('a held export of D leaves D editable and savable, and E usable', async () => {
    const d = resolve(tmp, 'held-export.pdf');
    const e = resolve(tmp, 'beside-export.pdf');
    await twoPagePdf(d, 'FIRST PAGE TEXT', 'SECOND PAGE TEXT');
    await twoPagePdf(e, 'OTHER ONE', 'OTHER TWO');
    await closeAllFiles();
    await openByPaths([d, e]);
    await setView('canvas');
    await focusTab({ doc: d });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === d,
      { timeoutMsg: 'the exported document never became active' });
    const working = (await getState()).activeFile!.workingPath;
    const pages = await waitForActiveCanvasPageIds();
    expect(pages).toHaveLength(2);
    expect(readerFolders(working)).toEqual([]);

    await holdReaderCopies();
    const exported = resolve(tmp, 'held-export.txt');
    await start('export', 'exportActiveAs', exported, 'txt');
    await browser.waitUntil(async () => (await readerCopiesWaiting()) === 1,
      { timeoutMsg: 'the export never reached its engine step on a copy' });
    expect(readerFolders(working)).toHaveLength(1);

    // A page edit of D while its export is held. It is pending in the page
    // tier, which offers Save; the file's own flag changes when it commits.
    await deleteCanvasPagesAndWait([pages[1]]);
    await browser.waitUntil(async () => await commandEnabled('file.save'),
      { timeoutMsg: 'the page edit never offered Save' });
    expect((await getState()).activeFile?.dirty).toBe(false);

    // A gated call on E: its gate commits D's page edit, which claims D's
    // working copy exclusively.
    await focusTab({ doc: e });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === e,
      { timeoutMsg: 'the second document never became active' });
    const copyOfE = resolve(tmp, 'beside-export-copy.pdf');
    await saveActiveAs(copyOfE);
    expect((await PDFDocument.load(readFileSync(copyOfE))).getPageCount()).toBe(2);
    expect((await settled('export'))!.done).toBe(false);

    // A save of D, with the export still held.
    await focusTab({ doc: d });
    await browser.waitUntil(async () => (await getState()).activeFile?.path === d,
      { timeoutMsg: 'the exported document never became active again' });
    // The gate of E's save committed D's page edit to D's working copy.
    expect((await getState()).activeFile?.dirty).toBe(true);
    expect((await PDFDocument.load(readFileSync(working))).getPageCount()).toBe(1);
    expect(await invokeAppCommand('file.save')).toBe(true);
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === false,
      { timeoutMsg: 'the save of the document never completed during the held export' });
    expect((await PDFDocument.load(readFileSync(d))).getPageCount()).toBe(1);
    expect(await readerCopiesWaiting()).toBe(1);
    expect((await settled('export'))!.done).toBe(false);

    // Released, the export reads the bytes it was asked for: both pages.
    await releaseReaderCopies();
    await browser.waitUntil(async () => (await settled('export'))?.done === true,
      { timeoutMsg: 'the export never settled' });
    expect((await settled('export'))!.failure).toBeNull();
    const text = readFileSync(exported, 'utf8');
    expect(text).toContain('FIRST PAGE TEXT');
    expect(text).toContain('SECOND PAGE TEXT');
    expect(readerFolders(working)).toEqual([]);
  });

  it('a window closed during a held export leaves no reader folder', async () => {
    const mainHandle = (await browser.getWindowHandles())[0];
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    await browser.switchToWindow(handles.find((h) => h !== mainHandle)!);
    await waitForHarness(30_000);
    const doc = resolve(tmp, 'closed-window.pdf');
    await twoPagePdf(doc, 'WINDOW ONE', 'WINDOW TWO');
    await openByPaths([doc]);
    const working = (await getState()).activeFile!.workingPath;

    await holdReaderCopies();
    await start('export', 'exportActiveAs', resolve(tmp, 'closed-window.txt'), 'txt');
    await browser.waitUntil(async () => (await readerCopiesWaiting()) === 1,
      { timeoutMsg: 'the export never reached its engine step on a copy' });
    expect(readerFolders(working)).toHaveLength(1);

    // A window that is not the last one is destroyed at once: the harness
    // close skips the renderer's wait for recorded writes, and the held call
    // never reached the engine, so no engine write holds the close either.
    // The copy is removed by the window's destruction alone.
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
    await waitForHandles(1);
    await browser.waitUntil(async () => readerFolders(working).length === 0, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `a reader folder of the closed window remains beside ${working}`,
    });
  });
});
