import { expect } from '@wdio/globals';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  closeAllFiles,
  deleteSelectedCanvasPages,
  emitTrayAction,
  getState,
  getWorkspacePageIds,
  openByPaths,
  pressGlobalKey,
  selectCanvasPages,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const CONFIRM_MESSAGE = '[data-testid="confirm-message"]';
const CONFIRM_CANCEL = '[data-testid="confirm-cancel"]';

const windowVisible = async (): Promise<boolean> =>
  browser.execute(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
    };
    return (await w.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })) === true;
  });

describe('tray Quit', () => {
  let dir = '';
  let pdf = '';

  before(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tray-quit-'));
    pdf = resolve(dir, 'pending.pdf');
    copyFileSync(SAMPLE_PDF, pdf);
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('asks before exiting dirty work and keeps the document when the user cancels', async () => {
    await waitForHarness();
    await openByPaths([pdf]);
    await setView('canvas');
    const pages = async () => (await getWorkspacePageIds()).filter((id) => id.startsWith(pdf));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });

    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });
    await emitTrayAction('quit');
    await waitForDisplayedSelector(CONFIRM_CANCEL, {
      timeout: 15_000,
      timeoutMsg: 'tray Quit did not ask how to handle the unsaved document',
    });
    expect(await $(CONFIRM_MESSAGE).getText()).toContain('pending.pdf');
    await $(CONFIRM_CANCEL).click();
    await waitForDisplayedSelector(CONFIRM_CANCEL, { timeout: 15_000, reverse: true });

    expect(await browser.getWindowHandles()).toHaveLength(1);
    expect(await pages()).toHaveLength(4);

    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 15_000,
      timeoutMsg: 'the page edit could not be undone after cancelling tray Quit',
    });
    expect((await getState()).activeFile?.pageCount).toBe(5);
  });

  it('brings a window hidden to the tray forward before asking about its unsaved work', async () => {
    const hidden = resolve(dir, 'hidden.pdf');
    copyFileSync(SAMPLE_PDF, hidden);
    await waitForHarness();
    await closeAllFiles();
    await browser.waitUntil(async () => (await getState()).fileCount === 0, {
      timeout: 15_000,
      timeoutMsg: 'the first case\'s document stayed open',
    });
    await openByPaths([hidden]);
    await setView('canvas');
    const pages = async () => (await getWorkspacePageIds()).filter((id) => id.startsWith(hidden));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });
    await browser.executeAsync((done: (v: unknown) => void) => {
      (window as any).__TAURI_INTERNALS__.invoke('hide_to_tray').then(done, done);
    });
    await browser.waitUntil(
      async () => !(await windowVisible()),
      { timeout: 10_000, timeoutMsg: 'the window never hid to the tray' },
    );

    await emitTrayAction('quit');
    await waitForDisplayedSelector(CONFIRM_CANCEL, {
      timeout: 15_000,
      timeoutMsg: 'tray Quit did not ask about the hidden window\'s unsaved document',
    });
    await browser.waitUntil(
      async () => windowVisible(),
      { timeout: 10_000, timeoutMsg: 'the prompt was raised in a window still hidden' },
    );
    const message = await $(CONFIRM_MESSAGE).getText();
    expect(message).toContain('hidden.pdf');
    expect(message).not.toContain('pending.pdf');
    await $(CONFIRM_CANCEL).click();
    await waitForDisplayedSelector(CONFIRM_CANCEL, { timeout: 15_000, reverse: true });

    expect(await windowVisible()).toBe(true);
    expect(await pages()).toHaveLength(4);
  });
});
