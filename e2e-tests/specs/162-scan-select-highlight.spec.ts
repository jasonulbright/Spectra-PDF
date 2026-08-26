import { resolve } from 'node:path';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getFirstAnnotation,
  commitPendingEdits,
  saveActiveAs,
  getActiveDocPages,
  selectCanvasPages,
  rotateSelectedCanvasPages,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// View-tier text recognition for selection on scanned pages.
//
// The fixture is a real image-only page: nothing extracts from it, so pdf.js's
// own text layer renders empty and the Select tool had
// nothing to grab. With the preference on, the page's own pixels are recognised
// in memory and the word boxes stand in as selection geometry, so a sweep
// produces an ordinary /Highlight with /QuadPoints. The FILE is untouched by
// the recognition itself; only the highlight the user authored is written.

const SCANNED = resolve(__dirname, '..', 'fixtures', 'scanned.pdf');
const OCR_TIMEOUT = 90_000; // a real Tesseract run over a rendered page

interface AnnotOnDisk {
  subtype: string;
  quadPoints?: number[];
}

async function annotationsOf(path: string): Promise<AnnotOnDisk[]> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as AnnotOnDisk[];
  await pdf.loadingTask.destroy();
  return annots;
}

/** Flip the preference through the panel the user flips it through, so the
 *  subscription that carries it to the live view is exercised too. */
async function setScanSelectPref(on: boolean): Promise<void> {
  await browser.keys(['Control', 'k']);
  const box = $('[data-testid="pref-scan-select-recognition"]');
  await box.waitForDisplayed({ timeoutMsg: 'no scanned-page recognition pref in General' });
  if ((await box.isSelected()) !== on) await box.click();
  await $('[data-testid="prefs-close"]').click();
  await $('[data-testid="pref-scan-select-recognition"]').waitForDisplayed({ reverse: true });
}

/** Select the first recognised word span and release, exactly as a drag ends. */
async function selectFirstSpan(): Promise<string> {
  return await browser.execute(function () {
    const spans = Array.from(
      document.querySelectorAll('[data-testid="text-layer"] span'),
    ) as HTMLElement[];
    const el = spans.find((s) => (s.textContent ?? '').trim().length > 2);
    if (!el) return '';
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return el.textContent ?? '';
  });
}

async function spanCount(): Promise<number> {
  return (await $$('[data-testid="text-layer"] span').getElements()).length;
}

/** Begin a selection gesture on the page's text layer.
 *
 *  Recognition is triggered by the GESTURE, not by the armed tool — Select is
 *  the default tool, so gating on it alone would recognise every scanned page
 *  the moment it scrolled into view. This is that first pointer-down. */
async function beginSelectionGesture(): Promise<boolean> {
  return await browser.execute(function () {
    const el = document.querySelector('[data-testid="text-layer"]') as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    return true;
  });
}

/** Every recognised span's box, in the layer's own coordinates. */
async function spanBoxes(): Promise<{ left: number; top: number; width: number }[]> {
  return await browser.execute(function () {
    return Array.from(document.querySelectorAll('[data-testid="text-layer"] span')).map((s) => {
      const r = (s as HTMLElement).getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) };
    });
  });
}

async function waitForRecognition(): Promise<void> {
  await browser.waitUntil(async () => (await beginSelectionGesture()) && (await spanCount()) > 0, {
    timeout: OCR_TIMEOUT,
    interval: 1_000,
    timeoutMsg: 'the scanned page was never recognised for selection',
  });
}

