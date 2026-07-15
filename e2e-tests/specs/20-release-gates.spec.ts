// The remaining release-gate coverage (2p): the bookmarks PANEL edit flow,
// context-menu page ops through the real DOM menu, and the canvas page drag
// driven by raw W3C pointer actions against usePageDrag's window-level
// native listeners (the harness-dispatch specs cover the reducer paths; this
// proves the pointer mechanics themselves).
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
  setDocViewMode,
  saveActiveAs,
  closeAllFiles,
  commitPendingEdits,
  getWorkspacePageIds,
  setReactInputValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const BOOKMARKED = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

async function makeTwoPager(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 300]);
  p1.drawText('PAGEONE', { x: 40, y: 150, font, size: 24 });
  const p2 = doc.addPage([400, 300]);
  p2.drawText('PAGETWO', { x: 40, y: 150, font, size: 24 });
  writeFileSync(path, await doc.save());
}

async function pageText(path: string, pageNumber: number): Promise<string> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const content = (await (await pdf.getPage(pageNumber)).getTextContent()) as {
    items: { str?: string }[];
  };
  await pdf.loadingTask.destroy();
  return content.items.map((i) => i.str ?? '').join(' ');
}

async function pageRotation(path: string, pageNumber: number): Promise<number> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const rotate = (await pdf.getPage(pageNumber)).rotate;
  await pdf.loadingTask.destroy();
  return rotate;
}

async function outlineTitles(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const outline = ((await pdf.getOutline()) ?? []) as { title: string }[];
  await pdf.loadingTask.destroy();
  return outline.map((o) => o.title);
}

