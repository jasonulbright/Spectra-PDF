import { resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  commandEnabled,
  setContentEditableValue,
} from '../support/harness.js';

// The inline paragraph editor under the conditions the issue lists: a paragraph
// the engine refuses falls back to the text-run editor, the width grips reflow
// the text while the editor stays open, a rotated page keeps the editor on its
// paragraph, and a right-to-left paragraph edits right-to-left.

const ARABIC_FONT = resolve(__dirname, '../../resources/fonts/IBMPlexSansArabic-Regular.ttf');
// Logical order: "marhaba bikum".
const ARABIC = 'مرحبا بكم';

type Build = (doc: PDFDocument) => Promise<void>;

describe('inline paragraph editor conditions', () => {
  let tmp: string;
  let serial = 0;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-inlinecond-'));
  });
  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  async function open(build: Build): Promise<void> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    await build(doc);
    serial += 1;
    const file = `cond-${serial}.pdf`;
    const path = resolve(tmp, file);
    writeFileSync(path, await doc.save());
    await waitForHarness();
    await openByPaths([path]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes(file),
      { timeout: 15_000, timeoutMsg: `${file} never became active` },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
  }

  async function paragraphTexts(): Promise<string[]> {
    return await browser.execute(function () {
      const h = (window as any).__SPECTRA_TEST__;
      const ids: string[] = h.editTextPageIds();
      return ids.length > 0 ? h.editParagraphs(ids[0]).map((q: { text: string }) => q.text) : [];
    });
  }

  it('a paragraph the engine refuses falls back to the text-run editor', async function () {
    this.timeout(120_000);
    await open(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      const c = rgb(0, 0, 0);
      // A clip box that ends between two pieces of one line: one piece shows,
      // the other is clipped away, so the engine refuses the paragraph.
      page.pushOperators(pushGraphicsState(), rectangle(40, 190, 66, 30), clip(), endPath());
      page.drawText('Shown', { x: 60, y: 200, size: 18, font, color: c });
      page.drawText(' cut away', { x: 108, y: 200, size: 18, font, color: c });
      page.pushOperators(popGraphicsState());
    });
    const run = await $('[data-testid^="edit-text-"][class*="page-edittext"]');
    await run.waitForDisplayed({ timeout: 30_000 });
    // No paragraph box: the engine listed no editable paragraph here.
    expect(await $('.page-editpara').isExisting()).toBe(false);
    await run.doubleClick();
    await $('[data-testid="edit-text-input"]').waitForDisplayed({ timeout: 10_000 });
    // The paragraph editor did not open.
    expect(await $('[data-testid="edit-para-input"]').isExisting()).toBe(false);
    await browser.keys(['Escape']);
  });

  it('dragging the width grip reflows the text while the editor stays open', async function () {
    this.timeout(120_000);
    await open(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      const c = rgb(0, 0, 0);
      page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 18, font, color: c });
      page.drawText('flowing on the second line', { x: 60, y: 178, size: 18, font, color: c });
    });
    await $('.page-editpara').waitForDisplayed({ timeout: 30_000 });
    await $('.page-editpara').doubleClick();
    const input = await $('[data-testid="edit-para-input"]');
    await input.waitForDisplayed({ timeout: 10_000 });
    const measure = async () =>
      await browser.execute(function () {
        const el = document.querySelector('[data-testid="edit-para-input"]') as HTMLElement;
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        return { width: el.getBoundingClientRect().width, lines: Math.round(el.scrollHeight / lh) };
      });
    const lineCounts = async (): Promise<number[]> =>
      await browser.execute(function () {
        const h = (window as any).__SPECTRA_TEST__;
        const ids: string[] = h.editTextPageIds();
        return ids.length > 0 ? h.editParagraphs(ids[0]).map((q: { lineCount: number }) => q.lineCount) : [];
      });
    const linesBefore = await lineCounts();
    const before = await measure();
    const grip = await $('[data-testid="edit-para-grip-end"]');
    await grip.waitForDisplayed({ timeout: 10_000 });
    const loc = await grip.getLocation();
    const size = await grip.getSize();
    const cx = Math.round(loc.x + size.width / 2);
    const cy = Math.round(loc.y + size.height / 2);
    await browser.performActions([
      {
        type: 'pointer',
        id: 'p1',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, x: cx, y: cy },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 200, x: Math.max(10, cx - Math.round(before.width * 0.4)), y: cy },
        ],
      },
    ]);
    // Still held down: the editor is narrower and the same text wraps onto
    // more lines, with nothing committed yet.
    await browser.waitUntil(
      async () => {
        const now = await measure();
        return now.width < before.width - 20 && now.lines > before.lines;
      },
      { timeout: 10_000, timeoutMsg: 'the editor did not narrow and rewrap while the grip was held' },
    );
    await browser.performActions([
      { type: 'pointer', id: 'p1', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerUp', button: 0 }] },
    ]);
    await browser.releaseActions();
    // Released: the editor stays open at the dragged width.
    expect(await input.isExisting()).toBe(true);
    const held = await measure();
    expect(held.width).toBeLessThan(before.width - 20);
    // Nothing is committed until the user commits.
    expect(await commandEnabled('edit.undo')).toBe(false);
    await browser.keys(['Control', 'Enter']);
    await input.waitForExist({ reverse: true, timeout: 30_000 });
    await browser.waitUntil(async () => (await lineCounts())[0] > linesBefore[0], {
      timeout: 30_000,
      timeoutMsg: 'the committed width did not rewrap the paragraph',
    });
    // One undo restores the original width.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await lineCounts())[0] === linesBefore[0], {
      timeout: 30_000,
      timeoutMsg: 'undo did not restore the paragraph width',
    });
  });

  it('a rotated page keeps the editor on its paragraph', async function () {
    this.timeout(120_000);
    await open(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      page.setRotation(degrees(90));
      const c = rgb(0, 0, 0);
      page.drawText('Rotated paragraph first', { x: 60, y: 200, size: 16, font, color: c });
      page.drawText('and its second line', { x: 60, y: 182, size: 16, font, color: c });
    });
    const box = await $('.page-editpara');
    await box.waitForDisplayed({ timeout: 30_000 });
    const boxRect = await browser.execute(function () {
      const r = (document.querySelector('.page-editpara') as HTMLElement).getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
    await box.doubleClick();
    const input = await $('[data-testid="edit-para-input"]');
    await input.waitForDisplayed({ timeout: 10_000 });
    const rect = await browser.execute(function () {
      const r = (document.querySelector('[data-testid="edit-para-input"]') as HTMLElement).getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
    expect(Math.abs(rect[0] - boxRect[0])).toBeLessThan(3);
    expect(Math.abs(rect[1] - boxRect[1])).toBeLessThan(3);
    expect(Math.abs(rect[2] - boxRect[2])).toBeLessThan(3);
    await setContentEditableValue('[data-testid="edit-para-input"]', 'Rotated paragraph, edited');
    await browser.keys(['Control', 'Enter']);
    await input.waitForExist({ reverse: true, timeout: 30_000 });
    await browser.waitUntil(
      async () => JSON.stringify(await paragraphTexts()) === JSON.stringify(['Rotated paragraph, edited']),
      { timeout: 30_000, timeoutMsg: 'the rotated-page edit did not commit' },
    );
  });

  it('a right-to-left paragraph edits right-to-left and commits', async function () {
    this.timeout(120_000);
    await open(async (doc) => {
      const font = await doc.embedFont(readFileSync(ARABIC_FONT), { subset: true });
      const page = doc.addPage([400, 300]);
      // The font library reorders right-to-left text to visual order itself.
      page.drawText(ARABIC, { x: 200, y: 200, size: 20, font, color: rgb(0, 0, 0) });
    });
    const box = await $('.page-editpara');
    await box.waitForDisplayed({ timeout: 30_000 });
    await box.doubleClick();
    const input = await $('[data-testid="edit-para-input"]');
    await input.waitForDisplayed({ timeout: 10_000 });
    expect(await input.getAttribute('dir')).toBe('rtl');
    const shown = await browser.execute(function () {
      return (document.querySelector('[data-testid="edit-para-input"]') as HTMLElement).textContent;
    });
    expect(shown).toBe(ARABIC);
    // Only letters the embedded subset already holds, so the edit stays encodable.
    const edited = `${ARABIC} مرحبا`;
    await setContentEditableValue('[data-testid="edit-para-input"]', edited);
    await browser.keys(['Control', 'Enter']);
    await input.waitForExist({ reverse: true, timeout: 30_000 });
    await browser.waitUntil(
      async () => JSON.stringify(await paragraphTexts()) === JSON.stringify([edited]),
      { timeout: 30_000, timeoutMsg: 'the right-to-left edit did not commit in logical order' },
    );
  });
});
