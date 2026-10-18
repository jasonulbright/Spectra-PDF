import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getState,
  invokeAppCommand,
  ocrReadyCount,
  applyOcr,
  openMenuItem,
  focusThisWindow,
  selectCanvasPages,
  getSelectedCanvasPageIds,
} from '../support/harness.js';
import { elementPixels, differingPixels, type Pixels } from '../support/png.js';

// A document selection that starts in a page's text layer and runs on across
// the window paints only the text layer. Text fields, selects, checkboxes and
// the operations log's own wording stay as they were, whichever gesture made
// the selection; a field the user is editing still shows its own selection.
// The state: a scanned page made searchable, the Scan & OCR panel open, and
// the find bar open over the page.

const SCANNED = resolve(__dirname, '..', 'fixtures', 'scanned.pdf');

const CHROME = [
  'find-input',
  'find-ocr-lang',
  'scanenhance-scope',
  'scanenhance-deskew',
  'scanenhance-maxskew',
  'scanenhance-specksize',
  'scanenhance-strength',
  'scanenhance-confidence',
  'scanenhance-quality',
  'page-nav-box',
  'reading-zoom-percent',
  'opqueue',
].map((id) => `[data-testid="${id}"]`);
const LAYER = '[data-testid="text-layer"]';

/** Pixels that may differ with nothing painted: anti-aliasing on a repaint. */
const NOISE = 4;

/** A point over the empty menu bar, where hovering changes nothing compared. */
async function parkPointer(): Promise<void> {
  const x = await browser.execute(() => Math.round(window.innerWidth / 2));
  await browser.action('pointer').move({ x, y: 14, duration: 0 }).perform();
  await browser.pause(200);
}

async function clearSelection(): Promise<void> {
  await browser.execute(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.getSelection()?.removeAllRanges();
  });
  await parkPointer();
}

async function snapshot(): Promise<Map<string, Pixels>> {
  const shots = new Map<string, Pixels>();
  for (const sel of [...CHROME, LAYER]) shots.set(sel, await elementPixels(sel));
  return shots;
}

/** Each element's count of pixels the live selection paints: the element with
 * the selection against the same element once the selection is removed. A
 * scroll or a new layer can switch text antialiasing between the gesture and
 * any earlier shot, so the two shots differ in the selection alone. */
async function selectionPaint(): Promise<Record<string, number>> {
  await parkPointer();
  const selected = await snapshot();
  await browser.execute(() => window.getSelection()?.removeAllRanges());
  await browser.pause(200);
  const out: Record<string, number> = {};
  for (const [sel, shot] of selected) out[sel] = differingPixels(shot, await elementPixels(sel));
  return out;
}

function expectOnlyTheLayerPainted(diff: Record<string, number>, gesture: string): void {
  const painted = CHROME.filter((sel) => diff[sel] > NOISE).map((sel) => `${gesture}: ${sel}=${diff[sel]}`);
  expect(painted).toEqual([]);
  expect({ gesture, layerShowsSelection: diff[LAYER] > 200 }).toEqual({ gesture, layerShowsSelection: true });
}

/** Whether a field holds the focus, carries the editing mark, and matches
 * the policy's selector for a field whose selection paints nothing. */
async function editingMark(testid: string): Promise<{ active: boolean; marked: boolean; quiet: boolean }> {
  return await browser.execute((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    return {
      active: document.activeElement === el,
      marked: el.hasAttribute('data-editing'),
      quiet: el.matches(':not(:focus, [data-editing])'),
    };
  }, testid);
}

async function selectionText(): Promise<string> {
  return await browser.execute(() => window.getSelection()?.toString() ?? '');
}

async function firstWord(): Promise<{ x: number; y: number }> {
  return await browser.execute(() => {
    const span = Array.from(document.querySelectorAll('[data-testid="text-layer"] span'))
      .find((s) => (s.textContent ?? '').trim().length > 2) as HTMLElement;
    const r = span.getBoundingClientRect();
    return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) };
  });
}

