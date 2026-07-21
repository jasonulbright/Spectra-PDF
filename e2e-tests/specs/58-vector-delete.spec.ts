import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, rgb } from 'pdf-lib';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// Phase 9.D1 — vector-object addressability: list the drawn path objects on a
// page, select one, delete it (undoable). Asserted via the harness vector
// bridge + the generation-tagged reindex (a whole-file op rebuilds the page,
// so waits key on the edit-vector page id advancing past the pre-op id).

interface Vec {
  index: number;
  kind: 'fill' | 'stroke' | 'fillstroke';
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
}

async function vectorPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editVectorPageIds();
  });
}

async function vectors(pageId: string): Promise<Vec[]> {
  return await browser.execute<Vec[], [string]>(function (p) {
    return (window as any).__SPECTRA_TEST__.editVectors(p);
  }, pageId);
}

async function selectVector(pageId: string, index: number): Promise<void> {
  await browser.execute<void, [string, number]>(
    function (p, i) {
      (window as any).__SPECTRA_TEST__.editVectorSelect(p, i);
    },
    pageId,
    index,
  );
}

async function deleteSelectedVector(): Promise<void> {
  await browser.execute<Promise<void>, []>(function () {
    return (window as any).__SPECTRA_TEST__.editVectorDelete();
  });
}

async function waitForVectors(): Promise<string> {
  await browser.waitUntil(
    async () => {
      const ids = await vectorPageIds();
      if (ids.length === 0) return false;
      return (await vectors(ids[0])).length > 0;
    },
    { timeout: 30_000, timeoutMsg: 'vectors never loaded' },
  );
  return (await vectorPageIds())[0];
}

async function waitForReindexed(
  preOpId: string,
  test: (vs: Vec[]) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const ids = await vectorPageIds();
      if (ids.length === 0 || ids[0] === preOpId) return false;
      return test(await vectors(ids[0]));
    },
    { timeout: 30_000, timeoutMsg },
  );
}

describe('vector-object delete (Phase 9.D1)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-vector-'));
    pdfPath = resolve(tmp, 'vectors.pdf');
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    // Two filled rectangles → two vector objects (deterministic; no border).
    page.drawRectangle({ x: 40, y: 40, width: 100, height: 60, color: rgb(1, 0, 0) });
    page.drawRectangle({ x: 240, y: 180, width: 80, height: 80, color: rgb(0, 0, 1) });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists vector objects, deletes one, and undo restores it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('vectors.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    const pageId = await waitForVectors();
    const vs = await vectors(pageId);
    expect(vs.length).toBe(2); // the two filled rects
    expect(vs.every((v) => v.kind === 'fill')).toBe(true);

    // Select the first object and delete it.
    await selectVector(pageId, 0);
    expect((await browser.execute(() => (window as any).__SPECTRA_TEST__.editVectorSelection())) as {
      index: number;
    } | null).toEqual({ pageId, index: 0 });
    await deleteSelectedVector();

    // The reindexed page lists ONE vector now.
    await waitForReindexed(pageId, (list) => list.length === 1, 'delete did not drop a vector');

    // Undo restores both.
    const preUndoId = (await vectorPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexed(preUndoId, (list) => list.length === 2, 'undo did not restore the vector');
  });
});
