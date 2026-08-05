// Annotation manipulation (rung 1): move, resize, multi-select, align,
// z-order, keyboard delete — real W3C pointer gestures through the
// manipulation handlers' window-level listeners, geometry asserted in the
// state harness, and the moved rect proven IN THE SAVED FILE via the CLI's
// comments-list (the file is truth, not the overlay).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  waitForHarness,
  openByPaths,
  setView,
  invokeAppCommand,
  addAnnotation,
  getPageAnnotations,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
  getActiveDocPages,
} from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

const CTRL = '\uE009'; // W3C Control key

/** Viewport-space rect of an element found by attribute value (ids embed
 * Windows paths, so CSS-escaping an attribute SELECTOR is a trap). */
async function rectOf(attr: string, value: string): Promise<{ x: number; y: number; w: number; h: number }> {
  return (await browser.execute(
    function (a: string, v: string) {
      const el = Array.from(document.querySelectorAll(`[${a}]`)).find(
        (e) => e.getAttribute(a) === v,
      );
      if (!el) return null as any;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    attr,
    value,
  )) as { x: number; y: number; w: number; h: number };
}

async function dragBy(fromX: number, fromY: number, dx: number, dy: number): Promise<void> {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(fromX), y: Math.round(fromY) })
    .down()
    .pause(60)
    .move({ x: Math.round(fromX + 8), y: Math.round(fromY + 8) }) // cross the 3px threshold
    .pause(60)
    .move({ x: Math.round(fromX + dx), y: Math.round(fromY + dy) })
    .pause(90)
    .up()
    .perform();
}

/** Click with Ctrl held — two parallel W3C input sources, tick-aligned.
 * releaseActions in finally: a mid-sequence throw (e.g. out-of-bounds)
 * must never leave the virtual Ctrl or button held for the next test. */
async function ctrlClick(x: number, y: number): Promise<void> {
  try {
    await browser.performActions([
      {
        type: 'key',
        id: 'kb',
        actions: [
          { type: 'keyDown', value: CTRL },
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: 0 },
          { type: 'keyUp', value: CTRL },
        ],
      },
      {
        type: 'pointer',
        id: 'ms',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
          { type: 'pause', duration: 0 },
        ],
      },
    ]);
  } finally {
    await browser.releaseActions();
  }
}

const selectedCount = async (): Promise<number> =>
  (await browser.execute(() => document.querySelectorAll('.page-annot-selected').length)) as number;

