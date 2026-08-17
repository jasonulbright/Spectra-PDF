import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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
  setReactSelectValue,
  watermarkSetPdfSource,
} from '../support/harness.js';

/** Click Apply and wait for the run to REALLY finish, by looking for the
 * stamp in the saved bytes.
 *
 * No panel signal settles this on its own. The dirty flag and the final
 * status line are both left behind by the case before ("Watermarked 2
 * pages" is the same sentence every time), so either would pass before the
 * engine round trip started; the transient "Applying …" is set and cleared
 * inside one poll interval on a two-page document. The document itself is
 * the only thing that changes, and each case stamps its own marker. */
async function applyAndSettle(dest: string, marker: string): Promise<void> {
  await $('[data-testid="watermark-apply"]').click();
  await browser.waitUntil(
    async () => {
      await saveActiveAs(dest);
      return (await pageItems(dest)).some((it) => it.includes(marker));
    },
    { timeout: 30_000, interval: 500, timeoutMsg: `the ${marker} stamp never landed` },
  );
}

/** A checkbox driven to a STATE rather than toggled — a case that ran before
 * this one may have left it either way. */
async function setChecked(selector: string, on: boolean): Promise<void> {
  const box = await $(selector);
  await box.waitForDisplayed({ timeout: 10_000 });
  if ((await box.isSelected()) !== on) await box.click();
  await browser.waitUntil(async () => (await $(selector).isSelected()) === on, {
    timeout: 5_000,
    timeoutMsg: `${selector} never reached ${on}`,
  });
}

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function makeTextFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`BODY TEXT PAGE ${i}`, { x: 50, y: 400, size: 18, font });
  }
  writeFileSync(path, await doc.save());
}

/** A one-page board to lift as a watermark source: real vector paths and real
 * text, so both halves of "vector stays vector" are checkable downstream. */
async function makeArtworkFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  page.drawRectangle({ x: 0, y: 0, width: 133, height: 200, color: rgb(0.86, 0.12, 0.12) });
  page.drawText('LETTERHEAD', { x: 160, y: 90, size: 24, font });
  writeFileSync(path, await doc.save());
}

/** The raw text ITEMS of one page. A tiled stamp overlaps itself, and pdf.js
 * splits and reorders the overlapping runs — the joined string of a page
 * carrying six copies of "TILEME" reads "LEME TILEM LEME TILEM …", so a
 * substring count of the whole word finds none. Counting the ITEMS that carry
 * any part of the word is the claim that survives fragmentation. */
async function pageItems(path: string, page = 1): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
  }).promise;
  const content = (await (await pdf.getPage(page)).getTextContent()) as {
    items: { str?: string }[];
  };
  const items = content.items.map((it) => it.str ?? '').filter((s) => s.trim().length > 0);
  await pdf.loadingTask.destroy();
  return items;
}

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
  }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = (await page.getTextContent()) as { items: { str?: string }[] };
    texts.push(content.items.map((it) => it.str ?? '').join(' '));
  }
  await pdf.loadingTask.destroy();
  return texts;
}

