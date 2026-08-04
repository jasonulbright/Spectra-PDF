// N11 slice A — SNAPPING against the built binary.
//
// The fixture draws two crossing rules at coordinates chosen so every target
// type is unambiguous, and the assertions are on the COMMITTED measurement's
// points: a snapped point is exact (the engine's geometry, projected), where
// an unsnapped pointer lands within a pixel or two of where it was aimed. So
// "did it snap?" is answered by exactness, not by a tolerance — the one thing
// a pointer-driven spec can prove cleanly.
//
// Also covered: the marker badge names the type, Alt suspends for the rest of
// the gesture, Tab cycles the candidates, and the status-bar master toggle
// turns the whole thing off.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  invokeAppCommand,
  getFirstAnnotation,
  getPageAnnotations,
  removeAnnotation,
  closeAllFiles,
} from '../support/harness.js';

const ALT = '\uE00A'; // W3C Alt key
const TAB = '\uE004'; // W3C Tab key

// A 400×400 page with two stroked rules. PDF space is bottom-left origin, so
// the display-normalized target of a PDF point (px, py) is (px/400, 1−py/400).
//
//   horizontal  (100,320) → (340,320)   ends 0.25,0.2 and 0.85,0.2
//                                       midpoint (220,320) → 0.55,0.2
//   vertical    (200,100) → (200,360)   ends 0.5,0.75 and 0.5,0.1
//                                       midpoint (200,230) → 0.5,0.425
//   crossing    (200,320)               → 0.5,0.2
//
// Every one of those is at least 0.05 of a page from every other, so at any
// sane zoom only one candidate is ever inside the 8 px radius.
const T = {
  endpointLeft: [0.25, 0.2] as [number, number],
  endpointRight: [0.85, 0.2] as [number, number],
  hMidpoint: [0.55, 0.2] as [number, number],
  intersection: [0.5, 0.2] as [number, number],
};

async function snapFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const ctx = doc.context;
  const stream = ctx.stream(
    '2 w 0 0 0 RG\n100 320 m 340 320 l S\n200 100 m 200 360 l S\n',
  );
  page.node.set(PDFName.of('Contents'), ctx.register(stream));
  writeFileSync(path, await doc.save());
}

async function pageRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return (await browser.execute(function () {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as { x: number; y: number; w: number; h: number } | null;
}

let pr: { x: number; y: number; w: number; h: number };

/** Viewport pixels for a display-normalized page point, offset by a few
 * pixels so the pointer is NEAR the target rather than on it — landing
 * exactly on it would prove nothing. */
function at(p: [number, number], dxPx = 0, dyPx = 0): { x: number; y: number } {
  return {
    x: Math.round(pr.x + pr.w * p[0] + dxPx),
    y: Math.round(pr.y + pr.h * p[1] + dyPx),
  };
}

/** Wait for PATHS, not merely for a key.
 *
 * A page with an entry and zero paths is a settled EMPTY listing, which is a
 * different thing from "not fetched yet" — the `listingSettled` lesson, and
 * asserting on the weaker condition is how a spec passes over a no-op. */
async function snapGeometryReady(): Promise<void> {
  await browser.waitUntil(
    async () =>
      ((await browser.execute(() => {
        const h = (window as any).__SPECTRA_TEST__;
        const ids: string[] = h?.snapGeometryPageIds?.() ?? [];
        return ids.reduce((n: number, id: string) => n + (h?.snapGeometry?.(id)?.length ?? 0), 0);
      })) as number) > 0,
    { timeout: 20_000, timeoutMsg: 'snap geometry never landed with any paths' },
  );
}

/** Read the live snap badge, or null when no marker is showing. */
async function badgeText(): Promise<string | null> {
  return (await browser.execute(
    () =>
      (document.querySelector('[data-testid="snap-type-badge"]') as HTMLElement | null)
        ?.textContent ?? null,
  )) as string | null;
}

/** Press and travel WITHOUT releasing.
 *
 * `perform(true)` is load-bearing: wdio's `perform()` calls `releaseActions()`
 * when it returns, which fires the pointerup and ends the gesture — every
 * mid-drag assertion would otherwise read a page with no gesture on it (spec
 * 34 holds the space bar the same way). The caller releases. */
async function pressAndTravel(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: from.x, y: from.y })
    .down()
    .pause(60)
    .move({ x: to.x, y: to.y })
    .pause(150)
    .perform(true);
}

async function release(): Promise<void> {
  await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).up().perform();
}

