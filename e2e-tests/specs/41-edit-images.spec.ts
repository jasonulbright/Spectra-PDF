import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
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
  editImageAct,
} from '../support/harness.js';

// Phase 7.1 — Edit ▸ Images round-trip against the built binary: arm the Edit
// tool (its command lands on the document and arms the mode), wait for the
// engine listings, then drive the REAL selection + action handlers with
// injected dialog inputs: replace (raw pixels) → extract (file exists) →
// delete (placements shrink) → undo (buffer restore refetches listings).

// A 1x1 red PNG (hand-checked bytes — pdf-lib embeds it as an XObject).
const RED_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('edit images (Phase 7.1)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-edit-'));
    pdfPath = resolve(tmp, 'with-image.pdf');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(RED_DOT_PNG);
    const page = doc.addPage([400, 300]);
    page.drawImage(png, { x: 100, y: 100, width: 120, height: 90 });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('replace → extract → delete → undo, all through the real handlers', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('with-image.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    // Arm the Edit tool (opens on the document, arms the edit mode, and the
    // canvas fetches placements from the engine).
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(async () => (await editImagePageIds()).length > 0, {
      timeout: 30_000,
      timeoutMsg: 'edit placements never loaded',
    });
    const pageId = (await editImagePageIds())[0];
    let placements = await editImagePlacements(pageId);
    expect(placements.length).toBe(1);
    expect(placements[0].nested).toBe(false);

    // REPLACE with injected 2x2 green raw pixels (no native picker).
    const rawPath = resolve(tmp, 'green.raw');
    writeFileSync(rawPath, Buffer.from([0, 200, 0, 0, 200, 0, 0, 200, 0, 0, 200, 0]));
    await editImageSelect(pageId, 0);
    await editImageAct('replace', {
      source: { raw_path: rawPath, width: 2, height: 2, channels: 3 },
    });
    // The op reloads the buffer; the listings refetch — still one placement.
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        return ids.length > 0 && (await editImagePlacements(ids[0])).length === 1;
      },
      { timeout: 30_000, timeoutMsg: 'placements did not refetch after replace' },
    );
    const pageIdAfter = (await editImagePageIds())[0];

    // EXTRACT the replaced image to an injected prefix — the engine appends
    // the format's real extension; assert SOMETHING landed for the prefix.
    const prefix = resolve(tmp, 'picked');
    await editImageSelect(pageIdAfter, 0);
    await editImageAct('extract', { outputPrefix: prefix });
    const extracted = readdirSync(tmp).filter((f) => f.startsWith('picked'));
    expect(extracted.length).toBe(1);

    // DELETE it — the page's placements drop to zero (page disappears from
    // the ids list, since only non-empty pages are listed).
    await editImageSelect(pageIdAfter, 0);
    await editImageAct('delete');
    await browser.waitUntil(async () => (await editImagePageIds()).length === 0, {
      timeout: 30_000,
      timeoutMsg: 'placements did not empty after delete',
    });

    // UNDO — the snapshot restores, the buffer refreshes, the listings
    // refetch: the image is back.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editImagePageIds();
        return ids.length > 0 && (await editImagePlacements(ids[0])).length === 1;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not restore the image placement' },
    );
  });
});
