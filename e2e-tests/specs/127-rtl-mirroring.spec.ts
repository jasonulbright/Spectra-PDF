import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  closeAllFiles,
  invokeAppCommand,
  addAnnotation,
} from '../support/harness.js';

// RIGHT-TO-LEFT UI MIRRORING.
//
// Driven by `qps-rtl` — the pseudo-catalog under a right-to-left direction,
// dev/e2e only. It exists because `qps` proves a surface is COVERED by the
// catalog and cannot prove it MIRRORS, and because the layout has to be
// provable before any right-to-left catalog exists: a catalog without its
// layout is a half-shipped feature.
//
// The governing distinction, and the reason the third test below is the most
// important one here: chrome is text flow and mirrors; the CANVAS is page
// geometry and does not. A page's top-left corner is its top-left corner in
// every language, and a north-west resize handle is geometrically north-west
// — mirroring it makes the handle under the pointer resize the opposite edge.
// An over-eager logical-property pass fails silently (the canvas still
// renders) until someone grabs a handle, so it is asserted here.

const FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

const setLanguage = async (lang: string): Promise<void> => {
  await browser.execute((l) => {
    (window as unknown as { __SPECTRA_TEST__: { setLanguage: (x: string) => void } })
      .__SPECTRA_TEST__.setLanguage(l);
  }, lang);
};

const directionOf = async (): Promise<string> =>
  (await browser.execute(() => document.documentElement.dir)) as string;

const languageOf = async (): Promise<string> =>
  (await browser.execute(() => document.documentElement.lang)) as string;

