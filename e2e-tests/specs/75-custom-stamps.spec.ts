import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, PDFString } from 'pdf-lib';
import { APP_BINARY } from '../support/app-data.js';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setReactInputValue,
  getPageAnnotations,
  commitPendingEdits,
  removeAnnotation,
  saveActiveAs,
  closeAllFiles,
  scrollIntoReach,
} from '../support/harness.js';
import type { PageAnnotationSnapshot } from '../support/harness.js';

// Custom stamp authoring: author a dynamic TEXT stamp
// through the real library UI, place it (tokens resolve at placement), put a
// custom IMAGE stamp through the REAL commit + save and verify the /Stamp
// with the CLI, then delete from the library. Library state and armed modes
// are cleared at the end (the cross-spec-leak rule).
//
// Two more suites each open a file of their own, built here, whose one stamp
// keeps its appearance through a commit. The first moves an image stamp: the
// canvas shows its image at the new place before the commit, and the commit
// keeps the image. The second holds a NoRotate stamp on a rotated page: it
// stands upright from the upper-left corner of its rectangle (ISO 32000-2
// 12.5.3) in the page raster before any edit, in its body after a move and
// under Rotate View, and the commit keeps its size and its flag.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = APP_BINARY;
// 4 by 4 pixels, every pixel opaque rgb(220, 30, 40).
const PNG_SOLID =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGO4I6cBRwzEcQDiwxIhcqFjJAAAAABJRU5ErkJggg==';
const SOLID_RGB = [220, 30, 40];

/** The active document's first page and its one stamp, as the state holds
 * them now. Page and annotation ids change at every read-back. */
async function firstPageStamp(): Promise<{ docId: string; pageId: string; stamp: PageAnnotationSnapshot } | null> {
  const first = await browser.executeAsync<{ docId: string; pageId: string } | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__
      .getFirstAnnotation(2000)
      .then((x: unknown) => done(x as any))
      .catch(() => done(null as any));
  });
  if (!first) return null;
  const stamp = (await getPageAnnotations(first.docId, first.pageId)).find((a) => a.kind === 'stamp');
  return stamp ? { docId: first.docId, pageId: first.pageId, stamp } : null;
}

interface StampBody {
  rect: { x: number; y: number; w: number; h: number };
  label: boolean;
  /** One RGBA sample for each point asked for. */
  preview: { drawn: boolean; width: number; height: number; samples: number[][] } | null;
}

/** What the canvas draws in one annotation's body. `points` are fractions of
 * the preview's width and height: by default its centre and a point a tenth
 * of the way in from the top left. */
async function bodyOf(
  annotationId: string,
  points: number[][] = [[0.5, 0.5], [0.1, 0.1]],
): Promise<StampBody | null> {
  return (await browser.execute(function (id: string, fractions: number[][]) {
    const el = Array.from(document.querySelectorAll('[data-annot-id]')).find(
      (e) => e.getAttribute('data-annot-id') === id,
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const canvas = el.querySelector('canvas[data-testid="stamp-appearance-preview"]') as HTMLCanvasElement | null;
    const context = canvas ? canvas.getContext('2d') : null;
    const at = (x: number, y: number): number[] =>
      context ? Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) : [];
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      label: el.querySelector('.page-annot-stamp-label') !== null,
      preview: canvas
        ? {
            drawn: canvas.dataset.drawn === 'true',
            width: canvas.width,
            height: canvas.height,
            samples: fractions.map(function (point) {
              return at(canvas.width * point[0], canvas.height * point[1]);
            }),
          }
        : null,
    };
  }, annotationId, points)) as StampBody | null;
}

let SCRATCH = '';

async function customStampsInStore(): Promise<unknown[]> {
  return await browser.execute(() => {
    try {
      return JSON.parse(localStorage.getItem('custom-stamps') ?? '[]');
    } catch {
      return [];
    }
  });
}

