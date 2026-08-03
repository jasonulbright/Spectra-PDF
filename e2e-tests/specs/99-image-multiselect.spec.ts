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
  editImageSelection,
  editImageTransformMany,
  editImageDeleteSelected,
} from '../support/harness.js';

// P7 multi-select — group transform and group delete against the built
// binary. Two placements are additively selected and moved by ONE multi
// engine op; a SINGLE undo restores both (the whole point: one gesture,
// one undo entry). Then both are deleted in one op and a single undo
// resurrects both. The on-canvas group frame lives in transformed space
// (undrivable — the spec-47 precedent); the harness drives the same
// commit path the frame's pointerup takes.
//
// Page ids regenerate on every whole-file commit (the non-authored-rebuild
// rule) — always re-fetch editImagePageIds()[0] after a commit.

const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function matrixClose(a: number[] | undefined, b: number[], eps = 0.5): boolean {
  return !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

/** The current first page's placement matrices in index order (post-rebuild). */
async function currentMatrices(): Promise<number[][]> {
  const ids = await editImagePageIds();
  if (ids.length === 0) return [];
  const placements = await editImagePlacements(ids[0]);
  return placements.map((p) => p.matrix);
}

async function waitForMatrices(targets: number[][], msg: string): Promise<string> {
  await browser.waitUntil(
    async () => {
      const ms = await currentMatrices();
      return (
        ms.length === targets.length && targets.every((t, i) => matrixClose(ms[i], t))
      );
    },
    { timeout: 30_000, timeoutMsg: msg },
  );
  return (await editImagePageIds())[0];
}

describe('image multi-select (P7)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-imgmulti-'));
    pdfPath = resolve(tmp, 'two-images.pdf');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(RED_DOT_PNG);
    const page = doc.addPage([400, 300]);
    page.drawImage(png, { x: 40, y: 60, width: 100, height: 80 });
    page.drawImage(png, { x: 220, y: 150, width: 120, height: 90 });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('group-moves two placements in one op and a single undo restores both', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('two-images.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const pageId = (await editImagePageIds())[0];
    expect(matrixClose((await currentMatrices())[0], [100, 0, 0, 80, 40, 60])).toBe(true);
    expect(matrixClose((await currentMatrices())[1], [120, 0, 0, 90, 220, 150])).toBe(true);

    // Additive selection: 0, then +1 → the group is [0, 1].
    await editImageSelect(pageId, 0);
    await editImageSelect(pageId, 1, true);
    const sel = await editImageSelection();
    expect(sel?.kind).toBe('image');
    expect(sel?.indexes).toEqual([0, 1]);

    // Group move: both shift by the same user-space delta (+50, +30) — one
    // multi op, ONE undo entry.
    await editImageTransformMany(pageId, [
      { index: 0, matrix: [100, 0, 0, 80, 90, 90] },
      { index: 1, matrix: [120, 0, 0, 90, 270, 180] },
    ]);
    await waitForMatrices(
      [
        [100, 0, 0, 80, 90, 90],
        [120, 0, 0, 90, 270, 180],
      ],
      'the group move never applied',
    );

    // The group re-selects after the rebuild (the P7 reselect stash).
    await browser.waitUntil(
      async () => {
        const s = await editImageSelection();
        return s?.kind === 'image' && (s.indexes ?? []).length === 2;
      },
      { timeout: 15_000, timeoutMsg: 'the group did not re-select after the commit' },
    );

    // ONE undo restores BOTH placements.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForMatrices(
      [
        [100, 0, 0, 80, 40, 60],
        [120, 0, 0, 90, 220, 150],
      ],
      'one undo did not restore both matrices',
    );
  });

  it('group-deletes the selection in one op and a single undo resurrects both', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const pageId = (await editImagePageIds())[0];
    await editImageSelect(pageId, 0);
    await editImageSelect(pageId, 1, true);
    await editImageDeleteSelected();

    // Both placements gone (the page drops out of the listing entirely).
    await browser.waitUntil(async () => (await editImagePageIds()).length === 0, {
      timeout: 30_000,
      timeoutMsg: 'the group delete never applied',
    });

    // ONE undo brings back both.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ms = await currentMatrices();
        return (
          ms.length === 2 &&
          matrixClose(ms[0], [100, 0, 0, 80, 40, 60]) &&
          matrixClose(ms[1], [120, 0, 0, 90, 220, 150])
        );
      },
      { timeout: 30_000, timeoutMsg: 'one undo did not resurrect both placements' },
    );
  });
});
