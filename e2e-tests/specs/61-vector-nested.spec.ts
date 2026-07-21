import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// Phase 9.D4 — form-nested vector paths. The committed fixture has a
// page-level fill + a fill INSIDE a Form XObject; the nested one lists with
// `nested: true` and is deletable (the engine edits a COPY of the form). A
// pikepdf-authored fixture (pdf-lib can't author form XObjects).

interface Vec {
  index: number;
  kind: string;
  nested: boolean;
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

describe('form-nested vector paths (Phase 9.D4)', () => {
  const pdfPath = resolve(process.cwd(), 'fixtures', 'nested-vector.pdf');

  it('lists a nested path and deletes it (form copy-on-edit); undo restores', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('nested-vector.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    const pageId = await waitForVectors();
    const vs = await vectors(pageId);
    expect(vs.length).toBe(2);
    const nestedIdx = vs.findIndex((v) => v.nested);
    expect(nestedIdx).toBeGreaterThanOrEqual(0); // the form-nested path is listed

    // Delete the nested path — routed through the engine's form copy-on-edit.
    await selectVector(pageId, nestedIdx);
    await deleteSelectedVector();
    await waitForReindexed(
      pageId,
      (list) => list.length === 1 && !list.some((v) => v.nested),
      'the nested path never deleted',
    );

    // Undo restores both (nested returns).
    const preUndoId = (await vectorPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexed(
      preUndoId,
      (list) => list.length === 2 && list.some((v) => v.nested),
      'undo did not restore the nested path',
    );
  });
});
