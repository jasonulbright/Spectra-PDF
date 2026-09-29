import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { waitForHarness, openByPaths, setView, closeAllFiles } from '../support/harness.js';

// Select-all and copy on a page whose rotated sidebar is drawn BEFORE the body.
// Native selection serializes DOM order; the text layer must read the body
// first and the sidebar after it, as search does.

const BODY_ONE = 'Body line one of the page';
const BODY_TWO = 'Body line two continues here';
const SIDEBAR = 'SIDEBAR LABEL';

async function makeSidebarPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 500]);
  page.drawText(SIDEBAR, { x: 30, y: 100, size: 14, font, rotate: degrees(90) });
  page.drawText(BODY_ONE, { x: 72, y: 420, size: 12, font });
  page.drawText(BODY_TWO, { x: 72, y: 400, size: 12, font });
  writeFileSync(path, await doc.save());
}

describe('rotated text copy order', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-rotcopy-'));
    source = resolve(tmp, 'sidebar.pdf');
    await makeSidebarPdf(source);
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('selects all page text in reading order', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');
    await browser.waitUntil(
      async () =>
        await browser.execute(function (side: string) {
          const layer = document.querySelector('[data-testid="text-layer"]');
          return (layer?.textContent ?? '').includes(side);
        }, SIDEBAR),
      { timeout: 15_000, timeoutMsg: 'text layer never rendered the sidebar' },
    );
    const copied = await browser.execute(function () {
      const layer = document.querySelector('[data-testid="text-layer"]')!;
      const range = document.createRange();
      range.selectNodeContents(layer);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const text = sel.toString();
      sel.removeAllRanges();
      return text;
    });
    const flat = copied.replace(/\s+/g, ' ').trim();
    expect(flat).toBe(`${BODY_ONE} ${BODY_TWO} ${SIDEBAR}`);
  });
});