describe('custom stamp authoring', () => {
  before(async () => {
    SCRATCH = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-stamps-'));
    await waitForHarness();
    await browser.execute(() => localStorage.removeItem('custom-stamps'));
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  after(async () => {
    await browser.execute(() => localStorage.removeItem('custom-stamps'));
    await invokeAppCommand('tools.select');
    await invokeAppCommand('tools.close');
  });

  it('authors a dynamic text stamp through the library UI', async () => {
    expect(await invokeAppCommand('tools.stamp')).toBe(true);
    await $('[data-testid="secondary-toolbar"]').waitForDisplayed({ timeout: 10_000 });

    await $('[data-testid="stamp-new-text"]').click();
    await $('[data-testid="stamp-new-label"]').waitForDisplayed();
    await setReactInputValue('[data-testid="stamp-new-label"]', 'SIGNED {date}');
    await $('[data-testid="stamp-new-color-e0393e"]').click();
    await $('[data-testid="stamp-new-add"]').click();

    // The pill appears and the library persisted.
    await browser.waitUntil(
      async () => (await $$('[data-testid^="stamp-custom-"]').getElements()).length > 0,
      { timeoutMsg: 'the custom stamp pill never appeared' },
    );
    const stored = await customStampsInStore();
    expect(stored.length).toBe(1);
    expect((stored[0] as { label: string }).label).toBe('SIGNED {date}');
  });

  it('placing it resolves the {date} token at placement time', async () => {
    // Select the custom pill (the only stamp-custom-* button, not the ×).
    const pills = await $$('[data-testid^="stamp-custom-"]').getElements();
    let pill: WebdriverIO.Element | null = null;
    for (const p of await pills) {
      const tid = await p.getAttribute('data-testid');
      if (tid !== null && !tid.includes('-del-')) pill = p;
    }
    expect(pill).not.toBeNull();
    await pill!.click();

    // Click the visible page.
    const rect = (await browser.execute(() => {
      const el = document.querySelector('[data-testid="document-view"] [data-page-id]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, width: b.width, height: b.height };
    })) as { left: number; top: number; width: number; height: number } | null;
    expect(rect).not.toBeNull();
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(rect!.left + rect!.width * 0.5), y: Math.round(rect!.top + rect!.height * 0.3) })
      .down()
      .pause(40)
      .up()
      .perform();

    const a = await browser.executeAsync<
      { kind: string; note?: string; annotationId: string; docId: string; pageId: string } | null,
      []
    >(function (done) {
      (window as any).__SPECTRA_TEST__
        .getFirstAnnotation(8000)
        .then((x: unknown) => done(x as any))
        .catch(() => done(null as any));
    });
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('stamp');
    expect(a!.note).toMatch(/^SIGNED \d/);
    expect(a!.note).not.toContain('{date}');

    // Clear it so the image leg's first-annotation read sees ITS stamp.
    await browser.execute(
      function (docId: string, pageId: string, annotationId: string) {
        (window as any).__SPECTRA_TEST__.removeAnnotation(docId, pageId, annotationId);
      },
      a!.docId,
      a!.pageId,
      a!.annotationId,
    );
  });

  it('an image stamp survives the REAL commit and save as a /Stamp', async () => {
    const added = (await browser.executeAsync(
      function (img: string, done: (r: unknown) => void) {
        (window as any).__SPECTRA_TEST__
          .addAnnotation({
            kind: 'stamp',
            x: 0.2,
            y: 0.2,
            w: 0.3,
            h: 0.2,
            color: '#2f6fed',
            note: 'Logo',
            imageData: img,
          })
          .then((r: unknown) => done(r))
          .catch((e: unknown) => done(String(e)));
      },
      PNG_SOLID,
    )) as { annotationId?: string } | string;
    expect(typeof added).not.toBe('string');

    const first = await browser.executeAsync<{ hasImage?: boolean } | null, []>(function (done) {
      (window as any).__SPECTRA_TEST__
        .getFirstAnnotation(8000)
        .then((x: unknown) => done(x as any))
        .catch(() => done(null as any));
    });
    expect(first?.hasImage).toBe(true);

    // Through the REAL commit bridge + save, then the REAL CLI reads it back.
    await browser.executeAsync(function (done) {
      (window as any).__SPECTRA_TEST__.commitPendingEdits().then(() => done(null));
    });
    const dest = resolve(SCRATCH, 'stamped.pdf');
    await browser.executeAsync(
      function (d: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .saveActiveAs(d)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      dest,
    );
    const out = execFileSync(APP_EXE, ['comments-list', dest], { encoding: 'utf-8' });
    const listed = JSON.parse(out) as { annotations?: { subtype: string }[] };
    expect((listed.annotations ?? []).some((x) => x.subtype === 'Stamp')).toBe(true);
  });

  it('deleting the custom stamp empties the library', async () => {
    const dels = await $$('[data-testid^="stamp-custom-del-"]').getElements();
    expect((await dels).length).toBe(1);
    // The × reveals on hover (opacity) — click it directly via the DOM.
    await browser.execute(() => {
      const el = document.querySelector('[data-testid^="stamp-custom-del-"]') as HTMLElement | null;
      el?.click();
    });
    await browser.waitUntil(
      async () => (await customStampsInStore()).length === 0,
      { timeoutMsg: 'delete did not empty the library' },
    );
  });
});

/** Closes every file and opens `path` alone in the document view, and waits
 * until its one stamp is in the state as a stamp that keeps its appearance. */
async function openStampFile(path: string): Promise<void> {
  await waitForHarness();
  await closeAllFiles();
  await openByPaths([path]);
  await browser.waitUntil(async () => (await getState()).view === 'canvas', {
    timeoutMsg: `opening ${path} did not land on canvas`,
  });
  await invokeAppCommand('view.documentView');
  await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  await browser.waitUntil(async () => (await firstPageStamp())?.stamp.carriedAppearance === true, {
    timeout: 20_000,
    timeoutMsg: 'the stamp of the file was never read as a stamp that keeps its appearance',
  });
  await invokeAppCommand('tools.select');
}

async function leaveStampFile(): Promise<void> {
  await invokeAppCommand('tools.select');
  await invokeAppCommand('tools.close');
  await closeAllFiles();
}

/** Drags the body of `annotationId` by a fraction of its own size and waits
 * until the state holds a new place. Returns the box before the drag and the
 * distance the pointer went. */
async function dragStamp(
  annotationId: string,
  byWidths: number,
  byHeights: number,
): Promise<{ from: StampBody; dx: number; dy: number }> {
  const centre = await scrollIntoReach(`[data-annot-id="${annotationId}"]`);
  const from = (await bodyOf(annotationId))!;
  const win = (await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }))) as { w: number; h: number };
  const clamp = (value: number, limit: number): number => Math.round(Math.max(10, Math.min(value, limit - 10)));
  const toX = clamp(centre.x + from.rect.w * byWidths, win.w);
  const toY = clamp(centre.y + from.rect.h * byHeights, win.h);
  const start = (await firstPageStamp())!.stamp;
  try {
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: centre.x, y: centre.y })
      .down()
      .pause(60)
      .move({ x: centre.x + Math.sign(toX - centre.x) * 8, y: centre.y + Math.sign(toY - centre.y) * 8 })
      .pause(60)
      .move({ x: toX, y: toY })
      .pause(90)
      .up()
      .perform();
  } finally {
    await browser.releaseActions();
  }
  await browser.waitUntil(
    async () => {
      const now = (await firstPageStamp())?.stamp;
      return now !== undefined && (Math.abs(now.x - start.x) > 0.01 || Math.abs(now.y - start.y) > 0.01);
    },
    { timeout: 5_000, timeoutMsg: 'the drag did not move the stamp' },
  );
  return { from, dx: toX - centre.x, dy: toY - centre.y };
}

