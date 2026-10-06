import { expect } from '@wdio/globals';
import { resolve } from 'node:path';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getState, invokeAppCommand, openByPaths, waitForHarness } from '../support/harness.js';
import { engineProcesses, onlyEngineProcess, processAlive } from '../support/engine-processes.js';

/**
 * Each window's engine processes, identified by role.
 *
 * A window has one window process for its short calls and, from its first
 * long call, one job process. Every engine spawn appends
 * `--spectra-role=<role> --spectra-window=<label>`, so the spec reads the
 * processes from the operating system's process table and selects them by
 * those arguments, never by the script path the health worker shares. The
 * long call here is one print preview of a one-page document, so no job
 * outlives the spec. Closing a window stops both of its processes.
 */

const ONE_PAGE = resolve(__dirname, '..', 'fixtures', 'nested-vector.pdf');
const OTHER_ONE_PAGE = resolve(__dirname, '..', 'fixtures', 'inline-image.pdf');

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

/** One print preview of the active document, then the cleanup of its folder:
 * two calls of the job process. */
async function printPreviewActive(id: number): Promise<void> {
  const working = (await getState()).activeFile!.workingPath;
  const result = await browser.executeAsync<{ dir?: string; error?: string }, [string, number]>(
    function (file, requestId, done) {
      const w = window as any;
      w.__TAURI_INTERNALS__
        .invoke('get_gs_path')
        .then((gs: string) =>
          w.__SPECTRA_TEST__.engineRequestWithId(
            'print_preview',
            { file, gs_path: gs, sheet_width: 612, sheet_height: 792, dpi: 72, max_pages: 1 },
            requestId,
          ),
        )
        .then((r: { preview_dir: string }) =>
          w.__SPECTRA_TEST__
            .engineRequestWithId('print_preview_cleanup', { directory: r.preview_dir }, requestId + 1)
            .then(() => done({ dir: r.preview_dir })),
        )
        .catch((e: unknown) => done({ error: String(e) }));
    },
    working,
    id,
  );
  expect(result.error).toBeUndefined();
  expect(result.dir).toBeTruthy();
}

describe('engine processes by role', () => {
  let mainHandle = '';
  let mainWindow = 0;
  let mainJob = 0;
  let secondLabel = '';
  let secondWindow = 0;
  let secondJob = 0;

  it('a window has one window process and, after a print preview, one job process', async () => {
    await waitForHarness();
    mainHandle = (await browser.getWindowHandles())[0];
    expect(await labelOfCurrentWindow()).toBe('main');
    const dir = mkdtempSync(resolve(tmpdir(), 'engine-processes-'));
    const doc = resolve(dir, 'one-page.pdf');
    copyFileSync(ONE_PAGE, doc);
    await openByPaths([doc]);
    expect((await getState()).fileCount).toBe(1);

    await printPreviewActive(9001);
    const processes = engineProcesses();
    mainWindow = onlyEngineProcess('window', 'main', processes);
    mainJob = onlyEngineProcess('job', 'main', processes);
    expect(mainJob).not.toBe(mainWindow);
    // The health worker is not one of the window's processes, whether or not
    // document health has started it.
    expect(processes.filter((p) => p.role === 'health').every((p) => p.window === null)).toBe(true);
  });

  it('a second window gets its own window and job processes', async () => {
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    const second = handles.find((h) => h !== mainHandle)!;
    await browser.switchToWindow(second);
    await waitForHarness(30_000);
    secondLabel = await labelOfCurrentWindow();
    expect(secondLabel.startsWith('doc-')).toBe(true);
    const dir = mkdtempSync(resolve(tmpdir(), 'engine-processes-second-'));
    const doc = resolve(dir, 'other.pdf');
    copyFileSync(OTHER_ONE_PAGE, doc);
    await openByPaths([doc]);
    expect((await getState()).fileCount).toBe(1);

    await printPreviewActive(9001);
    const processes = engineProcesses();
    secondWindow = onlyEngineProcess('window', secondLabel, processes);
    secondJob = onlyEngineProcess('job', secondLabel, processes);
    expect(new Set([mainWindow, mainJob, secondWindow, secondJob]).size).toBe(4);
    expect(onlyEngineProcess('job', 'main', processes)).toBe(mainJob);
  });

  it('closing the second window stops both of its processes and leaves the first window\'s', async () => {
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
    await waitForHandles(1);
    await browser.waitUntil(async () => !processAlive(secondWindow) && !processAlive(secondJob), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `a closed window's engine process is still running (${secondWindow}, ${secondJob})`,
    });
    expect(engineProcesses().filter((p) => p.window === secondLabel)).toEqual([]);
    expect(processAlive(mainWindow)).toBe(true);
    expect(processAlive(mainJob)).toBe(true);
    expect(await labelOfCurrentWindow()).toBe('main');
  });
});
