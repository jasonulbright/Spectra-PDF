import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  editImagePageIds,
  editImagePlacements,
  editImageSelect,
  editImageTransform,
  editImageAct,
} from '../support/harness.js';

// Phase 9.C4 — inline (BI/ID/EI) images against the built binary: they
// list as placements beside XObject draws, the wrap/drop family works on
// them (transform, delete), and undo restores. The engine ordinal
// agreement and refusals are pytest-pinned; this proves the wire.
// Fixture: e2e-tests/fixtures/inline-image.pdf (committed; one inline
// draw at [60,0,0,60,40,180], one XObject draw at [80,0,0,60,220,60]).
// Waits are generation-keyed (README §Adding-a-spec 4).

const FIXTURE = resolve(__dirname, '..', 'fixtures', 'inline-image.pdf');

async function placements(): Promise<
  { index: number; matrix: number[]; kind: string }[]
> {
  const ids = await editImagePageIds();
  if (ids.length === 0) return [];
  return await editImagePlacements(ids[0]);
}

describe('inline images (Phase 9.C4)', () => {
  it('lists both kinds, transforms and deletes the inline draw, undo restores', async function () {
    this.timeout(180_000);
    expect(existsSync(FIXTURE)).toBe(true);
    await waitForHarness();
    await openByPaths([FIXTURE]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('inline-image.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await placements()).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'both placements never listed',
    });
    let ps = await placements();
    expect(ps.map((p) => p.kind)).toEqual(['inline', 'xobject']);
    expect(ps[0].matrix[0]).toBeCloseTo(60, 0);

    // TRANSFORM the inline draw (+30 x).
    let pageId = (await editImagePageIds())[0];
    await editImageSelect(pageId, 0);
    const target = [...ps[0].matrix];
    target[4] += 30;
    await editImageTransform(pageId, 0, target);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === pageId) return false;
        const now = await editImagePlacements(ids[0]);
        return (
          now.length === 2 &&
          now[0].kind === 'inline' &&
          Math.abs(now[0].matrix[4] - target[4]) < 0.5
        );
      },
      { timeout: 30_000, timeoutMsg: 'the inline transform never applied' },
    );

    // DELETE the (moved) inline draw — only the XObject remains.
    pageId = (await editImagePageIds())[0];
    await editImageSelect(pageId, 0);
    await editImageAct('delete');
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === pageId) return false;
        const now = await editImagePlacements(ids[0]);
        return now.length === 1 && now[0].kind === 'xobject';
      },
      { timeout: 30_000, timeoutMsg: 'the inline delete never applied' },
    );

    // UNDO ×2 → the original two placements at the original matrix.
    let preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        return (await editImagePlacements(ids[0])).length === 2;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the inline draw' },
    );
    preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = await editImagePlacements(ids[0]);
        return now.length === 2 && Math.abs(now[0].matrix[4] - 40) < 0.5;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the original matrix' },
    );
  });
});
