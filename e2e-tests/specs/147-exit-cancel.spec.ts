import { expect } from '@wdio/globals';
import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  breakTabOrderPublish,
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
 * An app Exit that a window cancels, and the session record it leaves behind.
 *
 * File ▸ Exit records the session and CLOSES THE FILE to further writes before
 * any window is asked anything — the capture has to be taken while every window
 * is still standing, because each window's destruction writes that window out
 * of the record. A window that then cancels leaves the app running behind a
 * frozen description of the moment the exit was decided: the initiating window
 * is still in it though it has since closed, and every later open, close and
 * move goes unrecorded for the rest of the run. Cancelling therefore has to do
 * both halves — replace the record and lift the seal.
 *
 * The shape this spec drives is the one the fix has to survive: the window that
 * cancels is NOT the window that started the exit. The initiator has no unsaved
 * work, so nothing stops it, and it closes itself while the other window is
 * still holding its prompt — which is exactly why the sealed capture goes stale
 * rather than merely early.
 *
 * That also makes this case terminal for its window handle, which is why it
 * lives in its own spec file and steps off the dying handle before asserting
 * anything, the way 145's closing-window case does.
 *
 * `session.json` is read with Node's `fs` rather than through a bridge: it is
 * written entirely on the Rust side, and asking the renderer about it would
 * only prove what the renderer believes. The unseal's write is synchronous
 * inside the command the Cancel button invokes, so the polls here are short.
 */

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf'); // 5 pages
const BOOKMARKED_PDF = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

/** Where the Rust side records window geometry and each window's paths. */
const SESSION_FILE = resolve(process.env.APPDATA ?? '', 'com.spectrapdf.app', 'session.json');

const CONFIRM_MESSAGE = '[data-testid="confirm-message"]';
const CONFIRM_CANCEL = '[data-testid="confirm-cancel"]';

interface SessionRecord {
  labelKind: 'main' | 'doc';
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  monitor: string;
  files: string[];
}

function readSession(): SessionRecord[] {
  expect(existsSync(SESSION_FILE)).toBe(true);
  return (JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as { windows: SessionRecord[] }).windows;
}

const holds = (record: SessionRecord, path: string): boolean =>
  record.files.some((f) => f.toLowerCase() === path.toLowerCase());

const someWindowHolds = (windows: SessionRecord[], path: string): boolean =>
  windows.some((w) => holds(w, path));

async function labelOfCurrentWindow(): Promise<string> {
  return await browser.execute<string, []>(function () {
    return (window as any).__SPECTRA_TEST__.windowLabel();
  });
}

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

/** Poll the file until it says what the caller expects, reporting what it last
 * said when it never does — a bare `waitUntil` failure would name only the
 * timeout, and the record IS the assertion here. */
async function waitForSession(
  predicate: (windows: SessionRecord[]) => boolean,
  what: string,
): Promise<SessionRecord[]> {
  let last: SessionRecord[] = [];
  try {
    await browser.waitUntil(
      async () => {
        last = readSession();
        return predicate(last);
      },
      { timeout: 20_000, interval: 250 },
    );
  } catch {
    throw new Error(`${what} (last read ${JSON.stringify(last)})`);
  }
  return last;
}

