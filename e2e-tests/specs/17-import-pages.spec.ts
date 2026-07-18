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
  closeAllFiles,
  commitPendingEdits,
  getWorkspacePageIds,
  importPagesIntoDoc,
  pressGlobalKey,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf'); // 5 pages

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(path: string) {
  return pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false })
    .promise;
}

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

describe('import pages into a document (2n.3)', () => {
  let tmp: string;
  let targetA: string;
  let targetC: string;
  let sourceB: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-import-'));
    targetA = resolve(tmp, 'target-a.pdf');
    targetC = resolve(tmp, 'target-c.pdf');
    sourceB = resolve(tmp, 'source-b.pdf');
    copyFileSync(SAMPLE_PDF, targetA);
    copyFileSync(SAMPLE_PDF, targetC);
    copyFileSync(SAMPLE_PDF, sourceB);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await waitForHarness();
    await closeAllFiles();
    await browser.waitUntil(async () => (await getState()).fileCount === 0, {
      timeout: 5_000,
      timeoutMsg: 'files never closed between cases',
    });
  });

  // Phase 5 (§ F): ids are OPAQUE — generation-tagged positional or
  // adopted-authored — so the spec never predicts an id string. Doc ids
  // come from the pages' ids only via the shared suffix rule (a page id is
  // `<docid-prefix>#p<n>` in the positional world), and page assertions
  // use IDENTITY (the ids read from state before the action) plus
  // provenance prefixes (tmp paths contain no '#', so prefix matching is
  // sound in this controlled fixture even though product code must never
  // do it).
  const docIdOf = (pageId: string): string => pageId.replace(/#p\d+$/, '#0');

  it('imports a source file byte-only (no strip), commits it into the target, and evicts the source', async () => {
    await openByPaths([targetA]);
    await setView('canvas');
    const aPages = await waitForWorkspacePages(5);
    expect((await getState()).fileCount).toBe(1);
    const docId = docIdOf(aPages[0]);

    // Insert source-b's 5 pages into target-a at index 2.
    await importPagesIntoDoc(sourceB, docId, 2);
    const merged = await waitForWorkspacePages(10);

    // The imported pages land at index 2 — and there is exactly ONE document
    // (10 pages total, not 15): the source got NO strip of its own. Page-tier
    // splices preserve PageRef IDENTITY, so target-a's pages are the exact
    // ids read before the import, in order, around the b-provenance block.
    expect(merged.slice(0, 2)).toEqual([aPages[0], aPages[1]]);
    expect(merged.slice(2, 7).every((id) => id.startsWith(sourceB))).toBe(true);
    expect(new Set(merged.slice(2, 7)).size).toBe(5);
    expect(merged.slice(7)).toEqual([aPages[2], aPages[3], aPages[4]]);
    // Source is registered byte-only (present in files, but no strip above).
    expect((await getState()).fileCount).toBe(2);

    // Commit bakes the imported pages into target-a's own file.
    await commitPendingEdits();
    const dest = resolve(tmp, 'merged.pdf');
    await saveActiveAs(dest);
    const pdf = await loadPdf(dest);
    expect(pdf.numPages).toBe(10);
    await pdf.loadingTask.destroy();

    // Post-commit reindex baked the pages in, so the byte-only source is
    // unreferenced and evicted — back to one file.
    await browser.waitUntil(async () => (await getState()).fileCount === 1, {
      timeout: 10_000,
      timeoutMsg: 'byte-only import source was not evicted after commit',
    });
  });

  it('import into a document is undoable (page tier)', async () => {
    await openByPaths([targetC]);
    await setView('canvas');
    const cPages = await waitForWorkspacePages(5);
    const docId = docIdOf(cPages[0]);

    await importPagesIntoDoc(sourceB, docId, 5); // append b's pages
    await waitForWorkspacePages(10);

    // Ctrl+Z drains the page tier first — the import reverts.
    await pressGlobalKey('z', { ctrl: true });
    await waitForWorkspacePages(5);
    expect((await getWorkspacePageIds()).every((id) => id.startsWith(targetC))).toBe(true);
  });
});
