/**
 * P27 — content-aware crop, end to end.
 *
 * The measurement has exact pytest coverage; what this proves is the path a
 * reader takes: open the Crop tool's panel, measure, see the counts, commit,
 * and find the saved file's /CropBox around the content and nothing else.
 * Preview-then-apply is the contract — the number shown is the number that
 * lands — so both halves are driven, in that order.
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, rgb } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  setReactInputValue,
  saveActiveAs,
  closeAllFiles,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Page 1 draws one rectangle at a known place; page 2 is blank, so the run
// has both a page to crop and a page to skip.
const RECT = { x: 200, y: 100, w: 120, h: 60 };

async function makeFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ ...RECT, color: rgb(0, 0, 1) });
  doc.addPage([612, 792]);
  writeFileSync(path, await doc.save());
}

async function cropBox(path: string, pageNum: number): Promise<number[]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const view = (await pdf.getPage(pageNum)).view as number[];
  await pdf.loadingTask.destroy();
  return view;
}

describe('content-aware crop', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p27-'));
    source = resolve(tmp, 'src.pdf');
    await makeFixture(source);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('measures first, then crops to the content', async () => {
    await setActiveOp('pagebox');
    await setReactInputValue('[data-testid="pagebox-margin"]', '10');

    // Committing is refused until the measurement has run: the count shown
    // and the crop applied are the same call, and there is nothing to show
    // yet.
    expect(await $('[data-testid="pagebox-auto-apply"]').isEnabled()).toBe(false);

    await $('[data-testid="pagebox-auto-preview"]').click();
    await browser.waitUntil(async () => await $('[data-testid="pagebox-auto-summary"]').isExisting(), {
      timeout: 30_000,
      timeoutMsg: 'the measurement never reported',
    });
    const summary = await $('[data-testid="pagebox-auto-summary"]').getText();
    // One page to crop, one skipped — the blank one, reported rather than
    // cropped to nothing.
    expect(summary).toContain('1');

    await browser.waitUntil(async () => await $('[data-testid="pagebox-auto-apply"]').isEnabled(), {
      timeout: 10_000,
      timeoutMsg: 'the measurement never enabled the crop',
    });
    await $('[data-testid="pagebox-auto-apply"]').click();

    const dest = resolve(tmp, 'cropped.pdf');
    await browser.waitUntil(
      async () => !(await $('[data-testid="pagebox-auto-summary"]').isExisting()),
      { timeout: 30_000, timeoutMsg: 'the crop never committed' },
    );
    await saveActiveAs(dest);

    // The rectangle plus the 10pt margin, exactly.
    const box = await cropBox(dest, 1);
    expect(box[0]).toBeCloseTo(RECT.x - 10, 0);
    expect(box[1]).toBeCloseTo(RECT.y - 10, 0);
    expect(box[2]).toBeCloseTo(RECT.x + RECT.w + 10, 0);
    expect(box[3]).toBeCloseTo(RECT.y + RECT.h + 10, 0);

    // The blank page was skipped and keeps its full box.
    const blank = await cropBox(dest, 2);
    expect(Math.round(blank[2] - blank[0])).toBe(612);
    expect(Math.round(blank[3] - blank[1])).toBe(792);
  });
});
