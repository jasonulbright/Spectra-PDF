import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  commandEnabled,
  setContentEditableValue,
} from '../support/harness.js';

// Behaviour of the inline paragraph editor against the acceptance list of the
// issue that asked for it: Esc leaves the PDF alone, click-away commits, undo
// and redo follow a commit, opening and closing never move the view, the
// toolbar stays on the page, a narrow paragraph keeps its width, Ctrl+Enter is
// ignored while an IME composes, and mixed weights inside one paragraph show.

const ORIGINAL = 'Alpha beta gamma delta words flowing on the second line';

type Fixture = { name: string; pages?: number; draw: (page: PDFPage, regular: PDFFont, bold: PDFFont) => void };

const FIXTURES: Fixture[] = [
  {
    name: 'plain',
    draw: (page, f) => {
      const c = rgb(0, 0, 0);
      page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 18, font: f, color: c });
      page.drawText('flowing on the second line', { x: 60, y: 178, size: 18, font: f, color: c });
    },
  },
  {
    // Same paragraph on the first of four pages, so the view can scroll.
    name: 'scrolling',
    pages: 4,
    draw: (page, f) => {
      const c = rgb(0, 0, 0);
      page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 18, font: f, color: c });
      page.drawText('flowing on the second line', { x: 60, y: 178, size: 18, font: f, color: c });
    },
  },
  {
    // A paragraph close to the right edge of the page.
    name: 'rightedge',
    draw: (page, f) => {
      const c = rgb(0, 0, 0);
      page.drawText('Edge words here', { x: 270, y: 200, size: 14, font: f, color: c });
      page.drawText('on two lines', { x: 270, y: 184, size: 14, font: f, color: c });
    },
  },
  {
    // One short word: narrower than the editor's old minimum width.
    name: 'narrow',
    draw: (page, f) => {
      page.drawText('Hi', { x: 60, y: 200, size: 14, font: f, color: rgb(0, 0, 0) });
    },
  },
  {
    // Regular text and a bold run in ONE paragraph.
    name: 'mixed',
    draw: (page, f, b) => {
      const c = rgb(0, 0, 0);
      page.drawText('Plain start', { x: 60, y: 200, size: 16, font: f, color: c });
      page.drawText(' BOLD', { x: 60 + f.widthOfTextAtSize('Plain start', 16), y: 200, size: 16, font: b, color: c });
    },
  },
];

