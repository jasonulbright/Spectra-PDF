// RULERS, GRID, GUIDES and the Shift angle constrain, against
// the built binary.
//
// The fixture is a BLANK 400×400 page on purpose: with no drawn geometry the
// only snap candidates in existence are the ones this slice adds, so a landed
// point can only have come from a guide or the grid. (Spec 105 covers the
// geometric types on a page that has geometry.)
//
// As in 105, the assertion for "did it snap?" is EXACTNESS — a snapped
// coordinate is the target's own, where a pointer's is within a pixel or two
// of where it was aimed. Three mechanics matter here:
//   • `perform(true)` for any mid-gesture read — wdio's plain `perform()`
//     calls releaseActions() on return and ends the drag (spec 34's held
//     space bar is the precedent);
//   • the page rect is measured AFTER arming, because a mode opening the
//     secondary toolbar reflows the canvas and moves the cell;
//   • a square page at the default zoom is TALLER than the pane, so every
//     page coordinate below stays in the top band — a `move` past the
//     viewport is a WebDriver error, not a missed click.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  invokeAppCommand,
  getFirstAnnotation,
  getPageAnnotations,
  removeAnnotation,
  closeAllFiles,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

const SHIFT = ''; // W3C Shift key

/** The page is 400 pt square, so a point is pageWidthPx/400 CSS pixels. */
const PAGE_PT = 400;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function blankFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([PAGE_PT, PAGE_PT]);
  writeFileSync(path, await doc.save());
}

async function pageRect(): Promise<Rect | null> {
  return (await browser.execute(function () {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as Rect | null;
}

async function elementRect(testid: string): Promise<Rect | null> {
  return (await browser.execute(function (id: string) {
    const el = document.querySelector('[data-testid="' + id + '"]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, testid)) as Rect | null;
}

let pr: Rect;

/** Viewport pixels for a display-normalized page point. */
function at(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(pr.x + pr.w * x), y: Math.round(pr.y + pr.h * y) };
}

/** Arm the measuring tool and re-measure the cell it just moved. */
async function armMeasure(): Promise<void> {
  await invokeAppCommand('tools.measuredist');
  await browser.pause(400);
  pr = (await pageRect())!;
}

async function badgeText(): Promise<string | null> {
  return (await browser.execute(
    () =>
      (document.querySelector('[data-testid="snap-type-badge"]') as HTMLElement | null)
        ?.textContent ?? null,
  )) as string | null;
}

async function pressAndTravel(
  from: { x: number; y: number },
  to: { x: number; y: number },
  keys: string[] = [],
): Promise<void> {
  for (const k of keys) {
    await browser.performActions([
      { type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: k }] },
    ]);
  }
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: from.x, y: from.y })
    .down()
    .pause(60)
    .move({ x: to.x, y: to.y })
    .pause(150)
    .perform(true); // load-bearing: a plain perform() would end the drag
}

async function release(keys: string[] = []): Promise<void> {
  await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).up().perform();
  for (const k of keys) {
    await browser.performActions([
      { type: 'key', id: 'kb', actions: [{ type: 'keyUp', value: k }] },
    ]);
  }
}

async function measureDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  keys: string[] = [],
): Promise<string | null> {
  await pressAndTravel(from, to, keys);
  const text = await badgeText();
  await release(keys);
  return text;
}

async function lastMeasurePoints(): Promise<number[]> {
  const first = await getFirstAnnotation();
  if (!first) throw new Error('no annotation was committed');
  const all = await getPageAnnotations(first.docId, first.pageId);
  const meas = all.filter((a) => a.kind === 'measure');
  const last = meas[meas.length - 1];
  if (!last?.points) throw new Error('the committed measurement carries no points');
  return last.points;
}

async function clearMeasurements(): Promise<void> {
  const first = await getFirstAnnotation(2_000);
  if (!first) return;
  const all = await getPageAnnotations(first.docId, first.pageId);
  for (const a of all) await removeAnnotation(first.docId, first.pageId, a.id);
}

interface HarnessGuide {
  id: string;
  pageId: string;
  axis: 'x' | 'y';
  pos: number;
  rotationAtDraw: number;
}

async function guides(): Promise<HarnessGuide[]> {
  return (await browser.execute(
    () => (window as any).__SPECTRA_TEST__?.guides?.() ?? [],
  )) as HarnessGuide[];
}

