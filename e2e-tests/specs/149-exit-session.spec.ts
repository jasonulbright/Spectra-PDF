import { expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  getState,
  invokeAppCommand,
  openByPaths,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';
import { SESSION_FILE, STARTUP_FILE } from '../support/app-data.js';

/**
 * An app Exit that nobody cancels, and the launch that reads what it left.
 *
 * 147 drives the exit that is called OFF. This is its complement: the exit that
 * goes through. Three properties only this shape can show.
 *
 * The first is that a two-window Exit closes both windows and records both.
 * The capture is taken while every window still stands, because each window's
 * destruction writes that window out of the record — a capture taken one
 * destruction later can only ever describe the window that closed last.
 *
 * The second is the receipt. Nothing closes until every other window has
 * acknowledged the request, and a request that is not acknowledged calls the
 * quit off with a notice. The abort half is not drivable from here — it needs a
 * renderer that hears nothing, and a renderer this suite can reach is a
 * renderer that answers — so what is asserted is the ordinary verdict: the
 * windows go, which is only reachable through `request_quit` answering true.
 *
 * The third is the launch. A session saved with the main window already closed
 * has no main-kind record, and treating every record as an extra opens an EMPTY
 * main window beside the ones that were actually saved. The first record adopts
 * the slot instead, so the relaunch shows one window — the one that was saved.
 *
 * Two of those cases end with the app exiting, which ends the driver's session
 * with it. `browser.reloadSession()` is what makes them fit in one file: it
 * hands tauri-driver a fresh session, and tauri-driver launches the binary
 * again — which is also the only way the launch case can be driven at all,
 * since the thing under test is what a NEW process does with the file.
 *
 * `session.json` is read with Node's `fs`: it is written entirely on the Rust
 * side, and asking a renderer about it would only prove what the renderer
 * believes. The staging file beside it is read the same way — a write that
 * lands by rename leaves nothing behind, and the check is that nothing is
 * there.
 */

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const BOOKMARKED_PDF = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

// `SESSION_FILE` and `STARTUP_FILE` — the Rust-readable startup flags, read
// while the windows are being built, before any renderer exists to be asked —
// are resolved from the binary's own container: see `support/app-data.ts`.

interface SessionRecord {
  labelKind: 'main' | 'doc';
  files: string[];
}

function readSession(): SessionRecord[] {
  expect(existsSync(SESSION_FILE)).toBe(true);
  return (JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as { windows: SessionRecord[] }).windows;
}

const holds = (record: SessionRecord, path: string): boolean =>
  record.files.some((f) => f.toLowerCase() === path.toLowerCase());

/** Staging names are `session.json.<pid>.tmp`, beside the record. A write that
 * completed renamed its staged bytes onto the file; a write that failed removed
 * them. Either way the directory holds none afterwards. */
function stagingLeftovers(): string[] {
  const dir = dirname(SESSION_FILE);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^session\.json\..*\.tmp$/i.test(n));
}

function appIsRunning(): boolean {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq spectrapdf.exe', '/NH'], {
    encoding: 'utf-8',
  });
  return out.toLowerCase().includes('spectrapdf.exe');
}

/** Wait for the process to go, off the driver entirely: the session dies with
 * the app, so nothing that talks to a window can report this. */
async function waitForAppGone(what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!appIsRunning()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(what);
}

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

/** Turn the launch-restore preference on through the dialog that owns it —
 * the checkbox mirrors itself into the Rust-readable file, which is the half
 * the launch actually reads. */
async function enableRestoreWindows(): Promise<void> {
  expect(await invokeAppCommand('help.licenses')).toBe(true);
  await $('[data-testid="prefs-cat-tray"]').waitForDisplayed({ timeout: 15_000 });
  await $('[data-testid="prefs-cat-tray"]').click();
  const box = $('[data-testid="pref-restore-windows"]');
  await box.waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: 'the restore-windows preference is missing',
  });
  if (!(await box.isSelected())) await box.click();
  await browser.waitUntil(async () => await $('[data-testid="pref-restore-windows"]').isSelected(), {
    timeout: 10_000,
    timeoutMsg: 'the restore-windows preference never turned on',
  });
  // The mirror is an un-awaited invoke; the file is what the next launch reads.
  await browser.waitUntil(
    async () =>
      existsSync(STARTUP_FILE) &&
      JSON.parse(readFileSync(STARTUP_FILE, 'utf-8')).restoreWindowsOnLaunch === true,
    { timeout: 15_000, timeoutMsg: 'the preference never reached startup.json' },
  );
  await $('[data-testid="prefs-close"]').click();
}

