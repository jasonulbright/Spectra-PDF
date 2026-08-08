import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  getState,
  saveActiveAs,
  setReactInputValue,
  drawCropRect,
  invokeAppCommand,
  closeAllFiles,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function makeFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`BODY ${i}`, { x: 50, y: 400, size: 18, font });
  }
  writeFileSync(path, await doc.save());
}

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = (await (await pdf.getPage(i)).getTextContent()) as { items: { str?: string }[] };
    out.push(content.items.map((it) => it.str ?? '').join(' '));
  }
  await pdf.loadingTask.destroy();
  return out;
}

async function cropBox(path: string, pageNum: number): Promise<number[]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const view = (await pdf.getPage(pageNum)).view as number[]; // the crop box [x0,y0,x1,y1]
  await pdf.loadingTask.destroy();
  return view;
}

async function applyAndSave(dest: string): Promise<void> {
  await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
    timeout: 20_000,
    timeoutMsg: 'apply never marked the file dirty',
  });
  await saveActiveAs(dest);
  expect(existsSync(dest)).toBe(true);
}

describe('header/footer + page-box panels', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p5-'));
    source = resolve(tmp, 'src.pdf');
    await makeFixture(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('stamps a page-number footer on every page through the engine', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('headerfooter');
    await setReactInputValue('[data-testid="hf-bc"]', 'Page {page}');
    await $('[data-testid="hf-apply"]').click();
    const dest = resolve(tmp, 'stamped.pdf');
    await applyAndSave(dest);
    const texts = await pageTexts(dest);
    expect(texts[0]).toContain('Page 1');
    expect(texts[1]).toContain('Page 2');
    expect(texts[0]).toContain('BODY 1'); // original content preserved
  });

  it('crops the page via the page-box panel', async () => {
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('pagebox');
    await setReactInputValue('[data-testid="pagebox-top"]', '100');
    await $('[data-testid="pagebox-apply"]').click();
    const dest = resolve(tmp, 'cropped.pdf');
    await applyAndSave(dest);
    const box = await cropBox(dest, 1);
    // 792 tall, trimmed 100 off the top → crop box height 692.
    expect(Math.round(box[3] - box[1])).toBe(692);
    expect(Math.round(box[2] - box[0])).toBe(612);
  });

  it('sets a page label range through the page-labels panel', async () => {
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('pagelabels');
    // Add one range starting at page 1, roman lower-case.
    await $('[data-testid="pagelabel-add"]').click();
    await $('[data-testid="pagelabel-style-0"]').waitForDisplayed({ timeout: 10_000 });
    await browser.execute(() => {
      const sel = document.querySelector('[data-testid="pagelabel-style-0"]') as HTMLSelectElement;
      if (sel) {
        sel.value = 'r';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await $('[data-testid="pagelabel-apply"]').click();
    const dest = resolve(tmp, 'labeled.pdf');
    await applyAndSave(dest);
    // Verify the /PageLabels tree via pdf.js (getPageLabels returns per-page).
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(dest)), isEvalSupported: false }).promise;
    const labels = await pdf.getPageLabels();
    await pdf.loadingTask.destroy();
    expect(labels).toEqual(['i', 'ii']);
  });
});

describe('on-canvas crop draw', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p5b-'));
    source = resolve(tmp, 'src.pdf');
    await makeFixture(source);
    await waitForHarness();
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('a band drawn on the page fills the panel and crops on Apply', async () => {
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('pagebox');

    // The band is the region to KEEP: the top-left quarter of a 612x792
    // page, so 306pt comes off the right and 594pt off the bottom.
    await drawCropRect({ x: 0, y: 0, w: 0.5, h: 0.25 });

    // The panel's own fields must carry it — that is the whole handoff, and
    // the arithmetic tests cannot see any of it.
    await browser.waitUntil(
      async () => (await $('[data-testid="pagebox-right"]').getValue()) === '306',
      { timeout: 10_000, timeoutMsg: 'the drawn crop never reached the panel' },
    );
    expect(await $('[data-testid="pagebox-top"]').getValue()).toBe('0');
    expect(await $('[data-testid="pagebox-left"]').getValue()).toBe('0');
    expect(await $('[data-testid="pagebox-bottom"]').getValue()).toBe('594');
    // Scoped to the page it was drawn on, not silently to every page.
    expect(await $('[data-testid="pagebox-pages"]').getValue()).toBe('1');

    // And Apply is still what changes the file — the drawn crop goes through
    // the identical set_page_boxes call a typed one does.
    await $('[data-testid="pagebox-apply"]').click();
    const dest = resolve(tmp, 'drawn.pdf');
    await applyAndSave(dest);
    const box = await cropBox(dest, 1);
    expect(Math.round(box[2] - box[0])).toBe(306);
    expect(Math.round(box[3] - box[1])).toBe(198);
    // Page 2 was never in scope.
    const untouched = await cropBox(dest, 2);
    expect(Math.round(untouched[3] - untouched[1])).toBe(792);
  });
});

