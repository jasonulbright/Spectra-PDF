import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  invokeAppCommand,
  setUiLanguage,
  setToolDockWidth,
  setReactInputValue,
} from '../support/harness.js';

// The find bar floats over the canvas and the user can move it: by its grip,
// by its own background, or by the arrow keys on the focused grip. It never
// leaves the document region (under the tool strip, above the status bar,
// between the view's edges), keeps its place when it is closed and opened
// again, and a double-click on the grip puts it back in its default slot. A
// press on one of its controls operates the control and moves nothing.

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Layout {
  bar: Box;
  /** The document region: the canvas view less its tool strip and status bar. */
  region: Box;
  focused: string | null;
}

async function layout(): Promise<Layout> {
  return await browser.execute(() => {
    const bar = document.querySelector('[data-testid="find-bar"]') as HTMLElement;
    const view = bar.offsetParent as HTMLElement;
    const v = view.getBoundingClientRect();
    const inset = (name: string) => parseFloat(view.style.getPropertyValue(name)) || 0;
    const b = bar.getBoundingClientRect();
    return {
      bar: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      region: {
        left: v.left + view.clientLeft,
        top: v.top + view.clientTop + inset('--canvas-inset-block-start'),
        right: v.left + view.clientLeft + view.clientWidth,
        bottom: v.top + view.clientTop + view.clientHeight - inset('--canvas-inset-block-end'),
      },
      focused: document.activeElement?.getAttribute('data-testid') ?? null,
    };
  });
}

/** The layout once the canvas has stopped resizing: a tool dock that changes
 * width moves the bar's slot until the dock has settled. */
async function stableLayout(): Promise<Layout> {
  let last = '';
  let now: Layout | null = null;
  await browser.waitUntil(async () => {
    now = await layout();
    const key = JSON.stringify([now.bar, now.region]);
    const same = key === last;
    last = key;
    return same;
  }, { timeout: 10_000, interval: 250, timeoutMsg: 'the canvas never stopped resizing' });
  return now!;
}

function expectInside(l: Layout, label: string): void {
  const slack = 0.5;
  const outside: string[] = [];
  if (l.bar.left < l.region.left - slack) outside.push(`left ${l.bar.left} < ${l.region.left}`);
  if (l.bar.right > l.region.right + slack) outside.push(`right ${l.bar.right} > ${l.region.right}`);
  if (l.bar.top < l.region.top - slack) outside.push(`top ${l.bar.top} < ${l.region.top}`);
  if (l.bar.bottom > l.region.bottom + slack) outside.push(`bottom ${l.bar.bottom} > ${l.region.bottom}`);
  expect({ label, outside }).toEqual({ label, outside: [] });
}

/** The bar's inline-end edge and top against `expected`. The slot is anchored
 * at the inline-end edge, and the bar widens when the find count appears. */
function expectAt(actual: Box, expected: { left?: number; right?: number; top: number }, label: string): void {
  const off = (a: number, b: number) => (Math.abs(a - b) <= 1 ? 0 : Math.round(a - b));
  const inline = expected.right !== undefined
    ? off(actual.right, expected.right)
    : off(actual.left, expected.left ?? Number.NaN);
  expect({ label, inline, top: off(actual.top, expected.top) }).toEqual({ label, inline: 0, top: 0 });
}