describe('app exit and the launch that reads its record', () => {
  let tmp = '';
  let mainDoc = '';
  let secondDoc = '';
  let survivorDoc = '';

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'exit-session-'));
    mainDoc = resolve(tmp, 'main-window.pdf');
    secondDoc = resolve(tmp, 'second-window.pdf');
    survivorDoc = resolve(tmp, 'survivor.pdf');
    copyFileSync(BOOKMARKED_PDF, mainDoc);
    copyFileSync(SAMPLE_PDF, secondDoc);
    copyFileSync(SAMPLE_PDF, survivorDoc);
  });

  after(() => {
    // The preference is machine state, not workspace state: leaving it on would
    // make every later launch on this machine reopen whatever this spec was
    // holding. Written directly because the app that owns the setting is gone.
    try {
      const existing = existsSync(STARTUP_FILE)
        ? (JSON.parse(readFileSync(STARTUP_FILE, 'utf-8')) as Record<string, unknown>)
        : {};
      existing.restoreWindowsOnLaunch = false;
      writeFileSync(STARTUP_FILE, JSON.stringify(existing));
    } catch {
      /* a machine with no startup.json is a machine with the default already */
    }
    try {
      // Recursive: one case plants a DIRECTORY on this name to fail a write.
      if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE, { recursive: true, force: true });
    } catch {
      /* the next launch treats a missing record as a first run */
    }
    try {
      if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* the last launch still holds one of these open; the OS temp dir is its
         own cleanup story and a busy fixture must not fail the spec */
    }
  });

  it('two windows, each holding its own document', async () => {
    await waitForHarness();
    const handles = await browser.getWindowHandles();
    expect(handles).toHaveLength(1);
    expect(await labelOfCurrentWindow()).toBe('main');

    await openByPaths([mainDoc]);
    expect((await getState()).fileCount).toBe(1);

    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const both = await waitForHandles(2);
    const second = both.find((h) => h !== handles[0])!;
    await browser.switchToWindow(second);
    await waitForHarness(30_000);
    expect((await labelOfCurrentWindow()).startsWith('doc-')).toBe(true);
    await openByPaths([secondDoc]);
    expect((await getState()).fileCount).toBe(1);

    await browser.switchToWindow(handles[0]);
  });

  it('File ▸ Exit closes both of them and the app with them', async () => {
    // Neither window has unsaved work, so neither prompts and neither cancels.
    // The app going is the whole assertion available for `request_quit`'s
    // verdict from out here: a false answer unseals, shows the Exit-cancelled
    // notice and leaves both windows standing, so the process would still be
    // running when this gives up.
    expect(await invokeAppCommand('file.exit')).toBe(true);
    await waitForAppGone(
      'the app was still running after an Exit no window had reason to cancel — ' +
        'request_quit answered false, or a window never closed',
    );
  });

  it('and the record it left describes BOTH windows, with nothing staged beside it', async () => {
    const windows = readSession();
    expect(windows).toHaveLength(2);
    const main = windows.filter((w) => w.labelKind === 'main');
    const docs = windows.filter((w) => w.labelKind === 'doc');
    expect(main).toHaveLength(1);
    expect(docs).toHaveLength(1);
    // Each window's own documents, not one window's view of the app: a capture
    // taken after the first destruction would have lost whichever went first.
    expect(holds(main[0], mainDoc)).toBe(true);
    expect(holds(docs[0], secondDoc)).toBe(true);

    // A staged write lands by rename or takes its bytes with it. Nothing is
    // left beside the record either way.
    expect(stagingLeftovers()).toEqual([]);
  });

  it('a fresh launch, with restore turned on, holding one document in a second window', async () => {
    await browser.reloadSession();
    await waitForHarness(30_000);
    await enableRestoreWindows();

    const mainHandle = (await browser.getWindowHandles())[0];
    expect(await labelOfCurrentWindow()).toBe('main');

    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const both = await waitForHandles(2);
    const second = both.find((h) => h !== mainHandle)!;
    await browser.switchToWindow(second);
    await waitForHarness(30_000);
    await openByPaths([survivorDoc]);
    expect((await getState()).fileCount).toBe(1);

    // Close the MAIN window while the doc window stands. Its destruction writes
    // it out of the record, which is what leaves a session with no main-kind
    // window in it — the shape the launch has to handle.
    await browser.switchToWindow(mainHandle);
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(second);
    await waitForHandles(1);
  });

  it('quitting from that window records one window, and no main', async () => {
    expect(await invokeAppCommand('file.exit')).toBe(true);
    await waitForAppGone('the app was still running after the last window quit');

    const windows = readSession();
    expect(windows).toHaveLength(1);
    expect(windows[0].labelKind).toBe('doc');
    expect(holds(windows[0], survivorDoc)).toBe(true);
    expect(stagingLeftovers()).toEqual([]);
  });

  it('and the relaunch shows ONE window — the saved one, not an empty main beside it', async () => {
    await browser.reloadSession();
    await waitForHarness(30_000);

    // The saved record adopts the main slot rather than being rebuilt beside a
    // main window nobody saved.
    expect(await labelOfCurrentWindow()).toBe('main');
    await browser.waitUntil(async () => (await getState()).fileCount === 1, {
      timeout: 30_000,
      timeoutMsg: 'the restored launch never reopened the recorded document',
    });
    expect((await getState()).activeFile?.path.toLowerCase()).toBe(survivorDoc.toLowerCase());

    // The claim under test: one window, not two.
    expect(await browser.getWindowHandles()).toHaveLength(1);
  });

  // ── A quit snapshot that does not reach disk ─────────────────────────────
  //
  // The last window out captures the session on its way down, and the capture
  // is what the teardown is gated on. A write that failed leaves the PREVIOUS
  // run's record on the file and lifts the seal again, so destroying the window
  // then would exit having thrown this session away with nothing left standing
  // to capture it from.
  //
  // The failure is planted rather than stubbed: the record lands by renaming
  // its staged bytes over `session.json`, and a DIRECTORY sitting on that name
  // is a rename the OS refuses. The staging write itself still succeeds, which
  // is what makes this the outcome under test rather than an early error.

  /** Put a directory where the record goes. Non-empty, so no tidying pass can
   * turn it back into a name a rename could take. */
  function plantDirectoryOverRecord(): void {
    if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE, { recursive: true, force: true });
    mkdirSync(SESSION_FILE, { recursive: true });
    writeFileSync(resolve(SESSION_FILE, 'occupied.txt'), 'the record cannot land here');
    expect(statSync(SESSION_FILE).isDirectory()).toBe(true);
  }

  function clearPlantedDirectory(): void {
    if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE, { recursive: true, force: true });
  }

  it('the window × on the LAST window leaves it standing when the record cannot be written', async () => {
    plantDirectoryOverRecord();

    // Awaited, not fired and slept on: the command ANSWERING is what says the
    // close was refused. A close that went through would have destroyed this
    // window and taken the process with it, and there would be nothing left to
    // resolve the call.
    await browser.executeAsync<null, []>(function (done) {
      (window as any).__SPECTRA_TEST__.closeThisWindow()
        .then(() => done(null))
        .catch(() => done(null));
    });

    expect(appIsRunning()).toBe(true);
    expect(await browser.getWindowHandles()).toHaveLength(1);
    expect((await getState()).fileCount).toBe(1);

    // The staged bytes went with the failure: a write that could not land takes
    // its temp file away rather than leaving it beside the record.
    expect(stagingLeftovers()).toEqual([]);
  });

  it('File ▸ Exit says so rather than exiting on a record that never landed', async () => {
    // The same capture, reached through the quit. There is no peer to ask, so
    // the prepare round answers immediately and the capture is what fails —
    // and a quit that captured nothing must not close anything.
    expect(await invokeAppCommand('file.exit')).toBe(true);
    await waitForDisplayedSelector('[data-testid="confirm-message"]', {
      timeout: 30_000,
      timeoutMsg: 'the Exit reported nothing when its session snapshot could not be written',
    });
    expect(await $('[data-testid="confirm-message"]').getText()).toContain('nothing was closed');
    await $('[data-testid="notice-ok"]').click();
    await waitForDisplayedSelector('[data-testid="confirm-message"]', {
      timeout: 15_000,
      reverse: true,
    });

    expect(appIsRunning()).toBe(true);
    expect(await browser.getWindowHandles()).toHaveLength(1);
    expect(stagingLeftovers()).toEqual([]);
  });

  it('and the record starts landing again the moment it can', async () => {
    // The seal was lifted on each failure rather than held over a snapshot that
    // never reached disk, so nothing here has to be un-frozen: the ordinary
    // debounced write is what takes the file back.
    clearPlantedDirectory();

    const survivor = (await browser.getWindowHandles())[0];
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    const throwaway = handles.find((h) => h !== survivor)!;
    await browser.switchToWindow(throwaway);
    await waitForHarness(30_000);
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(survivor);
    await waitForHandles(1);

    await browser.waitUntil(
      () => existsSync(SESSION_FILE) && statSync(SESSION_FILE).isFile() && readSession().length > 0,
      { timeout: 20_000, interval: 250, timeoutMsg: 'session writes never resumed' },
    );
    expect(holds(readSession()[0], survivorDoc)).toBe(true);
  });
});
