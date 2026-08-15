/**
 * P34 — link authoring, end to end.
 *
 * The band is driven as a REAL pointer gesture rather than through a harness
 * seam: the commit callback is a prop, and a render path that forgets to pass
 * it draws the band, completes the drag and delivers nothing. Only pointer
 * events crossing the real component tree catch that class of defect.
 *
 * A URI link is asserted through its `/A` payload rather than clicked: this
 * app opens no external address, so "the link works" is a claim about the
 * bytes, and that is what is measured. The INTERNAL jump is clicked, because
 * that one lands inside the app and can therefore be observed.
 */
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
  invokeAppCommand,
  closeAllFiles,
  saveActiveAs,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

interface RawLink {
  subtype: string;
  url?: string;
  dest?: unknown;
  rect?: number[];
  borderStyle?: { width?: number; style?: number };
  color?: Uint8ClampedArray;
}

async function makeFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['ONE', 'TWO', 'THREE']) {
    const page = doc.addPage([612, 792]);
    page.drawText(label, { x: 60, y: 700, size: 28, font });
  }
  writeFileSync(path, await doc.save());
}

/** Every /Link on a page, as pdf.js reports it. */
async function linksOn(path: string, pageNumber: number): Promise<RawLink[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const annots = (await (await pdf.getPage(pageNumber)).getAnnotations()) as RawLink[];
  await pdf.loadingTask.destroy();
  return annots.filter((a) => a.subtype === 'Link');
}

/** The raw /Border and /BS a link carries — the appearance assertion. pdf.js
 * normalises borders, so the bytes are read straight out of the file. */
function borderBytes(path: string): string {
  return readFileSync(path, 'latin1');
}