describe('release gates (2p)', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-gates-'));
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('bookmarks panel: rename + add through the real editor, saved to the file', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([BOOKMARKED]);
    // M3.2b: the bookmarks editor is the nav-pane Bookmarks panel now (the Tools
    // OutlinePanel retired). Open it on the doc board via the nav icon strip.
    await setView('canvas');
    const icon = $('[data-testid="navicon-bookmarks"]');
    await icon.waitForClickable({ timeout: 15_000 });
    if ((await icon.getAttribute('aria-pressed')) !== 'true') await icon.click();

    const firstTitle = $('[data-testid="bookmark-title"]');
    await firstTitle.waitForDisplayed({ timeout: 15_000 });
    // Rename the first bookmark — focus + set + Enter commits (onBlur → save).
    await firstTitle.click();
    await setReactInputValue('[data-testid="bookmark-title"]', 'Renamed Chapter');
    await browser.keys(['Enter']);

    // Add a new top-level bookmark and title its (last) input, then commit.
    await $('[data-testid="bookmark-add"]').click();
    await browser.execute(function (value: string) {
      const inputs = document.querySelectorAll('[data-testid="bookmark-title"]');
      const input = inputs[inputs.length - 1] as HTMLInputElement;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.blur();
    }, 'Appendix Z');

    // The edits auto-save to the WORKING file async; a panel round-trip
    // (switch away + back) reloads the outline from disk, proving the saves
    // landed before saveActiveAs (a raw copy of the working file) captures them.
    await $('[data-testid="navicon-pages"]').click();
    await $('[data-testid="pages-panel"]').waitForDisplayed();
    await $('[data-testid="navicon-bookmarks"]').click();
    await $('[data-testid="bookmark-row"]').waitForDisplayed();
    await browser.waitUntil(
      async () => {
        const titles = await $$('[data-testid="bookmark-title"]').map((el) => el.getValue());
        return titles[0] === 'Renamed Chapter' && titles.includes('Appendix Z');
      },
      { timeout: 15_000, timeoutMsg: 'bookmark edits did not persist to the working file' },
    );

    const dest = resolve(tmp, 'rebookmarked.pdf');
    await saveActiveAs(dest);
    const titles2 = await outlineTitles(dest);
    expect(titles2[0]).toBe('Renamed Chapter');
    expect(titles2).toContain('Appendix Z');
  });

  it('context menu: rotate + delete through the real menu DOM', async () => {
    const source = resolve(tmp, 'two.pdf');
    await makeTwoPager(source);
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    // This drives the BOARD's page cells; documents open in the reading view
    // since M4.1g, so ask for the board explicitly.
    await setDocViewMode('organize');

    let ids: string[] = [];
    await browser.waitUntil(
      async () => {
        ids = await getWorkspacePageIds();
        return ids.length === 2;
      },
      { timeout: 15_000, timeoutMsg: 'workspace indexer never produced pages' },
    );

    // Open the menu on page 1 by dispatching the REAL contextmenu event on
    // its cell (the menu itself is ordinary fixed-position DOM).
    const openMenuOn = async (pageId: string): Promise<void> => {
      await browser.execute(function (id: string) {
        // Page ids embed Windows paths — backslashes break a CSS attribute
        // selector, so match on the attribute VALUE instead.
        const el = Array.from(document.querySelectorAll('[data-page-id]')).find(
          (e) => e.getAttribute('data-page-id') === id,
        )!;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          }),
        );
      }, pageId);
      await $('[data-testid="context-menu"]').waitForDisplayed({ timeout: 5_000 });
    };

    await openMenuOn(ids[0]);
    await $('button=Rotate right 90°').click();
    await openMenuOn(ids[1]);
    await $('button=Delete page').click();
    await commitPendingEdits();

    const dest = resolve(tmp, 'menu-ops.pdf');
    await saveActiveAs(dest);
    expect(await pageRotation(dest, 1)).toBe(90);
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(dest)),
      isEvalSupported: false,
    }).promise;
    expect(pdf.numPages).toBe(1);
    await pdf.loadingTask.destroy();
    expect(await pageText(dest, 1)).toContain('PAGEONE'); // page 2 was deleted
  });

  it('page drag: a real W3C pointer drag reorders pages, committed to the file', async () => {
    const source = resolve(tmp, 'drag.pdf');
    await makeTwoPager(source);
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    // The page-reorder drag is Organize-view-only by design (the reading view
    // is a column, not an arrangement surface) — select the board explicitly.
    await setDocViewMode('organize');

    let ids: string[] = [];
    await browser.waitUntil(
      async () => {
        ids = await getWorkspacePageIds();
        return ids.length === 2;
      },
      { timeout: 15_000, timeoutMsg: 'workspace indexer never produced pages' },
    );

    // Viewport-space centers of both cells (the canvas transform is already
    // applied in getBoundingClientRect).
    const rects = (await browser.execute(function (a: string, b: string) {
      // Attribute-VALUE match — ids embed Windows paths (see openMenuOn).
      const byId = (id: string): DOMRect =>
        Array.from(document.querySelectorAll('[data-page-id]'))
          .find((e) => e.getAttribute('data-page-id') === id)!
          .getBoundingClientRect();
      const ra = byId(a);
      const rb = byId(b);
      return {
        a: { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 },
        b: { x: rb.left + rb.width / 4, y: rb.top + rb.height / 2 },
      };
    }, ids[1], ids[0])) as { a: { x: number; y: number }; b: { x: number; y: number } };

    // Drag page 2 onto the left half of page 1 (an 'into' drop before it) —
    // real trusted pointer events through usePageDrag's window listeners.
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(rects.a.x), y: Math.round(rects.a.y) })
      .down()
      .pause(80)
      .move({ x: Math.round(rects.a.x + 12), y: Math.round(rects.a.y) }) // cross the 6px threshold
      .pause(80)
      .move({ x: Math.round(rects.b.x), y: Math.round(rects.b.y) })
      .pause(120)
      .up()
      .perform();

    await browser.waitUntil(
      async () => {
        const order = await getWorkspacePageIds();
        return order.length === 2 && order[0] === ids[1];
      },
      { timeout: 10_000, timeoutMsg: 'the pointer drag never reordered the pages' },
    );

    await commitPendingEdits();
    const dest = resolve(tmp, 'dragged.pdf');
    await saveActiveAs(dest);
    expect(await pageText(dest, 1)).toContain('PAGETWO'); // reorder baked
    expect(await pageText(dest, 2)).toContain('PAGEONE');
  });
});