describe('inline paragraph editor behaviour', () => {
  let tmp: string;
  let serial = 0;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-inlinebehave-'));
  });

  // A fresh file per test, so no test starts from another test's edits.
  async function writeFixture(name: string): Promise<{ path: string; file: string }> {
    const fx = FIXTURES.find((f) => f.name === name)!;
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([400, 300]);
    for (let i = 1; i < (fx.pages ?? 1); i += 1) doc.addPage([400, 300]);
    fx.draw(page, regular, bold);
    serial += 1;
    const file = `${name}-${serial}.pdf`;
    const path = resolve(tmp, file);
    writeFileSync(path, await doc.save());
    return { path, file };
  }

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  async function openFixture(name: string): Promise<void> {
    await waitForHarness();
    const { path, file } = await writeFixture(name);
    await openByPaths([path]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes(file),
      { timeout: 15_000, timeoutMsg: `${file} never became active` },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await $('.page-editpara').waitForDisplayed({ timeout: 30_000 });
  }

  async function openEditor(): Promise<void> {
    await $('.page-editpara').doubleClick();
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
  }

  async function paragraphTexts(): Promise<string[]> {
    return await browser.execute(function () {
      const h = (window as any).__SPECTRA_TEST__;
      const ids: string[] = h.editTextPageIds();
      return ids.length > 0 ? h.editParagraphs(ids[0]).map((q: { text: string }) => q.text) : [];
    });
  }

  async function waitForTexts(want: string[], why: string): Promise<void> {
    await browser.waitUntil(async () => JSON.stringify(await paragraphTexts()) === JSON.stringify(want), {
      timeout: 30_000,
      timeoutMsg: why,
    });
  }

  it('Esc closes the editor and leaves the PDF and its history untouched', async function () {
    this.timeout(120_000);
    await openFixture('plain');
    await waitForTexts([ORIGINAL], 'the fixture paragraph was not listed');
    await openEditor();
    await setContentEditableValue('[data-testid="edit-para-input"]', 'Something else entirely');
    await browser.keys(['Escape']);
    await $('[data-testid="edit-para-input"]').waitForExist({ reverse: true, timeout: 10_000 });
    await waitForTexts([ORIGINAL], 'Esc changed the paragraph');
    expect(await commandEnabled('edit.undo')).toBe(false);
  });

  it('click-away commits, undo restores the original, redo applies it again', async function () {
    this.timeout(120_000);
    const edited = 'Alpha beta gamma delta words flowing on the second line, plus more';
    await openFixture('plain');
    await openEditor();
    await setContentEditableValue('[data-testid="edit-para-input"]', edited);
    // Click on the page's empty area, away from the paragraph and its editor.
    const page = await $('[data-page-id]');
    const size = await page.getSize();
    await page.click({ x: 0, y: Math.round(size.height / 2) - 15 });
    await $('[data-testid="edit-para-input"]').waitForExist({ reverse: true, timeout: 30_000 });
    await waitForTexts([edited], 'click-away did not commit');
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForTexts([ORIGINAL], 'undo did not restore the original paragraph');
    expect(await invokeAppCommand('edit.redo')).toBe(true);
    await waitForTexts([edited], 'redo did not apply the edit again');
  });

  it('opening and closing the editor does not move zoom or scroll', async function () {
    this.timeout(120_000);
    const view = async () =>
      await browser.execute(function () {
        const scroller = document.querySelector('[data-testid="document-view"]') as HTMLElement | null;
        const box = (document.querySelector('.page-editpara') as HTMLElement | null)?.getBoundingClientRect();
        return {
          found: scroller !== null,
          room: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
          top: scroller?.scrollTop ?? -1,
          left: scroller?.scrollLeft ?? -1,
          bx: box ? Math.round(box.x) : null,
          by: box ? Math.round(box.y) : null,
        };
      });
    const zoom = async () => (await getState()).readingView?.zoomPercent;
    await openFixture('scrolling');
    await browser.waitUntil(async () => (await zoom()) !== undefined, {
      timeout: 15_000,
      timeoutMsg: 'the reading view never reported a zoom',
    });
    // A real, nonzero scroll offset to preserve.
    const room = (await view()).room;
    expect(room).toBeGreaterThan(60);
    await browser.execute(function () {
      (document.querySelector('[data-testid="document-view"]') as HTMLElement).scrollTop = 40;
    });
    await browser.waitUntil(async () => (await view()).top === 40, {
      timeout: 5_000,
      timeoutMsg: 'the view did not scroll to the test offset',
    });
    const before = await view();
    const zoomBefore = await zoom();
    await openEditor();
    const during = await view();
    expect(await zoom()).toBe(zoomBefore);
    expect(during.top).toBe(before.top);
    expect(during.left).toBe(before.left);
    await browser.keys(['Escape']);
    await $('[data-testid="edit-para-input"]').waitForExist({ reverse: true, timeout: 10_000 });
    await $('.page-editpara').waitForDisplayed({ timeout: 10_000 });
    const after = await view();
    expect(await zoom()).toBe(zoomBefore);
    expect(after.top).toBe(before.top);
    expect(after.left).toBe(before.left);
    expect(after.bx).toBe(before.bx);
    expect(after.by).toBe(before.by);
  });

  it('Ctrl+Enter is ignored while an IME composes, and commits after', async function () {
    this.timeout(120_000);
    await openFixture('plain');
    await openEditor();
    await setContentEditableValue('[data-testid="edit-para-input"]', 'Composed text stays');
    const input = await $('[data-testid="edit-para-input"]');
    await browser.execute(function () {
      const el = document.querySelector('[data-testid="edit-para-input"]') as HTMLElement;
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await browser.keys(['Control', 'Enter']);
    await browser.pause(400);
    expect(await input.isExisting()).toBe(true);
    await browser.execute(function () {
      const el = document.querySelector('[data-testid="edit-para-input"]') as HTMLElement;
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    });
    await browser.keys(['Control', 'Enter']);
    await input.waitForExist({ reverse: true, timeout: 30_000 });
    await waitForTexts(['Composed text stays'], 'the commit after the composition did not apply');
  });

  it('keeps the floating toolbar inside the page near the right edge', async function () {
    this.timeout(120_000);
    await openFixture('rightedge');
    await openEditor();
    const fit = await browser.execute(function () {
      const bar = document.querySelector('.page-editpara-toolbar') as HTMLElement;
      const page = bar.closest('[data-page-id]') as HTMLElement;
      const b = bar.getBoundingClientRect();
      const p = page.getBoundingClientRect();
      return { barRight: b.right, barLeft: b.left, pageRight: p.right, pageLeft: p.left };
    });
    expect(fit.barRight).toBeLessThanOrEqual(fit.pageRight + 1);
    expect(fit.barLeft).toBeGreaterThanOrEqual(fit.pageLeft - 1);
    await browser.keys(['Escape']);
  });

  it('a narrow paragraph keeps its own width in the editor', async function () {
    this.timeout(120_000);
    await openFixture('narrow');
    const boxW = (await $('.page-editpara').getSize()).width;
    await openEditor();
    const editorW = (await $('[data-testid="edit-para-input"]').getSize()).width;
    expect(Math.abs(editorW - boxW)).toBeLessThan(3);
    await browser.keys(['Escape']);
  });

  it('shows a bold run and a regular run inside one paragraph', async function () {
    this.timeout(120_000);
    await openFixture('mixed');
    await openEditor();
    const weights = await browser.execute(function () {
      const root = document.querySelector('[data-testid="edit-para-input"]') as HTMLElement;
      return Array.from(root.querySelectorAll('span[data-seg]')).map((s) => ({
        text: s.textContent,
        weight: Number(getComputedStyle(s as HTMLElement).fontWeight),
      }));
    });
    // Each piece of text carries its own weight: the plain start stays
    // regular and the bold run stays bold.
    expect(weights.some((w) => (w.text ?? '').includes('Plain start') && w.weight < 600)).toBe(true);
    expect(weights.some((w) => (w.text ?? '').includes('BOLD') && w.weight >= 600)).toBe(true);
    await browser.keys(['Escape']);
  });
});
