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
  editImageListingSettled,
  editImagePlacements,
  editImageSelect,
  editImageSelection,
  editImageAct,
  getSelectedCanvasPageIds,
  selectCanvasPages,
  setUiLanguage,
} from '../support/harness.js';
import type { ImagePlacement } from '../support/harness.js';

// Image adjustments against the built binary: opacity (a
// page-local ExtGState the LISTING seeds back), crop (a unit-space clip —
// bytes change, the placement matrix does not), and the rotate-90 toolbar
// button (routed through the image transform). The engine ops and the
// gesture math are unit-tested; this proves the end-to-end wire + undo.
// Waits are generation-keyed (page ids regenerate per commit — the
// non-authored-rebuild rule; see e2e README §Adding-a-spec 4).

const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function firstPlacement(): Promise<{ pageId: string; p: ImagePlacement | undefined }> {
  const ids = await editImagePageIds();
  if (ids.length === 0) return { pageId: '', p: undefined };
  return { pageId: ids[0], p: (await editImagePlacements(ids[0]))[0] };
}

interface StripLayout {
  height: number;
  documentTop: number;
  flexWrap: string;
  allInside: boolean;
  toggleVisible: boolean;
  overflowCount: number;
  status: { kind: string | null; text: boolean; live: string | null } | null;
}

/** The Edit strip's box, whether Close Tool, the overflow toggle and every
 * inline control lie inside it, and what the status line shows. */
async function stripLayout(): Promise<StripLayout> {
  return await browser.execute(() => {
    const strip = document.querySelector('[data-testid="secondary-toolbar"]');
    const view = document.querySelector('[data-testid="document-view"]');
    if (!strip || !view) throw new Error('Edit strip or document view is missing');
    const box = strip.getBoundingClientRect();
    const inside = (el: Element | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.width > 0;
    };
    const toggle = strip.querySelector('[data-testid="edit-actions-toggle"]');
    const status = strip.querySelector('[data-testid="edit-status"]');
    const inline = Array.from(strip.querySelectorAll('.edit-strip-inline [data-edit-item]'));
    return {
      height: Math.round(box.height),
      documentTop: Math.round(view.getBoundingClientRect().top),
      flexWrap: getComputedStyle(strip).flexWrap,
      allInside:
        inside(strip.querySelector('[data-testid="secondary-action-tools.close"]')) &&
        inside(toggle) &&
        inline.every(inside),
      toggleVisible: !!toggle && getComputedStyle(toggle).visibility === 'visible',
      overflowCount: strip.querySelectorAll('#edit-actions-popover [data-edit-item]').length,
      status: status
        ? {
            kind: status.getAttribute('data-kind'),
            text: (status.textContent ?? '').trim().length > 0,
            live: status.getAttribute('aria-live'),
          }
        : null,
    };
  });
}

/** An Edit control that may sit inline or in the overflow menu. */
async function revealEditControl(testId: string) {
  const el = $(`[data-testid="${testId}"]`);
  await el.waitForExist({ timeout: 10_000 });
  if (!(await el.isDisplayed())) {
    await $('[data-testid="edit-actions-toggle"]').click();
    await el.waitForDisplayed({ timeout: 5_000 });
  }
  return el;
}

async function workingHash(): Promise<string> {
  const wp = (await getState()).activeFile?.workingPath;
  if (!wp || !existsSync(wp)) return '';
  return createHash('sha256').update(readFileSync(wp)).digest('hex');
}

