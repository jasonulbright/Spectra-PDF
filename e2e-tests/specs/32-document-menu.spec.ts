import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getState,
  getActiveDocPages,
  commitPendingEdits,
  saveActiveAs,
  setReactInputValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// M6.3: menu completeness (§ 9.1) + Insert Blank Page (§ 9.3) + the new
// chords, driven through the real menu DOM and the real keys.

async function clickMenuPath(menu: string, ...items: string[]): Promise<void> {
  await $(`[data-testid="menu-${menu}"]`).click();
  for (const item of items) {
    const el = $(`[data-testid="${item}"]`);
    await el.waitForDisplayed({ timeoutMsg: `${item} not in the open menu` });
    await el.click();
  }
}

/** Per-page extracted text of a committed file, via a third reader (pdf.js). */
async function pageTexts(path: string): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' ').trim());
  }
  await doc.loadingTask.destroy();
  return out;
}

describe('document menu (M6.3)', () => {
  let tmp: string;
  let threePager: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ops-e2e-docmenu-'));
    // Three DISTINCT page sizes with per-page text: the size sequence pins the
    // neighbor rule and the text sequence pins the insertion POSITION — a
    // same-size fixture passed identically under prepend/append bugs
    // (review-caught).
    threePager = resolve(tmp, 'three.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const alpha = doc.addPage([400, 500]);
    alpha.drawText('alpha', { x: 40, y: 400, size: 14, font });
    const bravo = doc.addPage([300, 600]);
    bravo.drawText('bravo', { x: 40, y: 400, size: 14, font });
    const charlie = doc.addPage([500, 400]);
    charlie.drawText('charlie', { x: 40, y: 300, size: 14, font });
    writeFileSync(threePager, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('Blank Page inserts AFTER the page being read, sized like IT', async () => {
    await waitForHarness();
    await openByPaths([threePager]);
    await browser.waitUntil(
      async () => (await getActiveDocPages()).length === 3,
      { timeoutMsg: 'fixture never indexed' },
    );

    // Read page 2 first (the 300x600 one), through the real go-to-page UI —
    // Ctrl+Shift+N focuses the box (§ 9.2), Enter navigates.
    await browser.keys(['Control', 'Shift', 'n']);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          document.activeElement?.getAttribute('data-testid'),
        )) === 'page-nav-box',
      { timeoutMsg: 'Ctrl+Shift+N did not focus the page box' },
    );
    await setReactInputValue('[data-testid="page-nav-box"]', '2');
    await browser.keys(['Enter']);
    const pagesNow = await getActiveDocPages();
    await browser.waitUntil(
      async () => (await getState()).currentPageId === pagesNow[1].id,
      { timeoutMsg: 'go-to-page never made page 2 current' },
    );

    await clickMenuPath('document', 'submenu-document-insert', 'menuitem-document-insert-blank');

    await browser.waitUntil(
      async () => (await getActiveDocPages()).length === 4,
      { timeoutMsg: 'Blank Page did not add a page' },
    );
    // Neighbor rule: the blank copies page 2's size (300x600) — not page 1's,
    // not the Letter default.
    const pages = await getActiveDocPages();
    expect(pages.map((p) => [p.width, p.height])).toEqual([
      [400, 500], [300, 600], [300, 600], [500, 400],
    ]);
  });

  it('the insert is page-tier work: undo removes it, redo restores it', async () => {
    await browser.keys(['Control', 'z']);
    await browser.waitUntil(
      async () => (await getActiveDocPages()).length === 3,
      { timeoutMsg: 'undo did not remove the blank page' },
    );
    await browser.keys(['Control', 'y']);
    await browser.waitUntil(async () => (await getActiveDocPages()).length === 4);
  });

  it('the committed FILE carries the blank at POSITION 3 — empty, neighbor-sized', async () => {
    await commitPendingEdits();
    const dest = resolve(tmp, 'with-blank.pdf');
    await saveActiveAs(dest);

    const doc = await PDFDocument.load(readFileSync(dest));
    expect(doc.getPageCount()).toBe(4);
    const { width, height } = doc.getPage(2).getSize();
    expect(width).toBe(300);
    expect(height).toBe(600);

    // The text sequence is what discriminates POSITION: 'bravo' then the
    // empty page, then 'charlie'. Prepend, append, or insert-BEFORE-current
    // each produce a different sequence.
    expect(await pageTexts(dest)).toEqual(['alpha', 'bravo', '', 'charlie']);
  });

  it('View menu flips the pane mode both ways', async () => {
    await clickMenuPath('view', 'menuitem-view-organize-all');
    await browser.waitUntil(async () => (await getState()).docViewMode === 'organize', {
      timeoutMsg: 'Organize All Documents did not switch the pane',
    });
    await clickMenuPath('view', 'menuitem-view-document');
    await browser.waitUntil(async () => (await getState()).docViewMode === 'document', {
      timeoutMsg: 'Document View did not switch back',
    });
  });

  it('F3 opens Find, then steps matches — even from inside the find field', async () => {
    const textPdf = resolve(tmp, 'f3.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText('aurora on page one', { x: 40, y: 200, size: 14, font });
    doc.addPage([400, 300]).drawText('aurora again on page two', { x: 40, y: 200, size: 14, font });
    writeFileSync(textPdf, await doc.save());

    await closeAllFiles();
    await openByPaths([textPdf]);
    await browser.keys(['F3']);
    await $('[data-testid="find-input"]').waitForDisplayed({
      timeoutMsg: 'F3 did not open the Find bar',
    });
    await setReactInputValue('[data-testid="find-input"]', 'aurora');
    const cursor = $('[data-testid="find-cursor"]');
    await browser.waitUntil(
      async () => (await $('[data-testid="find-count"]').getText()).includes('match'),
      { timeoutMsg: 'no match count after typing a query' },
    );
    // Focus is still in the input — F3 must STEP, not type into the field.
    await browser.keys(['F3']);
    await browser.waitUntil(async () => (await cursor.getText()).startsWith('1/'), {
      timeoutMsg: 'F3 did not land on the first match page',
    });
    await browser.keys(['F3']);
    await browser.waitUntil(async () => (await cursor.getText()).startsWith('2/'), {
      timeoutMsg: 'second F3 did not advance',
    });
    await browser.keys(['Shift', 'F3']);
    await browser.waitUntil(async () => (await cursor.getText()).startsWith('1/'), {
      timeoutMsg: 'Shift+F3 did not step back',
    });
    expect(await $('[data-testid="find-input"]').getValue()).toBe('aurora');
    await browser.keys(['Escape']);
  });

  it('Edit ▸ Copy really copies — by MOUSE, the path that used to collapse the selection', async () => {
    // Select real text-layer content programmatically (a mouse drag would
    // work too; the point under test is what happens AFTER the selection).
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const span = document.querySelector('.textLayer span');
          if (!span || !span.textContent?.includes('aurora')) return false;
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          const r = document.createRange();
          r.selectNodeContents(span);
          sel.addRange(r);
          return true;
        }),
      { timeoutMsg: 'no text-layer span to select' },
    );

    await $('[data-testid="menu-edit"]').click();
    const copy = $('[data-testid="menuitem-edit-copy"]');
    await copy.waitForDisplayed();
    // Enablement re-resolves on menu OPEN (the selection isn't app state).
    expect(await copy.getAttribute('data-disabled')).toBeNull();
    // A REAL mouse click: its pointerdown used to collapse the selection
    // before onSelect ran, so Copy copied nothing, ever, by mouse
    // (review-caught) — this click is the discriminator.
    await copy.click();

    // Round-trip through a real paste — no clipboard-read permission needed.
    await browser.keys(['Control', 'f']);
    await $('[data-testid="find-input"]').waitForDisplayed();
    await setReactInputValue('[data-testid="find-input"]', '');
    await $('[data-testid="find-input"]').click();
    await browser.keys(['Control', 'v']);
    await browser.waitUntil(
      async () => (await $('[data-testid="find-input"]').getValue()).includes('aurora'),
      { timeoutMsg: 'pasted clipboard does not contain the copied text' },
    );
    await browser.keys(['Escape']);
  });

  it('File ▸ Export ▸ Text… opens the extract pane; Edit ▸ Copy grays without a selection', async () => {
    await browser.execute(() => window.getSelection()?.removeAllRanges());
    await clickMenuPath('file', 'submenu-file-export', 'menuitem-file-export-text');
    await browser.waitUntil(
      async () => (await getState()).activeOp === 'extract_text',
      { timeoutMsg: 'Export ▸ Text… did not open the extract pane' },
    );

    await $('[data-testid="menu-edit"]').click();
    const copy = $('[data-testid="menuitem-edit-copy"]');
    await copy.waitForDisplayed();
    expect(await copy.getAttribute('data-disabled')).not.toBeNull();
    await browser.keys(['Escape']);
  });
});
