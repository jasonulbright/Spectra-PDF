import { resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  editImageAct,
} from '../support/harness.js';

// Phase 9.C3 — image adjustments against the built binary: opacity (a
// page-local ExtGState the LISTING seeds back), crop (a unit-space clip —
// bytes change, the placement matrix does not), and the rotate-90 toolbar
// button (routed through the shipped C1 transform). The engine ops and the
// gesture math are unit-tested; this proves the end-to-end wire + undo.
// Waits are generation-keyed (page ids regenerate per commit — the
// non-authored-rebuild rule; see e2e README §Adding-a-spec 4).

const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function firstPlacement(): Promise<{
  pageId: string;
  p:
    | { index: number; nested: boolean; matrix: number[]; opacity: number; crop: number[] | null }
    | undefined;
}> {
  const ids = await editImagePageIds();
  if (ids.length === 0) return { pageId: '', p: undefined };
  return { pageId: ids[0], p: (await editImagePlacements(ids[0]))[0] };
}

async function workingHash(): Promise<string> {
  const wp = (await getState()).activeFile?.workingPath;
  if (!wp || !existsSync(wp)) return '';
  return createHash('sha256').update(readFileSync(wp)).digest('hex');
}

describe('image adjustments (Phase 9.C3)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-imgadj-'));
    pdfPath = resolve(tmp, 'adjust.pdf');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(RED_DOT_PNG);
    const page = doc.addPage([400, 300]);
    page.drawImage(png, { x: 100, y: 100, width: 120, height: 90 });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('sets opacity (listed back as the seed), then undo restores it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('adjust.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const { pageId, p } = await firstPlacement();
    expect(p?.opacity).toBeCloseTo(1);

    await editImageSelect(pageId, 0);
    await editImageAct('opacity', { opacity: 0.5 });
    // Generation-keyed: the re-listing carries the new opacity seed. This IS
    // the on-disk proof — the listing walks the buffer reloaded from the
    // WRITTEN file, resolving the registered ExtGState by name. (No byte-grep
    // here: qpdf packs small dicts into compressed object streams, so a raw
    // "/EditGS0" search false-fails — unlike the A3 font-name greps, which
    // hit plain objects.)
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return nowId !== '' && nowId !== pageId && Math.abs((now?.opacity ?? 0) - 0.5) < 0.01;
      },
      { timeout: 30_000, timeoutMsg: 'opacity 0.5 never listed back' },
    );
    // C1-tail: the selection SURVIVED the rebuild (auto-reselect against
    // the regenerated page id) — a chained edit needs no re-click.
    await browser.waitUntil(
      async () => {
        const sel = await editImageSelection();
        return sel !== null && sel.kind === 'image' && sel.index === 0;
      },
      { timeout: 10_000, timeoutMsg: 'the selection did not auto-restore after the commit' },
    );

    const preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = (await editImagePlacements(ids[0]))[0];
        return Math.abs((now?.opacity ?? 0) - 1) < 0.01;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore opacity 1' },
    );
  });

  it('crops, re-crops WIDER via collapse-replace, undoes both', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const { pageId, p } = await firstPlacement();
    const matrixBefore = p!.matrix;
    const hashBefore = await workingHash();
    expect(p!.crop).toBe(null); // pristine image: no tool crop listed

    await editImageSelect(pageId, 0);
    await editImageAct('crop', { rect: [0.25, 0.25, 0.75, 0.75] });
    // Generation-keyed; the crop clips — the placement matrix must NOT
    // move, and the LISTING now reports the tool crop (C3-tail).
    const cropIs = (
      c: number[] | null | undefined,
      want: [number, number, number, number],
    ): boolean => !!c && c.length === 4 && c.every((v, i) => Math.abs(v - want[i]) < 0.01);
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return (
          nowId !== '' &&
          nowId !== pageId &&
          !!now &&
          now.matrix.every((v, i) => Math.abs(v - matrixBefore[i]) < 0.5) &&
          cropIs(now.crop, [0.25, 0.25, 0.75, 0.75]) &&
          (await workingHash()) !== hashBefore
        );
      },
      { timeout: 30_000, timeoutMsg: 'the crop never committed (or never listed back)' },
    );

    // Re-crop WIDER — inexpressible under the old intersect semantics;
    // collapse-replace makes the listed crop GROW (the tail headline).
    // The C1-tail reselect means the selection survived the commit — the
    // chained act needs no re-select.
    const midId = (await editImagePageIds())[0];
    await editImageAct('crop', { rect: [0.1, 0.1, 0.9, 0.9] });
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return nowId !== '' && nowId !== midId && !!now && cropIs(now.crop, [0.1, 0.1, 0.9, 0.9]);
      },
      { timeout: 30_000, timeoutMsg: 'the re-crop never widened the listed crop' },
    );

    // Undo the re-crop → the first crop lists again.
    let preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = (await editImagePlacements(ids[0]))[0];
        return cropIs(now?.crop, [0.25, 0.25, 0.75, 0.75]);
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the first crop' },
    );
    // Undo the first crop → pristine bytes.
    preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        return (await workingHash()) === hashBefore;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the pre-crop bytes' },
    );
  });

  it('rotate-90 toolbar button turns the placement via the C1 transform', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const { pageId, p } = await firstPlacement();
    // Axis-aligned start: a=120, b=0.
    expect(Math.abs(p!.matrix[1])).toBeLessThan(0.5);

    await editImageSelect(pageId, 0);
    const btn = await $('[data-testid="edit-action-rotate-cw"]');
    await btn.waitForEnabled({ timeout: 10_000 });
    await btn.click();
    // After ±90°, the linear part goes off-diagonal: |b| ≈ 120, |a| ≈ 0.
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return (
          nowId !== '' &&
          nowId !== pageId &&
          !!now &&
          Math.abs(now.matrix[0]) < 0.5 &&
          Math.abs(now.matrix[1]) > 100
        );
      },
      { timeout: 30_000, timeoutMsg: 'the rotate button never turned the placement' },
    );

    const preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = (await editImagePlacements(ids[0]))[0];
        return !!now && Math.abs(now.matrix[1]) < 0.5;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the axis-aligned matrix' },
    );
  });
});