/** One RGBA sample of the page raster for each point, given as fractions of
 * the annotation's box on the screen (a point outside 0..1 is beside the
 * box). Reads the detail raster where it is shown over the point and the base
 * raster otherwise. Null until the base raster is painted. */
async function rasterAtBody(annotationId: string, points: number[][]): Promise<number[][] | null> {
  return (await browser.execute(function (id: string, fractions: number[][]) {
    const el = Array.from(document.querySelectorAll('[data-annot-id]')).find(
      (e) => e.getAttribute('data-annot-id') === id,
    );
    const cell = el ? el.closest('[data-page-id]') : null;
    if (!el || !cell) return null;
    const base = cell.querySelector('canvas.pageview-base.ready') as HTMLCanvasElement | null;
    const detail = cell.querySelector('canvas.pageview-detail') as HTMLCanvasElement | null;
    if (!base) return null;
    const box = el.getBoundingClientRect();
    const sample = function (canvas: HTMLCanvasElement, x: number, y: number): number[] | null {
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null;
      const context = canvas.getContext('2d');
      if (!context) return null;
      const px = Math.min(canvas.width - 1, Math.floor(((x - r.left) / r.width) * canvas.width));
      const py = Math.min(canvas.height - 1, Math.floor(((y - r.top) / r.height) * canvas.height));
      return Array.from(context.getImageData(px, py, 1, 1).data);
    };
    return fractions.map(function (point) {
      const x = box.left + point[0] * box.width;
      const y = box.top + point[1] * box.height;
      const sharp = detail && detail.style.display !== 'none' ? sample(detail, x, y) : null;
      return sharp || sample(base, x, y) || [];
    });
  }, annotationId, points)) as number[][] | null;
}

interface PaintedUpright {
  /** Stamps the render behind the painted base raster took as upright; null
   * until the base raster has painted. */
  base: number | null;
  /** The same for the detail raster; null while it is not shown. */
  detail: number | null;
}

/** What the rasters of the first page cell of the document view were
 * rendered with. Null while the cell is not there. */
async function paintedUpright(): Promise<PaintedUpright | null> {
  return (await browser.execute(function () {
    const cells = (window as any).__SPECTRA_TEST__.getPaintedUpright() as { base: number | null; detail: number | null }[];
    return cells.length > 0 ? { base: cells[0].base, detail: cells[0].detail } : null;
  })) as PaintedUpright | null;
}

