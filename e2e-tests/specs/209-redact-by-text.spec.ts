import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  setView,
  getRedactionMarkCount,
  clearRedactionMarks,
  invokeAppCommand,
} from '../support/harness.js';

// Issue 110: with the Redact tool, a drag that starts on text selects it and
// the release makes one mark per line, each as tall as its line. A drag that
// starts anywhere else still draws a box, so pictures and scans keep working.
// Only a gesture that began on text may mark: an older selection never does.

async function makePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 400]);
  first.drawText('Alpha bravo charlie delta', { x: 30, y: 340, size: 16, font });
  first.drawText('Echo foxtrot golf hotel', { x: 30, y: 300, size: 16, font });
  first.drawText('India juliet kilo lima', { x: 30, y: 260, size: 16, font });
  const second = doc.addPage([400, 400]);
  second.drawText('Mike november oscar papa', { x: 30, y: 340, size: 16, font });
  second.drawText('Quebec romeo sierra tango', { x: 30, y: 300, size: 16, font });
  writeFileSync(path, await doc.save());
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The text spans of one page (0 = first), in document order. */
const spanBoxes = (pageIndex: number): Promise<Box[]> =>
  browser.execute((index: number) => {
    const pages = Array.from(document.querySelectorAll('[data-page-id]')).filter((el) =>
      el.querySelector('[data-testid="text-layer"]'),
    );
    const page = pages[index];
    if (!page) return [];
    return Array.from(page.querySelectorAll('[data-testid="text-layer"] span'))
      .filter((el) => (el.textContent ?? '').trim().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
  }, pageIndex);

const allSpanCount = (): Promise<number> =>
  browser.execute(
    () =>
      Array.from(document.querySelectorAll('[data-testid="text-layer"] span')).filter(
        (el) => (el.textContent ?? '').trim().length > 0,
      ).length,
  );

async function drag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  // Several short moves, so the browser extends the selection step by step
  // as it does for a hand drag.
  const steps = 8;
  let chain = browser.action('pointer').move({ x: Math.round(from.x), y: Math.round(from.y), origin: 'viewport' });
  chain = chain.down();
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

const marks = (): Promise<{ top: number; height: number; width: number }[]> =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('.page-redact')).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, width: r.width };
    }),
  );

const selectedText = (): Promise<string> =>
  browser.execute(() => window.getSelection()?.toString() ?? '');

