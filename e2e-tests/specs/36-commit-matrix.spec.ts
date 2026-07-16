import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  focusTab,
  getState,
  getWorkspacePageIds,
  selectCanvasPages,
  rotateSelectedCanvasPages,
  setDocViewMode,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// § 6.6's commit-trigger matrix (recovered M4.3 scope), all four rows:
//   1. doc→doc tab switches do NOT commit (the tier is workspace-global);
//   2. LEAVING doc-tab-land (to Home/Tools) commits — panels and Home always
//      see materialized state;
//   3. a byte-READING surface gates the commit first (Properties, M5.5b);
//   4. File ▸ Save commits first, to the original path.

async function pendingBadgeVisible(): Promise<boolean> {
  return (await browser.execute(() =>
    document.querySelector('[data-testid="apply-page-edits-btn"]') !== null,
  )) as boolean;
}

async function anglesOf(path: string): Promise<number[]> {
  const doc = await PDFDocument.load(readFileSync(path));
  return Array.from({ length: doc.getPageCount() }, (_, i) => doc.getPage(i).getRotation().angle);
}

/** Rotate the LAST workspace page 90° as a pending page-tier edit. */
async function addPendingRotate(): Promise<void> {
  const ids = await getWorkspacePageIds();
  await selectCanvasPages([ids[ids.length - 1]]);
  await rotateSelectedCanvasPages(90);
  await browser.waitUntil(pendingBadgeVisible, {
    timeoutMsg: 'the rotate never registered as pending',
  });
}

describe('commit-trigger matrix (§ 6.6)', () => {
  let tmp: string;
  let fileA: string;
  let fileB: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ops-e2e-matrix-'));
    fileA = resolve(tmp, 'a.pdf');
    fileB = resolve(tmp, 'b.pdf');
    copyFileSync(SAMPLE_PDF, fileA);
    copyFileSync(SAMPLE_PDF, fileB);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('doc→doc tab switches do NOT commit a pending page edit', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([fileA, fileB]);
    await browser.waitUntil(async () => (await getState()).fileCount === 2);
    await setDocViewMode('organize');
    await browser.waitUntil(
      async () => (await getWorkspacePageIds()).length === 10,
      { timeout: 15_000, timeoutMsg: 'the workspace indexer never produced both files' },
    );

    await addPendingRotate(); // on B, the focused (last-opened) file
    const workingB = (await getState()).activeFile!.workingPath;

    // A doc→doc round trip: B → A → B. Never leaves doc-tab-land.
    await browser.keys(['Control', 'Shift', 'Tab']);
    await browser.waitUntil(async () => (await getState()).activeFile?.path === fileA);
    expect(await pendingBadgeVisible()).toBe(true);
    await browser.keys(['Control', 'Tab']);
    await browser.waitUntil(async () => (await getState()).activeFile?.path === fileB);
    expect(await pendingBadgeVisible()).toBe(true);
    // The bytes are untouched: every page still upright.
    expect((await anglesOf(workingB)).every((a) => a === 0)).toBe(true);
  });

  it('LEAVING doc-tab-land commits — Home and the panels see materialized state', async () => {
    const workingB = (await getState()).activeFile!.workingPath;
    await focusTab('home');
    await browser.waitUntil(
      async () => (await anglesOf(workingB)).filter((a) => a === 90).length === 1,
      { timeoutMsg: 'leaving doc land did not commit the pending rotate' },
    );
    await focusTab({ doc: fileB });
    await browser.waitUntil(async () => (await getState()).view === 'canvas');
    expect(await pendingBadgeVisible()).toBe(false);
  });

  it('a byte-READING surface gates the commit first (Properties, the M5.5b rule)', async () => {
    await addPendingRotate(); // same page again: pending 90 on top of 90
    await browser.keys(['Control', 'd']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed();
    await browser.waitUntil(async () => !(await pendingBadgeVisible()), {
      timeoutMsg: 'Properties did not gate the pending edit',
    });
    await browser.keys(['Escape']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed({ reverse: true });

    const workingB = (await getState()).activeFile!.workingPath;
    expect((await anglesOf(workingB)).filter((a) => a === 180).length).toBe(1);
  });

  it('File ▸ Save commits first and lands the edit at the ORIGINAL path', async () => {
    await addPendingRotate(); // pending 90 on top of the committed 180
    await browser.keys(['Control', 's']);
    await browser.waitUntil(async () => !(await pendingBadgeVisible()), {
      timeoutMsg: 'Save did not commit the pending edit',
    });
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === false, {
      timeoutMsg: 'Save never cleared the dirty flag',
    });
    expect((await anglesOf(fileB)).filter((a) => a === 270).length).toBe(1);
  });
});