describe('image adjustments', () => {
  let tmp: string;
  let pdfPath: string;
  let stripPdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-imgadj-'));
    pdfPath = resolve(tmp, 'adjust.pdf');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(RED_DOT_PNG);
    const page = doc.addPage([400, 300]);
    page.drawImage(png, { x: 100, y: 100, width: 120, height: 90 });
    writeFileSync(pdfPath, await doc.save());
    stripPdfPath = resolve(tmp, 'strip.pdf');
    const two = await PDFDocument.create();
    const twoPng = await two.embedPng(RED_DOT_PNG);
    two.addPage([400, 300]).drawImage(twoPng, { x: 100, y: 100, width: 120, height: 90 });
    two.addPage([400, 300]);
    writeFileSync(stripPdfPath, await two.save());
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
    // "/EditGS0" search false-fails — unlike the font-name greps, which
    // hit plain objects.)
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return nowId !== '' && nowId !== pageId && Math.abs((now?.opacity ?? 0) - 0.5) < 0.01;
      },
      { timeout: 30_000, timeoutMsg: 'opacity 0.5 never listed back' },
    );
    // The selection SURVIVED the rebuild (auto-reselect against
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
    // move, and the LISTING now reports the tool crop.
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
    // The auto-reselect means the selection survived the commit — the
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

  it('rotate-90 toolbar button turns the placement via the transform', async function () {
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
    const btn = await revealEditControl('edit-action-rotate-cw');
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

  it('sets a blend mode: listed back as the seed, merged with opacity, undone', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const { pageId, p } = await firstPlacement();
    expect(p?.blend).toBe('Normal');

    await editImageSelect(pageId, 0);
    await editImageAct('opacity', { blend: 'Multiply' });
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return nowId !== '' && nowId !== pageId && now?.blend === 'Multiply';
      },
      { timeout: 30_000, timeoutMsg: 'blend Multiply never listed back' },
    );

    // A chained opacity set MERGES into the same frame — the blend survives
    // (the collapse re-emits carried state; losing it was the widened
    // collapse's failure mode).
    const midId = (await editImagePageIds())[0];
    await editImageAct('opacity', { opacity: 0.5 });
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return (
          nowId !== '' &&
          nowId !== midId &&
          now?.blend === 'Multiply' &&
          Math.abs((now?.opacity ?? 0) - 0.5) < 0.01
        );
      },
      { timeout: 30_000, timeoutMsg: 'the opacity re-set lost the blend mode' },
    );

    // Undo ×2 → Normal / opacity 1.
    let preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = (await editImagePlacements(ids[0]))[0];
        return now?.blend === 'Multiply' && Math.abs((now?.opacity ?? 0) - 1) < 0.01;
      },
      { timeout: 30_000, timeoutMsg: 'first undo did not drop the opacity set' },
    );
    preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = (await editImagePlacements(ids[0]))[0];
        return now?.blend === 'Normal';
      },
      { timeout: 30_000, timeoutMsg: 'second undo did not restore blend Normal' },
    );
  });

  it('sets a linear gradient mask: seeded back, cleared, undone', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.open.edit');
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const { pageId, p } = await firstPlacement();
    expect(p?.mask).toBe(null);

    await editImageSelect(pageId, 0);
    await editImageAct('opacity', {
      mask: { kind: 'linear', from: [0, 0.5], to: [1, 0.5], start_alpha: 1, end_alpha: 0 },
    });
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return (
          nowId !== '' &&
          nowId !== pageId &&
          now?.mask?.kind === 'linear' &&
          Math.abs((now?.mask?.endAlpha ?? 1) - 0) < 0.01
        );
      },
      { timeout: 30_000, timeoutMsg: 'the linear mask never listed back' },
    );

    // Clear it explicitly ({kind:'none'}) — the mask entry AND its form
    // must stop being referenced (engine sweep), the seed returns to null.
    const midId = (await editImagePageIds())[0];
    await editImageAct('opacity', { mask: { kind: 'none' } });
    await browser.waitUntil(
      async () => {
        const { pageId: nowId, p: now } = await firstPlacement();
        return nowId !== '' && nowId !== midId && !!now && now.mask === null;
      },
      { timeout: 30_000, timeoutMsg: 'the mask clear never applied' },
    );

    // Undo the clear → the mask is back; undo the set → null again.
    let preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = (await editImagePlacements(ids[0]))[0];
        return now?.mask?.kind === 'linear';
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the mask' },
    );
    preUndoId = (await editImagePageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        if (ids.length === 0 || ids[0] === preUndoId) return false;
        const now = (await editImagePlacements(ids[0]))[0];
        return !!now && now.mask === null;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not remove the mask' },
    );
  });

  it('keeps the Edit strip one row, its controls reachable, and Delete off the pages', async function () {
    this.timeout(240_000);
    await waitForHarness();
    const originalSize = await browser.getWindowSize();
    const imageCount = async (): Promise<number> =>
      (await Promise.all((await editImagePageIds()).map(editImagePlacements))).flat().length;
    const deleteByKey = async (key: 'Delete' | 'Backspace'): Promise<void> => {
      const pages = await browser.execute(() =>
        ((window as any).__SPECTRA_TEST__.getActiveDocPages() as { id: string }[]).map((pg) => pg.id),
      );
      expect(pages.length).toBe(2);
      await selectCanvasPages(pages);
      const { pageId } = await firstPlacement();
      await editImageSelect(pageId, 0);
      expect((await getSelectedCanvasPageIds()).sort()).toEqual([...pages].sort());
      const before = await workingHash();
      await browser.keys([key]);
      await browser.waitUntil(
        async () =>
          (await workingHash()) !== before &&
          (await editImageListingSettled()) &&
          (await imageCount()) === 0,
        { timeout: 30_000, timeoutMsg: `${key} did not remove the selected image` },
      );
      expect((await getState()).activeFile?.pageCount).toBe(2);
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await browser.waitUntil(
        async () => (await editImageListingSettled()) && (await imageCount()) === 1,
        { timeout: 30_000, timeoutMsg: 'undo did not restore the image' },
      );
    };
    try {
      await browser.setWindowSize(1024, 768);
      await openByPaths([stripPdfPath]);
      await browser.waitUntil(
        async () => ((await getState()).activeFile?.path ?? '').includes('strip.pdf'),
        { timeout: 15_000, timeoutMsg: 'fixture never became active' },
      );
      expect(await invokeAppCommand('tools.open.edit')).toBe(true);
      await browser.waitUntil(async () => (await imageCount()) === 1, {
        timeout: 30_000,
        timeoutMsg: 'edit placements never loaded',
      });

      await deleteByKey('Delete');
      await deleteByKey('Backspace');

      await browser.setWindowSize(800, 768);
      await setUiLanguage('de');
      const idle = await stripLayout();
      expect(idle.status).toEqual({ kind: 'hint', text: true, live: 'polite' });
      const { pageId } = await firstPlacement();
      await editImageSelect(pageId, 0);
      await browser.waitUntil(async () => (await editImageSelection())?.kind === 'image', {
        timeout: 10_000,
        timeoutMsg: 'image selection did not settle',
      });
      const selected = await stripLayout();
      expect(selected.flexWrap).toBe('nowrap');
      expect(selected.height).toBe(idle.height);
      expect(selected.documentTop).toBe(idle.documentTop);
      expect(selected.allInside).toBe(true);
      expect(selected.toggleVisible).toBe(true);
      expect(selected.overflowCount).toBeGreaterThan(0);

      await $('[data-testid="edit-actions-toggle"]').click();
      await $('[data-testid="edit-actions-popover"]').waitForDisplayed({ timeout: 5_000 });
      const expanded = await stripLayout();
      expect(expanded.height).toBe(idle.height);
      expect(expanded.documentTop).toBe(idle.documentTop);

      // Escape closes the menu first, then clears the selection, and leaves
      // Select & Edit armed.
      await browser.keys(['Escape']);
      await $('[data-testid="edit-actions-popover"]').waitForDisplayed({ reverse: true, timeout: 5_000 });
      expect((await editImageSelection())?.kind).toBe('image');
      await browser.keys(['Escape']);
      await browser.waitUntil(async () => (await editImageSelection()) === null, {
        timeout: 5_000,
        timeoutMsg: 'Escape did not clear the selected image',
      });
      expect(await $('[data-testid="tool-edit"]').getAttribute('aria-pressed')).toBe('true');

      await setUiLanguage('he');
      await editImageSelect(pageId, 0);
      await browser.waitUntil(async () => (await editImageSelection())?.kind === 'image', {
        timeout: 10_000,
        timeoutMsg: 'image selection did not settle in a right-to-left layout',
      });
      const rtl = await stripLayout();
      expect(rtl.height).toBe(idle.height);
      expect(rtl.allInside).toBe(true);
    } finally {
      await setUiLanguage('en');
      await browser.setWindowSize(originalSize.width, originalSize.height);
    }
  });
});
