import { expect } from '@wdio/globals';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  closeAllFiles,
  getState,
  invokeAppCommand,
  openByPaths,
  saveActiveAs,
  setActiveOp,
  setReactInputValue,
  setReactSelectValue,
  setView,
  waitForHarness,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

/**
 * Drawing bands while Rotate View is on (W-14). Rotate View turns what is shown
 * and nothing stored, so a band drawn on the turned page must land on the same
 * part of the stored page that the reader sees under the pointer. Driven as real
 * pointer gestures on a 612x792 page turned clockwise: a displayed point (u, v),
 * fractions from the shown left and top, is the stored point whose fraction from
 * the stored left is v and from the stored top is 1 - u.
 *
 * Crop is the case for the placements that freeze their rotation at the draw
 * (signature, new field, add text, crop, add image); the link band is the case
 * for the regions that convert at once (link, bead, snapshot).
 */

const TOL = 12;

// The page is shown turned clockwise by `view` (Rotate View), `baked` (the page's own
// /Rotate 90) or `both` (they add up to a half turn).
const SHOWN = {
  view: {
    title: 'bands drawn while Rotate View is on',
    crop: { left: 61.2, right: 367.2, top: 237.6, bottom: 158.4 },
    link: [91.8, 118.8, 214.2, 435.6],
  },
  baked: {
    title: 'bands drawn on a page whose own /Rotate is 90',
    crop: { left: 61.2, right: 367.2, top: 237.6, bottom: 158.4 },
    link: [91.8, 118.8, 214.2, 435.6],
  },
  both: {
    title: 'bands drawn on a /Rotate 90 page with Rotate View on (a half turn)',
    crop: { left: 183.6, right: 122.4, top: 475.2, bottom: 79.2 },
    link: [275.4, 118.8, 520.2, 277.2],
  },
} as const;

for (const how of ['view', 'baked', 'both'] as const) describe(SHOWN[how].title, () => {
  let tmp = '';
  let source = '';
  let pr: { x: number; y: number; w: number; h: number };

  async function pageRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return (await browser.execute(function () {
      const el = document.querySelector('[data-page-id]');
      if (!el) return null as unknown as { x: number; y: number; w: number; h: number };
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })) as { x: number; y: number; w: number; h: number } | null;
  }

  async function drag(from: [number, number], to: [number, number]): Promise<void> {
    // Measured at the moment of the drag, once two reads agree: a page that is
    // still settling after the turn would put the pointer on another part of it.
    let last = JSON.stringify(await pageRect());
    for (let i = 0; i < 20; i++) {
      await browser.pause(250);
      const now = JSON.stringify(await pageRect());
      if (now === last) break;
      last = now;
    }
    pr = (await pageRect())!;
    const at = (f: [number, number]): { x: number; y: number } => ({
      x: Math.round(pr.x + pr.w * f[0]),
      y: Math.round(pr.y + pr.h * f[1]),
    });
    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(at(from))
      .down()
      .pause(80)
      .move(at(mid))
      .pause(80)
      .move(at(to))
      .pause(80)
      .up()
      .perform();
  }

  async function openTurned(): Promise<void> {
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
    if (how !== 'baked') expect(await invokeAppCommand('view.rotateCW')).toBe(true);
    // The turned page is wider than tall: the frame settles once it is laid out.
    await browser.waitUntil(async () => {
      const r = await pageRect();
      return !!r && (how === 'both' ? r.w < r.h : r.w > r.h);
    }, { timeout: 15_000, timeoutMsg: 'the page never showed turned' });
    await browser.pause(800);
    pr = (await pageRect())!;
  }

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-rvb-'));
    source = resolve(tmp, 'src.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const label of ['ONE', 'TWO', 'THREE']) {
      const page = doc.addPage([612, 792]);
      page.drawText(label, { x: 60, y: 700, size: 28, font });
      if (how !== 'view') page.setRotation(degrees(90));
    }
    writeFileSync(source, await doc.save());
    await waitForHarness();
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('a crop band lands on the stored part of the page the reader sees', async () => {
    await openTurned();
    expect(await invokeAppCommand('tools.open.pagebox')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'cropdraw', {
      timeout: 10_000,
      timeoutMsg: 'opening the tool never armed the crop mode',
    });
    await drag([0.2, 0.1], [0.7, 0.4]);
    await browser.waitUntil(
      async () => ((await browser.execute(() => document.querySelectorAll('[data-testid="crop-placement"]').length)) as number) === 1,
      { timeout: 10_000, timeoutMsg: 'the drawn crop left no mark on the turned page' },
    );
    expect(await invokeAppCommand('tools.panel.pagebox')).toBe(true);
    await browser.waitUntil(
      async () => Number(await $('[data-testid="pagebox-left"]').getValue()) > 0,
      { timeout: 10_000, timeoutMsg: 'the drawn crop never reached the panel' },
    );
    // Shown u 0.2..0.7 and v 0.1..0.4 on the clockwise-turned page keep the stored
    // x 0.1..0.4 and the stored top 0.3..0.8 of a 612 x 792 page. The two vertical
    // insets differ on purpose, so a top/bottom swap cannot pass.
    const crop = SHOWN[how].crop;
    for (const [id, want] of [
      ['pagebox-left', crop.left],
      ['pagebox-right', crop.right],
      ['pagebox-top', crop.top],
      ['pagebox-bottom', crop.bottom],
    ] as const) {
      const got = Number(await $(`[data-testid="${id}"]`).getValue());
      expect(Math.abs(got - want)).toBeLessThan(TOL);
    }
  });

  it('a link band lands on the stored part of the page the reader sees', async () => {
    await openTurned();
    expect(await invokeAppCommand('tools.open.links')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'linkdraw', {
      timeout: 10_000,
      timeoutMsg: 'opening the Links tool never armed the draw mode',
    });
    expect(await invokeAppCommand('tools.panel.links')).toBe(true);
    await setActiveOp('links');
    await $('[data-testid="links-draw-hint"]').waitForDisplayed({ timeout: 20_000 });
    await drag([0.15, 0.15], [0.55, 0.35]);
    await $('[data-testid="links-draw-pending"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'the drag left no pending rectangle on the turned page',
    });
    await setReactSelectValue('[data-testid="link-new-kind"]', 'goto');
    await setReactInputValue('[data-testid="link-new-page"]', '3');
    await $('[data-testid="link-new-create"]').click();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
      timeout: 20_000,
      timeoutMsg: 'creating the link never marked the file dirty',
    });
    const dest = resolve(tmp, 'linked.pdf');
    await saveActiveAs(dest);

    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(dest)) }).promise;
    const links = ((await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; rect?: number[] }[]).filter(
      (a) => a.subtype === 'Link',
    );
    await pdf.loadingTask.destroy();
    expect(links).toHaveLength(1);
    // Shown u 0.15..0.55 and v 0.15..0.35 are the stored x 0.15..0.35 and the stored
    // top 0.45..0.85, which in PDF space (up from the bottom) is y 118.8..435.6.
    const want = SHOWN[how].link;
    const got = links[0].rect!;
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i])).toBeLessThan(TOL);
  });
});