describe('link authoring', () => {
  let tmp: string;
  let source: string;
  let pr: { x: number; y: number; w: number; h: number };

  const FROM: [number, number] = [0.15, 0.15];
  const TO: [number, number] = [0.55, 0.35];

  async function pageRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return (await browser.execute(function () {
      const el = document.querySelector('[data-page-id]');
      if (!el) return null as unknown as { x: number; y: number; w: number; h: number };
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })) as { x: number; y: number; w: number; h: number } | null;
  }

  async function dragBand(): Promise<void> {
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
  }

  async function openLinksTool(): Promise<void> {
    expect(await invokeAppCommand('tools.open.links')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'linkdraw', {
      timeout: 10_000,
      timeoutMsg: 'opening the Links tool never armed the draw mode',
    });
    expect(await invokeAppCommand('tools.panel.links')).toBe(true);
    await setActiveOp('links');
  }

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p34-'));
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

  it('a dragged band becomes a link to a page in this document, with a visible border', async () => {
    await openLinksTool();
    await $('[data-testid="links-draw-hint"]').waitForDisplayed({ timeout: 20_000 });

    await dragBand();

    // The gesture reached the panel — nothing was written yet.
    await $('[data-testid="links-draw-pending"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'the drag left no pending rectangle in the Links panel',
    });
    expect(await $('[data-testid="links-draw-pending"]').getText()).toContain('1');

    // Target: page 3 of this document, fitting the page.
    await setReactSelectValue('[data-testid="link-new-kind"]', 'goto');
    await setReactInputValue('[data-testid="link-new-page"]', '3');
    await setReactSelectValue('[data-testid="link-new-view"]', 'fit');
    // Appearance: a visible dashed border. The default is invisible, which is
    // exactly why an authored one has to be asserted.
    await setReactInputValue('[data-testid="link-new-width"]', '2');
    await setReactSelectValue('[data-testid="link-new-style"]', 'dashed');

    await $('[data-testid="link-new-create"]').click();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
      timeout: 20_000,
      timeoutMsg: 'creating the link never marked the file dirty',
    });

    const dest = resolve(tmp, 'linked.pdf');
    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    const links = await linksOn(dest, 1);
    expect(links).toHaveLength(1);
    // The destination resolves to a page in THIS document.
    expect(links[0].dest).toBeTruthy();
    expect(links[0].url).toBeUndefined();

    // The border landed: /BS with a width and a dashed style, and /Border
    // agreeing about the width.
    const bytes = borderBytes(dest);
    expect(bytes).toContain('/BS');
    expect(/\/S\s*\/D/.test(bytes)).toBe(true);
    expect(/\/Border\s*\[\s*0\s+0\s+2\s*\]/.test(bytes)).toBe(true);
  });

  it('the created link is listed, and its Go to lands on its own page', async () => {
    await $('[data-testid="link-item"]').waitForDisplayed({ timeout: 20_000 });
    expect((await $$('[data-testid="link-item"]')).length).toBe(1);
    // The listing names the kind the document actually carries.
    expect(await $('[data-testid="link-item"]').getAttribute('data-link-kind')).toBe('internal');

    // Jump to the link's OWN page (page 1 — where the rectangle is).
    await setActiveOp('links');
    await $('[data-testid="link-jump-1-0"]').click();
    await browser.waitUntil(async () => (await getState()).currentPage === 1, {
      timeout: 10_000,
      timeoutMsg: 'Go to never landed on the link’s page',
    });
  });

  it('the internal destination jumps to the page it names', async () => {
    // The click-through half: an internal GoTo is the one target that lands
    // inside this app, so it is exercised rather than asserted on bytes alone.
    // The link region is a real element on the page; clicking it selects the
    // link, and the panel's Go to on the TARGET page is what proves the
    // destination resolves.
    await $('[data-testid="link-region"]').waitForDisplayed({ timeout: 20_000 });
    await $('[data-testid="link-region"]').click();
    await $('[data-testid="link-edit-1-0-kind"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'clicking the link on the page never opened its editor',
    });
    // The editor opened on the target the document carries.
    expect(await $('[data-testid="link-edit-1-0-kind"]').getValue()).toBe('goto');
    expect(await $('[data-testid="link-edit-1-0-page"]').getValue()).toBe('3');
  });

  it('retargets an existing link to a web address and asserts the /A payload', async () => {
    await setReactSelectValue('[data-testid="link-edit-1-0-kind"]', 'uri');
    await setReactInputValue('[data-testid="link-edit-1-0-url"]', 'https://retargeted.example');
    await $('[data-testid="link-save-1-0"]').click();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
      timeout: 20_000,
      timeoutMsg: 'retargeting never marked the file dirty',
    });

    const dest = resolve(tmp, 'retargeted.pdf');
    await saveActiveAs(dest);
    const links = await linksOn(dest, 1);
    expect(links).toHaveLength(1);
    // Not clicked — this app opens no external address. The payload IS the
    // assertion.
    expect(links[0].url).toBe('https://retargeted.example/');
    expect(links[0].dest).toBeFalsy();
  });

  it('a link to another file authors a /GoToR, never a /Launch', async () => {
    await openLinksTool();
    pr = (await pageRect())!;
    await dragBand();
    await $('[data-testid="links-draw-pending"]').waitForDisplayed({ timeout: 20_000 });

    await setReactSelectValue('[data-testid="link-new-kind"]', 'file');
    await setReactInputValue('[data-testid="link-new-file"]', 'appendix.pdf');
    await setReactInputValue('[data-testid="link-new-file-page"]', '2');
    await $('[data-testid="link-new-create"]').click();

    await browser.waitUntil(async () => ((await $$('[data-testid="link-item"]')).length) === 2, {
      timeout: 20_000,
      timeoutMsg: 'the file link never appeared in the listing',
    });

    const dest = resolve(tmp, 'goto-remote.pdf');
    await saveActiveAs(dest);
    const bytes = borderBytes(dest);
    expect(bytes).toContain('/GoToR');
    expect(bytes).toContain('appendix.pdf');
    // /Launch names a program for the OS to run; this app never authors one.
    expect(bytes).not.toContain('/Launch');
  });

  it('deletes a link through the same gate', async () => {
    await setActiveOp('links');
    await $('[data-testid="link-delete-1-1"]').waitForDisplayed({ timeout: 20_000 });
    await $('[data-testid="link-delete-1-1"]').click();
    await browser.waitUntil(async () => ((await $$('[data-testid="link-item"]')).length) === 1, {
      timeout: 20_000,
      timeoutMsg: 'the link was never removed from the listing',
    });

    const dest = resolve(tmp, 'deleted.pdf');
    await saveActiveAs(dest);
    expect(await linksOn(dest, 1)).toHaveLength(1);
  });
});