/** One RGBA sample of the page raster of the first page cell for each point,
 * given as fractions of the shown page. Reads the detail raster where it is
 * shown over the point and the base raster otherwise. Null until the base
 * raster is painted. */
async function rasterAtPage(points: number[][]): Promise<number[][] | null> {
  return (await browser.execute(function (fractions: number[][]) {
    const base = document.querySelector('[data-page-id] canvas.pageview-base.ready') as HTMLCanvasElement | null;
    if (!base) return null;
    const detail = base.closest('[data-page-id]')!.querySelector('canvas.pageview-detail') as HTMLCanvasElement | null;
    const page = base.getBoundingClientRect();
    const sample = function (canvas: HTMLCanvasElement, x: number, y: number): number[] | null {
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null;
      const context = canvas.getContext('2d');
      if (!context) return null;
      const px = Math.min(canvas.width - 1, Math.floor(((x - r.left) / r.width) * canvas.width));
      const py = Math.min(canvas.height - 1, Math.floor(((y - r.top) / r.height) * canvas.height));
      return Array.from(context.getImageData(px, py, 1, 1).data);
    };
    return fractions.map(function (point) {
      const x = page.left + point[0] * page.width;
      const y = page.top + point[1] * page.height;
      const sharp = detail && detail.style.display !== 'none' ? sample(detail, x, y) : null;
      return sharp || sample(base, x, y) || [];
    });
  }, points)) as number[][] | null;
}

function expectColour(sample: number[], rgb: number[]): void {
  expect(sample[3]).toBe(255);
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(sample[channel] - rgb[channel])).toBeLessThanOrEqual(6);
  }
}

/** The stamps of the first page of a saved file. */
async function savedStamps(path: string): Promise<{ doc: PDFDocument; rotate: number; stamps: PDFDict[] }> {
  const doc = await PDFDocument.load(readFileSync(path));
  const page = doc.getPage(0);
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  const stamps = annots.asArray()
    .map((entry) => doc.context.lookup(entry, PDFDict))
    .filter((dict) => dict.get(PDFName.of('Subtype')) === PDFName.of('Stamp'));
  return { doc, rotate: page.getRotation().angle, stamps };
}

const rectOf = (stamp: PDFDict): number[] => stamp.lookup(PDFName.of('Rect'), PDFArray).asArray().map(Number);

describe('a read-back image stamp that is moved', () => {
  const PAGE = { width: 400, height: 600 };
  let scratch = '';

  before(async () => {
    scratch = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-stamp-carried-'));
    // The file an earlier commit of an image stamp leaves: the appearance
    // draws one image over the whole box.
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const image = await doc.embedPng(Buffer.from(PNG_SOLID.slice(PNG_SOLID.indexOf(',') + 1), 'base64'));
    const appearance = doc.context.register(doc.context.stream('q 120 0 0 120 0 0 cm /Im0 Do Q', {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 120, 120], Resources: { XObject: { Im0: image.ref } },
    }));
    const stamp = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [80, 380, 200, 500], C: [0.18, 0.44, 0.93], F: 4, AP: { N: appearance } });
    stamp.set(PDFName.of('Contents'), PDFString.of('Logo'));
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(stamp)]));
    const path = resolve(scratch, 'image-stamp.pdf');
    writeFileSync(path, await doc.save());
    await openStampFile(path);
  });

  after(leaveStampFile);

  it('shows its image before the next commit, and the commit keeps it', async () => {
    const before = (await firstPageStamp())!;
    await browser.waitUntil(async () => (await bodyOf(before.stamp.id)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the read-back stamp has no body on the canvas',
    });
    // Unedited, the page raster shows the stamp and the overlay draws nothing.
    const untouched = (await bodyOf(before.stamp.id))!;
    expect({ label: untouched.label, preview: untouched.preview }).toEqual({ label: false, preview: null });

    const drag = await dragStamp(before.stamp.id, 0.6, 0.6);
    expect(drag.dx).toBeGreaterThan(12);
    const moved = (await firstPageStamp())!;
    expect(moved.stamp.id).toBe(before.stamp.id);
    expect(moved.stamp.carriedAppearance).toBe(true);

    // Before any commit the body is the stamp's own appearance: image pixels
    // over the whole box, and no text label.
    await browser.waitUntil(async () => (await bodyOf(moved.stamp.id))?.preview?.drawn === true, {
      timeout: 15_000,
      timeoutMsg: 'the moved stamp never drew its appearance',
    });
    const shown = (await bodyOf(moved.stamp.id))!;
    expect(shown.label).toBe(false);
    expect(shown.preview!.width).toBeGreaterThan(8);
    expect(shown.preview!.height).toBeGreaterThan(8);
    for (const sample of shown.preview!.samples) expectColour(sample, SOLID_RGB);
    // The body went with the drag; a snap can shift it by a little.
    expect(shown.rect.x - drag.from.rect.x).toBeGreaterThan(drag.dx / 2);

    // The commit writes the new rectangle and keeps the image.
    await commitPendingEdits();
    const dest = resolve(scratch, 'image-stamp-moved.pdf');
    await saveActiveAs(dest);
    const { stamps } = await savedStamps(dest);
    expect(stamps.length).toBe(1);
    const normal = stamps[0].lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream);
    const xobjects = normal.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
    const subtypes = xobjects.keys().map((name) => xobjects.lookup(name, PDFStream).dict.get(PDFName.of('Subtype')));
    expect(subtypes).toEqual([PDFName.of('Image')]);
    // The page is unrotated: x0 is x times the page width.
    const rect = rectOf(stamps[0]);
    expect(Math.abs(rect[0] - moved.stamp.x * PAGE.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect[2] - rect[0] - moved.stamp.w * PAGE.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect[3] - rect[1] - 120)).toBeLessThanOrEqual(1);
  });
});