const center = (b: Box) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });

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
    await browser.waitUntil(async () => (await allSpanCount()) >= 5, {
      timeout: 20_000,
      timeoutMsg: 'the text layer never showed text',
    });
    // The page lays itself out to the pane after it opens; drag only once the
    // text has stopped moving.
    let last = '';
    let steady = 0;
    await browser.waitUntil(
      async () => {
        const now = JSON.stringify(await spanBoxes(0));
        steady = now === last ? steady + 1 : 0;
        last = now;
        await browser.pause(200);
        return steady >= 4;
      },
      { timeout: 20_000, timeoutMsg: 'the text never settled' },
    );
  });

  afterEach(async () => {
    await clearRedactionMarks();
  });

  after(async () => {
    await closeAllFiles();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('marks one box per line when text is dragged over', async () => {
    const spans = await spanBoxes(0);
    const first = spans[0];
    const last = spans[spans.length - 1];
    await drag(
      { x: first.left + 3, y: center(first).y },
      { x: last.right - 3, y: center(last).y },
    );
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 3, {
      timeoutMsg: `expected 3 marks, saw ${await getRedactionMarkCount()}`,
    });
    const boxes = await marks();
    const heights = boxes.map((m) => m.height);
    // The lines are the same size, so the boxes are the same height.
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1.5);
    expect(await selectedText()).toBe('');
  });

  it('marks only the selected lines when a drag crosses a page break', async () => {
    // Put the last line of page 1 near the top of the pane, so the first line of
    // page 2 is on screen too.
    await browser.execute(() => {
      const pages = Array.from(document.querySelectorAll('[data-page-id]')).filter((el) =>
        el.querySelector('[data-testid="text-layer"]'),
      );
      const spans = pages[0].querySelectorAll('[data-testid="text-layer"] span');
      const last = spans[spans.length - 1] as HTMLElement;
      let scroller: HTMLElement | null = last.parentElement;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
        scroller = scroller.parentElement;
      }
      if (scroller) scroller.scrollTop += last.getBoundingClientRect().top - 120;
    });
    await browser.pause(500);
    const a = (await spanBoxes(0)).at(-1)!;
    const b = (await spanBoxes(1))[0];
    const viewport = await browser.execute(() => window.innerHeight);
    expect(b.bottom).toBeLessThan(viewport);
    await drag({ x: a.left + 3, y: center(a).y }, { x: b.right - 3, y: center(b).y });
    await browser.waitUntil(async () => (await getRedactionMarkCount()) >= 1, {
      timeoutMsg: 'the drag across pages made no marks',
    });
    const boxes = await marks();
    // Two lines selected: two marks, each a text line, never a page-sized box.
    expect(boxes).toHaveLength(2);
    for (const m of boxes) expect(m.height).toBeLessThan(60);
  });

  it('draws a box when the drag starts off the text', async () => {
    const page = await $('[data-page-id]');
    const r = await page.getElementRect(page.elementId);
    const x = r.x + r.width - 40;
    const y = r.y + r.height - 60;
    await drag({ x, y }, { x: x + 25, y: y + 30 });
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 1, {
      timeoutMsg: `expected 1 drawn mark, saw ${await getRedactionMarkCount()}`,
    });
  });

  it('never turns an older selection into marks', async () => {
    // A selection made earlier, for instance with the Select tool.
    await browser.execute(() => {
      const span = document.querySelector('[data-testid="text-layer"] span')!;
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    // An unrelated press and release off the text draws a box and nothing more.
    const page = await $('[data-page-id]');
    const r = await page.getElementRect(page.elementId);
    const x = r.x + r.width - 40;
    const y = r.y + r.height - 60;
    await drag({ x, y }, { x: x + 25, y: y + 30 });
    await browser.waitUntil(async () => (await getRedactionMarkCount()) >= 1, {
      timeoutMsg: 'the drawn box never appeared',
    });
    expect(await getRedactionMarkCount()).toBe(1);
  });

  it('draws a box over text when Shift is held', async () => {
    // Earlier specs scrolled the pane; bring the first line back to the top.
    await browser.execute(() => {
      (document.querySelector('[data-testid="text-layer"] span') as HTMLElement).scrollIntoView({ block: 'center' });
    });
    await browser.pause(400);
    const spans = await spanBoxes(0);
    const first = spans[0];
    const from = { x: first.left + 3, y: center(first).y };
    // Hold Shift: the browser keeps the modifier for the pointer events after it.
    await browser.action('key').down('').perform(true);
    try {
      await drag(from, { x: from.x + 60, y: from.y + 70 });
    } finally {
      await browser.releaseActions();
    }
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 1, {
      timeoutMsg: `expected 1 drawn mark, saw ${await getRedactionMarkCount()}`,
    });
    const [box] = await marks();
    // A drawn band is about the drag's size, not one text line.
    expect(box.height).toBeGreaterThan(50);
  });

  it('marks a line once, not once per pane, in split view', async () => {
    expect(await invokeAppCommand('window.split')).toBe(true);
    try {
      await browser.pause(800);
      await browser.execute(() => {
        (document.querySelector('[data-testid="text-layer"] span') as HTMLElement).scrollIntoView({ block: 'center' });
      });
      await browser.pause(400);
      const spans = await spanBoxes(0);
      const first = spans[0];
      const second = spans[1];
      await drag({ x: first.left + 3, y: center(first).y }, { x: second.right - 3, y: center(second).y });
      await browser.waitUntil(async () => (await getRedactionMarkCount()) >= 1, {
        timeoutMsg: 'the drag in split view made no marks',
      });
      await browser.pause(300);
      // Two lines selected: two marks in the document, whatever the pane count.
      expect(await getRedactionMarkCount()).toBe(2);
    } finally {
      await invokeAppCommand('window.split');
    }
  });

  it('marks one narrow column per line on a page stored turned a quarter-turn', async () => {
    // The file itself says /Rotate 90, so each line shows as a column on screen.
    const turned = resolve(tmp, 'turned.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 400]);
    page.setRotation(degrees(90));
    page.drawText('Alpha bravo charlie delta', { x: 30, y: 340, size: 16, font });
    page.drawText('Echo foxtrot golf hotel', { x: 30, y: 300, size: 16, font });
    page.drawText('India juliet kilo lima', { x: 30, y: 260, size: 16, font });
    writeFileSync(turned, await doc.save());
    await closeAllFiles();
    await openByPaths([turned]);
    await setView('canvas');
    await browser.execute(() => (window as any).__SPECTRA_TEST__.setTool('redact'));
    await browser.waitUntil(async () => (await allSpanCount()) >= 3, {
      timeout: 20_000,
      timeoutMsg: 'the turned page never showed text',
    });
    let last = '';
    let steady = 0;
    await browser.waitUntil(
      async () => {
        const now = JSON.stringify(await spanBoxes(0));
        steady = now === last ? steady + 1 : 0;
        last = now;
        await browser.pause(200);
        return steady >= 4;
      },
      { timeout: 20_000, timeoutMsg: 'the turned page never settled' },
    );
    const spans = await spanBoxes(0);
    expect(spans.length).toBe(3);
    // The lines are columns now: each span is taller than it is wide.
    expect(spans[0].bottom - spans[0].top).toBeGreaterThan(spans[0].right - spans[0].left);
    const first = spans[0];
    const third = spans[2];
    await drag({ x: center(first).x, y: first.top + 20 }, { x: center(third).x, y: third.bottom - 20 });
    await browser.waitUntil(async () => (await getRedactionMarkCount()) === 3, {
      timeoutMsg: `expected 3 column marks, saw ${await getRedactionMarkCount()}`,
    });
    for (const m of await marks()) expect(m.height).toBeGreaterThan(m.width);
  });
});