describe('selecting and highlighting text on a scanned page', () => {
  let tmp: string;
  let saved: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-scansel-'));
    saved = resolve(tmp, 'scanned-highlighted.pdf');
    await waitForHarness();
    await closeAllFiles();
    await setScanSelectPref(true);
  });

  after(async () => {
    // The e2e profile persists localStorage across spec files — leave the
    // preference the way the suite found it (default ON).
    await setScanSelectPref(true);
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('recognises the page and offers word spans where pdf.js found no text', async () => {
    await openByPaths([SCANNED]);
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });

    // Nothing has been swept yet, so nothing has been recognised yet — the
    // trigger is the gesture, not the page scrolling into view.
    expect(await spanCount()).toBe(0);

    await waitForRecognition();
    // The status attribute is the layer's own report; 'ready' means the boxes
    // cleared the confidence gate and are mounted as selection geometry.
    await $('[data-testid="text-layer"][data-ocr-status="ready"]').waitForExist({
      timeout: OCR_TIMEOUT,
      timeoutMsg: 'the recognised page never reported ready',
    });
    expect(await spanCount()).toBeGreaterThan(0);
  });

  it('a sweep authors a quad-carrying highlight', async () => {
    const text = await selectFirstSpan();
    expect(text.length).toBeGreaterThan(2);

    await $('[data-testid="text-selection-menu"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'no markup bar for the recognised selection',
    });
    await $('[data-testid="markup-highlight"]').click();

    const first = await getFirstAnnotation(15_000);
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('textmarkup');
    expect(first!.markupType).toBe('highlight');
    // Real quads, not a bare box: /QuadPoints is what makes a highlight valid
    // on a page that has no text layer at all.
    expect(first!.quadCount).toBeGreaterThan(0);
  });

  it('survives save and reload as a native /Highlight with /QuadPoints', async () => {
    await commitPendingEdits();
    await saveActiveAs(saved);
    const annots = await annotationsOf(saved);
    const highlights = annots.filter((a) => a.subtype === 'Highlight');
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].quadPoints?.length ?? 0).toBeGreaterThan(0);

    // The recognition itself wrote nothing: the saved file gained the
    // highlight and NOT a text layer.
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(saved)) }).promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    await pdf.loadingTask.destroy();
    expect(content.items.length).toBe(0);
  });

  it('a page-tier rotate re-recognises rather than serving transposed boxes', async () => {
    // A quarter-turn changes no bytes, so the pdf.js proxy and the page number
    // are both unchanged while the raster the boxes were measured against has
    // swapped dimensions. Serving the pre-rotation entry transposes every
    // hit-box: the sweep selects a different word than the pointer is over,
    // and the quads it authors land on the wrong part of the page.
    await closeAllFiles();
    await openByPaths([SCANNED]);
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await waitForRecognition();
    const upright = await spanBoxes();
    expect(upright.length).toBeGreaterThan(0);

    const pages = await getActiveDocPages();
    await selectCanvasPages([pages[0].id]);
    await rotateSelectedCanvasPages(90);
    await browser.pause(1_000);

    await waitForRecognition();
    const turned = await spanBoxes();
    expect(turned.length).toBeGreaterThan(0);
    // The layout the boxes are laid out against has swapped, so the spans must
    // have moved. Identical geometry after a quarter-turn is the stale-cache
    // signature.
    expect(turned.map((b) => `${b.left},${b.top},${b.width}`).join('|')).not.toBe(
      upright.map((b) => `${b.left},${b.top},${b.width}`).join('|'),
    );

    // Put the page back so the next case starts from the upright document.
    await selectCanvasPages([pages[0].id]);
    await rotateSelectedCanvasPages(270);
    await browser.pause(1_000);
  });

  it('preference OFF unmounts the spans on the page already on screen', async () => {
    // Flipped with the document OPEN and recognised: "off restores the older
    // behaviour exactly" has to be true immediately, not only after a reopen,
    // a rotate or a zoom rebuilds the layer for some unrelated reason.
    await waitForRecognition();
    expect(await spanCount()).toBeGreaterThan(0);

    await setScanSelectPref(false);
    await browser.waitUntil(async () => (await spanCount()) === 0, {
      timeout: 15_000,
      timeoutMsg: 'the recognised spans stayed mounted after the preference went off',
    });
    expect(await $('[data-testid="text-layer"][data-ocr-status]').isExisting()).toBe(false);
  });

  it('preference OFF restores the old behaviour on a freshly opened scan', async () => {
    await closeAllFiles();
    await openByPaths([SCANNED]);
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    // Long enough that recognition would have finished had it run at all.
    await beginSelectionGesture();
    await browser.pause(3_000);
    expect(await spanCount()).toBe(0);
    expect(
      await $('[data-testid="text-layer"][data-ocr-status]').isExisting(),
    ).toBe(false);
  });
});