describe('a read-back NoRotate stamp on a rotated page', () => {
  // The page is 400 by 600 with /Rotate 90: it shows 600 wide and 400 high.
  const PAGE = { width: 400, height: 600 };
  const RECT = [60, 300, 260, 380];
  const NO_ROTATE_PRINT = 20;
  const RED = [255, 0, 0];
  const BLUE = [0, 0, 255];
  let scratch = '';

  before(async () => {
    scratch = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-stamp-norotate-'));
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE.width, PAGE.height]);
    page.node.set(PDFName.of('Rotate'), doc.context.obj(90));
    // Red in the left half of the appearance, blue in the right half.
    const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 40 re f 0 0 1 rg 50 0 50 40 re f', {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 100, 40], Resources: {},
    }));
    const stamp = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: NO_ROTATE_PRINT, AP: { N: appearance } });
    stamp.set(PDFName.of('Contents'), PDFString.of('Upright'));
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(stamp)]));
    const path = resolve(scratch, 'no-rotate-stamp.pdf');
    writeFileSync(path, await doc.save());
    await openStampFile(path);
  });

  after(leaveStampFile);

  it('is drawn upright at its box before any edit, and not on its rectangle as the page turns it', async () => {
    const before = (await firstPageStamp())!;
    expect(before.stamp.noRotate).toBe(true);
    await browser.waitUntil(async () => (await bodyOf(before.stamp.id)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the read-back NoRotate stamp has no body on the canvas',
    });
    await scrollIntoReach(`[data-annot-id="${before.stamp.id}"]`);
    // The page raster draws the unedited stamp; the overlay draws nothing.
    const untouched = (await bodyOf(before.stamp.id))!;
    expect({ label: untouched.label, preview: untouched.preview }).toEqual({ label: false, preview: null });
    // Four points of the box, then the centre of the rectangle as /Rotate 90
    // turns it: 80 by 200 points, left of the box and below its top. The box
    // is 200 by 80 points from (380, 60) on the shown page.
    const points = [[0.25, 0.25], [0.25, 0.75], [0.75, 0.25], [0.75, 0.75], [-0.2, 1.25]];
    const near = (sample: number[] | undefined, rgb: number[]): boolean =>
      !!sample && sample.length === 4 && sample[3] === 255 && rgb.every((value, channel) => Math.abs(sample[channel] - value) <= 6);
    await browser.waitUntil(
      async () => {
        const samples = await rasterAtBody(before.stamp.id, points);
        return !!samples && near(samples[0], RED) && near(samples[1], RED) && near(samples[2], BLUE) && near(samples[3], BLUE);
      },
      { timeout: 20_000, timeoutMsg: 'the page raster never showed the NoRotate stamp upright at its box' },
    );
    const shown = (await rasterAtBody(before.stamp.id, points))!;
    expectColour(shown[0], RED);
    expectColour(shown[1], RED);
    expectColour(shown[2], BLUE);
    expectColour(shown[3], BLUE);
    expectColour(shown[4], [255, 255, 255]);
    // Still unedited: the overlay holds no bitmap, so the stamp is drawn once.
    expect((await bodyOf(before.stamp.id))!.preview).toBeNull();
  });

  it('stands upright from the upper-left corner of its rectangle, moves upright, and keeps its size and flag in the file', async () => {
    // The upper-left corner of /Rect is (60, 380). Under /Rotate 90 it shows
    // at x = 380 / 600 and y = 60 / 400, and the box keeps 200 by 80 points.
    const before = (await firstPageStamp())!;
    expect(before.stamp.noRotate).toBe(true);
    const upright = [RECT[3] / PAGE.height, RECT[0] / PAGE.width, (RECT[2] - RECT[0]) / PAGE.height, (RECT[3] - RECT[1]) / PAGE.width];
    [before.stamp.x, before.stamp.y, before.stamp.w, before.stamp.h].forEach((value, index) => {
      expect(Math.abs(value - upright[index])).toBeLessThanOrEqual(0.002);
    });

    await dragStamp(before.stamp.id, -0.4, 0.5);
    const moved = (await firstPageStamp())!;
    expect(moved.stamp.noRotate).toBe(true);
    expect(Math.abs(moved.stamp.w - before.stamp.w)).toBeLessThanOrEqual(0.0005);
    expect(Math.abs(moved.stamp.h - before.stamp.h)).toBeLessThanOrEqual(0.0005);

    // The body is the appearance as written, not turned with the page: red
    // on the left from top to bottom, blue on the right.
    const samples = [[0.25, 0.25], [0.25, 0.75], [0.75, 0.25], [0.75, 0.75]];
    await browser.waitUntil(async () => (await bodyOf(moved.stamp.id, samples))?.preview?.drawn === true, {
      timeout: 15_000,
      timeoutMsg: 'the moved NoRotate stamp never drew its appearance',
    });
    const shown = (await bodyOf(moved.stamp.id, samples))!;
    expect(shown.label).toBe(false);
    expect(shown.preview!.width).toBeGreaterThan(shown.preview!.height);
    expectColour(shown.preview!.samples[0], RED);
    expectColour(shown.preview!.samples[1], RED);
    expectColour(shown.preview!.samples[2], BLUE);
    expectColour(shown.preview!.samples[3], BLUE);

    // Rotate View turns the shown page a quarter clockwise: 400 wide and 600
    // high. The stored box does not change. On the screen the corner turns
    // with the page, and the body stays upright with its size in points.
    const cellBox = async (): Promise<{ x: number; y: number; w: number; h: number }> =>
      (await browser.execute(function (id: string) {
        const body = Array.from(document.querySelectorAll('[data-annot-id]')).find((e) => e.getAttribute('data-annot-id') === id);
        const r = body!.closest('[data-page-id]')!.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }, moved.stamp.id)) as { x: number; y: number; w: number; h: number };
    expect((await cellBox()).w).toBeGreaterThan((await cellBox()).h);
    await invokeAppCommand('view.rotateCW');
    try {
      await browser.waitUntil(async () => { const cell = await cellBox(); return cell.h > cell.w; }, {
        timeout: 10_000,
        timeoutMsg: 'Rotate View did not turn the shown page',
      });
      const stored = (await firstPageStamp())!.stamp;
      expect([stored.x, stored.y, stored.w, stored.h]).toEqual([moved.stamp.x, moved.stamp.y, moved.stamp.w, moved.stamp.h]);
      await browser.waitUntil(async () => (await bodyOf(moved.stamp.id, samples))?.preview?.drawn === true, {
        timeout: 15_000,
        timeoutMsg: 'the NoRotate stamp never drew its appearance in the turned view',
      });
      const cell = await cellBox();
      const turned = (await bodyOf(moved.stamp.id, samples))!;
      expect(Math.abs((turned.rect.x - cell.x) / cell.w - (1 - moved.stamp.y))).toBeLessThanOrEqual(0.01);
      expect(Math.abs((turned.rect.y - cell.y) / cell.h - moved.stamp.x)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(turned.rect.w / cell.w - (RECT[2] - RECT[0]) / PAGE.width)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(turned.rect.h / cell.h - (RECT[3] - RECT[1]) / PAGE.height)).toBeLessThanOrEqual(0.01);
      expect(turned.label).toBe(false);
      expect(turned.preview!.width).toBeGreaterThan(turned.preview!.height);
      expectColour(turned.preview!.samples[0], RED);
      expectColour(turned.preview!.samples[1], RED);
      expectColour(turned.preview!.samples[2], BLUE);
      expectColour(turned.preview!.samples[3], BLUE);
      // The body is not inside a wrapper that turns it.
      const wrapped = await browser.execute(function (id: string) {
        const body = Array.from(document.querySelectorAll('[data-annot-id]')).find((e) => e.getAttribute('data-annot-id') === id);
        return body!.querySelector('.page-annot-turn') !== null;
      }, moved.stamp.id);
      expect(wrapped).toBe(false);
    } finally {
      await invokeAppCommand('view.rotateCCW');
    }
    await browser.waitUntil(async () => { const cell = await cellBox(); return cell.w > cell.h; }, {
      timeout: 10_000,
      timeoutMsg: 'Rotate View did not turn the shown page back',
    });

    await commitPendingEdits();
    // After the commit the page raster draws the stamp: upright at the new box,
    // and nothing of it at the box it had before the move. The points of the
    // old box are given as fractions of the new one; those inside the new box
    // are left out.
    const committed = (await firstPageStamp())!.stamp;
    expect(committed.noRotate).toBe(true);
    await browser.waitUntil(async () => (await bodyOf(committed.id)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the committed NoRotate stamp has no body on the canvas',
    });
    await scrollIntoReach(`[data-annot-id="${committed.id}"]`);
    const oldPoints = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5]]
      .map(([u, v]) => [
        (before.stamp.x + u * before.stamp.w - committed.x) / committed.w,
        (before.stamp.y + v * before.stamp.h - committed.y) / committed.h,
      ])
      .filter(([u, v]) => u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05);
    expect(oldPoints.length).toBeGreaterThanOrEqual(2);
    const rasterPoints = [...samples, ...oldPoints];
    const close = (sample: number[] | undefined, rgb: number[]): boolean =>
      !!sample && sample.length === 4 && sample[3] === 255 && rgb.every((value, channel) => Math.abs(sample[channel] - value) <= 6);
    await browser.waitUntil(
      async () => {
        const raster = await rasterAtBody(committed.id, rasterPoints);
        return !!raster && close(raster[0], RED) && close(raster[1], RED) && close(raster[2], BLUE) && close(raster[3], BLUE)
          && raster.slice(samples.length).every((sample) => close(sample, [255, 255, 255]));
      },
      { timeout: 20_000, timeoutMsg: 'after the commit the page raster did not show the stamp upright at its new box and nothing at its old box' },
    );
    // The page raster draws it once: the overlay holds no bitmap.
    expect((await bodyOf(committed.id))!.preview).toBeNull();
    const dest = resolve(scratch, 'no-rotate-stamp-moved.pdf');
    await saveActiveAs(dest);
    const { rotate, stamps } = await savedStamps(dest);
    expect(rotate).toBe(90);
    expect(stamps.length).toBe(1);
    expect(stamps[0].lookup(PDFName.of('F'), PDFNumber).asNumber()).toBe(NO_ROTATE_PRINT);
    // The new upper-left corner: x0 is the shown y times the page width, y1
    // the shown x times the page height. Width and height are as written.
    const rect = rectOf(stamps[0]);
    expect(Math.abs(rect[0] - moved.stamp.y * PAGE.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect[3] - moved.stamp.x * PAGE.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect[2] - rect[0] - (RECT[2] - RECT[0]))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(rect[3] - rect[1] - (RECT[3] - RECT[1]))).toBeLessThanOrEqual(0.5);
  });
});

