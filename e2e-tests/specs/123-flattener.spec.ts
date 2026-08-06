// Flattener preview: what would be rasterized, then what actually was.
//
// The claim the whole design rests on is that flattening a region does not
// cost the rest of the page. So the assertions are: the preview marks the
// transparent object and the region it will rasterize BEFORE anything is
// written; the apply rasterizes that region; and the thirty lines of text
// outside it are still EXTRACTABLE afterwards — which is exactly what a
// whole-page flatten destroys.
//
// The seam is NOT re-measured here. It is pinned in the engine at three
// resolutions with its counterfactual, against raw pixels; this runner has no
// canvas to rasterize into, so anything it could assert would be weaker than
// what already holds. What this spec is uniquely able to show is the part a
// unit test cannot: the whole chain from the panel's controls to a saved file
// whose text a third reader can still pull out.
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  invokeAppCommand,
  saveActiveAs,
  setReactInputValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const PAGE = resolve(__dirname, '..', 'fixtures', 'transparency-page.pdf');

/** Every wait here stays under the suite's own per-test budget. A wait AT that
 *  budget loses the race to it, and the failure then reads as a bare timeout
 *  with none of the message that says what was being waited for. */
const WAIT_MS = 45_000;

/** The fixture's own construction: thirty text lines and one square. */
const TEXT_LINES = 30;

let workDir = '';

/** Page-1 text of a saved file, through a third reader. */
async function pageOneText(path: string): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  const text = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
  await doc.loadingTask.destroy();
  return text;
}

async function openFlattener(): Promise<void> {
  await setView('operations');
  await invokeAppCommand('view.documentView');
  await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  await setActiveOp('flattener');
  await $('[data-testid="flattener-apply"]').waitForDisplayed({ timeout: 15_000 });
}

/** The panel's count for one category. */
async function categoryCount(category: string): Promise<number> {
  const text = await $(`[data-testid="flattener-category-${category}"]`).getText();
  const match = /(\d+)/.exec(text);
  return match ? Number(match[1]) : -1;
}

async function regionCount(): Promise<number> {
  const text = await $('[data-testid="flattener-regions"]').getText();
  const match = /(\d+)/.exec(text);
  return match ? Number(match[1]) : -1;
}

describe('flattener preview', () => {
  before(async () => {
    workDir = mkdtempSync(resolve(tmpdir(), 'spectra-flatten-'));
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([PAGE]);
    await openFlattener();
  });

  after(async () => {
    await closeAllFiles();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('classifies the page before anything is rewritten', async () => {
    await browser.waitUntil(async () => (await regionCount()) > 0, {
      timeout: WAIT_MS,
      timeoutMsg: 'the flattener never classified the page',
    });
    expect(await regionCount()).toBe(1);
    expect(await categoryCount('transparent')).toBe(1);
    // The square sits clear of every text line, so nothing is under it and no
    // text is inside the region. An over-broad report is what would make the
    // preview useless.
    expect(await categoryCount('affected')).toBe(0);
    expect(await categoryCount('outlined_text')).toBe(0);
  });

  it('marks the region and its objects on the page', async () => {
    await $('[data-testid="flattener-armed"]').click();
    await browser.waitUntil(
      async () => (await $$('[data-flatten-category="region"]')).length > 0,
      { timeout: WAIT_MS, timeoutMsg: 'the region was never marked on the page' },
    );
    const marks = await $$('[data-flatten-category="transparent"]');
    expect(marks.length).toBe(1);
  });

  it('a category switched off stops being drawn', async () => {
    await $('[data-testid="flattener-category-transparent"] input').click();
    await browser.waitUntil(
      async () => (await $$('[data-flatten-category="transparent"]')).length === 0,
      { timeout: 20_000, timeoutMsg: 'the transparent marks outlived the checkbox' },
    );
    // The region is not a category, so it stays.
    expect((await $$('[data-flatten-category="region"]')).length).toBeGreaterThan(0);
    await $('[data-testid="flattener-category-transparent"] input').click();
  });

  it('the balance toward raster swallows the text the vector end kept live', async () => {
    await setReactInputValue('[data-testid="flattener-balance"]', '100');
    await browser.waitUntil(async () => (await categoryCount('outlined_text')) > 0, {
      timeout: WAIT_MS,
      timeoutMsg: 'the raster end of the balance never absorbed the text',
    });
    expect(await categoryCount('outlined_text')).toBe(TEXT_LINES);
    await setReactInputValue('[data-testid="flattener-balance"]', '0');
    await browser.waitUntil(async () => (await categoryCount('outlined_text')) === 0, {
      timeout: WAIT_MS,
      timeoutMsg: 'the vector end never gave the text back',
    });
  });

  it('applying at the vector end leaves the text outside the region live', async () => {
    await $('[data-testid="flattener-apply"]').click();
    // The empty-classification line requires a report that CAME BACK and
    // found nothing; waiting on a zero count alone would pass against the
    // null report the re-read starts from.
    await $('[data-testid="flattener-none"]').waitForDisplayed({ timeout: WAIT_MS });
    expect(await categoryCount('transparent')).toBe(0);
    const flattened = resolve(workDir, 'flattened.pdf');
    await saveActiveAs(flattened);
    const text = await pageOneText(flattened);
    // Every line the fixture drew is still text a reader can pull out.
    for (let i = 0; i < TEXT_LINES; i += 1) {
      const label = `Line ${String(i).padStart(2, '0')}`;
      expect(text).toContain(label);
    }
  });

  it('a page with nothing left to flatten offers nothing to do', async () => {
    expect(await regionCount()).toBe(0);
    expect(await $('[data-testid="flattener-apply"]').isEnabled()).toBe(false);
  });
});