describe('watermark panel stamps text through the real engine round trip', () => {
  let tmp: string;
  let source: string;
  let dest: string;
  let artwork: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-wm-'));
    source = resolve(tmp, 'watermark-me.pdf');
    dest = resolve(tmp, 'watermarked.pdf');
    artwork = resolve(tmp, 'letterhead.pdf');
    await makeTextFixture(source);
    await makeArtworkFixture(artwork);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('applies the panel form to every page of the saved file', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('watermark');

    // NOT setValue — see setReactInputValue for why (controlled-input clear
    // race + WebView2 keystroke drops, both observed live in this spec).
    await setReactInputValue('[data-testid="watermark-text"]', 'E2E-WATERMARK');
    await $('[data-testid="watermark-apply"]').click();

    // UPDATE_FILE marks the file dirty once the engine round trip lands.
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
      timeout: 20_000,
      timeoutMsg: 'watermark apply never marked the file dirty',
    });

    await saveActiveAs(dest);
    expect(existsSync(dest)).toBe(true);

    const texts = await pageTexts(dest);
    expect(texts).toHaveLength(2);
    for (const [i, text] of texts.entries()) {
      expect(text).toContain('E2E-WATERMARK');
      expect(text).toContain(`BODY TEXT PAGE ${i + 1}`);
    }
  });

  it('the source toggle swaps the text field for the image picker', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('watermark');

    await setReactSelectValue('[data-testid="watermark-source"]', 'text');
    expect(await $('[data-testid="watermark-text"]').isExisting()).toBe(true);
    expect(await $('[data-testid="watermark-pick-image"]').isExisting()).toBe(false);

    await setReactSelectValue('[data-testid="watermark-source"]', 'image');
    await browser.waitUntil(
      async () => $('[data-testid="watermark-pick-image"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'image mode never showed its picker' },
    );
    // The text field and the colour swatches belong to the text source only.
    expect(await $('[data-testid="watermark-text"]').isExisting()).toBe(false);
    expect(await $('[data-testid="watermark-image-name"]').getText()).not.toBe('');

    // Applying with no image chosen refuses in the panel, before the engine.
    await $('[data-testid="watermark-apply"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="status-bar"]').getText()).includes('image'),
      { timeout: 5_000, timeoutMsg: 'no-image refusal never surfaced' },
    );
  });

  it('tiling stamps the text many times on one page', async () => {
    const tiled = resolve(tmp, 'tiled.pdf');
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('watermark');

    // The panel is not remounted between opens, so the source a previous case
    // left is still selected — every case names the source it wants.
    await setReactSelectValue('[data-testid="watermark-source"]', 'text');
    await setReactInputValue('[data-testid="watermark-text"]', 'TILEME');
    await setReactInputValue('[data-testid="watermark-angle"]', '0');
    await setReactInputValue('[data-testid="watermark-scale"]', '0.25');
    await setChecked('[data-testid="watermark-tile"]', true);
    // A tiled stamp is fragmented by pdf.js, so the settle marker is a
    // fragment the reorder cannot destroy.
    await applyAndSettle(tiled, 'ILEM');

    // Tiling is the one placement claim a text extractor can settle: several
    // copies of the stamp on ONE page. Where each copy LANDS is proved by
    // raster diff in the engine suite, which a text layer cannot show.
    const items = await pageItems(tiled);
    const stamps = items.filter((it) => /TILE|ILEM|LEME/.test(it));
    expect(stamps.length).toBeGreaterThan(2);
    expect(items.join(' ')).toContain('BODY TEXT PAGE 1');
  });

  it('a corner position keeps the stamp on the page', async () => {
    const cornered = resolve(tmp, 'cornered.pdf');
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('watermark');

    await setReactSelectValue('[data-testid="watermark-source"]', 'text');
    await setReactInputValue('[data-testid="watermark-text"]', 'CORNERED');
    await setReactInputValue('[data-testid="watermark-angle"]', '0');
    await setChecked('[data-testid="watermark-tile"]', false);
    await setReactSelectValue('[data-testid="watermark-position"]', 'bottom-right');
    await applyAndSettle(cornered, 'CORNERED');
    expect((await pageTexts(cornered))[0]).toContain('CORNERED');
  });

  it('the source toggle swaps in the PDF picker and its page field', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('watermark');

    await setReactSelectValue('[data-testid="watermark-source"]', 'pdf');
    await browser.waitUntil(async () => $('[data-testid="watermark-pick-pdf"]').isExisting(), {
      timeout: 5_000,
      timeoutMsg: 'PDF mode never showed its picker',
    });
    // The other two sources' inputs belong to them alone.
    expect(await $('[data-testid="watermark-text"]').isExisting()).toBe(false);
    expect(await $('[data-testid="watermark-pick-image"]').isExisting()).toBe(false);
    expect(await $('[data-testid="watermark-pdf-page"]').isExisting()).toBe(true);

    // Applying with no PDF chosen refuses in the panel, before the engine.
    await $('[data-testid="watermark-apply"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="status-bar"]').getText()).includes('PDF'),
      { timeout: 5_000, timeoutMsg: 'no-PDF refusal never surfaced' },
    );
  });

  it('stamps a page of another PDF as vector artwork on every page', async () => {
    const lifted = resolve(tmp, 'lifted.pdf');
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('watermark');

    // The picker is native; the harness sets the state a pick would set and
    // the REAL Apply button runs the REAL engine call.
    await watermarkSetPdfSource(artwork, 1);
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="watermark-pdf-name"]').getText()).includes('letterhead'),
      { timeout: 5_000, timeoutMsg: 'the injected PDF source never reached the panel' },
    );
    await setReactInputValue('[data-testid="watermark-angle"]', '0');
    // The panel is not remounted between opens, so every numeric control a
    // previous case moved is named here too.
    await setReactInputValue('[data-testid="watermark-scale"]', '1');
    await setChecked('[data-testid="watermark-tile"]', false);
    await setReactSelectValue('[data-testid="watermark-position"]', 'center');
    // The lifted page keeps its own text, which is what "vector stays vector"
    // means at this layer — a rasterized stamp would extract nothing.
    await applyAndSettle(lifted, 'LETTERHEAD');

    const texts = await pageTexts(lifted);
    expect(texts).toHaveLength(2);
    for (const [i, text] of texts.entries()) {
      expect(text).toContain('LETTERHEAD');
      expect(text).toContain(`BODY TEXT PAGE ${i + 1}`);
    }
  });
});
