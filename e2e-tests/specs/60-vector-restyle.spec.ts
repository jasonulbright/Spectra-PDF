import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, rgb } from 'pdf-lib';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// Phase 9.D3 — recolour / re-width a vector object. Driven via the harness
// restyle bridge; asserted via the generation-tagged reindex + the re-listed
// fill/stroke/lineWidth.

interface Vec {
  index: number;
  kind: string;
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
  lineWidth: number;
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
async function restyleVector(
  pageId: string,
  index: number,
  opts: { fill?: [number, number, number]; stroke?: [number, number, number]; lineWidth?: number },
): Promise<void> {
  await browser.execute<Promise<void>, [string, number, typeof opts]>(
    function (p, i, o) {
      return (window as any).__SPECTRA_TEST__.editVectorRestyle(p, i, o);
    },
    pageId,
    index,
    opts,
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

describe('vector-object restyle (Phase 9.D3)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-vecrestyle-'));
    pdfPath = resolve(tmp, 'vec-restyle.pdf');
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    // A red-filled rect + a blue-stroked line (the two restyle targets).
    page.drawRectangle({ x: 40, y: 40, width: 100, height: 60, color: rgb(1, 0, 0) });
    page.drawLine({ start: { x: 200, y: 200 }, end: { x: 300, y: 250 }, color: rgb(0, 0, 1) });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('recolours a fill; undo restores it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('vec-restyle.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    const pageId = await waitForVectors();
    const vs = await vectors(pageId);
    const fillIdx = vs.findIndex((v) => v.kind === 'fill');
    expect(fillIdx).toBeGreaterThanOrEqual(0);
    expect(vs[fillIdx].fill).toEqual([1, 0, 0]); // pristine red

    // Recolour the fill to green.
    await restyleVector(pageId, fillIdx, { fill: [0, 1, 0] });
    await waitForReindexed(
      pageId,
      (list) => list.some((v) => v.kind === 'fill' && v.fill?.[1] === 1 && v.fill?.[0] === 0),
      'the fill never recoloured green',
    );

    // Undo restores the red fill.
    const preUndoId = (await vectorPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexed(
      preUndoId,
      (list) => list.some((v) => v.kind === 'fill' && v.fill?.[0] === 1 && v.fill?.[1] === 0),
      'undo did not restore the red fill',
    );
  });
});