/**
 * The same handoff through the REAL gesture.
 *
 * The harness seam above calls the crop callback directly, so it proves the
 * arithmetic and the panel handoff but says nothing about whether a pointer
 * drag ever reaches that callback — the callback is a prop, and a render path
 * that fails to pass it draws the band, completes the drag, and delivers
 * nothing. Only pointer events crossing the real component tree can catch
 * that, so this drives one: window-level native listeners per the canvas
 * invariant, entered the way a reader enters the tool.
 */
describe('on-canvas crop draw, real pointer gesture', () => {
  let tmp: string;
  let source: string;
  let pr: { x: number; y: number; w: number; h: number };

  // The band, as a fraction of the drawn page frame, and what it means on a
  // 612x792 page: the region to KEEP, so the insets are what falls outside it.
  const FROM: [number, number] = [0.3, 0.1];
  const TO: [number, number] = [0.7, 0.4];
  const EXPECT = { left: 183.6, right: 183.6, top: 79.2, bottom: 475.2 };
  // Pointer coordinates are whole pixels and the band snaps to page geometry,
  // so the drawn value lands near the nominal one rather than on it.
  const TOL = 12;

  async function pageRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return (await browser.execute(function () {
      const el = document.querySelector('[data-page-id]');
      if (!el) return null as unknown as { x: number; y: number; w: number; h: number };
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })) as { x: number; y: number; w: number; h: number } | null;
  }

  async function cropMarkCount(): Promise<number> {
    return (await browser.execute(function () {
      return document.querySelectorAll('[data-testid="crop-placement"]').length;
    })) as number;
  }

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p5c-'));
    source = resolve(tmp, 'src.pdf');
    await makeFixture(source);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
    pr = (await pageRect())!;
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('a dragged band marks the page and fills the panel', async () => {
    // Opening the tool is what arms the mode — the reader picks Crop and the
    // cursor is live, with no second step.
    expect(await invokeAppCommand('tools.open.pagebox')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'cropdraw', {
      timeout: 10_000,
      timeoutMsg: 'opening the tool never armed the crop mode',
    });

    const at = (f: [number, number]): { x: number; y: number } => ({
      x: Math.round(pr.x + pr.w * f[0]),
      y: Math.round(pr.y + pr.h * f[1]),
    });
    const mid: [number, number] = [(FROM[0] + TO[0]) / 2, (FROM[1] + TO[1]) / 2];
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(at(FROM))
      .down()
      .pause(80)
      .move(at(mid))
      .pause(80)
      .move(at(TO))
      .pause(80)
      .up()
      .perform();

    // The mark the release leaves behind: the drawn rectangle stays on the
    // page, so the reader can see what they asked to keep before applying it.
    await browser.waitUntil(async () => (await cropMarkCount()) === 1, {
      timeout: 10_000,
      timeoutMsg: 'the drawn crop left no mark on the page',
    });

    // ...and the panel's own fields carry it. The dock is not opened by the
    // tool, so a crop drawn before the panel is on screen must survive until
    // it mounts.
    expect(await invokeAppCommand('tools.panel.pagebox')).toBe(true);
    await browser.waitUntil(
      async () => Number(await $('[data-testid="pagebox-left"]').getValue()) > 0,
      { timeout: 10_000, timeoutMsg: 'the drawn crop never reached the panel' },
    );
    for (const [id, want] of [
      ['pagebox-left', EXPECT.left],
      ['pagebox-right', EXPECT.right],
      ['pagebox-top', EXPECT.top],
      ['pagebox-bottom', EXPECT.bottom],
    ] as const) {
      const got = Number(await $(`[data-testid="${id}"]`).getValue());
      expect(Math.abs(got - want)).toBeLessThan(TOL);
    }
    // Scoped to the page it was drawn on, not silently to every page.
    expect(await $('[data-testid="pagebox-pages"]').getValue()).toBe('1');

    // Apply is still what changes the file, through the same call a typed
    // crop uses.
    await $('[data-testid="pagebox-apply"]').click();
    const dest = resolve(tmp, 'dragged.pdf');
    await applyAndSave(dest);
    const box = await cropBox(dest, 1);
    expect(Math.abs(box[2] - box[0] - (612 - EXPECT.left - EXPECT.right))).toBeLessThan(2 * TOL);
    expect(Math.abs(box[3] - box[1] - (792 - EXPECT.top - EXPECT.bottom))).toBeLessThan(2 * TOL);
    // Page 2 was never in scope.
    const untouched = await cropBox(dest, 2);
    expect(Math.round(untouched[3] - untouched[1])).toBe(792);
  });
});
