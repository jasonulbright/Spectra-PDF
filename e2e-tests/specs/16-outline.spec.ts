import { resolve } from 'node:path';
import { readFileSync, copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
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
  setView,
  saveActiveAs,
  closeAllFiles,
  getState,
  getOutlineOrder,
  reorderOutline,
} from '../support/harness.js';

// bookmarked.pdf: 5 pages; outline = Chapter 1 [Section 1.1, Section 1.2],
// External Link (URI action → https://example.com/x), Chapter 2.
const BOOKMARKED_PDF = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(path: string) {
  return pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false })
    .promise;
}

// pdf.js exposes a URI action bookmark's target as `url`/`unsafeUrl`.
interface PdfOutlineItem {
  title: string;
  url: string | null;
  unsafeUrl?: string | null;
  items: PdfOutlineItem[];
}

const titles = (items: PdfOutlineItem[]): string[] => items.map((i) => i.title);

// M3.2b: the outline surface is now the nav-pane Bookmarks panel (the
// right-rail OutlineSidebar retired). It registers the same harness hooks
// (getOutlineOrder / reorderOutline) on mount, so only the "open it" step
// changed — from the toggle-outline pill to the nav icon strip.
async function showOutline(): Promise<void> {
  const icon = await $('[data-testid="navicon-bookmarks"]');
  await icon.waitForClickable({ timeout: 15_000 });
  const pressed = await icon.getAttribute('aria-pressed');
  if (pressed !== 'true') await icon.click();
  // The panel registers its harness hooks on mount, then reads the outline
  // through the engine. Each spec FILE launches a fresh app (see wdio.conf
  // afterSession reaping), so the first read here waits on the engine's cold
  // boot — which eagerly imports the full pyHanko stack (engine/__main__.py) —
  // on top of app launch + first canvas render. On a loaded CI runner that
  // cold path occasionally exceeded the old 10s budget (observed ~2/5); the
  // engine read itself is instant, so a wider budget just absorbs boot jitter.
  await browser.waitUntil(async () => (await getOutlineOrder()).length > 0, {
    timeout: 20_000,
    timeoutMsg: 'bookmarks panel never populated',
  });
}

describe('outline sidebar (2n.2)', () => {
  let tmp: string;
  let bookA: string;
  let bookB: string;
  let bookC: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-outline-'));
    bookA = resolve(tmp, 'book-a.pdf');
    bookB = resolve(tmp, 'book-b.pdf');
    bookC = resolve(tmp, 'book-c.pdf');
    copyFileSync(BOOKMARKED_PDF, bookA);
    copyFileSync(BOOKMARKED_PDF, bookB);
    copyFileSync(BOOKMARKED_PDF, bookC);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await waitForHarness();
    await closeAllFiles();
    await browser.waitUntil(async () => (await getState()).fileCount === 0, {
      timeout: 5_000,
      timeoutMsg: 'files never closed between cases',
    });
  });

  it('reorders a top-level node and persists the new order with its URI action preserved', async () => {
    await openByPaths([bookA]);
    await setView('canvas');
    await showOutline();

    // Initial flattened order + depths.
    const before = await getOutlineOrder();
    expect(before.map((r) => r.title)).toEqual([
      'Chapter 1',
      'Section 1.1',
      'Section 1.2',
      'External Link',
      'Chapter 2',
    ]);
    expect(before.map((r) => r.depth)).toEqual([0, 1, 1, 0, 0]);

    // Move "External Link" (root index 1) to the very top at depth 0.
    await reorderOutline([1], 0, 0);
    await browser.waitUntil(
      async () => (await getOutlineOrder())[0]?.title === 'External Link',
      { timeout: 10_000, timeoutMsg: 'reorder did not surface in the sidebar' },
    );
    expect((await getOutlineOrder()).map((r) => r.title)).toEqual([
      'External Link',
      'Chapter 1',
      'Section 1.1',
      'Section 1.2',
      'Chapter 2',
    ]);

    // Independently verify the SAVED file: reordered top level + the URI action
    // survived the get→reorder→set round trip (2l action preservation).
    const dest = resolve(tmp, 'reordered.pdf');
    await saveActiveAs(dest);
    const pdf = await loadPdf(dest);
    const outline = (await pdf.getOutline()) as PdfOutlineItem[];
    expect(titles(outline)).toEqual(['External Link', 'Chapter 1', 'Chapter 2']);
    const link = outline[0];
    expect(link.url ?? link.unsafeUrl ?? '').toContain('example.com/x');
    // Chapter 1 still owns its two sections.
    const ch1 = outline.find((i) => i.title === 'Chapter 1')!;
    expect(titles(ch1.items)).toEqual(['Section 1.1', 'Section 1.2']);
    await pdf.loadingTask.destroy();
  });

  it('nests a node under another (reparenting) and persists the new tree', async () => {
    await openByPaths([bookB]);
    await setView('canvas');
    await showOutline();

    // Nest "Chapter 2" (root index 2) as the last child of "Chapter 1": lifting
    // it leaves [Ch1(d0), S1.1(d1), S1.2(d1), Link(d0)]; drop after S1.2
    // (overIndex 3) at depth 1.
    await reorderOutline([2], 3, 1);
    await browser.waitUntil(
      async () => (await getOutlineOrder()).some((r) => r.title === 'Chapter 2' && r.depth === 1),
      { timeout: 10_000, timeoutMsg: 'reparent did not surface in the sidebar' },
    );
    expect((await getOutlineOrder()).map((r) => `${r.title}@${r.depth}`)).toEqual([
      'Chapter 1@0',
      'Section 1.1@1',
      'Section 1.2@1',
      'Chapter 2@1',
      'External Link@0',
    ]);

    const dest = resolve(tmp, 'reparented.pdf');
    await saveActiveAs(dest);
    const pdf = await loadPdf(dest);
    const outline = (await pdf.getOutline()) as PdfOutlineItem[];
    expect(titles(outline)).toEqual(['Chapter 1', 'External Link']);
    const ch1 = outline.find((i) => i.title === 'Chapter 1')!;
    expect(titles(ch1.items)).toEqual(['Section 1.1', 'Section 1.2', 'Chapter 2']);
    await pdf.loadingTask.destroy();
  });

  it('serializes two rapid drops — the last one wins and persists, no stale overwrite (review #1)', async () => {
    await openByPaths([bookC]);
    await setView('canvas');
    await showOutline();

    // Fire two reorders synchronously (both read the same pre-render tree, so
    // the SECOND must win), then await BOTH persists. Without the persist chain
    // their snapshot/set_outline/readBuffer sequences could interleave and let
    // the first (stale) order win the file on disk.
    const err = await browser.executeAsync<string | null, []>((done) => {
      const h = (window as any).__SPECTRA_TEST__;
      const p1 = h.reorderOutline([2], 0, 0); // Chapter 2 → top
      const p2 = h.reorderOutline([1], 0, 0); // External Link → top (from the original tree)
      Promise.all([p1, p2])
        .then(() => done(null))
        .catch((e: unknown) => done(String(e)));
    });
    if (err) throw new Error(`rapid reorder failed: ${err}`);

    const dest = resolve(tmp, 'rapid.pdf');
    await saveActiveAs(dest);
    const pdf = await loadPdf(dest);
    const outline = (await pdf.getOutline()) as PdfOutlineItem[];
    // The SAVED file reflects the last drop (External Link on top), not the first.
    expect(titles(outline)[0]).toBe('External Link');
    await pdf.loadingTask.destroy();
  });
});
