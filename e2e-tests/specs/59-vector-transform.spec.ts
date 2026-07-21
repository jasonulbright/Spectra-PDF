import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, rgb } from 'pdf-lib';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// Phase 9.D2 — move/resize/rotate a vector object. Driven via the harness
// transform bridge (a target placement M'); asserted via the generation-tagged
// reindex (a whole-file op rebuilds the page) + the re-listed userRect.

interface Vec {
  index: number;
  kind: string;
  userRect: [number, number, number, number];
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
async function transformVector(pageId: string, index: number, matrix: number[]): Promise<void> {
  await browser.execute<Promise<void>, [string, number, number[]]>(
    function (p, i, m) {
      return (window as any).__SPECTRA_TEST__.editVectorTransform(p, i, m);
    },
    pageId,
    index,
    matrix,
  );
}

async function waitForVectors(): Promise<string> {
  await browser.waitUntil(
    async () => {
      const ids = await vectorPageIds();
      return ids.length > 0 && (await vectors(ids[0])).length > 0;
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

describe('vector-object transform (Phase 9.D2)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-vectortx-'));
    pdfPath = resolve(tmp, 'vec-tx.pdf');
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    // A filled rect at device [40,40,140,100] (pdf-lib y-up: x40 y40 w100 h60).
    page.drawRectangle({ x: 40, y: 40, width: 100, height: 60, color: rgb(1, 0, 0) });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('moves a vector object; undo restores it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('vec-tx.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    const pageId = await waitForVectors();
    const vs = await vectors(pageId);
    expect(vs.length).toBe(1);
    const [x0, y0] = vs[0].userRect;
    expect(Math.round(x0)).toBe(40);
    expect(Math.round(y0)).toBe(40);

    // Move +50,+40: current bbox [40,40,140,100] → target M' = [100,0,0,60,90,80].
    await selectVector(pageId, 0);
    await transformVector(pageId, 0, [100, 0, 0, 60, 90, 80]);
    await waitForReindexed(
      pageId,
      (list) => list.length === 1 && Math.round(list[0].userRect[0]) === 90,
      'the vector never moved',
    );
    const moved = (await vectors((await vectorPageIds())[0]))[0].userRect;
    expect(Math.round(moved[0])).toBe(90);
    expect(Math.round(moved[1])).toBe(80);

    // Round-37 MED: the object stays SELECTED after the transform (the reselect
    // survives the page-id rebuild) — a chained move/delete needs no re-click.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => (window as any).__SPECTRA_TEST__.editVectorSelection() as unknown,
        )) !== null,
      { timeout: 10_000, timeoutMsg: 'selection was not restored after the transform' },
    );

    // Undo restores the original position.
    const preUndoId = (await vectorPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexed(
      preUndoId,
      (list) => list.length === 1 && Math.round(list[0].userRect[0]) === 40,
      'undo did not restore the vector position',
    );
  });
});