/** Open the status bar's snap popover (idempotent). */
async function openSnapPopover(): Promise<void> {
  if (await (await browser.$('[data-testid="snap-options-popover"]')).isExisting()) return;
  const caret = await browser.$('[data-testid="snap-options-toggle"]');
  await caret.waitForDisplayed({ timeout: 5_000 });
  await caret.click();
  await (await browser.$('[data-testid="snap-options-popover"]')).waitForDisplayed({
    timeout: 5_000,
  });
}

/**
 * Close the popover by CLICKING ITS CARET, never with Escape.
 *
 * Escape is a chain in this app, and its scopes reach past the popover —
 * pressing it here disarmed the measuring mode, so every drag afterwards
 * landed on an idle page and the failure read as "the grid does not snap"
 * rather than "the tool was closed". Cost a full spec run; recorded so the
 * next spec that drives this popover does not repeat it.
 */
async function closeSnapPopover(): Promise<void> {
  if (!(await (await browser.$('[data-testid="snap-options-popover"]')).isExisting())) return;
  await (await browser.$('[data-testid="snap-options-toggle"]')).click();
  await browser.waitUntil(
    async () => !(await (await browser.$('[data-testid="snap-options-popover"]')).isExisting()),
    { timeout: 5_000, timeoutMsg: 'the snap popover never closed' },
  );
}

async function setCheckbox(testid: string, want: boolean): Promise<void> {
  const box = await browser.$(`[data-testid="${testid}"]`);
  await box.waitForDisplayed({ timeout: 5_000 });
  if ((await box.isSelected()) !== want) await box.click();
  await browser.waitUntil(async () => (await box.isSelected()) === want, {
    timeout: 5_000,
    timeoutMsg: `${testid} never reached ${want}`,
  });
}

async function gridLineCount(): Promise<number> {
  return (await browser.execute(
    () => document.querySelectorAll('[data-testid="page-grid"] line').length,
  )) as number;
}

async function openFixture(): Promise<void> {
  const tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-grid-'));
  const src = resolve(tmp, 'blank.pdf');
  await blankFixture(src);
  await closeAllFiles();
  await openByPaths([src]);
  await setView('canvas');
  await browser.waitUntil(async () => (await pageRect()) !== null, {
    timeout: 15_000,
    timeoutMsg: 'no page cell appeared',
  });
}

