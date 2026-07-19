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
  editImageAdd,
} from '../support/harness.js';

// Phase 9.C2 — Add Image against the built binary. Arm Edit, then embed a new
// raster at a user-space box via the REAL commit (the native file picker is
// undrivable — the harness injects the source). The new placement appears at
// the box, coexisting with the existing image; undo removes it. The engine
// embed is unit-tested (pytest); this proves the end-to-end wire.
//
// A whole-file engine op rebuilds the page (positional ids regenerate), so —
// like 47 — re-fetch editImagePageIds()[0] after the commit.

const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function matrixClose(a: number[] | undefined, b: number[], eps = 0.5): boolean {
  return !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

async function currentPlacements(): Promise<{ index: number; matrix: number[] }[]> {
  const ids = await editImagePageIds();
  if (ids.length === 0) return [];
  return editImagePlacements(ids[0]);
}

describe('add image (Phase 9.C2)', () => {
  let tmp: string;
  let pdfPath: string;
  let rawPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-addimg-'));
    pdfPath = resolve(tmp, 'with-image.pdf');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(RED_DOT_PNG);
    const page = doc.addPage([400, 300]);
    page.drawImage(png, { x: 50, y: 50, width: 100, height: 80 }); // existing placement
    writeFileSync(pdfPath, await doc.save());
    rawPath = resolve(tmp, 'green.raw');
    writeFileSync(rawPath, Buffer.from([0, 200, 0, 0, 200, 0, 0, 200, 0, 0, 200, 0])); // 2x2 RGB
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('embeds a new image at the box, coexisting with the existing one; undo removes it', async function () {
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
    expect((await currentPlacements()).length).toBe(1); // the existing image

    // Embed a new image at user rect [200,150,320,240] → cm [120,0,0,90,200,150].
    await editImageAdd(1, [200, 150, 320, 240], {
      raw_path: rawPath,
      width: 2,
      height: 2,
      channels: 3,
    });

    await browser.waitUntil(
      async () => {
        const p = await currentPlacements();
        return (
          p.length === 2 &&
          p.some((pl) => matrixClose(pl.matrix, [120, 0, 0, 90, 200, 150])) &&
          p.some((pl) => matrixClose(pl.matrix, [100, 0, 0, 80, 50, 50])) // original survives
        );
      },
      { timeout: 30_000, timeoutMsg: 'the added image never appeared at the box' },
    );

    // Undo drops the added image, leaving the original.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const p = await currentPlacements();
        return p.length === 1 && matrixClose(p[0]?.matrix, [100, 0, 0, 80, 50, 50]);
      },
      { timeout: 30_000, timeoutMsg: 'undo did not remove the added image' },
    );
  });
});
