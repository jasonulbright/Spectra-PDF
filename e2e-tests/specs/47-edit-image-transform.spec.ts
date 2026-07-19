import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  editImagePageIds,
  editImagePlacements,
  editImageSelect,
  editImageTransform,
} from '../support/harness.js';

// Phase 9.C1 — image move/resize/rotate against the built binary. Arm Edit,
// select the image, and drive the REAL transform commit (the on-canvas drag
// handles live in transformed space — undrivable by WebDriver, the new-field
// precedent). The re-listed placement matrix must equal the target M'; undo
// restores it. The engine transform + the gesture math are unit-tested
// (pytest / vitest); this proves the end-to-end wire.
//
// NOTE: a whole-file engine op REBUILDS the page (positional ids regenerate —
// the non-authored-rebuild rule), so the page id changes on every commit. Like
// 41-edit-images, re-fetch `editImagePageIds()[0]` after each commit rather
// than reusing a captured id.

const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function matrixClose(a: number[] | undefined, b: number[], eps = 0.5): boolean {
  return !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

/** The current (post-rebuild) first page's sole placement matrix, or []. */
async function currentMatrix(): Promise<number[]> {
  const ids = await editImagePageIds();
  if (ids.length === 0) return [];
  return (await editImagePlacements(ids[0]))[0]?.matrix ?? [];
}

/** Wait until the first page has exactly one placement at `target`, then return
 * its (fresh) page id — the anchor for the next select+transform. */
async function waitForMatrix(target: number[], msg: string): Promise<string> {
  await browser.waitUntil(async () => matrixClose(await currentMatrix(), target), {
    timeout: 30_000,
    timeoutMsg: msg,
  });
  return (await editImagePageIds())[0];
}

describe('edit image transform (Phase 9.C1)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-imgtx-'));
    pdfPath = resolve(tmp, 'with-image.pdf');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(RED_DOT_PNG);
    const page = doc.addPage([400, 300]);
    // drawImage emits `120 0 0 90 100 100 cm /Img Do` — a known placement CTM.
    page.drawImage(png, { x: 100, y: 100, width: 120, height: 90 });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('moves then resizes a placement via the real commit, and undo restores it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('with-image.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    let pageId = (await editImagePageIds())[0];
    expect(matrixClose(await currentMatrix(), [120, 0, 0, 90, 100, 100])).toBe(true);

    // MOVE: shift +100 x, +50 y (same size).
    await editImageSelect(pageId, 0);
    await editImageTransform(pageId, 0, [120, 0, 0, 90, 200, 150]);
    pageId = await waitForMatrix([120, 0, 0, 90, 200, 150], 'the move never applied');

    // RESIZE (from the moved state): double the footprint about its origin.
    await editImageSelect(pageId, 0);
    await editImageTransform(pageId, 0, [240, 0, 0, 180, 200, 150]);
    await waitForMatrix([240, 0, 0, 180, 200, 150], 'the resize never applied');

    // Undo the resize, then the move — back to the original CTM.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForMatrix([120, 0, 0, 90, 200, 150], 'undo did not restore the pre-resize matrix');
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForMatrix([120, 0, 0, 90, 100, 100], 'undo did not restore the original matrix');
  });

  it('rotates a placement (off-diagonal terms round-trip)', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const pageId = (await editImagePageIds())[0];
    await editImageSelect(pageId, 0);

    // A rotated/scaled target with non-zero b, c.
    const rotated = [0, 90, -120, 0, 220, 100];
    await editImageTransform(pageId, 0, rotated);
    await waitForMatrix(rotated, 'the rotate never applied');
    expect(await invokeAppCommand('edit.undo')).toBe(true);
  });
});
