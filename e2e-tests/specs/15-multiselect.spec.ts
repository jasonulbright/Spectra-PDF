import { resolve } from 'node:path';
import { readFileSync, copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  saveActiveAs,
  commitPendingEdits,
  closeAllFiles,
  getWorkspacePageIds,
  selectCanvasPages,
  getSelectedCanvasPageIds,
  deleteSelectedCanvasPages,
  rotateSelectedCanvasPages,
  pressGlobalKey,
} from '../support/harness.js';

// sample.pdf is a 5-page PDF (empty content streams — page COUNT is all this
// slice needs; multi-select operates on pages, not their content).
const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(path: string) {
  return pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false })
    .promise;
}

// The workspace indexer runs async after OPEN_FILE — poll until the canvas has
// produced the expected number of page ids.
async function waitForWorkspacePages(expected: number): Promise<string[]> {
  let ids: string[] = [];
  await browser.waitUntil(
    async () => {
      ids = await getWorkspacePageIds();
      return ids.length === expected;
    },
    { timeout: 10_000, timeoutMsg: `workspace never reached ${expected} pages` },
  );
  return ids;
}

describe('multi-select page ops (2n.1)', () => {
  let tmp: string;
  let sampleA: string;
  let sampleB: string;
  let sampleC: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-multisel-'));
    sampleA = resolve(tmp, 'sample-a.pdf');
    sampleB = resolve(tmp, 'sample-b.pdf');
    sampleC = resolve(tmp, 'sample-c.pdf');
    copyFileSync(SAMPLE_PDF, sampleA);
    copyFileSync(SAMPLE_PDF, sampleB);
    copyFileSync(SAMPLE_PDF, sampleC);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  // Multi-select is workspace-wide (select-all spans every open file), so each
  // case must start from a clean workspace — otherwise a prior test's leftover
  // file would inflate the page counts and cross-contaminate the selection.
  beforeEach(async () => {
    await waitForHarness();
    await closeAllFiles();
    await browser.waitUntil(async () => (await getState()).fileCount === 0, {
      timeout: 5_000,
      timeoutMsg: 'files never closed between cases',
    });
  });

  it('deletes exactly the selected pages as one batch and persists via commit', async () => {
    await openByPaths([sampleA]);
    await setView('canvas');

    const before = await getState();
    const total = before.activeFile!.pageCount;
    expect(total).toBe(5);
    const ids = await waitForWorkspacePages(total);

    // Select the first two pages (a subset — must not empty the file).
    await selectCanvasPages([ids[0], ids[1]]);
    await browser.waitUntil(
      async () => (await getSelectedCanvasPageIds()).length === 2,
      { timeout: 5_000, timeoutMsg: 'selection never reached 2 pages' },
    );

    await deleteSelectedCanvasPages();
    // The two selected pages are gone from the workspace immediately (page tier).
    await waitForWorkspacePages(total - 2);

    await commitPendingEdits();
    const dest = resolve(tmp, 'deleted.pdf');
    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    const pdf = await loadPdf(dest);
    expect(pdf.numPages).toBe(total - 2); // 3 pages survived
    await pdf.loadingTask.destroy();

    const after = await getState();
    expect(after.activeFile!.pageCount).toBe(total - 2);
  });

  it('Ctrl+A selects every page via the real keyboard handler, and Delete is refused when it would empty the file', async () => {
    await openByPaths([sampleB]);
    await setView('canvas');
    const total = (await getState()).activeFile!.pageCount;
    await waitForWorkspacePages(total);

    // Real global keydown → the WorkspaceCanvasView Ctrl+A handler.
    await pressGlobalKey('a', { ctrl: true });
    await browser.waitUntil(
      async () => (await getSelectedCanvasPageIds()).length === total,
      { timeout: 5_000, timeoutMsg: 'Ctrl+A never selected all pages' },
    );

    // Deleting the whole selection would empty the file — the reducer rejects
    // atomically, so every page survives.
    await pressGlobalKey('Delete');
    // Give the (rejected) dispatch a tick, then confirm nothing was removed.
    await browser.pause(200);
    const stillThere = await getWorkspacePageIds();
    expect(stillThere.length).toBe(total);
    expect((await getState()).activeFile!.pageCount).toBe(total);
  });

  it('rotates the selected pages as one batch and bakes /Rotate into the saved file', async () => {
    await openByPaths([sampleC]);
    await setView('canvas');
    const total = (await getState()).activeFile!.pageCount;
    const ids = await waitForWorkspacePages(total);

    // Rotate only the first two pages 90° clockwise.
    await selectCanvasPages([ids[0], ids[1]]);
    await browser.waitUntil(
      async () => (await getSelectedCanvasPageIds()).length === 2,
      { timeout: 5_000, timeoutMsg: 'selection never reached 2 pages' },
    );
    await rotateSelectedCanvasPages(90);

    await commitPendingEdits();
    const dest = resolve(tmp, 'rotated.pdf');
    await saveActiveAs(dest);

    const pdf = await loadPdf(dest);
    const p1 = await pdf.getPage(1);
    const p2 = await pdf.getPage(2);
    const p3 = await pdf.getPage(3);
    expect(p1.rotate).toBe(90);
    expect(p2.rotate).toBe(90);
    expect(p3.rotate).toBe(0); // untouched
    await pdf.loadingTask.destroy();
  });
});
