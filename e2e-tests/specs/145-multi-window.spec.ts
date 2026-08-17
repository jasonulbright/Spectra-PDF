import { expect } from '@wdio/globals';
import { resolve } from 'node:path';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  waitForHarness,
  getState,
  invokeAppCommand,
  waitForDisplayedSelector,
} from '../support/harness.js';

/**
 * A second workspace window, and the four failures that are live the instant
 * one exists.
 *
 * Every renderer-bound event in this app is an app-wide broadcast unless it
 * goes out addressed, and every renderer singleton — the engine request-id
 * counter, the page-generation counter, the storage mirrors — exists once per
 * window. What this spec drives is the four consequences:
 *
 *   1. one document, one window (the claim), with the refusal naming it;
 *   2. one engine, addressed replies — two windows waiting on the SAME
 *      request id each get their own answer;
 *   3. closing a non-final window closes THAT window and leaves the app up;
 *   4. closing the last window still exits the session cleanly.
 *
 * The two-window shape is a driver fact, not an assumption: a Tauri window is
 * a WebDriver window handle, so the second workspace is reached with
 * `switchToWindow` and driven through its own harness.
 */

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const BOOKMARKED_PDF = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

/** Wait until the driver reports `count` window handles. */
async function waitForHandles(count: number): Promise<string[]> {
  let handles: string[] = [];
  await browser.waitUntil(
    async () => {
      handles = await browser.getWindowHandles();
      return handles.length === count;
    },
    { timeout: 30_000, interval: 250, timeoutMsg: `never saw ${count} window handles` },
  );
  return handles;
}

async function labelOfCurrentWindow(): Promise<string> {
  return await browser.execute<string, []>(function () {
    return (window as any).__SPECTRA_TEST__.windowLabel();
  });
}