describe('rulers and guides', () => {
  before(async () => {
    await waitForHarness();
    await openFixture();
    await invokeAppCommand('view.rulers');
    await armMeasure();
  });

  after(async () => {
    await browser.releaseActions();
    await invokeAppCommand('view.clearGuides');
    await invokeAppCommand('view.rulers');
    await invokeAppCommand('tools.close');
    await closeAllFiles();
  });

  afterEach(async () => {
    await browser.releaseActions();
    await clearMeasurements();
  });

  it('shows both rulers, reading in the measuring scale’s unit', async () => {
    const h = await browser.$('[data-testid="ruler-h"]');
    const v = await browser.$('[data-testid="ruler-v"]');
    await h.waitForDisplayed({ timeout: 5_000 });
    await v.waitForDisplayed({ timeout: 5_000 });

    // The label spacing is a QUANTITY, not decoration: it must be the round
    // number of scale-units the tick math chose, measured against the page's
    // own size. At the default 1 in = 1 in, that is inches of paper.
    const labels = (await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="ruler-h"] .ruler-label')).map((el) => ({
        text: (el.textContent ?? '').trim(),
        left: (el.parentElement as HTMLElement).getBoundingClientRect().left,
      })),
    )) as { text: string; left: number }[];
    expect(labels.length).toBeGreaterThan(2);
    const pxPerIn = (pr.w / PAGE_PT) * 72;
    for (let i = 1; i < labels.length; i++) {
      const gapUnits = Number(labels[i].text) - Number(labels[i - 1].text);
      const gapPx = labels[i].left - labels[i - 1].left;
      expect(Math.abs(gapPx - gapUnits * pxPerIn)).toBeLessThan(2);
    }
    // Zero sits on the page's left edge — the ruler measures the PAGE, not
    // the scroll pane.
    const zero = labels.find((l) => Number(l.text) === 0);
    expect(zero).toBeDefined();
    expect(Math.abs(zero!.left - pr.x)).toBeLessThan(3);
  });

  it('re-reads in FEET when the drawing scale says 1 in = 4 ft', async () => {
    await setReactInputValue('[data-testid="measure-scale-to"]', '4');
    await setReactSelectValue('[data-testid="measure-scale-to-unit"]', 'ft');
    await browser.pause(200);
    const corner = (await browser.execute(
      () =>
        (document.querySelector('.docview-ruler-corner') as HTMLElement | null)?.textContent ?? '',
    )) as string;
    expect(corner.trim()).toBe('ft');

    const values = (await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="ruler-h"] .ruler-label')).map((el) =>
        Number((el.textContent ?? '').trim()),
      ),
    )) as number[];
    // A 400 pt page is 5.55 in of paper = 22.2 ft, so the ruler must now
    // reach values an inch-ruler never would.
    expect(Math.max(...values)).toBeGreaterThan(5);

    // …and back, so the rest of the suite sees the shipped default.
    await setReactInputValue('[data-testid="measure-scale-to"]', '1');
    await setReactSelectValue('[data-testid="measure-scale-to-unit"]', 'in');
    await browser.pause(200);
  });

  it('drags a GUIDE off the top ruler onto the page', async () => {
    expect(await guides()).toHaveLength(0);
    const ruler = (await elementRect('ruler-h'))!;
    const target = at(0.5, 0.25);
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(ruler.x + ruler.w / 2), y: Math.round(ruler.y + ruler.h / 2) })
      .down()
      .pause(60)
      .move({ x: target.x, y: target.y })
      .pause(80)
      .up()
      .perform();
    await browser.waitUntil(async () => (await guides()).length === 1, {
      timeout: 5_000,
      timeoutMsg: 'the ruler drag never placed a guide',
    });
    const [g] = await guides();
    // The top ruler creates a horizontal guide, following drafting convention.
    expect(g.axis).toBe('y');
    expect(Math.abs(g.pos - 0.25)).toBeLessThan(0.01);
    expect(await (await browser.$('[data-testid="page-guide"]')).isExisting()).toBe(true);
  });

  it('SNAPS to that guide, exactly, and names it', async () => {
    const [g] = await guides();
    expect(g).toBeDefined();
    // Aim a few pixels off the guide; the landed y must be the guide's own.
    const from = at(0.15, 0.05);
    const to = { x: at(0.85, 0).x, y: Math.round(pr.y + pr.h * g.pos) + 4 };
    const badge = await measureDrag(from, to);
    expect(badge).toBe('Guide');
    const pts = await lastMeasurePoints();
    expect(Math.abs(pts[3] - g.pos)).toBeLessThan(1e-6);
  });

  it('MOVES a guide by dragging it, and DELETES it by dragging off the page', async () => {
    // Back to Select: a guide's grab strip is only interactive there, so a
    // drawing gesture can never be swallowed by one.
    await invokeAppCommand('tools.close');
    await browser.pause(300);
    const cell = (await pageRect())!;
    const [g0] = await guides();
    const grab = { x: Math.round(cell.x + cell.w / 2), y: Math.round(cell.y + cell.h * g0.pos) };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: grab.x, y: grab.y })
      .down()
      .pause(60)
      .move({ x: grab.x, y: Math.round(cell.y + cell.h * 0.12) })
      .pause(80)
      .up()
      .perform();
    await browser.waitUntil(
      async () => {
        const [g] = await guides();
        return !!g && Math.abs(g.pos - 0.12) < 0.02;
      },
      { timeout: 5_000, timeoutMsg: 'the guide never moved' },
    );

    // Drag it clear of the page to remove it.
    const [g1] = await guides();
    const held = { x: grab.x, y: Math.round(cell.y + cell.h * g1.pos) };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: held.x, y: held.y })
      .down()
      .pause(60)
      .move({ x: held.x, y: Math.max(2, Math.round(cell.y - 30)) })
      .pause(80)
      .up()
      .perform();
    await browser.waitUntil(async () => (await guides()).length === 0, {
      timeout: 5_000,
      timeoutMsg: 'the guide dragged off the page was not removed',
    });
  });
});

