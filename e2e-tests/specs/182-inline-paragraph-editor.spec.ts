import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setContentEditableValue,
} from '../support/harness.js';

// The paragraph editor sits ON the paragraph it edits: same box, the page's
// own look (face class, colour), no toolbar over the text, and Ctrl+Enter
// commits from the middle of the text.

describe('inline paragraph editor', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-inlinepara-'));
    pdfPath = resolve(tmp, 'inline-para.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const page = doc.addPage([400, 300]);
    const color = rgb(0.7, 0, 0);
    page.drawText('Alpha beta gamma delta words', { x: 60, y: 200, size: 18, font, color });
    page.drawText('flowing on the second line', { x: 60, y: 178, size: 18, font, color });
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('opens over the paragraph box with the paragraph look, and Ctrl+Enter commits', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('inline-para.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    const box = await $('.page-editpara');
    await box.waitForDisplayed({ timeout: 30_000 });
    const boxRect = await browser.execute(function () {
      const r = (document.querySelector('.page-editpara') as HTMLElement).getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
    await box.doubleClick();
    const input = await $('[data-testid="edit-para-input"]');
    await input.waitForDisplayed({ timeout: 10_000 });
    const look = await browser.execute(function () {
      const el = document.querySelector('[data-testid="edit-para-input"]') as HTMLElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { family: cs.fontFamily, color: cs.color, rect: [r.x, r.y, r.width, r.height] };
    });
    // Same left/top/width as the paragraph's own box (a pixel or two for the
    // box's dashed border).
    expect(Math.abs(look.rect[0] - boxRect[0])).toBeLessThan(3);
    expect(Math.abs(look.rect[1] - boxRect[1])).toBeLessThan(3);
    expect(Math.abs(look.rect[2] - boxRect[2])).toBeLessThan(3);
    expect(look.family).toContain('Liberation Serif');
    expect(look.family).toMatch(/^"?Times"?, /);
    expect(look.color).toBe('rgb(178, 0, 0)');

    await setContentEditableValue(
      '[data-testid="edit-para-input"]',
      'Alpha beta gamma delta words flowing on the second line, and more',
    );
    // The longer text wraps inside the editor at the paragraph's own width
    // while typing, before any commit.
    const live = await browser.execute(function () {
      const el = document.querySelector('[data-testid="edit-para-input"]') as HTMLElement;
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      return { width: el.getBoundingClientRect().width, lines: el.scrollHeight / lh };
    });
    expect(Math.abs(live.width - boxRect[2])).toBeLessThan(3);
    expect(live.lines).toBeGreaterThan(2.5);
    // Caret is not at the end: plain Enter would split here.
    await browser.keys(['Home']);
    await browser.keys(['Control', 'Enter']);
    await input.waitForExist({ reverse: true, timeout: 30_000 });
    await browser.waitUntil(
      async () =>
        await browser.execute(function () {
          const h = (window as any).__SPECTRA_TEST__;
          const ids: string[] = h.editTextPageIds();
          const paras: { text: string }[] = ids.length > 0 ? h.editParagraphs(ids[0]) : [];
          return paras.length === 1 && paras[0].text === 'Alpha beta gamma delta words flowing on the second line, and more';
        }),
      { timeout: 30_000, timeoutMsg: 'Ctrl+Enter did not commit the edited text' },
    );
  });
});