const waitForDirection = async (want: string): Promise<void> => {
  await browser.waitUntil(async () => (await directionOf()) === want, {
    timeout: 10_000,
    timeoutMsg: `<html dir> never became ${want}`,
  });
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Viewport rect of the first element matching a CSS selector. */
async function rectOf(selector: string): Promise<Rect | null> {
  return (await browser.execute((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, selector)) as Rect | null;
}

/** Viewport rect of an element found by an attribute VALUE — page and
 * annotation ids embed Windows paths, which cannot be CSS-escaped safely. */
async function rectOfAttr(attr: string, value: string): Promise<Rect | null> {
  return (await browser.execute(
    function (a: string, v: string) {
      const el = Array.from(document.querySelectorAll(`[${a}]`)).find(
        (e) => e.getAttribute(a) === v,
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    attr,
    value,
  )) as Rect | null;
}

async function dragBy(fromX: number, fromY: number, dx: number): Promise<void> {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(fromX), y: Math.round(fromY) })
    .down()
    .pause(60)
    .move({ x: Math.round(fromX + dx / 2), y: Math.round(fromY) })
    .pause(60)
    .move({ x: Math.round(fromX + dx), y: Math.round(fromY) })
    .pause(90)
    .up()
    .perform();
}

describe('RTL mirroring', () => {
  let annotationId: string;
  let pageId: string;

  before(async () => {
    await waitForHarness();
    const tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-rtl-'));
    const src = resolve(tmp, 'rtl.pdf');
    copyFileSync(FIXTURE, src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    const a = await addAnnotation({
      kind: 'highlight',
      x: 0.25,
      y: 0.2,
      w: 0.25,
      h: 0.12,
      color: '#ffd54f',
    });
    annotationId = a.annotationId;
    pageId = a.pageId;
    await browser.waitUntil(async () => (await rectOfAttr('data-page-id', pageId)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the page cell never appeared',
    });
  });

  after(async () => {
    await browser.releaseActions();
    await setLanguage('en');
    await waitForDirection('ltr');
    await invokeAppCommand('tools.close');
    await closeAllFiles();
  });

  afterEach(async () => {
    await browser.releaseActions();
  });

  it('sets <html dir> from the language, without disturbing <html lang>', async () => {
    // Direction and language are two facts, set together, and neither is
    // derived from the other's DOM value. The pseudo-locale keeps `lang="en"`
    // because it has no BCP-47 identity — its direction still flips.
    await setLanguage('qps-rtl');
    await waitForDirection('rtl');
    expect(await languageOf()).toBe('en');

    await setLanguage('es');
    await waitForDirection('ltr');
    expect(await languageOf()).toBe('es');

    await setLanguage('qps');
    await waitForDirection('ltr');
    expect(await languageOf()).toBe('en');

    await setLanguage('en');
    await waitForDirection('ltr');
    expect(await languageOf()).toBe('en');
  });

  it('swaps the nav pane and the tool dock to opposite sides', async () => {
    // A computed-style assertion would pass against a stylesheet that changed
    // without the layout moving, so this reads the two panes' actual rects.
    // `view.navPane` TOGGLES, and the pane's open state persists across the
    // battery, so this asks for the state rather than assuming it.
    if (!(await $('[data-testid="nav-pane"]').isExisting())) {
      expect(await invokeAppCommand('view.navPane')).toBe(true);
    }
    expect(await invokeAppCommand('tools.panel.rotate')).toBe(true);
    await $('[data-testid="nav-pane"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });

    await setLanguage('en');
    await waitForDirection('ltr');
    const navLtr = (await rectOf('[data-testid="nav-pane"]'))!;
    const dockLtr = (await rectOf('[data-testid="tool-dock"]'))!;
    expect(navLtr.x).toBeLessThan(dockLtr.x);

    await setLanguage('qps-rtl');
    await waitForDirection('rtl');
    const navRtl = (await rectOf('[data-testid="nav-pane"]'))!;
    const dockRtl = (await rectOf('[data-testid="tool-dock"]'))!;
    expect(navRtl.x).toBeGreaterThan(dockRtl.x);
  });

  it('leaves the canvas unmirrored — page geometry is the document\'s', async () => {
    await setLanguage('qps-rtl');
    await waitForDirection('rtl');

    // A compass handle names a corner of the SELECTED object. Under a
    // mirrored canvas the north-west handle would sit at the maximum x.
    // Selection runs off pointerdown, so this is a real pointer click.
    const annot = (await rectOfAttr('data-annot-id', annotationId))!;
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(annot.x + annot.w / 2), y: Math.round(annot.y + annot.h / 2) })
      .down()
      .pause(40)
      .up()
      .perform();
    await $('[data-testid="annot-handle-nw"]').waitForDisplayed({ timeout: 10_000 });
    const nw = (await rectOf('[data-testid="annot-handle-nw"]'))!;
    const ne = (await rectOf('[data-testid="annot-handle-ne"]'))!;
    const sw = (await rectOf('[data-testid="annot-handle-sw"]'))!;
    const se = (await rectOf('[data-testid="annot-handle-se"]'))!;
    expect(nw.x).toBeLessThan(ne.x);
    expect(sw.x).toBeLessThan(se.x);
    expect(Math.abs(nw.x - sw.x)).toBeLessThan(2);

    // A ruler measures page geometry from the page origin, so its corner
    // stays at the minimum x of the ruler strip whatever the UI language is.
    expect(await invokeAppCommand('view.rulers')).toBe(true);
    await $('[data-testid="ruler-h"]').waitForDisplayed({ timeout: 10_000 });
    const corner = (await rectOf('.docview-ruler-corner'))!;
    const horizontal = (await rectOf('[data-testid="ruler-h"]'))!;
    const vertical = (await rectOf('[data-testid="ruler-v"]'))!;
    expect(corner.x).toBeLessThanOrEqual(horizontal.x);
    expect(Math.abs(corner.x - vertical.x)).toBeLessThan(2);
    expect(await invokeAppCommand('view.rulers')).toBe(true);
  });

  it('runs both pane resize drags the way that widens them', async () => {
    // The defect this exists to catch: a drag computing a width from a raw
    // clientX delta narrows the pane when it is dragged to widen it. CSS
    // logical properties cannot fix pointer arithmetic.
    await setLanguage('qps-rtl');
    await waitForDirection('rtl');
    await $('[data-testid="nav-resize-handle"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="tool-dock-resize"]').waitForDisplayed({ timeout: 10_000 });

    // Under rtl the nav pane sits on the right, so it widens as the handle
    // moves LEFT.
    const navBefore = (await rectOf('[data-testid="nav-pane"]'))!;
    const navHandle = (await rectOf('[data-testid="nav-resize-handle"]'))!;
    await dragBy(navHandle.x + navHandle.w / 2, navHandle.y + navHandle.h / 2, -60);
    await browser.waitUntil(
      async () => (await rectOf('[data-testid="nav-pane"]'))!.w > navBefore.w + 20,
      { timeout: 10_000, timeoutMsg: 'the nav pane did not widen under rtl' },
    );

    // The tool dock sits on the left under rtl, so it widens as its handle
    // moves RIGHT.
    const dockBefore = (await rectOf('[data-testid="tool-dock"]'))!;
    const dockHandle = (await rectOf('[data-testid="tool-dock-resize"]'))!;
    await dragBy(dockHandle.x + dockHandle.w / 2, dockHandle.y + dockHandle.h / 2, 60);
    await browser.waitUntil(
      async () => (await rectOf('[data-testid="tool-dock"]'))!.w > dockBefore.w + 20,
      { timeout: 10_000, timeoutMsg: 'the tool dock did not widen under rtl' },
    );
  });
});