describe('grid and angle constrain', () => {
  before(async () => {
    await waitForHarness();
    await openFixture();
    await armMeasure();
  });

  after(async () => {
    await browser.releaseActions();
    await openSnapPopover();
    await setCheckbox('grid-scaled', false);
    await setCheckbox('grid-show', false);
    await setCheckbox('snap-type-grid', false);
    await closeSnapPopover();
    await invokeAppCommand('tools.close');
    await closeAllFiles();
  });

  afterEach(async () => {
    await browser.releaseActions();
    await clearMeasurements();
  });

  it('draws the GRID and snaps to it, in the units asked for', async () => {
    // Grid snapping is OFF by default and deliberately so: a grid candidate
    // exists at every point on the page, unlike the geometric types.
    expect(await (await browser.$('[data-testid="page-grid"]')).isExisting()).toBe(false);
    await openSnapPopover();
    await setCheckbox('grid-show', true);
    await setCheckbox('snap-type-grid', true);
    // A half-inch grid on a 400 pt page: a line every 36 pt, i.e. every 0.09
    // of the page — far outside the 8 px radius at this zoom.
    await setReactInputValue('[data-testid="grid-spacing"]', '0.5');
    await setReactSelectValue('[data-testid="grid-unit"]', 'in');
    await closeSnapPopover();
    await browser.pause(250);

    expect(await gridLineCount()).toBeGreaterThan(4);

    // The grid runs from the page's top-left corner, so a line sits at every
    // multiple of 36/400 normalized. Aim just off one and land on it exactly.
    // Offset by a few PIXELS, not by a fraction of the spacing: the radius is
    // a felt distance in screen pixels, so a grid line half a cell away is
    // correctly out of reach and aiming there would prove the opposite of
    // what this asserts.
    const step = 36 / PAGE_PT;
    const targetX = step * 3; // 108 pt
    const targetY = step * 2; // 72 pt
    const near = at(targetX, targetY);
    await pressAndTravel({ x: near.x + 3, y: near.y + 3 }, at(step * 6, step * 3));
    const badge = await badgeText();
    await release();
    expect(badge).toBe('Grid');
    const pts = await lastMeasurePoints();
    expect(Math.abs(pts[0] - targetX)).toBeLessThan(1e-6);
    expect(Math.abs(pts[1] - targetY)).toBeLessThan(1e-6);
  });

  it('reads the grid spacing in REAL-WORLD units through the drawing scale', async () => {
    // 1 in = 4 ft, and a 1 ft grid: 18 pt of paper per line, half of what the
    // half-inch paper grid gave. The line count is the observable.
    const before = await gridLineCount();
    await setReactInputValue('[data-testid="measure-scale-to"]', '4');
    await setReactSelectValue('[data-testid="measure-scale-to-unit"]', 'ft');
    await openSnapPopover();
    await setCheckbox('grid-scaled', true);
    await setReactInputValue('[data-testid="grid-spacing"]', '1');
    await closeSnapPopover();
    await browser.pause(300);
    // 18 pt lines are twice as dense as 36 pt ones.
    expect(await gridLineCount()).toBeGreaterThan(before * 1.6);

    // And a drag lands on an 18 pt multiple, which the paper grid had none of.
    const step = 18 / PAGE_PT;
    const targetX = step * 7; // 126 pt — not a multiple of 36
    const targetY = step * 5; // 90 pt — likewise
    const near = at(targetX, targetY);
    await pressAndTravel({ x: near.x + 3, y: near.y + 3 }, at(step * 12, step * 9));
    await release();
    const pts = await lastMeasurePoints();
    expect(Math.abs(pts[0] - targetX)).toBeLessThan(1e-6);
    expect(Math.abs(pts[1] - targetY)).toBeLessThan(1e-6);

    // Restore the 1:1 scale for the angle case below.
    await setReactInputValue('[data-testid="measure-scale-to"]', '1');
    await setReactSelectValue('[data-testid="measure-scale-to-unit"]', 'in');
    await openSnapPopover();
    await setCheckbox('grid-scaled', false);
    await setCheckbox('grid-show', false);
    await setCheckbox('snap-type-grid', false);
    await closeSnapPopover();
    await browser.pause(250);
    expect(await (await browser.$('[data-testid="page-grid"]')).isExisting()).toBe(false);
  });

  it('SHIFT holds the segment to the nearest angle increment', async () => {
    // ~40° below horizontal on a square page; the default 15° increment makes
    // 45° the nearest ray, so the committed leg must be exactly diagonal.
    const from = at(0.15, 0.05);
    const dx = Math.round(pr.w * 0.2);
    const dy = Math.round(dx * Math.tan((40 * Math.PI) / 180));
    await measureDrag(from, { x: from.x + dx, y: from.y + dy }, [SHIFT]);
    const pts = await lastMeasurePoints();
    // The page is square, so equal normalized deltas ARE 45° on screen.
    const legX = pts[2] - pts[0];
    const legY = pts[3] - pts[1];
    expect(legX).toBeGreaterThan(0.1);
    expect(Math.abs(legX - legY)).toBeLessThan(1e-6);
  });
});
