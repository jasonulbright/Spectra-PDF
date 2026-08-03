import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName } from 'pdf-lib';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// The vector bridge is driven directly off the window harness (the 58–61
// idiom — there are no named exports for this family).
async function editVectorPageIds(): Promise<string[]> {
  return await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.editVectorPageIds();
  });
}

async function editVectors(
  pageId: string,
): Promise<{ index: number; kind: string; userRect: [number, number, number, number] }[]> {
  return await browser.execute(function (p) {
    return (window as any).__SPECTRA_TEST__.editVectors(p);
  }, pageId);
}

async function editVectorSelect(pageId: string, index: number): Promise<void> {
  await browser.execute(
    function (p, i) {
      (window as any).__SPECTRA_TEST__.editVectorSelect(p, i);
    },
    pageId,
    index,
  );
}

async function editVectorTransform(
  pageId: string,
  index: number,
  matrix: number[],
): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, number, number[]]>(
    function (p, i, m, done) {
      (window as any).__SPECTRA_TEST__.editVectorTransform(p, i, m)
        .then(() => done(null))
        .catch((err: unknown) => done(('__SPECTRA_E2E_ERROR__:' + String(err)) as any));
    },
    pageId,
    index,
    matrix,
  );
  if (typeof result === 'string') {
    throw new Error(`editVectorTransform failed: ${result.replace('__SPECTRA_E2E_ERROR__:', '')}`);
  }
}

async function editVectorDelete(): Promise<void> {
  const result = await browser.executeAsync<string | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__.editVectorDelete()
      .then(() => done(null))
      .catch((err: unknown) => done(('__SPECTRA_E2E_ERROR__:' + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`editVectorDelete failed: ${result.replace('__SPECTRA_E2E_ERROR__:', '')}`);
  }
}

// P8 slice D — `sh` shadings are OBJECTS against the built binary. The
// gradient-fill idiom (`q <clip> W n /Sh0 sh Q`) lists as kind "shading"
// with the CLIP's rect, transforms as one unit (clip + shading move
// together), and deletes whole. The fixture builds the idiom with pdf-lib's
// low-level context (drawRectangle can't emit `sh`).
//
// Page ids regenerate on every whole-file commit — re-fetch after each.

async function shadingFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const ctx = doc.context;
  const fn = ctx.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0],
    C1: [1],
    N: 1,
  });
  const shading = ctx.obj({
    ShadingType: 2,
    ColorSpace: PDFName.of('DeviceGray'),
    Coords: [0, 0, 1, 0],
    Function: fn,
    Extend: [true, true],
  });
  page.node.set(
    PDFName.of('Resources'),
    ctx.obj({ Shading: ctx.obj({ Sh0: shading }) }),
  );
  const stream = ctx.stream('q 100 100 200 100 re W n /Sh0 sh Q\n1 0 0 rg 300 250 40 30 re f');
  page.node.set(PDFName.of('Contents'), ctx.register(stream));
  writeFileSync(path, await doc.save());
}

describe('shading objects (P8)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-shading-'));
    pdfPath = resolve(tmp, 'gradient.pdf');
    await shadingFixture(pdfPath);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists the gradient as kind shading, moves clip+shading as one, deletes whole', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('gradient.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await editVectorPageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'vector listings never loaded',
    });
    let pageId = (await editVectorPageIds())[0];
    let vs = await editVectors(pageId);
    expect(vs.map((v) => v.kind)).toEqual(['shading', 'fill']);
    // The shading's rect IS the clip box.
    expect(vs[0].userRect.map(Math.round)).toEqual([100, 100, 300, 200]);

    // TRANSFORM the shading: clip and gradient move together — the fresh
    // listing's rect lands on the target box.
    await editVectorSelect(pageId, 0);
    await editVectorTransform(pageId, 0, [100, 0, 0, 50, 250, 30]);
    await browser.waitUntil(
      async () => {
        const ids = await editVectorPageIds();
        if (ids.length === 0 || ids[0] === pageId) return false;
        const now = await editVectors(ids[0]);
        return (
          now.length === 2 &&
          now[0].kind === 'shading' &&
          Math.abs(now[0].userRect[0] - 250) < 0.5 &&
          Math.abs(now[0].userRect[3] - 80) < 0.5
        );
      },
      { timeout: 30_000, timeoutMsg: 'the shading transform never applied' },
    );

    // DELETE it whole; the red rect survives; undo restores.
    pageId = (await editVectorPageIds())[0];
    await editVectorSelect(pageId, 0);
    await editVectorDelete();
    await browser.waitUntil(
      async () => {
        const ids = await editVectorPageIds();
        if (ids.length === 0 || ids[0] === pageId) return false;
        const now = await editVectors(ids[0]);
        return now.length === 1 && now[0].kind === 'fill';
      },
      { timeout: 30_000, timeoutMsg: 'the shading delete never applied' },
    );
    const preUndoId = (await editVectorPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editVectorPageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = await editVectors(ids[0]);
        return now.length === 2 && now[0].kind === 'shading';
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the shading' },
    );
  });
});