describe('annotation manipulation', () => {
  let tmp: string;
  let doc: { docId: string; pageId: string };
  let aId: string;
  let bId: string;
  let pageRect: { x: number; y: number; w: number; h: number };
  let pagePts: { width: number; height: number };

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'annot-manip-'));
    const src = resolve(tmp, 'manip.pdf');
    copyFileSync(FIXTURE, src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    const a = await addAnnotation({ kind: 'highlight', x: 0.2, y: 0.2, w: 0.2, h: 0.1, color: '#ffd54f' });
    doc = { docId: a.docId, pageId: a.pageId };
    aId = a.annotationId;
    bId = (await addAnnotation({ kind: 'highlight', x: 0.6, y: 0.55, w: 0.15, h: 0.2, color: '#4fc3f7' })).annotationId;
    await browser.waitUntil(async () => (await rectOf('data-page-id', doc.pageId)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the page cell never appeared',
    });
    pageRect = await rectOf('data-page-id', doc.pageId);
    const pages = await getActiveDocPages();
    pagePts = { width: pages[0].width, height: pages[0].height };
  });

  it('drags an annotation body to a new position (move gesture)', async () => {
    const body = await rectOf('data-annot-id', aId);
    expect(body).not.toBeNull();
    // +20% of the page right, +15% down.
    await dragBy(
      body.x + body.w / 2,
      body.y + body.h / 2,
      pageRect.w * 0.2,
      pageRect.h * 0.15,
    );
    const a = (await getPageAnnotations(doc.docId, doc.pageId)).find((x) => x.id === aId)!;
    expect(Math.abs(a.x - 0.4)).toBeLessThan(0.03);
    expect(Math.abs(a.y - 0.35)).toBeLessThan(0.03);
    // The gesture selected it on the press.
    expect(await selectedCount()).toBe(1);
  });

  it('resizes via the SE handle, opposite corner anchored', async () => {
    const before = (await getPageAnnotations(doc.docId, doc.pageId)).find((x) => x.id === aId)!;
    const handle = await rectOf('data-testid', 'annot-handle-se');
    expect(handle).not.toBeNull();
    await dragBy(
      handle.x + handle.w / 2,
      handle.y + handle.h / 2,
      pageRect.w * 0.1,
      pageRect.h * 0.05,
    );
    const after = (await getPageAnnotations(doc.docId, doc.pageId)).find((x) => x.id === aId)!;
    expect(Math.abs(after.w - (before.w + 0.1))).toBeLessThan(0.03);
    expect(Math.abs(after.h - (before.h + 0.05))).toBeLessThan(0.03);
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.005); // anchor held
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.005);
  });

  it('ctrl-click adds to the selection; align-left aligns the group', async () => {
    const bBody = await rectOf('data-annot-id', bId);
    await ctrlClick(bBody.x + bBody.w / 2, bBody.y + bBody.h / 2);
    await browser.waitUntil(async () => (await selectedCount()) === 2, {
      timeout: 5_000,
      timeoutMsg: 'ctrl-click never grew the selection to 2',
    });
    // The properties bar is the group-ops surface.
    await invokeAppCommand('view.propertiesBar');
    const alignBtn = await $('[data-testid="pbar-align-left"]');
    await alignBtn.waitForDisplayed({ timeout: 5_000 });
    await alignBtn.click();
    const annots = await getPageAnnotations(doc.docId, doc.pageId);
    const a = annots.find((x) => x.id === aId)!;
    const b = annots.find((x) => x.id === bId)!;
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.001);
  });

  it('z-order: bring-to-front reorders the page annotation array', async () => {
    // Single-select A (plain click on its body).
    const aBody = await rectOf('data-annot-id', aId);
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(aBody.x + aBody.w / 2), y: Math.round(aBody.y + aBody.h / 2) })
      .down()
      .up()
      .perform();
    await browser.waitUntil(async () => (await selectedCount()) === 1, { timeout: 5_000 });
    const before = (await getPageAnnotations(doc.docId, doc.pageId)).map((x) => x.id);
    expect(before).toEqual([aId, bId]);
    await $('[data-testid="pbar-z-front"]').click();
    const after = (await getPageAnnotations(doc.docId, doc.pageId)).map((x) => x.id);
    expect(after).toEqual([bId, aId]);
  });

  it('ctrl-marquee rubber-bands both annotations into the selection', async () => {
    // Selection is [A] after the z-order test. A ctrl-drag over empty page
    // area sweeps a marquee; both bodies INTERSECT it (intersection, not
    // containment). The page cell can extend below the fold, so every
    // coordinate clamps to the viewport — an out-of-bounds pointerMove
    // throws mid-sequence and leaves virtual inputs held (learned the hard
    // way: the first run poisoned the next test's clicks).
    const win = (await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }))) as {
      w: number;
      h: number;
    };
    const x0 = Math.round(Math.min(Math.max(pageRect.x + pageRect.w * 0.05, 5), win.w - 10));
    const y0 = Math.round(Math.min(Math.max(pageRect.y + pageRect.h * 0.05, 5), win.h - 10));
    const x1 = Math.round(Math.min(pageRect.x + pageRect.w * 0.9, win.w - 5));
    const y1 = Math.round(Math.min(pageRect.y + pageRect.h * 0.85, win.h - 5));
    try {
      await browser.performActions([
        {
          type: 'key',
          id: 'kb-m',
          actions: [
            { type: 'keyDown', value: CTRL },
            { type: 'pause', duration: 0 },
            { type: 'pause', duration: 0 },
            { type: 'pause', duration: 0 },
            { type: 'pause', duration: 0 },
            { type: 'keyUp', value: CTRL },
          ],
        },
        {
          type: 'pointer',
          id: 'ms-m',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 0, x: x0, y: y0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', duration: 120, x: x1, y: y1 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
    } finally {
      await browser.releaseActions();
    }
    await browser.waitUntil(async () => (await selectedCount()) === 2, {
      timeout: 5_000,
      timeoutMsg: 'the ctrl-marquee never selected both annotations',
    });
  });

  it('the moved geometry survives commit into the SAVED file (CLI truth)', async () => {
    const a = (await getPageAnnotations(doc.docId, doc.pageId)).find((x) => x.id === aId)!;
    await commitPendingEdits();
    const dest = resolve(tmp, 'manip-committed.pdf');
    await saveActiveAs(dest);
    const out = execFileSync(APP_EXE, ['comments-list', dest], { encoding: 'utf-8' });
    const listed = JSON.parse(out.slice(out.indexOf('{'))) as {
      annotations: { page: number; rect: number[] }[];
      count: number;
    };
    expect(listed.count).toBe(2);
    // The moved+resized annotation's PDF rect matches the harness geometry
    // (display-normalized → PDF points; page 1 is unrotated, origin at
    // bottom-left, so x0 = x·W and y1 = (1−y)·H).
    // Both annotations share x after align-left — match BOTH axes to find A.
    const hit = listed.annotations.find(
      (x) =>
        Math.abs(x.rect[0] - a.x * pagePts.width) < 3 &&
        Math.abs(x.rect[3] - (1 - a.y) * pagePts.height) < 3,
    );
    expect(hit).toBeDefined();
  });

  it('keyboard: Delete removes the whole selection in one step', async () => {
    // After the commit the originals were baked into the file AND re-imported
    // into the tier as editable imports — so the page is
    // not empty. Add two fresh ones and assert on THEIR ids, not the count.
    const f1 = await addAnnotation({ kind: 'highlight', x: 0.1, y: 0.1, w: 0.1, h: 0.1, color: '#ffd54f' });
    const f2 = await addAnnotation({ kind: 'highlight', x: 0.4, y: 0.4, w: 0.1, h: 0.1, color: '#4fc3f7' });
    const r1 = await rectOf('data-annot-id', f1.annotationId);
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(r1.x + r1.w / 2), y: Math.round(r1.y + r1.h / 2) })
      .down()
      .up()
      .perform();
    await browser.waitUntil(async () => (await selectedCount()) === 1, { timeout: 5_000 });
    const r2 = await rectOf('data-annot-id', f2.annotationId);
    await ctrlClick(r2.x + r2.w / 2, r2.y + r2.h / 2);
    await browser.waitUntil(async () => (await selectedCount()) === 2, { timeout: 5_000 });
    await browser.keys(['Delete']);
    await browser.waitUntil(
      async () => {
        const ids = (await getPageAnnotations(f1.docId, f1.pageId)).map((x) => x.id);
        return !ids.includes(f1.annotationId) && !ids.includes(f2.annotationId);
      },
      { timeout: 5_000, timeoutMsg: 'Delete never removed the selection' },
    );
  });
});