async function center(selector: string): Promise<{ x: number; y: number }> {
  return await browser.execute((sel: string) => {
    const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
}

/** Presses at `from` and releases `dx`, `dy` away, the release point held
 * inside the window: WebDriver refuses a pointer outside the viewport. */
async function drag(from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  const view = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const to = {
    x: Math.min(Math.max(from.x + dx, 1), view.w - 2),
    y: Math.min(Math.max(from.y + dy, 1), view.h - 2),
  };
  await browser.action('pointer')
    .move({ x: from.x, y: from.y, duration: 0 })
    .down()
    .move({ x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2), duration: 120 })
    .move({ x: to.x, y: to.y, duration: 120 })
    .up()
    .perform();
  await browser.pause(150);
}

async function openFind(): Promise<void> {
  const input = $('[data-testid="find-input"]');
  if (!(await input.isDisplayed().catch(() => false))) {
    await invokeAppCommand('edit.find');
    await input.waitForDisplayed({ timeout: 10_000 });
  }
  await browser.pause(150);
}

async function closeFind(): Promise<void> {
  await $('[data-testid="find-input"]').click();
  await browser.keys('Escape');
  await $('[data-testid="find-bar"]').waitForExist({ reverse: true, timeout: 10_000 });
}

describe('the find bar moves over the canvas', () => {
  let tmp: string;
  let slot: Box;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-find-move-'));
    const source = resolve(tmp, 'text.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    for (let i = 0; i < 20; i++) {
      page.drawText(`Line ${i + 1} of the find bar fixture`, { x: 60, y: 720 - i * 24, size: 14, font });
    }
    writeFileSync(source, await doc.save());
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
    await openFind();
    slot = (await layout()).bar;
  });

  after(async () => {
    await setUiLanguage('en').catch(() => undefined);
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('opens in its default slot with a grip at its leading edge', async () => {
    const l = await layout();
    expectInside(l, 'slot');
    expect(l.focused).toBe('find-input');
    const grip = await browser.execute(() => {
      const bar = document.querySelector('[data-testid="find-bar"]') as HTMLElement;
      const g = document.querySelector('[data-testid="find-grip"]') as HTMLElement;
      const s = getComputedStyle(g);
      return {
        first: bar.firstElementChild === g,
        named: (g.getAttribute('aria-label') ?? '').length > 0 && (g.getAttribute('title') ?? '').length > 0,
        cursor: s.cursor,
        touchAction: s.touchAction,
        barCursor: getComputedStyle(bar).cursor,
        toggleCursor: getComputedStyle(document.querySelector('[data-testid="find-case"]') as HTMLElement).cursor,
      };
    });
    expect(grip).toEqual({ first: true, named: true, cursor: 'grab', touchAction: 'none', barCursor: 'grab', toggleCursor: 'default' });
  });

  it('the grip drags the bar, the field keeps the focus, and typing still works', async () => {
    await drag(await center('[data-testid="find-grip"]'), -220, 140);
    const l = await layout();
    expectAt(l.bar, { right: slot.right - 220, top: slot.top + 140 }, 'after the grip drag');
    expectInside(l, 'after the grip drag');
    expect(l.focused).toBe('find-input');
    expect(await browser.execute(() => window.getSelection()?.toString() ?? '')).toBe('');
    await browser.keys('fixture');
    expect(await $('[data-testid="find-input"]').getValue()).toBe('fixture');
    await browser.keys('Enter');
    expect(await $('[data-testid="find-input"]').getValue()).toBe('fixture');
  });

  it('the bar never leaves the document region, however far it is dragged', async () => {
    for (const [dx, dy] of [[-3000, -3000], [3000, 3000], [-3000, 3000], [3000, -3000]]) {
      await drag(await center('[data-testid="find-grip"]'), dx, dy);
      expectInside(await layout(), `drag ${dx},${dy}`);
    }
  });

  it('the bar background drags it; a press on a control moves nothing', async () => {
    await browser.execute(() => {
      const g = document.querySelector('[data-testid="find-grip"]') as HTMLElement;
      g.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await browser.pause(150);
    const before = (await layout()).bar;
    // The padding strip below the controls is the bar's own background.
    await drag({ x: Math.round((before.left + before.right) / 2), y: Math.round(before.bottom - 3) }, -100, 60);
    let l = await layout();
    expectAt(l.bar, { right: before.right - 100, top: before.top + 60 }, 'background drag');
    for (const control of ['find-case', 'find-input']) {
      const at = (await layout()).bar;
      const pressedBefore = await $('[data-testid="find-case"]').getAttribute('aria-pressed');
      await drag(await center(`[data-testid="${control}"]`), -80, 50);
      l = await layout();
      expectAt(l.bar, at, `press on ${control}`);
      expect(await $('[data-testid="find-case"]').getAttribute('aria-pressed')).toBe(pressedBefore);
    }
  });

  it('a press on error text in the bar selects the text and moves nothing', async () => {
    await $('[data-testid="find-regex"]').click();
    await setReactInputValue('[data-testid="find-input"]', 'inv(');
    await browser.waitUntil(async () => browser.execute(() => {
      const c = document.querySelector('[data-testid="find-count"]') as HTMLElement | null;
      return c !== null && c.className.includes('text-red-') && (c.textContent ?? '').trim().length > 3;
    }), { timeout: 10_000, timeoutMsg: 'the find count never showed an error' });
    await stableLayout();
    const at = (await layout()).bar;
    const count = await browser.execute(() => {
      const r = (document.querySelector('[data-testid="find-count"]') as HTMLElement).getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), y: Math.round(r.top + r.height / 2) };
    });
    await browser.action('pointer')
      .move({ x: count.left + 1, y: count.y, duration: 0 })
      .down()
      .move({ x: count.right - 1, y: count.y, duration: 150 })
      .up()
      .perform();
    await browser.pause(150);
    expectAt((await layout()).bar, at, 'press on error text');
    const selected = (await browser.execute(() => window.getSelection()?.toString() ?? '')).trim();
    const error = (await $('[data-testid="find-count"]').getText()).trim();
    expect({ selectedLength: selected.length > 3, insideError: error.includes(selected) })
      .toEqual({ selectedLength: true, insideError: true });
    await browser.execute(() => window.getSelection()?.removeAllRanges());
    await $('[data-testid="find-regex"]').click();
    await setReactInputValue('[data-testid="find-input"]', '');
  });

  it('a double-click on the grip puts the bar back in its slot', async () => {
    const grip = await center('[data-testid="find-grip"]');
    await browser.action('pointer')
      .move({ x: grip.x, y: grip.y, duration: 0 })
      .down().up().pause(40).down().up()
      .perform();
    await browser.pause(150);
    expectAt((await layout()).bar, slot, 'after the double-click');
  });

  it('the bar keeps its place when it is closed and opened again', async () => {
    await drag(await center('[data-testid="find-grip"]'), -150, 90);
    const moved = (await layout()).bar;
    expectAt(moved, { right: slot.right - 150, top: slot.top + 90 }, 'moved');
    await closeFind();
    await openFind();
    const l = await layout();
    expectAt(l.bar, moved, 'reopened');
    expect(l.focused).toBe('find-input');
  });

  it('the arrow keys on the focused grip move the bar; Home puts it back', async () => {
    await browser.execute(() => (document.querySelector('[data-testid="find-grip"]') as HTMLElement).focus());
    const start = (await layout()).bar;
    await browser.keys('ArrowLeft');
    await browser.keys('ArrowLeft');
    expectAt((await layout()).bar, { right: start.right - 16, top: start.top }, 'two steps left');
    await browser.keys(['Shift', 'ArrowDown']);
    expectAt((await layout()).bar, { right: start.right - 16, top: start.top + 48 }, 'a large step down');
    await browser.keys('Home');
    expectAt((await layout()).bar, slot, 'Home');
    await browser.keys('Escape');
    await $('[data-testid="find-bar"]').waitForExist({ reverse: true, timeout: 10_000 });
    await openFind();
  });

  it('a narrower canvas pulls a moved bar back inside, and it returns when the canvas widens', async () => {
    expect(await invokeAppCommand('tools.open.ocr')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 15_000 });
    await setToolDockWidth(300);
    await openFind();
    await stableLayout();
    // To the inline-start edge, as far as it goes.
    await drag(await center('[data-testid="find-grip"]'), -3000, 0);
    const far = await layout();
    expect(Math.abs(far.bar.left - far.region.left)).toBeLessThanOrEqual(1);
    await setToolDockWidth(700);
    await browser.waitUntil(async () => {
      const l = await layout();
      return l.region.right < far.region.right - 100;
    }, { timeout: 10_000, timeoutMsg: 'the canvas never narrowed' });
    expectInside(await stableLayout(), 'after the canvas narrowed');
    await setToolDockWidth(300);
    const wide = await stableLayout();
    expect(Math.abs(wide.bar.left - wide.region.left)).toBeLessThanOrEqual(1);
  });

  it('a smaller window pulls a moved bar back inside', async () => {
    const size = await browser.getWindowSize();
    try {
      await stableLayout();
      await drag(await center('[data-testid="find-grip"]'), 0, 3000);
      const low = await layout();
      expect(Math.abs(low.bar.bottom - low.region.bottom)).toBeLessThanOrEqual(1);
      await browser.setWindowSize(size.width, Math.max(600, size.height - 200));
      await browser.waitUntil(async () => (await layout()).region.bottom < low.region.bottom - 100, {
        timeout: 10_000,
        timeoutMsg: 'the window never shrank',
      });
      expectInside(await stableLayout(), 'after the window shrank');
    } finally {
      await browser.setWindowSize(size.width, size.height);
    }
  });

  it('in a right-to-left UI the slot is on the left and the bar follows the pointer', async () => {
    await closeFind();
    await setUiLanguage('ar');
    await openFind();
    // The previous test left the bar at the bottom: put it back in its slot.
    await browser.execute(() => {
      const g = document.querySelector('[data-testid="find-grip"]') as HTMLElement;
      g.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await browser.pause(150);
    const rtlSlot = await layout();
    expect(rtlSlot.bar.left - rtlSlot.region.left).toBeLessThan(rtlSlot.region.right - rtlSlot.bar.right);
    const gripAtRightEdge = await browser.execute(() => {
      const bar = document.querySelector('[data-testid="find-bar"]') as HTMLElement;
      const g = document.querySelector('[data-testid="find-grip"]') as HTMLElement;
      return Math.abs(g.getBoundingClientRect().right - bar.getBoundingClientRect().right) < 20;
    });
    expect({ gripAtRightEdge }).toEqual({ gripAtRightEdge: true });
    await drag(await center('[data-testid="find-grip"]'), 120, 80);
    const moved = await layout();
    expectAt(moved.bar, { left: rtlSlot.bar.left + 120, top: rtlSlot.bar.top + 80 }, 'RTL drag');
    expectInside(moved, 'RTL drag');
    await browser.execute(() => (document.querySelector('[data-testid="find-grip"]') as HTMLElement).focus());
    await browser.keys('ArrowRight');
    expectAt((await layout()).bar, { left: rtlSlot.bar.left + 128, top: rtlSlot.bar.top + 80 }, 'RTL arrow');
    await drag(await center('[data-testid="find-grip"]'), -3000, 0);
    expectInside(await layout(), 'RTL clamp');
    await browser.execute(() => {
      const g = document.querySelector('[data-testid="find-grip"]') as HTMLElement;
      g.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await browser.pause(150);
    expectAt((await layout()).bar, { left: rtlSlot.bar.left, top: rtlSlot.bar.top }, 'RTL reset');
    await closeFind();
    await setUiLanguage('en');
  });
});
