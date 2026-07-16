import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getState,
  getWorkspacePageIds,
  getFirstAnnotation,
  setDocViewMode,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// M6.2: Hand/Select modes + Space temporary hand + the PageInspector's
// retirement (double-click / context-menu "Open" now READ the page).

async function scrollTopOf(): Promise<number> {
  return (await browser.execute(() => {
    const el = document.querySelector('[data-testid="document-view"]');
    return el ? el.scrollTop : -1;
  })) as number;
}

async function dragBy(dx: number, dy: number): Promise<void> {
  const box = (await browser.execute(() => {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })) as { x: number; y: number };
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(box.x), y: Math.round(box.y) })
    .down()
    .pause(60)
    .move({ x: Math.round(box.x + dx), y: Math.round(box.y + dy) })
    .pause(60)
    .up()
    .perform();
}

describe('hand tool (M6.2)', () => {
  it('the toolbar Hand button arms the mode, pressed-state and all', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 5);

    const hand = $('[data-testid="toolbar-hand"]');
    await hand.click();
    await browser.waitUntil(async () => (await getState()).tool === 'hand', {
      timeoutMsg: 'the Hand button did not arm hand',
    });
    expect(await hand.getAttribute('aria-pressed')).toBe('true');
  });

  it('hand DRAGS the reading view — and neither selects nor annotates', async () => {
    // Scroll down a little first so an upward drag has somewhere to go, then
    // drag the page DOWN (content follows the hand: scrollTop decreases).
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="document-view"]');
      if (el) el.scrollTop = 400;
    });
    const before = await scrollTopOf();
    expect(before).toBeGreaterThan(0);

    await dragBy(0, 150);
    await browser.waitUntil(async () => (await scrollTopOf()) < before - 100, {
      timeoutMsg: 'the hand drag did not scroll the reading view',
    });
    // It held the paper — it didn't touch the page model.
    const s = await getState();
    expect(s.tool).toBe('hand');
    expect((await getWorkspacePageIds()).length).toBe(5);
  });

  it('Space is a TEMPORARY hand: hold to pan, release to get your mode back', async () => {
    await $('[data-testid="toolbar-select"]').click();
    await browser.waitUntil(async () => (await getState()).tool === 'select');

    // perform(true) = skipRelease: plain perform() auto-releases every
    // pressed input at the end, so the "hold" would keyup instantly.
    await browser.action('key').down(' ').perform(true);
    await browser.waitUntil(async () => (await getState()).tool === 'hand', {
      timeoutMsg: 'holding Space did not arm hand',
    });
    await browser.action('key').up(' ').perform();
    await browser.waitUntil(async () => (await getState()).tool === 'select', {
      timeoutMsg: 'releasing Space did not restore the prior mode',
    });
  });

  it('on the board, hand never picks a page up', async () => {
    // The PAN half of hand-on-the-board is not drivable here: the driver's
    // synthetic input fires pointer listeners (usePageDrag, and this suite's
    // own drags) but d3-zoom listens to MOUSE events, which never arrive —
    // verified with a background-drag bisect, which is also why the board's
    // pan has never had an e2e. The admission rule itself is unit-tested
    // (zoomGestureAllowed, tests/zoom-gesture.test.ts); this case pins the
    // OTHER half: the same drag that reorders pages in Select must move
    // nothing in Hand (spec 20 proves the Select half with this exact
    // gesture).
    await setDocViewMode('organize');
    await $('[data-testid="toolbar-hand"]').click();
    await browser.waitUntil(async () => (await getState()).tool === 'hand');

    const order = await getWorkspacePageIds();
    await dragBy(120, 40);
    // Give a would-be reorder time to land, then pin that nothing moved.
    await browser.pause(300);
    expect(await getWorkspacePageIds()).toEqual(order);
    expect(
      await browser.execute(() => document.querySelector('.page-drag-ghost, [class*="drag-ghost"]') !== null),
    ).toBe(false);
    // …and nothing was PAINTED: hand fell through PageCell's annotate branch
    // once, drawing a highlight instead of panning (review-caught CRITICAL —
    // this exact real drag is the repro).
    expect(await getFirstAnnotation(1_500)).toBeNull();
  });

  it('hand-on-page PANS; select-on-page does not (the d3 admission rule, live)', async () => {
    // d3 doesn't check isTrusted, so in-page synthetic MOUSE events drive the
    // real gesture through the real filter — the half the driver can't reach.
    const panProbe = () =>
      browser.execute(() => {
        const cell = document.querySelector('[data-page-id]');
        const world = document.querySelector('.canvas-world') as HTMLElement | null;
        if (!cell || !world) return 'missing';
        const before = world.style.transform;
        const r = cell.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
        cell.dispatchEvent(new MouseEvent('mousedown', { ...opts, clientX: x, clientY: y }));
        window.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: x + 80, clientY: y + 30 }));
        window.dispatchEvent(new MouseEvent('mouseup', { ...opts, clientX: x + 80, clientY: y + 30 }));
        return world.style.transform !== before ? 'panned' : 'no-pan';
      });

    expect(await getState()).toHaveProperty('tool', 'hand');
    expect(await panProbe()).toBe('panned');

    await $('[data-testid="toolbar-select"]').click();
    await browser.waitUntil(async () => (await getState()).tool === 'select');
    // The SAME synthetic drag from a page must be refused in Select — pages
    // belong to pickup there. This is the filter's discrimination, live.
    expect(await panProbe()).toBe('no-pan');
  });

  it('double-click page THREE on the board reads PAGE THREE — the inspector is gone', async () => {
    await $('[data-testid="toolbar-select"]').click();
    // Page 1 is the wrong-behavior fallback (the stale-ref jump landed there,
    // review-caught HIGH) — only a non-first page discriminates.
    const targetId = (await getWorkspacePageIds())[2];
    const cells = await $$('[data-page-id]');
    let target: WebdriverIO.Element | null = null;
    for (const c of cells) {
      if ((await c.getAttribute('data-page-id')) === targetId) { target = c; break; }
    }
    expect(target).not.toBeNull();
    await target!.doubleClick();
    await browser.waitUntil(async () => (await getState()).docViewMode === 'document', {
      timeoutMsg: 'double-click did not open the reading view',
    });
    await browser.waitUntil(async () => (await getState()).currentPageId === targetId, {
      timeoutMsg: 'the reading view did not land on the double-clicked page',
    });
    // Nothing renders the retired overlay.
    expect(
      await browser.execute(() => document.querySelector('.page-inspector, [data-testid="page-inspector"]') !== null),
    ).toBe(false);
  });
});
