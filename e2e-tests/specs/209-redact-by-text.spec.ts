import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  setView,
  getRedactionMarkCount,
  clearRedactionMarks,
} from '../support/harness.js';

// Issue 110: with the Redact tool, a drag that starts on text selects it and
// the release makes one mark per line, each as tall as its line. A drag that
// starts anywhere else still draws a box, so pictures and scans keep working.

async function makePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText('Alpha bravo charlie delta', { x: 30, y: 340, size: 16, font });
  page.drawText('Echo foxtrot golf hotel', { x: 30, y: 300, size: 16, font });
  page.drawText('India juliet kilo lima', { x: 30, y: 260, size: 16, font });
  writeFileSync(path, await doc.save());
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const spanBoxes = (): Promise<Box[]> =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="text-layer"] span'))
      .filter((el) => (el.textContent ?? '').trim().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }),
  );

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  // Several short moves, so the browser extends the selection step by step
  // as it does for a hand drag.
  const steps = 8;
  let chain = browser
    .action('pointer')
    .move({ x: Math.round(from.x), y: Math.round(from.y), origin: 'viewport' })
    .down();
  for (let i = 1; i <= steps; i++) {
    chain = chain.move({
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      origin: 'viewport',
      duration: 20,
    });
  }
  await chain.up().perform();
}

const markHeights = (): Promise<number[]> =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('.page-redact')).map((el) => el.getBoundingClientRect().height),
  );

describe('redact by selecting text', () => {
  let tmp = '';
  let file = '';

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-redact-text-'));
    file = resolve(tmp, 'lines.pdf');
    await makePdf(file);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([file]);
    await setView('canvas');
    await browser.execute(() => (window as any).__SPECTRA_TEST__.setTool('redact'));
    await browser.waitUntil(async () => (await spanBoxes()).length >= 3, {
      timeout: 20_000,
      timeoutMsg: 'the text layer never showed text',
    });
    // The page lays itself out to the pane after it opens; drag only once the
    // text has stopped moving.
    let last = '';
    let steady = 0;
    await browser.waitUntil(
      async () => {
        const now = JSON.stringify(await spanBoxes());
        steady = now === last ? steady + 1 : 0;
        last = now;
        await browser.pause(200);
        return steady >= 4;
      },
      { timeout: 20_000, timeoutMsg: 'the text never settled' },
    );
  });

  after(async () => {
    await clearRedactionMarks();
    await closeAllFiles();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('marks one box per line when text is dragged over', async () => {
    const spans = await spanBoxes();
    const first = spans[0];
    const last = spans[spans.length - 1];
    // From inside the first word to inside the last word: all three lines.
    await drag(
      { x: first.left + 3, y: (first.top + first.bottom) / 2 },
      { x: last.right - 3, y: (last.top + last.bottom) / 2 },
    );
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 3, {
      timeoutMsg: `expected 3 marks, saw ${await getRedactionMarkCount()}`,
    });
    const heights = await markHeights();
    expect(heights).toHaveLength(3);
    // The lines are the same size, so the boxes are the same height.
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1.5);
    // The selection is cleared once the marks exist.
    const selected = await browser.execute(() => window.getSelection()?.toString() ?? '');
    expect(selected).toBe('');
  });

  it('still draws a box when the drag starts off the text', async () => {
    await clearRedactionMarks();
    const page = await $('[data-page-id]');
    const r = await page.getElementRect(page.elementId);
    const x = r.x + r.width - 40;
    const y = r.y + r.height - 60;
    await drag({ x, y }, { x: x + 25, y: y + 30 });
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 1, {
      timeoutMsg: `expected 1 drawn mark, saw ${await getRedactionMarkCount()}`,
    });
  });
});
