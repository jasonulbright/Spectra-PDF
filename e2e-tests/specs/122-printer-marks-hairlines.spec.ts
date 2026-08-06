// Printer marks and hairlines: two file transforms with a measurable
// before/after.
//
// Marks are drawn OUTSIDE the trim, so the assertion that matters is that the
// PAGE GREW and then went back to exactly the size it was. And the marks paint
// in registration colour, so the second assertion is that they survive on a
// plate with every process ink switched off — a mark drawn in black would
// vanish there, and would be useless on press for the same reason.
//
// Hairlines are the widths a proof cannot show. The fixture carries a `1 w`
// under a tenth-scale transform, which draws 0.1 pt: the panel has to count it
// before anything is rewritten, and the fix has to land it on the replacement
// DEVICE width rather than on the replacement operand.
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  getActiveDocPages,
  invokeAppCommand,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

const SPOT = resolve(__dirname, '..', 'fixtures', 'separations-spot.pdf');
const LADDER = resolve(__dirname, '..', 'fixtures', 'hairlines-ladder.pdf');

/** The fixture's own page size, and what the default marks add to each edge. */
const PAGE_EXTENT = 400;
const OFFSET = 9;
const LENGTH = 18;
const GROWTH = OFFSET + LENGTH;
const GROWN_EXTENT = PAGE_EXTENT + GROWTH * 2;
/** The fixture declares no trim box, so the marks are placed against its
 *  media box — whose low corner is the origin. */
const TRIM_LOW = 0;

async function openPanel(op: string, ready: string): Promise<void> {
  await setView('operations');
  await invokeAppCommand('view.documentView');
  await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  await setActiveOp(op);
  await $(`[data-testid="${ready}"]`).waitForDisplayed({ timeout: 15_000 });
}

async function waitForPageExtent(extent: number, message: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const pages = await getActiveDocPages();
      return pages.length > 0 && Math.round(pages[0].width) === extent;
    },
    { timeout: 60_000, timeoutMsg: message },
  );
}

/** The darkest sample inside a small box at a normalized page coordinate on
 *  the separation composite — 0 is full ink, 255 is bare paper. */
async function separationDarkestAt(fx: number, fy: number): Promise<number | null> {
  return browser.execute(
    function (nx: number, ny: number) {
      const list = Array.prototype.slice.call(
        document.querySelectorAll('canvas.pageview-separation.ready'),
      ) as HTMLCanvasElement[];
      const drawn = list.filter((c) => c.width > 8 && c.height > 8);
      if (drawn.length === 0) return null;
      const canvas = drawn[0];
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const px = Math.round(nx * canvas.width);
      const py = Math.round(ny * canvas.height);
      const half = 4;
      const x = Math.max(0, px - half);
      const y = Math.max(0, py - half);
      const w = Math.min(canvas.width - x, half * 2 + 1);
      const h = Math.min(canvas.height - y, half * 2 + 1);
      const data = ctx.getImageData(x, y, w, h).data;
      let darkest = 255;
      for (let i = 0; i < data.length; i += 4) {
        const value = Math.min(data[i], data[i + 1], data[i + 2]);
        if (value < darkest) darkest = value;
      }
      return darkest;
    },
    fx,
    fy,
  );
}

async function hairlineCount(): Promise<number> {
  const text = await $('[data-testid="hairlines-count"]').getText();
  const match = /(\d+)/.exec(text);
  return match ? Number(match[1]) : -1;
}