describe('a read-back NoRotate stamp of a layer that is off', () => {
  // The page is 400 by 600 with /Rotate 90. The stamp is optional content of
  // a group the default configuration turns off, so no render shows it.
  const PAGE = { width: 400, height: 600 };
  const RECT = [60, 300, 260, 380];
  const NO_ROTATE_PRINT = 20;
  const WHITE = [255, 255, 255];
  let scratch = '';

  before(async () => {
    scratch = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-stamp-norotate-layer-'));
    const doc = await PDFDocument.create();
    const group = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden stamps') }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
      OCGs: [group],
      D: { BaseState: 'ON', OFF: [group], Order: [group] },
    }));
    const page = doc.addPage([PAGE.width, PAGE.height]);
    page.node.set(PDFName.of('Rotate'), doc.context.obj(90));
    const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 40 re f 0 0 1 rg 50 0 50 40 re f', {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 100, 40], Resources: {},
    }));
    const stamp = doc.context.obj({
      Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: NO_ROTATE_PRINT, AP: { N: appearance }, OC: group,
    });
    stamp.set(PDFName.of('Contents'), PDFString.of('Hidden'));
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(stamp)]));
    const path = resolve(scratch, 'no-rotate-stamp-hidden-layer.pdf');
    writeFileSync(path, await doc.save());
    await openStampFile(path);
  });

  after(leaveStampFile);

  it('is drawn nowhere: not upright at its box and not on its turned rectangle', async () => {
    const read = (await firstPageStamp())!;
    expect(read.stamp.noRotate).toBe(true);
    await browser.waitUntil(async () => (await bodyOf(read.stamp.id)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the read-back NoRotate stamp has no body on the canvas',
    });
    await scrollIntoReach(`[data-annot-id="${read.stamp.id}"]`);
    // Four points of the upright box, then the centre of the rectangle as
    // /Rotate 90 turns it.
    const points = [[0.25, 0.25], [0.25, 0.75], [0.75, 0.25], [0.75, 0.75], [-0.2, 1.25]];
    const white = (sample: number[] | undefined): boolean =>
      !!sample && sample.length === 4 && sample[3] === 255 && WHITE.every((value, channel) => Math.abs(sample[channel] - value) <= 6);
    // The rasters that are sampled come from a render that took the stamp as
    // upright: the record of the page was there, and the upright render ran.
    // A raster of a render before the record counts no stamp.
    await browser.waitUntil(
      async () => {
        const painted = await paintedUpright();
        if (!painted || painted.base !== 1 || (painted.detail !== null && painted.detail !== 1)) return false;
        const samples = await rasterAtBody(read.stamp.id, points);
        return !!samples && samples.every(white);
      },
      { timeout: 20_000, timeoutMsg: 'the upright render of the page never ran, or it shows a NoRotate stamp of a layer that is off' },
    );
    const painted = (await paintedUpright())!;
    expect(painted.base).toBe(1);
    const shown = (await rasterAtBody(read.stamp.id, points))!;
    for (const sample of shown) expectColour(sample, WHITE);
    expect((await bodyOf(read.stamp.id))!.preview).toBeNull();
  });
});