describe('cancelled exit', () => {
  let mainHandle = '';
  let secondHandle = '';
  /** Held by the initiating window, which closes: clean, so nothing stops it. */
  let cleanPdf = '';
  /** Held by the window that cancels, with unsaved page edits. */
  let dirtyPdf = '';
  /** Opened after the cancel, to prove the file is being written again. */
  let laterPdf = '';

  it('boots one workspace window holding a clean document', async () => {
    await waitForHarness();
    const handles = await browser.getWindowHandles();
    expect(handles).toHaveLength(1);
    mainHandle = handles[0];
    expect(await labelOfCurrentWindow()).toBe('main');

    // Private copies: a claim is keyed by canonical path, and a fixture the
    // rest of the battery also opens would make this spec order-dependent.
    const dir = mkdtempSync(resolve(tmpdir(), 'exit-cancel-'));
    cleanPdf = resolve(dir, 'clean.pdf');
    dirtyPdf = resolve(dir, 'dirty.pdf');
    laterPdf = resolve(dir, 'later.pdf');
    copyFileSync(BOOKMARKED_PDF, cleanPdf);
    copyFileSync(SAMPLE_PDF, dirtyPdf);
    copyFileSync(BOOKMARKED_PDF, laterPdf);

    await openByPaths([cleanPdf]);
    expect((await getState()).fileCount).toBe(1);
    expect((await getState()).activeFile?.dirty).toBe(false);
  });

  it('a second window holds a document with unsaved page edits', async () => {
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    secondHandle = handles.find((h) => h !== mainHandle)!;

    await browser.switchToWindow(secondHandle);
    await waitForHarness(30_000);
    expect((await labelOfCurrentWindow()).startsWith('doc-')).toBe(true);

    await openByPaths([dirtyPdf]);
    await setView('canvas');
    const pages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(dirtyPdf));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });

    // A page-tier edit, which is what makes this window's close flow ask a
    // question the exit has to wait on.
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });
  });

  it('File ▸ Exit seals the record and asks the other window', async () => {
    await browser.switchToWindow(mainHandle);
    expect(await invokeAppCommand('file.exit')).toBe(true);

    // Off the initiating window before anything is awaited: it has no unsaved
    // work, so it closes itself, and a driver command against a closed handle
    // is an error rather than a slow answer.
    await browser.switchToWindow(secondHandle);
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 30_000 });
    expect(await $(CONFIRM_MESSAGE).getText()).toContain('dirty.pdf');

    // The initiator is gone while this window is still being asked.
    await waitForHandles(1);

    // What the seal is FOR: the capture was taken before any window was asked,
    // so it still describes both windows — including the one that has since
    // destroyed itself, whose own destruction write the seal refused. Every
    // assertion after the cancel is a comparison against this.
    const sealed = readSession();
    expect(sealed.filter((w) => w.labelKind === 'main')).toHaveLength(1);
    expect(someWindowHolds(sealed, cleanPdf)).toBe(true);
    expect(someWindowHolds(sealed, dirtyPdf)).toBe(true);
  });

  it('cancelling replaces the sealed record with what is actually left', async () => {
    await waitForDisplayedSelector(CONFIRM_CANCEL, { timeout: 15_000 });
    await $(CONFIRM_CANCEL).click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000, reverse: true });

    // A cancel keeps this window, its document and its unsaved edits.
    expect((await labelOfCurrentWindow()).startsWith('doc-')).toBe(true);
    expect((await getState()).fileCount).toBe(1);
    expect(
      (await getWorkspacePageIds()).filter((id) => id.startsWith(dirtyPdf)),
    ).toHaveLength(4);

    // The record now describes the app as it stands: one window, the one that
    // cancelled. The window that closed during the aborted exit dropped out on
    // its own — its claims and geometry went with its destruction, and only the
    // write was suppressed.
    const windows = await waitForSession(
      (w) =>
        w.length === 1 &&
        w[0].labelKind === 'doc' &&
        holds(w[0], dirtyPdf) &&
        !someWindowHolds(w, cleanPdf),
      'the cancelled exit never replaced the sealed session record',
    );
    expect(windows.filter((r) => r.labelKind === 'main')).toHaveLength(0);
  });

  it('and puts the file back under live tracking for the rest of the run', async () => {
    // Undo first, so the rest of the run — and the teardown — sees a clean
    // document rather than a second prompt.
    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(
      async () =>
        (await getWorkspacePageIds()).filter((id) => id.startsWith(dirtyPdf)).length === 5,
      { timeout: 30_000, timeoutMsg: 'the page delete could not be undone after the cancel' },
    );

    await openByPaths([laterPdf]);
    await browser.waitUntil(async () => (await getState()).fileCount === 2, {
      timeout: 30_000,
      timeoutMsg: 'the second document never opened after the cancelled exit',
    });

    // Opening a document changes what a snapshot WOULD say without asking for
    // one: the file is written from window lifecycle and geometry, and the
    // paths come off the claim table when a write happens. So the write is
    // provoked by a window closing — a path that goes through the same
    // seal check every debounced write goes through, and one that produced
    // nothing at all while the record was frozen.
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    const throwaway = handles.find((h) => h !== secondHandle)!;
    await browser.switchToWindow(throwaway);
    await waitForHarness(30_000);
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(secondHandle);
    await waitForHandles(1);

    await waitForSession(
      (w) => someWindowHolds(w, dirtyPdf) && someWindowHolds(w, laterPdf),
      'session writes never resumed after the cancelled exit',
    );
  });

  it('an Exit no peer acknowledges is called off BEFORE anything is captured', async () => {
    // The quit is two rounds with the capture strictly between them: every peer
    // is asked to finish publishing what it has measured and to say so, and
    // only once all of them have is the record taken and sealed. A peer that
    // does not answer therefore aborts the quit with NOTHING captured and
    // nothing sealed — which is the difference this case reads: the record goes
    // on following the app afterwards.
    //
    // A peer that does not answer is the one shape this suite cannot produce by
    // ordinary means — a renderer it can reach is a renderer that answers — so
    // the seam sits where the failure is: this window's tab-order flush reports
    // that the order did not land, and a window in that state withholds its
    // receipt rather than acknowledging over an order the far side never got.
    await breakTabOrderPublish();

    // A second window to exit FROM: the prepare round goes to the peers, so the
    // window that withholds must not be the one that asks.
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    const initiator = handles.find((h) => h !== secondHandle)!;
    await browser.switchToWindow(initiator);
    await waitForHarness(30_000);

    // With teeth: the record is describing BOTH windows right now, so a sealed
    // record and a live one differ in what happens next.
    await waitForSession((w) => w.length === 2, 'the second window was never recorded');

    expect(await invokeAppCommand('file.exit')).toBe(true);
    // Fail-closed and said out loud: the quit unsealed nothing because it
    // captured nothing, and the user is told rather than watching Exit do
    // nothing at all.
    await waitForDisplayedSelector(CONFIRM_MESSAGE, {
      timeout: 30_000,
      timeoutMsg: 'an Exit no peer acknowledged reported nothing',
    });
    expect(await $(CONFIRM_MESSAGE).getText()).toContain('nothing was closed');
    await $('[data-testid="notice-ok"]').click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000, reverse: true });

    // Nothing closed.
    expect(await browser.getWindowHandles()).toHaveLength(2);

    // And the record was never frozen: this window's own destruction still
    // writes it out, which a sealed file would have refused.
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(secondHandle);
    await waitForHandles(1);
    await waitForSession(
      (w) => w.length === 1 && holds(w[0], dirtyPdf),
      'the aborted exit left the session record sealed',
    );
  });
});
