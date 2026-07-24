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
  closeAllFiles,
  getFirstAnnotation,
  commitPendingEdits,
  saveActiveAs,
  setReactInputValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Authoring markup BY GESTURE (the N-cluster's create half): select text on the
// page in the reading view and the floating bar turns it into a native
// /Highlight (or Underline/StrikeOut/Squiggly) with real /QuadPoints.

async function makeTextPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText('Selectable sentence for markup', { x: 40, y: 320, size: 16, font });
  page.drawText('A second line of body text', { x: 40, y: 290, size: 16, font });
  writeFileSync(path, await doc.save());
}

/** Select the first non-trivial text-layer span, then release the pointer —
 *  the bar is placed on release, exactly as a real drag ends. */
async function selectFirstTextSpan(): Promise<string> {
  return await browser.execute(function () {
    const spans = Array.from(
      document.querySelectorAll('[data-testid="text-layer"] span'),
    ) as HTMLElement[];
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
}

interface AnnotOnDisk {
  subtype: string;
  quadPoints?: number[];
  url?: string;
}
async function annotationsOf(path: string): Promise<AnnotOnDisk[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as AnnotOnDisk[];
  await pdf.loadingTask.destroy();
  return annots;
}

describe('authoring text markup from a selection', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-markup-'));
    source = resolve(tmp, 'text.pdf');
    await makeTextPdf(source);
    await waitForHarness();
    await closeAllFiles();
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('selecting text offers a markup bar that authors a quad-carrying highlight', async () => {
    await openByPaths([source]);
    // The reading view is where the text layer lives; a document opens there.
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(
      async () => (await $$('[data-testid="text-layer"] span')).length > 0,
      { timeout: 20_000, timeoutMsg: 'the text layer never rendered' },
    );

    const text = await selectFirstTextSpan();
    expect(text.length).toBeGreaterThan(3);

    const menu = $('[data-testid="text-selection-menu"]');
    await menu.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'no markup bar for the selection' });
    await $('[data-testid="markup-highlight"]').click();

    const first = await getFirstAnnotation(15_000);
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('textmarkup');
    expect(first!.markupType).toBe('highlight');
    expect(first!.quadCount).toBeGreaterThan(0); // real quads, not a bare box

    // The bar goes away with the selection it acted on.
    await browser.waitUntil(async () => !(await menu.isExisting()), {
      timeout: 5_000,
      timeoutMsg: 'the markup bar outlived the selection',
    });
  });

  it('links the same selection to a URL', async () => {
    await browser.waitUntil(
      async () => (await $$('[data-testid="text-layer"] span')).length > 0,
      { timeout: 20_000, timeoutMsg: 'the text layer never rendered' },
    );
    await selectFirstTextSpan();
    await $('[data-testid="text-selection-menu"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="markup-link"]').click();
    // The URL editor replaces the buttons; typing destroys the selection, which
    // is exactly why the quads are captured when it opens.
    const input = $('[data-testid="markup-link-url"]');
    await input.waitForDisplayed({ timeout: 5_000 });
    await setReactInputValue('[data-testid="markup-link-url"]', 'https://example.com/linked');
    await $('[data-testid="markup-link-apply"]').click();
    // The link is written by the engine (not the page tier), so the file itself
    // now carries it — the bar closes once that lands.
    await browser.waitUntil(
      async () => !(await $('[data-testid="markup-link-url"]').isExisting()),
      { timeout: 30_000, timeoutMsg: 'the link editor never closed (create failed?)' },
    );
  });

  it('commits to a native /Highlight with /QuadPoints on disk', async () => {
    await commitPendingEdits();
    const dest = resolve(tmp, 'marked.pdf');
    await saveActiveAs(dest);
    const annots = await annotationsOf(dest);
    const highlights = annots.filter((a) => a.subtype === 'Highlight');
    expect(highlights).toHaveLength(1);
    // The authored link rides along in the same file.
    const links = annots.filter((a) => a.subtype === 'Link');
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((l) => (l as { url?: string }).url?.includes('example.com/linked'))).toBe(true);
    // 8 numbers per quad (UL, UR, LL, LR) — the marker of real text markup
    // rather than a rectangle pretending to be one.
    expect(highlights[0].quadPoints?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
