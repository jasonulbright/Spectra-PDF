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
  editImagePlacements,
  editImageSelect,
  editImageSelection,
  editImageTransformMany,
  editImageDeleteSelected,
  settledEditImagePageIds,
} from '../support/harness.js';

// Image multi-select — group transform and group delete against the built
// binary. Two placements are additively selected and moved by ONE multi
// engine op; a SINGLE undo restores both (the whole point: one gesture,
// one undo entry). Then both are deleted in one op and a single undo
// resurrects both. The on-canvas group frame lives in transformed space
// (undrivable — the spec-47 precedent); the harness drives the same
// commit path the frame's pointerup takes.
//
// Page ids regenerate on every whole-file commit (the non-authored-rebuild
// rule) — always re-fetch the page id from a SETTLED listing after a commit.
// A commit lands as two passes (bytes, then the reindex's regenerated ids);
// binding a selection to a mid-pass reading names a page that is already
// dead, and the action then refuses. That is the defect this spec caught.

const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function matrixClose(a: number[] | undefined, b: number[], eps = 0.5): boolean {
  return !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

/**
 * The listing maps are keyed by GENERATION-TAGGED page ids: a whole-file op
 * rotates every id, the canvas prunes the dead keys the moment it sees the
 * rotation, and the fresh listing is a per-page engine round-trip behind. So
 * "the page has no placements" and "the fresh listing hasn't landed" are the
 * same reading, and an assertion that accepts it passes over an op that did
 * NOTHING — which is exactly what hid the stale-binding defect this round.
 * Every wait below therefore reads only a SETTLED listing.
 */
async function waitForMatrices(targets: number[][], msg: string): Promise<string> {
  let settledPageId = '';
  await browser.waitUntil(
    async () => {
      const ids = await settledEditImagePageIds();
      if (ids === null || ids.length === 0) return false; // in flight / no page
      const ms = (await editImagePlacements(ids[0])).map((p) => p.matrix);
      if (ms.length !== targets.length) return false;
      if (!targets.every((t, i) => matrixClose(ms[i], t))) return false;
      settledPageId = ids[0];
      return true;
    },
    { timeout: 30_000, timeoutMsg: msg },
  );
  return settledPageId;
}

/** A settled listing with no placements at all — every image is gone. */
async function waitForNoPlacements(msg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const ids = await settledEditImagePageIds();
      return ids !== null && ids.length === 0;
    },
    { timeout: 30_000, timeoutMsg: msg },
  );
}

describe('image multi-select', () => {
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
    const pageId = await waitForMatrices(
      [
        [100, 0, 0, 80, 40, 60],
        [120, 0, 0, 90, 220, 150],
      ],
      'edit placements never loaded',
    );

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

    // The group re-selects after the rebuild (the reselect stash).
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
    // The previous test's undo commits in TWO passes (bytes, then the
    // reindex's regenerated page ids). Bind the selection to a SETTLED
    // listing — a mid-pass reading names a page whose id is already dead,
    // and the delete would then refuse (silently, before this round).
    const pageId = await waitForMatrices(
      [
        [100, 0, 0, 80, 40, 60],
        [120, 0, 0, 90, 220, 150],
      ],
      'edit placements never settled after the previous undo',
    );
    await editImageSelect(pageId, 0);
    await editImageSelect(pageId, 1, true);
    expect((await editImageSelection())?.indexes).toEqual([0, 1]);
    await editImageDeleteSelected();

    // Both placements gone (the page drops out of the listing entirely) —
    // asserted against a SETTLED listing, so a delete that did nothing
    // cannot satisfy it through the mid-rebuild empty window.
    await waitForNoPlacements('the group delete never applied');

    // ONE undo brings back both.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForMatrices(
      [
        [100, 0, 0, 80, 40, 60],
        [120, 0, 0, 90, 220, 150],
      ],
      'one undo did not resurrect both placements',
    );
  });
});
