import { resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  rebuildTextLayers,
} from '../support/harness.js';

// A text layer is rebuilt whenever its page gets a new pdf.js proxy, which a
// new buffer of the same bytes produces. Over the same page geometry the new
// spans replace the old ones in one step, and a selection made in the old
// spans is carried across when the text is unchanged, so the markup bar the
// selection opened stays open and covers the same characters.

async function makePdf(path: string, pages: [string, string][], size: [number, number]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [first, second] of pages) {
    const page = doc.addPage(size);
    page.drawText(first, { x: 20, y: size[1] - 40, size: 16, font });
    page.drawText(second, { x: 20, y: size[1] - 70, size: 16, font });
  }
  writeFileSync(path, await doc.save());
}

/** Each text layer's finished-build counter, in page order. */
const builds = () => browser.execute(() =>
  Array.from(document.querySelectorAll('[data-testid="text-layer"]'))
    .map((layer) => Number(layer.getAttribute('data-text-build') ?? 0)));

/**
 * Waits until `count` text layers are built at the size their page cells are
 * drawn at. A layer built while the reading view was still settling its zoom
 * is rebuilt for the new size, and that rebuild clears the selection, as a zoom
 * does; a selection made before it would not survive to be tested.
 */
async function waitForSettledLayers(count: number, pageHeightPt: number): Promise<void> {
  await browser.waitUntil(async () => browser.execute((n: number, heightPt: number) => {
    const layers = Array.from(document.querySelectorAll('[data-testid="text-layer"]')) as HTMLElement[];
    return layers.length >= n && layers.slice(0, n).every((layer) => {
      const scale = parseFloat(layer.style.getPropertyValue('--scale-factor'));
      const cell = layer.parentElement?.getBoundingClientRect().height ?? 0;
      return Number(layer.getAttribute('data-text-build') ?? 0) > 0 && Math.abs(scale * heightPt - cell) < 2;
    });
  }, count, pageHeightPt), { timeout: 20_000, timeoutMsg: `${count} text layer(s) never settled at their drawn size` });
}

/** Marks every current span, and records whether any text layer is ever seen
 * empty from here on. */
async function watchLayers(): Promise<void> {
  await browser.execute(() => {
    const w = window as any;
    w.__layerEmptied = false;
    w.__layerObserver?.disconnect();
    for (const span of Array.from(document.querySelectorAll('[data-testid="text-layer"] span'))) {
      (span as HTMLElement).dataset.e2eOldSpan = 'true';
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if ((record.target as Element).childNodes.length === 0) w.__layerEmptied = true;
      }
    });
    for (const layer of Array.from(document.querySelectorAll('[data-testid="text-layer"]'))) {
      if (layer.childNodes.length === 0) w.__layerEmptied = true;
      observer.observe(layer, { childList: true });
    }
    w.__layerObserver = observer;
  });
}

async function rebuildAndWait(): Promise<void> {
  const before = await builds();
  await watchLayers();
  await rebuildTextLayers();
  await browser.waitUntil(async () => {
    const now = await builds();
    return now.length === before.length && now.every((n, i) => n > before[i]);
  }, { timeout: 20_000, timeoutMsg: 'the text layers were never rebuilt' });
  const seen = await browser.execute(() => {
    const w = window as any;
    w.__layerObserver?.disconnect();
    return {
      emptied: w.__layerEmptied as boolean,
      oldSpans: document.querySelectorAll('[data-e2e-old-span]').length,
    };
  });
  expect(seen.emptied).toBe(false);
  expect(seen.oldSpans).toBe(0);
}

/** The live selection's text and which text layer (by page order) holds each end. */
const selectionState = () => browser.execute(() => {
  const sel = window.getSelection();
  const layers = Array.from(document.querySelectorAll('[data-testid="text-layer"]'));
  const layerOf = (node: Node | null) => layers.findIndex((layer) => node !== null && layer.contains(node));
  return {
    text: sel?.toString() ?? '',
    anchorLayer: layerOf(sel?.anchorNode ?? null),
    focusLayer: layerOf(sel?.focusNode ?? null),
  };
});

describe('a text layer rebuilt over the same geometry keeps the selection', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-text-layer-'));
    await waitForHarness();
  });
  after(async () => {
    await browser.execute(() => { (window as any).__layerObserver?.disconnect(); });
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('a selection in one page and its markup bar survive the swap of every span', async () => {
    const source = resolve(tmp, 'one-page.pdf');
    await makePdf(source, [['Selectable sentence kept across a rebuild', 'A second line of body text']], [400, 400]);
    await closeAllFiles();
    await openByPaths([source]);
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await waitForSettledLayers(1, 400);

    const selected = await browser.execute(() => {
      const spans = Array.from(document.querySelectorAll('[data-testid="text-layer"] span')) as HTMLElement[];
      const el = spans.find((s) => (s.textContent ?? '').trim().length > 3);
      if (!el) return '';
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return el.textContent ?? '';
    });
    expect(selected.length).toBeGreaterThan(3);
    const menu = $('[data-testid="text-selection-menu"]');
    await menu.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'no markup bar for the selection' });

    await rebuildAndWait();
    const after = await selectionState();
    expect(after.text).toBe(selected);
    expect(after.anchorLayer).toBe(0);
    expect(after.focusLayer).toBe(0);
    await expect(menu).toBeDisplayed();
    await expect($('[data-testid="markup-highlight"]')).toBeDisplayed();
  });

  // Page 1's last span to page 2's first span, dragged either way.
  for (const direction of ['forward', 'backward'] as const) {
    it(`a selection dragged ${direction} across two pages keeps both ends when both layers rebuild`, async () => {
      // Short, wide pages, so both pages and their text layers are on screen.
      const source = resolve(tmp, `two-pages-${direction}.pdf`);
      await makePdf(source, [
        ['First page opening line', 'First page closing line'],
        ['Second page opening line', 'Second page closing line'],
      ], [600, 120]);
      await closeAllFiles();
      await openByPaths([source]);
      await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
      await waitForSettledLayers(2, 120);

      const selected = await browser.execute((forward: boolean) => {
        const layers = Array.from(document.querySelectorAll('[data-testid="text-layer"]'));
        const spansOf = (layer: Element) =>
          (Array.from(layer.querySelectorAll('span')) as HTMLElement[]).filter((s) => (s.textContent ?? '').trim().length > 3);
        const startText = spansOf(layers[0]).at(-1)?.firstChild;
        const endText = spansOf(layers[1])[0]?.firstChild;
        if (!startText || !endText) return '';
        const end = endText.textContent!.length;
        const sel = window.getSelection();
        if (forward) sel?.setBaseAndExtent(startText, 0, endText, end);
        else sel?.setBaseAndExtent(endText, end, startText, 0);
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        return sel?.toString() ?? '';
      }, direction === 'forward');
      expect(selected).toContain('First page closing line');
      expect(selected).toContain('Second page opening line');
      await $('[data-testid="text-selection-menu"]').waitForDisplayed({ timeout: 10_000, timeoutMsg: 'no markup bar for the selection' });

      await rebuildAndWait();
      const after = await selectionState();
      expect(after.text).toBe(selected);
      // The anchor stays where the drag began: page 1 forward, page 2 backward.
      expect(after.anchorLayer).toBe(direction === 'forward' ? 0 : 1);
      expect(after.focusLayer).toBe(direction === 'forward' ? 1 : 0);
      await expect($('[data-testid="text-selection-menu"]')).toBeDisplayed();
    });
  }
});
