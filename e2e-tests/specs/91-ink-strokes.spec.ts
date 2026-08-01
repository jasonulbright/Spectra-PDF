// N5 — freehand ink capture with stroke merging: pen lifts inside the merge
// window extend the SAME annotation (a signature drawn in two strokes is ONE
// /Ink), while a stroke after the window starts a new drawing. Real pointer
// gestures through the page cell's window-level ink listeners; the state
// harness reads the resulting stroke counts.
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  getFirstAnnotation,
  getPageAnnotations,
  closeAllFiles,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function pageRect(): Promise<{ x: number; y: number; w: number; h: number }> {
  return (await browser.execute(function () {
    const el = document.querySelector('.page-cell canvas, [data-page-id]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as { x: number; y: number; w: number; h: number };
}

async function drawStroke(r: { x: number; y: number; w: number; h: number },
                          from: [number, number], to: [number, number]): Promise<void> {
  const fx = Math.round(r.x + r.w * from[0]);
  const fy = Math.round(r.y + r.h * from[1]);
  const tx = Math.round(r.x + r.w * to[0]);
  const ty = Math.round(r.y + r.h * to[1]);
  try {
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: fx, y: fy })
      .down()
      .pause(40)
      .move({ x: Math.round((fx + tx) / 2), y: Math.round((fy + ty) / 2) })
      .pause(40)
      .move({ x: tx, y: ty })
      .pause(40)
      .up()
      .perform();
  } finally {
    await browser.releaseActions();
  }
}

describe('ink capture with stroke merging (N5)', () => {
  it('two quick strokes land in ONE annotation; a late stroke starts a new one', async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE_PDF]);
    await setView('canvas');

    // Arm Comment ▸ Draw through the real menu + strip (the user's path).
    await $('[data-testid="menu-tools"]').click();
    await $('[data-testid="menuitem-tool-comment"]').waitForDisplayed();
    await $('[data-testid="menuitem-tool-comment"]').click();
    await $('[data-testid="tool-ink"]').waitForDisplayed();
    await $('[data-testid="tool-ink"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="tool-ink"]').getAttribute('aria-pressed')) === 'true',
      { timeoutMsg: 'Draw mode never armed' },
    );

    const r = await pageRect();
    expect(r).not.toBeNull();

    // Two pen lifts, well inside the 2.5s merge window. All targets stay in
    // the page's TOP band — the cell extends below the fold, and a W3C
    // pointer move outside the viewport hard-fails (the standing trap).
    await drawStroke(r, [0.2, 0.12], [0.4, 0.2]);
    await drawStroke(r, [0.25, 0.25], [0.45, 0.15]);

    const first = await getFirstAnnotation();
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('ink');
    await browser.waitUntil(
      async () => (await getFirstAnnotation())?.strokeCount === 2,
      { timeoutMsg: 'the second stroke did not merge into the first annotation' },
    );
    const one = await getPageAnnotations(first!.docId, first!.pageId);
    expect(one.filter((a) => a.kind === 'ink')).toHaveLength(1);

    // Past the merge window: a NEW drawing begins.
    await browser.pause(2700);
    await drawStroke(r, [0.55, 0.1], [0.7, 0.22]);
    await browser.waitUntil(
      async () => {
        const all = await getPageAnnotations(first!.docId, first!.pageId);
        return all.filter((a) => a.kind === 'ink').length === 2;
      },
      { timeoutMsg: 'a stroke after the merge window did not start a new annotation' },
    );

    await closeAllFiles();
  });

  it('the eraser SPLITS a crossed stroke (N5b) and removes a fully-erased drawing', async () => {
    await closeAllFiles();
    await openByPaths([SAMPLE_PDF]);
    await setView('canvas');
    await $('[data-testid="menu-tools"]').click();
    await $('[data-testid="menuitem-tool-comment"]').waitForDisplayed();
    await $('[data-testid="menuitem-tool-comment"]').click();
    await $('[data-testid="tool-ink"]').waitForDisplayed();
    await $('[data-testid="tool-ink"]').click();

    const r = await pageRect();
    // One long horizontal stroke.
    await drawStroke(r, [0.15, 0.15], [0.6, 0.15]);
    const first = await getFirstAnnotation();
    expect(first!.kind).toBe('ink');
    expect(first!.strokeCount).toBe(1);

    // Erase across its MIDDLE: partial erase splits it into two strokes.
    await $('[data-testid="tool-inkerase"]').waitForDisplayed();
    await $('[data-testid="tool-inkerase"]').click();
    await drawStroke(r, [0.37, 0.08], [0.38, 0.22]);
    await browser.waitUntil(
      async () => (await getFirstAnnotation())?.strokeCount === 2,
      { timeoutMsg: 'the eraser did not split the stroke' },
    );

    // Scrub the whole drawing away: the annotation itself goes.
    await drawStroke(r, [0.1, 0.15], [0.65, 0.15]);
    await drawStroke(r, [0.1, 0.13], [0.65, 0.17]);
    await browser.waitUntil(
      async () => {
        const a = await getFirstAnnotation(2000).catch(() => null);
        return a === null || a.kind !== 'ink';
      },
      { timeoutMsg: 'a fully-erased drawing was not removed' },
    );

    await closeAllFiles();
  });
});