/** A whole measure-distance drag; returns the badge seen just before release. */
async function measureDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<string | null> {
  await pressAndTravel(from, to);
  const text = await badgeText();
  await release();
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

describe('snapping (N11 slice A)', () => {
  before(async () => {
    await waitForHarness();
    const tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-snap-'));
    const src = resolve(tmp, 'rules.pdf');
    await snapFixture(src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
    await invokeAppCommand('tools.measuredist');
    await snapGeometryReady();
    // Measure the cell AFTER arming: the mode opens the secondary toolbar,
    // which reflows the canvas and MOVES the page. A rect captured before
    // that aims every gesture at the wrong pixels (it cost a full spec run).
    await browser.pause(300);
    pr = (await pageRect())!;
  });

  after(async () => {
    await browser.releaseActions();
    await invokeAppCommand('tools.close');
    await closeAllFiles();
  });

  afterEach(async () => {
    await browser.releaseActions();
    await clearMeasurements();
  });

  it('snaps to an ENDPOINT, exactly, and names it', async () => {
    const badge = await measureDrag(at(T.endpointLeft, 5, 5), at(T.endpointRight, -5, 4));
    expect(badge).toBe('Endpoint');
    const pts = await lastMeasurePoints();
    expect(Math.abs(pts[0] - T.endpointLeft[0])).toBeLessThan(1e-6);
    expect(Math.abs(pts[1] - T.endpointLeft[1])).toBeLessThan(1e-6);
    expect(Math.abs(pts[2] - T.endpointRight[0])).toBeLessThan(1e-6);
    expect(Math.abs(pts[3] - T.endpointRight[1])).toBeLessThan(1e-6);
  });

  it('snaps to a MIDPOINT even though the cursor is ON the line', async () => {
    // The cursor sits on the rule, so the `edge` candidate is at distance 0 —
    // priority is what makes the midpoint win, not proximity.
    const badge = await measureDrag(at(T.hMidpoint, 4, 0), at(T.endpointRight, -5, 4));
    expect(badge).toBe('Endpoint'); // the badge reports the LAST snap of the drag
    const pts = await lastMeasurePoints();
    expect(Math.abs(pts[0] - T.hMidpoint[0])).toBeLessThan(1e-6);
    expect(Math.abs(pts[1] - T.hMidpoint[1])).toBeLessThan(1e-6);
  });

  it('snaps to an INTERSECTION the two rules never store', async () => {
    // Neither path carries this point — it is computed, lazily, from the two
    // segments the cursor's buckets touched.
    const badge = await measureDrag(at(T.intersection, 4, 4), at(T.endpointRight, -5, 4));
    expect(badge).toBe('Endpoint');
    const pts = await lastMeasurePoints();
    expect(Math.abs(pts[0] - T.intersection[0])).toBeLessThan(1e-6);
    expect(Math.abs(pts[1] - T.intersection[1])).toBeLessThan(1e-6);
  });

  it('names the INTERSECTION in the marker badge', async () => {
    // Start clear of every target so the badge can only come from the end.
    await pressAndTravel(at(T.endpointLeft, 0, -40), at(T.intersection, 4, 4));
    try {
      expect(await badgeText()).toBe('Intersection');
    } finally {
      await release();
    }
  });

  it('Alt SUSPENDS snapping for the rest of the gesture', async () => {
    const near = at(T.endpointRight, -6, 5);
    try {
      await pressAndTravel(at(T.endpointLeft, 0, -40), near);
      expect(await badgeText()).toBe('Endpoint'); // snapped so far
      // Now hold Alt and nudge: the marker goes, and the point stays raw.
      await browser.performActions([
        { type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: ALT }] },
      ]);
      await browser
        .action('pointer', { parameters: { pointerType: 'mouse' } })
        .move({ x: near.x + 1, y: near.y })
        .pause(150)
        .perform(true);
      expect(await badgeText()).toBeNull();
      await release();
      const pts = await lastMeasurePoints();
      // The END point must NOT be the exact endpoint - Alt suspended it.
      expect(Math.abs(pts[2] - T.endpointRight[0])).toBeGreaterThan(1e-6);
    } finally {
      await browser.performActions([
        { type: 'key', id: 'kb', actions: [{ type: 'keyUp', value: ALT }] },
      ]);
      await browser.releaseActions();
    }
  });

  it('Tab CYCLES to the next candidate under the cursor', async () => {
    // On the intersection, the candidates are intersection → midpoint? no —
    // → the two segments' edge points. Whatever the second is, it must be a
    // DIFFERENT type, and a second Tab must keep moving rather than stick.
    const onCross = at(T.intersection, 3, 3);
    try {
      await pressAndTravel(at(T.endpointLeft, 0, -40), onCross);
      expect(await badgeText()).toBe('Intersection');
      await browser.performActions([
        {
          type: 'key',
          id: 'kb',
          actions: [{ type: 'keyDown', value: TAB }, { type: 'keyUp', value: TAB }],
        },
      ]);
      // The cycle is read on the next pointer sample.
      await browser
        .action('pointer', { parameters: { pointerType: 'mouse' } })
        .move({ x: onCross.x + 1, y: onCross.y })
        .pause(150)
        .perform(true);
      const cycled = await badgeText();
      expect(cycled).not.toBeNull();
      expect(cycled).not.toBe('Intersection');
      await release();
    } finally {
      await browser.releaseActions();
    }
  });

  it('the status-bar master toggle turns snapping off, and the drag lands raw', async () => {
    const toggle = await browser.$('[data-testid="snap-toggle"]');
    await toggle.waitForDisplayed({ timeout: 5_000 });
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    await toggle.click();
    await browser.waitUntil(async () => (await toggle.getAttribute('aria-pressed')) === 'false', {
      timeout: 5_000,
      timeoutMsg: 'the snap toggle never turned off',
    });
    const badge = await measureDrag(at(T.endpointLeft, 5, 5), at(T.endpointRight, -5, 4));
    expect(badge).toBeNull();
    const pts = await lastMeasurePoints();
    expect(Math.abs(pts[0] - T.endpointLeft[0])).toBeGreaterThan(1e-6);
    // …and back on for whatever runs next.
    await toggle.click();
    await browser.waitUntil(async () => (await toggle.getAttribute('aria-pressed')) === 'true', {
      timeout: 5_000,
      timeoutMsg: 'the snap toggle never turned back on',
    });
  });
});
