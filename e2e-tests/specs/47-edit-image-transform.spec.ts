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
  editImageSelect,
  editImageTransformSettled,
  settledPlacement,
  waitForSettledMatrix,
} from '../support/harness.js';

// Image move/resize/rotate against the built binary. Arm Edit,
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

/** Wait for a SETTLED listing that has a placement, and return its page id. */
async function waitForSettledPageId(msg: string): Promise<string> {
  let id = '';
  await browser.waitUntil(
    async () => {
      const cur = await settledPlacement(0);
      if (!cur) return false;
      id = cur.pageId;
      return true;
    },
    { timeout: 30_000, interval: 250, timeoutMsg: msg },
  );
  return id;
}

describe('edit image transform', () => {
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
    let pageId = await waitForSettledPageId('edit placements never loaded');
    await waitForSettledMatrix([120, 0, 0, 90, 100, 100], 'the fixture CTM never listed');

    // MOVE: shift +100 x, +50 y (same size).
    await editImageSelect(pageId, 0);
    pageId = await editImageTransformSettled(
      0,
      [120, 0, 0, 90, 200, 150],
      'the move never applied',
    );

    // RESIZE (from the moved state): double the footprint about its origin.
    await editImageSelect(pageId, 0);
    await editImageTransformSettled(0, [240, 0, 0, 180, 200, 150], 'the resize never applied');

    // Undo the resize, then the move — back to the original CTM.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForSettledMatrix(
      [120, 0, 0, 90, 200, 150],
      'undo did not restore the pre-resize matrix',
    );
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForSettledMatrix(
      [120, 0, 0, 90, 100, 100],
      'undo did not restore the original matrix',
    );
  });

  it('rotates a placement (off-diagonal terms round-trip)', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    const pageId = await waitForSettledPageId('edit placements never loaded');
    await editImageSelect(pageId, 0);

    // A rotated/scaled target with non-zero b, c.
    const rotated = [0, 90, -120, 0, 220, 100];
    await editImageTransformSettled(0, rotated, 'the rotate never applied');
    expect(await invokeAppCommand('edit.undo')).toBe(true);
  });
});