describe('printer marks', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SPOT]);
    await openPanel('printermarks', 'printer-marks-add');
  });

  after(async () => {
    await closeAllFiles();
  });

  it('says which box it is guessing from when there is no trim box', async () => {
    const source = await $('[data-testid="printer-marks-trim-source"]').getText();
    expect(source.length).toBeGreaterThan(0);
    // The fixture carries no trim box, and a document being guessed at has to
    // be told about rather than silently marked.
    await $('[data-testid="printer-marks-no-trim"]').waitForDisplayed({ timeout: 15_000 });
    const pages = await getActiveDocPages();
    expect(Math.round(pages[0].width)).toBe(PAGE_EXTENT);
    expect(Math.round(pages[0].height)).toBe(PAGE_EXTENT);
  });

  it('adding marks grows the page by the offset plus the length, on every edge', async () => {
    // The heaviest weight, so a mark is a whole device pixel at preview
    // resolution and the plate assertion below reads ink rather than
    // antialiasing.
    await setReactSelectValue('[data-testid="printer-marks-weight"]', '0.5');
    await $('[data-testid="printer-marks-add"]').click();
    await waitForPageExtent(GROWN_EXTENT, 'the page never grew to hold the marks');
    const pages = await getActiveDocPages();
    expect(Math.round(pages[0].height)).toBe(GROWN_EXTENT);
  });

  it('reports that the pages now carry marks', async () => {
    await $('[data-testid="printer-marks-present"]').waitForDisplayed({ timeout: 20_000 });
  });

  it('the marks carry ink with every process plate switched off', async () => {
    await setActiveOp('outputpreview');
    await $('[data-testid="output-preview-arm"]').waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="output-preview-arm"]').click();
    await browser.waitUntil(
      async () => (await separationDarkestAt(0.5, 0.5)) !== null,
      { timeout: 90_000, timeoutMsg: 'the separation raster never replaced the page' },
    );
    // Hide every plate, then bring back ONE spot. Registration colour paints
    // every separation, so a crop mark is still on that plate; a mark drawn
    // in black would be on the black plate alone and would be gone here.
    await $('[data-testid="output-preview-hide-all"]').click();
    await $('[data-testid="output-preview-toggle-pantone-185-c"]').click();
    // The bottom-left corner's horizontal crop arm runs along the trim's own
    // y, from one offset outside the trim's x to one offset plus one length.
    // Page coordinates map onto the canvas through the GROWN media box, whose
    // origin sits `GROWTH` below the original page origin.
    const pageToX = (x: number) => (x + GROWTH) / GROWN_EXTENT;
    const pageToY = (y: number) => 1 - (y + GROWTH) / GROWN_EXTENT;
    const markX = pageToX(TRIM_LOW - OFFSET - LENGTH / 2);
    const markY = pageToY(TRIM_LOW);
    let darkest = 255;
    await browser.waitUntil(
      async () => {
        const value = await separationDarkestAt(markX, markY);
        if (value === null) return false;
        darkest = value;
        return darkest < 220;
      },
      {
        timeout: 60_000,
        timeoutMsg: 'the crop mark did not paint on the remaining plate',
      },
    );
    expect(darkest).toBeLessThan(220);
    // A control sample in the same margin band, well away from any mark: the
    // assertion above has to be about the mark, not about the band.
    const blank = await separationDarkestAt(pageToX(TRIM_LOW + 100), markY);
    expect(blank).toBeGreaterThan(240);
    await $('[data-testid="output-preview-arm"]').click();
  });

  it('removing the marks puts the page back to the size it was', async () => {
    await setActiveOp('printermarks');
    await $('[data-testid="printer-marks-remove"]').waitForDisplayed({ timeout: 15_000 });
    await $('[data-testid="printer-marks-remove"]').click();
    await waitForPageExtent(PAGE_EXTENT, 'the page never went back to its original size');
    const pages = await getActiveDocPages();
    expect(Math.round(pages[0].width)).toBe(PAGE_EXTENT);
    expect(Math.round(pages[0].height)).toBe(PAGE_EXTENT);
    expect(await $('[data-testid="printer-marks-present"]').isExisting()).toBe(false);
  });
});

describe('fix hairlines', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([LADDER]);
    await openPanel('hairlines', 'hairlines-fix');
  });

  after(async () => {
    await closeAllFiles();
  });

  it('counts the hairlines and names their widths before anything is rewritten', async () => {
    await browser.waitUntil(async () => (await hairlineCount()) > 0, {
      timeout: 30_000,
      timeoutMsg: 'the hairline count never appeared',
    });
    // 0, 0.05, 0.1 and 0.24 pt, plus the scaled stroke that also draws 0.1 pt.
    expect(await hairlineCount()).toBe(5);
    for (const width of ['0', '0-05', '0-1', '0-24']) {
      expect(await $(`[data-testid="hairlines-width-${width}"]`).isExisting()).toBe(true);
    }
  });

  it('refuses a replacement thinner than the threshold before running anything', async () => {
    await setReactInputValue('[data-testid="hairlines-replacement"]', '0.1');
    await $('[data-testid="hairlines-bad-replacement"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="hairlines-fix"]').isEnabled()).toBe(false);
    await setReactInputValue('[data-testid="hairlines-replacement"]', '0.25');
    await browser.waitUntil(
      async () => !(await $('[data-testid="hairlines-bad-replacement"]').isExisting()),
      { timeout: 10_000, timeoutMsg: 'the replacement objection outlived the value' },
    );
  });

  it('raises every hairline and leaves nothing below the threshold', async () => {
    await $('[data-testid="hairlines-fix"]').click();
    await browser.waitUntil(async () => (await hairlineCount()) === 0, {
      timeout: 60_000,
      timeoutMsg: 'hairlines survived the fix',
    });
    expect(await $('[data-testid="hairlines-fix"]').isEnabled()).toBe(false);
  });

  it('a stricter threshold finds the strokes the first pass was not asked about', async () => {
    await setReactInputValue('[data-testid="hairlines-threshold"]', '0.4');
    await setReactInputValue('[data-testid="hairlines-replacement"]', '0.4');
    await browser.waitUntil(async () => (await hairlineCount()) > 0, {
      timeout: 30_000,
      timeoutMsg: 'raising the threshold found nothing',
    });
    expect(await hairlineCount()).toBeGreaterThan(0);
  });
});
