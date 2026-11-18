import { expect } from '@wdio/globals';
import { resolve } from 'node:path';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import {
  deleteSelectedCanvasPages,
  getState,
  getWorkspacePageIds,
  invokeAppCommand,
  openByPaths,
  pressGlobalKey,
  selectCanvasPages,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

/**
 * Window > Move to New Window writes the document over the user's own file,
 * which clears its undo. A document with unsaved edits therefore asks first
 * (W-9). Cancel leaves everything as it was: the tab, the file on disk and the
 * undo history. Save and Move writes the file and moves the document.
 */

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const CONFIRM_MESSAGE = '[data-testid="confirm-message"]';
const CONFIRM_CANCEL = '[data-testid="confirm-cancel"]';
const CONFIRM_AFFIRM = '[data-testid="confirm-affirm"]';

describe('Move to New Window asks before it saves', () => {
  let pdf = '';
  let mainHandle = '';
  let moveRun: Promise<unknown> | undefined;

  const pages = async (): Promise<string[]> =>
    (await getWorkspacePageIds()).filter((id) => id.startsWith(pdf));

  before(async () => {
    await waitForHarness();
    mainHandle = (await browser.getWindowHandles())[0];
    const dir = mkdtempSync(resolve(tmpdir(), 'move-asks-'));
    pdf = resolve(dir, 'moveme.pdf');
    copyFileSync(SAMPLE_PDF, pdf);
    await openByPaths([pdf]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });
  });

  it('asks, naming the file, when the document has unsaved edits', async () => {
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed',
    });

    moveRun = invokeAppCommand('window.moveToNewWindow');
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 20_000 });
    const text = await $(CONFIRM_MESSAGE).getText();
    expect(text).toContain('moveme.pdf');
    expect(text).toContain('unsaved changes');
  });

  it('Cancel keeps the document here, the file untouched and the undo intact', async () => {
    const onDisk = readFileSync(pdf);
    await $(CONFIRM_CANCEL).click();
    await $(CONFIRM_MESSAGE).waitForDisplayed({ reverse: true, timeout: 10_000 });
    await moveRun?.catch(() => undefined);
    await browser.pause(1500);

    expect((await browser.getWindowHandles()).length).toBe(1);
    expect((await getState()).fileCount).toBe(1);
    expect(readFileSync(pdf).equals(onDisk)).toBe(true);
    expect((await getState()).activeFile?.dirty).toBe(true);
    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'Cancel cleared the undo history',
    });
    // Delete again so the next case has something to save.
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the second delete never landed',
    });
  });

  it('Save and Move writes the file and moves the document', async () => {
    const before = readFileSync(pdf);
    moveRun = invokeAppCommand('window.moveToNewWindow');
    await waitForDisplayedSelector(CONFIRM_AFFIRM, { timeout: 20_000 });
    expect(await $(CONFIRM_AFFIRM).getText()).toBe('Save and Move');
    await $(CONFIRM_AFFIRM).click();
    await moveRun?.catch(() => undefined);

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'the new window never appeared',
    });
    // The new window is built when the destination is reserved, before the
    // write, so the file changes a moment after the window appears.
    await browser.waitUntil(async () => !readFileSync(pdf).equals(before), {
      timeout: 20_000,
      timeoutMsg: 'Save and Move never wrote the original file',
    });
    expect((await PDFDocument.load(readFileSync(pdf))).getPageCount()).toBe(4);

    const popped = (await browser.getWindowHandles()).find((h) => h !== mainHandle)!;
    await browser.switchToWindow(popped);
    await waitForHarness(30_000);
    await browser.waitUntil(async () => (await getState()).fileCount === 1, {
      timeout: 30_000,
      timeoutMsg: 'the document never arrived in the new window',
    });
    expect((await getState()).activeFile?.path.toLowerCase()).toBe(pdf.toLowerCase());
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
  });
});
