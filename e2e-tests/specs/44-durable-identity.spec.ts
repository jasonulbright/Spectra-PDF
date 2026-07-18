import { resolve } from 'node:path';
import { copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  setView,
  closeAllFiles,
  commitPendingEdits,
  getWorkspacePageIds,
  invokeAppCommand,
} from '../support/harness.js';

// Phase 5 (§ F) — durable identity across the AUTHORED rebuild, observed
// against the real binary: a canvas selection spanning two files survives
// the atomic page-tier commit (the reindex ADOPTS the commit's published
// ids), and a file-level undo — a NON-authored restore — prunes exactly
// that file's ids while the other file's selection lives on.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function selectCanvasPages(ids: string[]): Promise<void> {
  await browser.execute<void, [string[]]>(function (pageIds) {
    (window as any).__SPECTRA_TEST__.selectCanvasPages(pageIds);
  }, ids);
}

async function getSelectedCanvasPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.getSelectedCanvasPageIds();
  });
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

async function rotateSelectedCanvasPages(delta: 90 | 270): Promise<void> {
  await browser.execute<void, [90 | 270]>(function (d) {
    (window as any).__SPECTRA_TEST__.rotateSelectedCanvasPages(d);
  }, delta);
}

describe('durable identity (Phase 5 § F)', () => {
  let tmp: string;
  let fileA: string;
  let fileB: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-identity-'));
    fileA = resolve(tmp, 'ident-a.pdf');
    fileB = resolve(tmp, 'ident-b.pdf');
    copyFileSync(SAMPLE_PDF, fileA);
    copyFileSync(SAMPLE_PDF, fileB);
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

  it('a cross-file selection survives the authored commit; undo (non-authored) prunes only its file', async function () {
    this.timeout(120_000);
    await openByPaths([fileA, fileB]);
    await setView('canvas');
    const all = await waitForWorkspacePages(10);
    const aIds = all.filter((id) => id.startsWith(fileA));
    const bIds = all.filter((id) => id.startsWith(fileB));
    expect(aIds.length).toBe(5);
    expect(bIds.length).toBe(5);

    // Select one page in each file, dirty both via a page-tier rotate,
    // then commit — ONE atomic authored rebuild of both files.
    const picked = [aIds[1], bIds[0]];
    await selectCanvasPages(picked);
    expect(await getSelectedCanvasPageIds()).toEqual(expect.arrayContaining(picked));
    await rotateSelectedCanvasPages(90);
    await commitPendingEdits();

    // Adoption: the SAME ids survive the rebuild — in the workspace
    // listing AND in the live selection (the § F payoff, end to end).
    await browser.waitUntil(
      async () => {
        const ids = await getWorkspacePageIds();
        return picked.every((id) => ids.includes(id));
      },
      { timeout: 15_000, timeoutMsg: 'adopted ids never appeared in the reindexed workspace' },
    );
    expect(await getSelectedCanvasPageIds()).toEqual(expect.arrayContaining(picked));

    // File-level undo restores fileA's pre-commit bytes — a NON-authored
    // rebuild. Its reindex mints a fresh generation: fileA's selected id
    // dies, fileB's selection is untouched (per-path § F pruning).
    const active = (await getState()).activeFile?.path ?? '';
    const undonePath = active.includes('ident-a') ? fileA : fileB;
    const survivor = undonePath === fileA ? bIds[0] : aIds[1];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const sel = await getSelectedCanvasPageIds();
        return sel.length === 1 && sel[0] === survivor;
      },
      {
        timeout: 15_000,
        timeoutMsg: 'undo did not prune exactly the restored file\'s selection',
      },
    );
    // And the undone file's pages all carry fresh-generation ids now.
    const after = await getWorkspacePageIds();
    const undoneIds = after.filter((id) => id.startsWith(undonePath));
    expect(undoneIds.length).toBe(5);
    expect(undoneIds.every((id) => id.includes('#g'))).toBe(true);
  });
});
