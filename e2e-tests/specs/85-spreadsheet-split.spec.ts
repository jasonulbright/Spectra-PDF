import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// The king's SPREADSHEET SPLIT (the resolved 2026-07-30 deferral): a 2×2
// grid over ONE document with frozen-pane semantics — panes in a row share
// vertical scroll, panes in a column share horizontal scroll, zoom
// broadcasts. Driven through the real command + real DOM scrollers.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

const SCROLLER = (pane: string): string =>
  `[data-testid="doc-pane-${pane}"] [data-testid="document-view"]`;

async function setScroll(pane: string, prop: 'scrollTop' | 'scrollLeft', v: number): Promise<void> {
  await browser.execute(
    (sel: string, pr: string, val: number) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) (el as unknown as Record<string, number>)[pr] = val;
    },
    SCROLLER(pane),
    prop,
    v,
  );
}

async function getScroll(pane: string, prop: 'scrollTop' | 'scrollLeft'): Promise<number> {
  return (await browser.execute(
    (sel: string, pr: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? (el as unknown as Record<string, number>)[pr] : -1;
    },
    SCROLLER(pane),
    prop,
  )) as number;
}

describe('spreadsheet split (quad, frozen-pane links)', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    if ((await getState()).splitMode !== 'off') {
      await invokeAppCommand('window.split'); // normalize from any prior state
    }
  });

  after(async () => {
    if ((await getState()).splitMode !== 'off') {
      const mode = (await getState()).splitMode;
      await invokeAppCommand(mode === 'quad' ? 'window.spreadsheetSplit' : 'window.split');
    }
  });

  it('window.spreadsheetSplit shows four panes of the same document', async () => {
    expect(await invokeAppCommand('window.spreadsheetSplit')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitMode === 'quad', {
      timeoutMsg: 'the command did not enter quad mode',
    });
    await $('[data-testid="quad-container"]').waitForDisplayed({ timeout: 10_000 });
    for (const p of ['a', 'b', 'c', 'd']) {
      await expect($(SCROLLER(p))).toBeDisplayed();
    }
  });

  it('panes in a ROW share vertical scroll; the column partner does not follow it', async () => {
    await setScroll('a', 'scrollTop', 240);
    await browser.waitUntil(async () => (await getScroll('b', 'scrollTop')) === 240, {
      timeout: 5_000,
      timeoutMsg: "pane b (a's row partner) never mirrored scrollTop",
    });
    expect(await getScroll('c', 'scrollTop')).toBe(0); // column partner: left only
  });

  it('after a broadcast zoom, panes in a COLUMN share horizontal scroll', async () => {
    // Zoom until the page is wider than a half-width pane — the zoom
    // commands broadcast to all four panes in quad mode.
    for (let i = 0; i < 5; i++) expect(await invokeAppCommand('view.zoomIn')).toBe(true);
    await browser.waitUntil(
      async () => {
        await setScroll('a', 'scrollLeft', 60);
        return (await getScroll('c', 'scrollLeft')) === 60;
      },
      { timeout: 10_000, timeoutMsg: "pane c (a's column partner) never mirrored scrollLeft" },
    );
    expect(await getScroll('b', 'scrollLeft')).toBe(0); // row partner: top only
  });

  it('toggling off restores exactly one view', async () => {
    expect(await invokeAppCommand('window.spreadsheetSplit')).toBe(true);
    await browser.waitUntil(async () => (await getState()).splitMode === 'off', {
      timeoutMsg: 'the quad never toggled off',
    });
    await $('[data-testid="quad-container"]').waitForExist({ reverse: true, timeout: 5_000 });
    await expect($('[data-testid="document-view"]')).toBeDisplayed();
  });
});