describe('multi-window', () => {
  let mainHandle = '';
  let secondHandle = '';
  let ownedPdf = '';
  let otherPdf = '';

  it('boots with one workspace window', async () => {
    await waitForHarness();
    const handles = await browser.getWindowHandles();
    expect(handles).toHaveLength(1);
    mainHandle = handles[0];
    expect(await labelOfCurrentWindow()).toBe('main');

    // Private copies: the claim is keyed by canonical path, and a fixture the
    // rest of the battery also opens would make this spec order-dependent.
    const dir = mkdtempSync(resolve(tmpdir(), 'multi-window-'));
    ownedPdf = resolve(dir, 'owned.pdf');
    otherPdf = resolve(dir, 'other.pdf');
    copyFileSync(SAMPLE_PDF, ownedPdf);
    copyFileSync(BOOKMARKED_PDF, otherPdf);
  });

  it('opens a document in the first window', async () => {
    await browser.executeAsync<string | null, [string]>(
      function (p, done) {
        (window as any).__SPECTRA_TEST__.openByPaths([p])
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      ownedPdf,
    );
    const state = await getState();
    expect(state.fileCount).toBe(1);
    expect(state.activeFile?.path.toLowerCase()).toBe(ownedPdf.toLowerCase());
  });

  it('Window ▸ New Window opens a second workspace with its own harness', async () => {
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    secondHandle = handles.find((h) => h !== mainHandle)!;

    await browser.switchToWindow(secondHandle);
    await waitForHarness(30_000);

    // A distinct label is what every per-window decision keys on: the
    // capability glob, the backdrop record, the claim table, the engine route
    // and the per-window storage keys.
    const label = await labelOfCurrentWindow();
    expect(label).not.toBe('main');
    expect(label.startsWith('doc-')).toBe(true);

    // A fresh workspace, not a second view of the first one's documents.
    const state = await getState();
    expect(state.fileCount).toBe(0);
    expect(state.activeFile).toBeNull();
  });

  it('refuses a document the other window holds, by name', async () => {
    await browser.executeAsync<string | null, [string]>(
      function (p, done) {
        (window as any).__SPECTRA_TEST__.openByPaths([p])
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      ownedPdf,
    );

    // The refusal is a dialog that names the file and offers the window that
    // holds it. Silent divergence here is data loss: both windows would edit
    // private working copies of one file and the later save would win.
    // Re-queried at every step: affirming unmounts the dialog, and a handle
    // taken before the click names a node that no longer exists.
    const MESSAGE = '[data-testid="confirm-message"]';
    await waitForDisplayedSelector(MESSAGE, { timeout: 15_000 });
    expect(await $(MESSAGE).getText()).toContain('owned.pdf');
    await expect($('[data-testid="confirm-affirm"]')).toBeDisplayed();

    // Nothing was opened, and no working copy was minted.
    expect((await getState()).fileCount).toBe(0);

    await $('[data-testid="confirm-affirm"]').click();
    await waitForDisplayedSelector(MESSAGE, { timeout: 10_000, reverse: true });

    // Focusing the other window must not have moved the driver's own idea of
    // which window it is driving.
    await browser.switchToWindow(secondHandle);
  });

  it('opens a document of its own', async () => {
    await browser.executeAsync<string | null, [string]>(
      function (p, done) {
        (window as any).__SPECTRA_TEST__.openByPaths([p])
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      otherPdf,
    );
    const state = await getState();
    expect(state.fileCount).toBe(1);
    expect(state.activeFile?.path.toLowerCase()).toBe(otherPdf.toLowerCase());
  });

  it('gives each window its own engine result for the SAME request id', async () => {
    // The renderer's request-id counter is module-scoped, so both windows
    // number from 1 and correlate a reply by that number alone. Both ask about
    // a DIFFERENT file under id 4242: with an unaddressed reply one window
    // resolves the other's promise and reports the wrong document's answer
    // with no error anywhere. `get_page_count` echoes the file it read, which
    // is the exact discriminator.
    const ID = 4242;

    await browser.switchToWindow(mainHandle);
    const mainWorking = (await getState()).activeFile!.workingPath;
    await browser.execute(
      function (path, id) {
        (window as any).__U4_MAIN = null;
        (window as any).__SPECTRA_TEST__.engineRequestWithId('get_page_count', { file: path }, id)
          .then((r: unknown) => { (window as any).__U4_MAIN = r; })
          .catch((e: unknown) => { (window as any).__U4_MAIN = { file: `error: ${String(e)}` }; });
      },
      mainWorking,
      ID,
    );

    await browser.switchToWindow(secondHandle);
    const secondWorking = (await getState()).activeFile!.workingPath;
    const secondResult = await browser.executeAsync<{ file: string }, [string, number]>(
      function (path, id, done) {
        (window as any).__SPECTRA_TEST__.engineRequestWithId('get_page_count', { file: path }, id)
          .then((r: unknown) => done(r as { file: string }))
          .catch((e: unknown) => done({ file: `error: ${String(e)}` }));
      },
      secondWorking,
      ID,
    );

    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(
      async () => Boolean(await browser.execute(() => (window as any).__U4_MAIN)),
      { timeout: 30_000, timeoutMsg: 'the first window never got its own engine reply' },
    );
    const mainResult = await browser.execute<{ file: string }, []>(
      function () { return (window as any).__U4_MAIN; },
    );

    expect(mainResult.file).toBe(mainWorking);
    expect(secondResult.file).toBe(secondWorking);
    expect(mainWorking).not.toBe(secondWorking);
  });

  it('closing the second window leaves the app and the first window alive', async () => {
    await browser.switchToWindow(secondHandle);
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    // Off the dying window before waiting: a driver command against a closed
    // handle is an error, not a slow answer.
    await browser.switchToWindow(mainHandle);
    await waitForHandles(1);

    // The quit hazard: the close path used to destroy the window labelled
    // "main" and exit the process whichever window asked, discarding the other
    // window's unsaved work with its prompt still on screen.
    expect(await labelOfCurrentWindow()).toBe('main');
    const state = await getState();
    expect(state.fileCount).toBe(1);
    expect(state.activeFile?.path.toLowerCase()).toBe(ownedPdf.toLowerCase());
  });

  it('releases the closed window claims so the first window can take them', async () => {
    // Release is driven from the window's own destruction, not from its
    // renderer: a crashed or hung renderer must not wedge a path for the rest
    // of the session.
    await browser.executeAsync<string | null, [string]>(
      function (p, done) {
        (window as any).__SPECTRA_TEST__.openByPaths([p])
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      otherPdf,
    );
    await expect($('[data-testid="confirm-message"]')).not.toBeDisplayed();
    expect((await getState()).fileCount).toBe(2);
  });

  it('Move to New Window MOVES the document — it never clones it', async () => {
    // Pop-out moves: two live copies of one file would be two independent
    // edit sessions on two private working copies, reconciled by whichever
    // save lands last. Only the PATH crosses — a page id is minted against a
    // per-window counter and names a different physical page over there.
    const moved = (await getState()).activeFile!.path;
    expect(await invokeAppCommand('window.moveToNewWindow')).toBe(true);

    const handles = await waitForHandles(2);
    const popped = handles.find((h) => h !== mainHandle)!;

    // The document has LEFT this window.
    await browser.waitUntil(async () => (await getState()).fileCount === 1, {
      timeout: 20_000,
      timeoutMsg: 'the moved document never left the first window',
    });
    const remaining = await getState();
    expect(remaining.activeFile?.path.toLowerCase()).not.toBe(moved.toLowerCase());

    // …and arrived in the new one, which claimed it on the way in.
    await browser.switchToWindow(popped);
    await waitForHarness(30_000);
    await browser.waitUntil(async () => (await getState()).fileCount === 1, {
      timeout: 30_000,
      timeoutMsg: 'the moved document never arrived in the new window',
    });
    expect((await getState()).activeFile?.path.toLowerCase()).toBe(moved.toLowerCase());

    // Leave one window behind so the session's final close is the ordinary
    // last-window teardown.
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
    await waitForHandles(1);
  });
});