describe('a selection across the window paints no chrome', () => {

  before(async function () {
    this.timeout(240_000);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SCANNED]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('scanned.pdf'),
      { timeout: 20_000, timeoutMsg: 'scanned.pdf never became active' },
    );
    expect(await invokeAppCommand('tools.open.ocr')).toBe(true);
    await $('[data-testid="find-ocr-lang"]').waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(async () => (await ocrReadyCount()) > 0, {
      timeout: 180_000,
      interval: 1_000,
      timeoutMsg: 'the scanned page was never recognised',
    });
    await applyOcr();
    // The log settles: every row finished and no new row for a while.
    let rows = -1;
    await browser.waitUntil(async () => {
      const now = await browser.execute(() => ({
        rows: document.querySelectorAll('[data-testid="opqueue-item"]').length,
        running: document.querySelectorAll('[data-testid="opqueue-item"][data-status="running"]').length,
        spans: document.querySelectorAll('[data-testid="text-layer"] span').length,
      }));
      const settled = now.rows > 0 && now.running === 0 && now.spans > 0 && now.rows === rows;
      rows = now.rows;
      return settled;
    }, { timeout: 60_000, interval: 2_500, timeoutMsg: 'the operations log never settled' });
    await clearSelection();
  });

  after(async () => {
    await clearSelection();
    await closeAllFiles();
  });

  it('chrome holds no selectable text; text fields and the text layer do', async () => {
    const userSelect = await browser.execute(() => {
      const of = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).userSelect : 'missing';
      };
      return {
        select: of('[data-testid="find-ocr-lang"]'),
        checkbox: of('[data-testid="scanenhance-deskew"]'),
        button: of('[data-testid="find-case"]'),
        status: of('[data-testid="opqueue-item"][data-status="done"] [data-testid="opqueue-status"]'),
        label: of('[data-testid="scanenhance-scans"]'),
        findField: of('[data-testid="find-input"]'),
        numberField: of('[data-testid="scanenhance-maxskew"]'),
        layer: of('[data-testid="text-layer"] span'),
      };
    });
    expect(userSelect).toEqual({
      select: 'none',
      checkbox: 'none',
      button: 'none',
      status: 'none',
      label: 'none',
      findField: 'text',
      numberField: 'text',
      layer: 'text',
    });
  });

  it('a range from the text layer to the end of the window paints only the text layer', async () => {
    await clearSelection();
    await browser.execute(() => {
      const span = Array.from(document.querySelectorAll('[data-testid="text-layer"] span'))
        .find((s) => (s.textContent ?? '').trim().length > 2)!;
      const range = document.createRange();
      range.setStart(span.firstChild ?? span, 0);
      range.setEnd(document.body, document.body.childNodes.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    expect((await selectionText()).length).toBeGreaterThan(5);
    expectOnlyTheLayerPainted(await selectionPaint(), 'range to the end');
  });

  it('Shift+Arrow from a word in the text layer paints only the text layer', async () => {
    await clearSelection();
    const word = await firstWord();
    await browser.action('pointer')
      .move({ x: word.x, y: word.y, duration: 0 })
      .down().up().pause(40).down().up()
      .perform();
    for (let i = 0; i < 25; i++) await browser.keys(['Shift', 'ArrowDown']);
    await browser.keys(['Shift', 'End']);
    expect((await selectionText()).length).toBeGreaterThan(5);
    expectOnlyTheLayerPainted(await selectionPaint(), 'Shift+Arrow');
  });

  it('a drag from the text layer onto a panel field paints only the text layer', async () => {
    await clearSelection();
    const word = await firstWord();
    const field = await $('[data-testid="scanenhance-maxskew"]').getLocation();
    await browser.action('pointer')
      .move({ x: word.x, y: word.y, duration: 0 })
      .down()
      .move({ x: word.x + 30, y: word.y + 5, duration: 100 })
      .pause(50)
      .move({ x: Math.round(field.x + 10), y: Math.round(field.y + 8), duration: 400 })
      .pause(100)
      .up()
      .perform();
    expect((await selectionText()).length).toBeGreaterThan(5);
    expectOnlyTheLayerPainted(await selectionPaint(), 'drag onto a field');
  });

  it('Ctrl+A on a select or a checkbox selects the pages, as on a button, never the document text', async () => {
    for (const id of ['find-ocr-lang', 'scanenhance-deskew']) {
      await clearSelection();
      await selectCanvasPages([]);
      await browser.execute((testid: string) => {
        (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).focus();
      }, id);
      await browser.keys(['Control', 'a']);
      expect({ id, selection: await selectionText(), pages: (await getSelectedCanvasPageIds()).length > 0 })
        .toEqual({ id, selection: '', pages: true });
    }
    await selectCanvasPages([]);
  });

  it('a field the user is editing still shows its own selection, and takes typing', async () => {
    await clearSelection();
    // The pixel checks below read the window: with another application in
    // front, the field would match neither `:focus` nor the editing mark.
    await focusThisWindow();
    const input = $('[data-testid="find-input"]');
    await input.click();
    expect(await editingMark('find-input')).toEqual({ active: true, marked: true, quiet: false });
    await browser.keys('hello');
    await parkPointer();
    const typed = await elementPixels('[data-testid="find-input"]');
    await browser.keys(['Shift', 'Home']);
    await browser.pause(150);
    expect(differingPixels(typed, await elementPixels('[data-testid="find-input"]'))).toBeGreaterThan(100);
    await browser.keys(['Control', 'a']);
    await browser.keys('world');
    expect(await input.getValue()).toBe('world');
    // Double-click a word, then drag inside the field, both from an unfocused start.
    await clearSelection();
    const box = await input.getLocation();
    await browser.action('pointer').move({ x: Math.round(box.x + 14), y: Math.round(box.y + 12), duration: 0 })
      .down().up().pause(40).down().up().perform();
    expect(await browser.execute(() => {
      const i = document.querySelector('[data-testid="find-input"]') as HTMLInputElement;
      return [document.activeElement === i, i.selectionStart, i.selectionEnd];
    })).toEqual([true, 0, 5]);
    await clearSelection();
    await browser.action('pointer').move({ x: Math.round(box.x + 6), y: Math.round(box.y + 12), duration: 0 })
      .down().move({ x: Math.round(box.x + 200), y: Math.round(box.y + 12), duration: 150 }).up().perform();
    await browser.keys('Z');
    expect(await input.getValue()).toBe('Z');
    await browser.keys(['Control', 'a']);
    await browser.keys('Delete');
    expect(await input.getValue()).toBe('');
  });

  it('Ctrl+A in a number field selects and shows the field text', async () => {
    await clearSelection();
    await focusThisWindow();
    const field = $('[data-testid="scanenhance-quality"]');
    await field.click();
    expect(await editingMark('scanenhance-quality')).toEqual({ active: true, marked: true, quiet: false });
    await parkPointer();
    const before = await elementPixels('[data-testid="scanenhance-quality"]');
    await browser.keys(['Control', 'a']);
    await browser.pause(150);
    expect(await browser.execute(() => {
      const i = document.querySelector('[data-testid="scanenhance-quality"]') as HTMLInputElement;
      return document.activeElement === i && window.getSelection()?.toString() === i.value && i.value.length > 0;
    })).toBe(true);
    expect(differingPixels(before, await elementPixels('[data-testid="scanenhance-quality"]'))).toBeGreaterThan(20);
    await clearSelection();
  });

  it('a menu that renders outside the app shell holds no selectable text', async () => {
    await openMenuItem('menu-file', 'menuitem-file-open');
    const item = await browser.execute(() => {
      const el = document.querySelector('[data-testid="menuitem-file-open"]') as HTMLElement;
      return { userSelect: getComputedStyle(el).userSelect, inShell: el.closest('.app-shell') !== null };
    });
    await browser.keys('Escape');
    expect(item).toEqual({ userSelect: 'none', inShell: false });
  });
});