describe('a read-back NoRotate stamp that is deleted', () => {
  // The page is 400 by 600 with /Rotate 90: it shows 600 wide and 400 high.
  const PAGE = { width: 400, height: 600 };
  const RECT = [60, 300, 260, 380];
  const NO_ROTATE_PRINT = 20;
  const RED = [255, 0, 0];
  const BLUE = [0, 0, 255];
  const WHITE = [255, 255, 255];
  let scratch = '';

  before(async () => {
    scratch = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-stamp-norotate-deleted-'));
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE.width, PAGE.height]);
    page.node.set(PDFName.of('Rotate'), doc.context.obj(90));
    const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 40 re f 0 0 1 rg 50 0 50 40 re f', {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 100, 40], Resources: {},
    }));
    const stamp = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: NO_ROTATE_PRINT, AP: { N: appearance } });
    stamp.set(PDFName.of('Contents'), PDFString.of('Upright'));
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(stamp)]));
    const path = resolve(scratch, 'no-rotate-stamp-deleted.pdf');
    writeFileSync(path, await doc.save());
    await openStampFile(path);
  });

  after(leaveStampFile);

  it('leaves the page raster after the commit: the first paint of the new bytes shows no stamp at its box', async () => {
    const read = (await firstPageStamp())!;
    expect(read.stamp.noRotate).toBe(true);
    await browser.waitUntil(async () => (await bodyOf(read.stamp.id)) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the read-back NoRotate stamp has no body on the canvas',
    });
    await scrollIntoReach(`[data-annot-id="${read.stamp.id}"]`);
    // Four points of the upright box, as fractions of the shown page.
    const points = [[0.25, 0.25], [0.25, 0.75], [0.75, 0.25], [0.75, 0.75]]
      .map(([u, v]) => [read.stamp.x + u * read.stamp.w, read.stamp.y + v * read.stamp.h]);
    const near = (sample: number[] | undefined, rgb: number[]): boolean =>
      !!sample && sample.length === 4 && sample[3] === 255 && rgb.every((value, channel) => Math.abs(sample[channel] - value) <= 6);
    await browser.waitUntil(
      async () => {
        const samples = await rasterAtPage(points);
        return !!samples && near(samples[0], RED) && near(samples[1], RED) && near(samples[2], BLUE) && near(samples[3], BLUE);
      },
      { timeout: 20_000, timeoutMsg: 'the page raster never showed the NoRotate stamp upright at its box' },
    );
    expect((await paintedUpright())!.base).toBe(1);

    await removeAnnotation(read.docId, read.pageId, read.stamp.id);
    await commitPendingEdits();
    // The rasters of the committed bytes come from a render that took no
    // stamp as upright, and hold nothing at the box. The pixels of the bytes
    // before the commit hold the stamp there, so they fail both tests.
    await browser.waitUntil(
      async () => {
        const painted = await paintedUpright();
        if (!painted || painted.base !== 0 || (painted.detail !== null && painted.detail !== 0)) return false;
        const samples = await rasterAtPage(points);
        return !!samples && samples.every((sample) => near(sample, WHITE));
      },
      { timeout: 20_000, timeoutMsg: 'after the commit the page raster still shows the deleted NoRotate stamp, or never painted the new bytes' },
    );
    const shown = (await rasterAtPage(points))!;
    for (const sample of shown) expectColour(sample, WHITE);
    const dest = resolve(scratch, 'no-rotate-stamp-deleted-saved.pdf');
    await saveActiveAs(dest);
    const saved = await PDFDocument.load(readFileSync(dest));
    const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const subtypes = (annots ? annots.asArray() : []).map((entry) => saved.context.lookup(entry, PDFDict).get(PDFName.of('Subtype')));
    expect(subtypes.filter((subtype) => subtype === PDFName.of('Stamp'))).toEqual([]);
  });
});
