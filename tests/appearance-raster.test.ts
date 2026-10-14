// An imported stamp whose appearance the commit carries is drawn on the
// canvas from a bitmap of that appearance. The bitmap covers the annotation
// rectangle in the page's own frame; the canvas stretches it onto the edited
// box and turns it with the page.

import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageAnnotation, PageRef } from '../src/renderer/state/types';
import { commit, importedPages } from './support/commit-cycle';
import { loadPdf } from './support/saved-pdf';
import { pdfPointToDisplay, pdfRectToDisplay } from '../src/renderer/lib/pdfx-build';
import {
  APPEARANCE_RASTER_MAX_SIDE,
  APPEARANCE_RASTER_MAX_TIER,
  APPEARANCE_RASTER_MISS_RETRIES,
  APPEARANCE_RASTER_PAGES,
  drawAppearanceRaster,
  holdAppearanceRaster,
  isAppearanceRenderCancellation,
  quarterTurn,
  releaseAppearanceRasters,
  retainAppearanceRasters,
  appearanceRasterDemand,
  appearanceRasterKey,
  appearanceRasterMatrix,
  appearanceRasterPageCount,
  appearanceRasterRenderCount,
  appearanceRasterScale,
  appearanceRasterTier,
  appearanceRasterTurn,
} from '../src/renderer/lib/appearance-raster';
import type { QuarterTurn, AppearanceRaster, AppearanceRasterSource } from '../src/renderer/lib/appearance-raster';

// pdf.js draws through this package outside a browser. Guarded on the package
// itself: an install without optional packages holds none.
const HAS_CANVAS = (() => {
  try {
    createRequire(import.meta.url).resolve('@napi-rs/canvas');
    return true;
  } catch {
    return false;
  }
})();

const TURNS: QuarterTurn[] = [0, 90, 180, 270];

/** An opaque PNG of one colour. */
function solidPng(r: number, g: number, b: number, size = 4): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0).map((_, i) => [r, g, b][i % 3])]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

type Pixel = [number, number, number, number];
interface Canvas2d {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
const pixel = (canvas: unknown, x: number, y: number): Pixel =>
  Array.from((canvas as { getContext(kind: '2d'): Canvas2d }).getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Pixel;

const RED: Pixel = [255, 0, 0, 255];
const BLUE: Pixel = [0, 0, 255, 255];
const CLEAR: Pixel = [0, 0, 0, 0];

/** Two pages, the second with /Rotate 90. Each holds one stamp at
 *  [50 400 250 500] whose appearance is red in its left half, blue in its
 *  right half and unpainted in its top quarter; and one text note. */
async function twoToneStamps(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rotate of [0, 90]) {
    const page = doc.addPage([400, 600]);
    page.drawText('page content');
    if (rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(rotate));
    const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 30 re f 0 0 1 rg 50 0 50 30 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: {},
    }));
    const stamp = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [50, 400, 250, 500], F: 4, AP: { N: appearance } });
    stamp.set(PDFName.of('Contents'), PDFString.of('Two tone'));
    const note = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 500, 318, 518], F: 4 });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(stamp), doc.context.register(note)]));
  }
  return doc.save();
}

async function blankPage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 600]);
  return doc.save();
}

const placing = (added: Omit<PageAnnotation, 'id'>) => ([page, ...rest]: PageRef[]): PageRef[] =>
  [{ ...page, annotations: [...(page.annotations ?? []), { id: `placed-${(page.annotations ?? []).length}`, ...added }] }, ...rest];

const stampsOf = (pages: PageRef[]): PageAnnotation[] => (pages[0].annotations ?? []).filter((a) => a.kind === 'stamp');

async function stampIds(pdf: PDFDocumentProxy, pageNumber: number): Promise<string[]> {
  const annotations = (await (await pdf.getPage(pageNumber)).getAnnotations()) as { id: string; subtype: string }[];
  return annotations.filter((a) => a.subtype === 'Stamp').map((a) => a.id);
}

let keys = 0;
const freshKey = (): string => `appearance-raster-test-${++keys}`;

describe('where the bitmap lands in the edited box', () => {
  it('adds the page rotation in the file to the pending rotation', () => {
    expect(TURNS.flatMap((file) => TURNS.map((pending) => appearanceRasterTurn(file, pending)))).toEqual([
      0, 90, 180, 270, 90, 180, 270, 0, 180, 270, 0, 90, 270, 0, 90, 180,
    ]);
    expect([quarterTurn(-90), quarterTurn(450), quarterTurn(360, 360), quarterTurn(Number.NaN, 90)]).toEqual([270, 90, 0, 90]);
  });

  it('turns a NoRotate stamp by nothing, whatever the page rotation', () => {
    expect(TURNS.flatMap((file) => TURNS.map((pending) => appearanceRasterTurn(file, pending, true)))).toEqual(Array.from({ length: 16 }, () => 0));
  });

  it('maps each bitmap corner where the page rotation maps that corner of the rectangle', () => {
    const box = { x: 10, y: 20, width: 400, height: 600 };
    const rect: [number, number, number, number] = [60, 420, 260, 520];
    // The bitmap is the rectangle in the page's own frame, top row first.
    const corners: { uv: [number, number]; point: [number, number] }[] = [
      { uv: [0, 0], point: [rect[0], rect[3]] },
      { uv: [1, 0], point: [rect[2], rect[3]] },
      { uv: [0, 1], point: [rect[0], rect[1]] },
      { uv: [1, 1], point: [rect[2], rect[1]] },
      { uv: [0.25, 0.75], point: [rect[0] + 50, rect[1] + 25] },
    ];
    for (const turn of TURNS) {
      const shown = pdfRectToDisplay(rect, box, turn);
      const [a, b, c, d, e, f] = appearanceRasterMatrix(turn, shown.w, shown.h);
      for (const { uv: [u, v], point } of corners) {
        const [x, y] = pdfPointToDisplay(point[0], point[1], box, turn);
        expect([shown.x + a * u + c * v + e, shown.y + b * u + d * v + f].map((n) => Number(n.toFixed(9))))
          .toEqual([x, y].map((n) => Number(n.toFixed(9))));
      }
    }
  });

  it('stretches onto a box of another size', () => {
    expect(appearanceRasterMatrix(0, 30, 10)).toEqual([30, 0, 0, 10, 0, 0]);
    expect(appearanceRasterMatrix(90, 30, 10)).toEqual([0, 10, -30, 0, 30, 0]);
    expect(appearanceRasterMatrix(180, 30, 10)).toEqual([-30, 0, 0, -10, 30, 10]);
    expect(appearanceRasterMatrix(270, 30, 10)).toEqual([0, -10, 30, 0, 0, 10]);
  });
});

describe('resolution and cache keys', () => {
  it('takes the next power of two of the view resolution', () => {
    expect([0, 0.4, 1, 1.01, 2, 2.5, 4, 7.9, 8, 31, 1000, Number.NaN].map(appearanceRasterTier))
      .toEqual([1, 1, 1, 2, 2, 4, 4, 8, 8, 32, APPEARANCE_RASTER_MAX_TIER, 1]);
  });

  it('keeps the longest stamp side inside the canvas limit', () => {
    expect(appearanceRasterScale(8, 200)).toBe(8);
    expect(appearanceRasterScale(8, 1024)).toBe(4);
    expect(appearanceRasterScale(32, 800) * 800).toBe(APPEARANCE_RASTER_MAX_SIDE);
    expect(appearanceRasterScale(4, 0)).toBe(4);
  });

  it('asks for the pixels the box on the screen shows', () => {
    const rectangle = { width: 200, height: 100 };
    // The box at the page zoom: the zoom itself.
    expect(appearanceRasterDemand({ width: 600, height: 300 }, rectangle, 3)).toBe(3);
    // Drawn at a quarter of its size, and at four times its size.
    expect(appearanceRasterDemand({ width: 150, height: 75 }, rectangle, 3)).toBe(0.75);
    expect(appearanceRasterDemand({ width: 2400, height: 1200 }, rectangle, 3)).toBe(12);
    // A box turned a quarter pairs its sides by length.
    expect(appearanceRasterDemand({ width: 300, height: 600 }, rectangle, 3)).toBe(3);
    // A stretched box asks for the side that shows more pixels per point.
    expect(appearanceRasterDemand({ width: 200, height: 400 }, rectangle, 3)).toBe(2);
    // An unknown or empty rectangle takes the page zoom.
    expect([appearanceRasterDemand({ width: 10, height: 10 }, null, 3), appearanceRasterDemand({ width: 10, height: 10 }, { width: 0, height: 0 }, 3)]).toEqual([3, 3]);
    // The tier of a stamp drawn small is below the tier of the page.
    expect([appearanceRasterTier(appearanceRasterDemand({ width: 150, height: 75 }, rectangle, 3)), appearanceRasterTier(3)]).toEqual([1, 4]);
  });

  it('reads a cancelled render by the name pdf.js gives it', () => {
    const named = (name: string): Error => Object.assign(new Error('x'), { name });
    expect([named('RenderingCancelledException'), named('AbortException'), named('Error'), null, 'RenderingCancelledException'].map(isAppearanceRenderCancellation))
      .toEqual([true, true, false, false, false]);
  });

  it('keys a page by its number and tier', () => {
    expect(appearanceRasterKey(3, 4)).toBe('3@4');
    expect(new Set([appearanceRasterKey(1, 14), appearanceRasterKey(11, 4), appearanceRasterKey(1, 1), appearanceRasterKey(1, 2)]).size).toBe(4);
  });
});

/** A document with `count` pages, each with one two-tone stamp. */
async function stampPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < count; index++) {
    const page = doc.addPage([400, 600]);
    const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 40 re f 0 0 1 rg 50 0 50 40 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: {},
    }));
    const stamp = doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [50, 400, 250, 500], F: 4, AP: { N: appearance } });
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(stamp)]));
  }
  return doc.save();
}

interface Opened {
  copies: PDFDocumentProxy[];
  source: AppearanceRasterSource;
}

/** A source whose copies are counted. `wrap` stands between the raster and
 *  each copy it opens. */
function sourceOf(
  bytes: Uint8Array,
  pdf: PDFDocumentProxy,
  contentKey: string | null = null,
  wrap: (copy: PDFDocumentProxy) => PDFDocumentProxy = (copy) => copy,
): Opened {
  const copies: PDFDocumentProxy[] = [];
  return {
    copies,
    source: {
      pdf,
      contentKey,
      open: async () => {
        const copy = await loadPdf(bytes);
        copies.push(copy);
        return wrap(copy);
      },
    },
  };
}

async function rasterOf(source: AppearanceRasterSource, pageNumber: number, id: string, pixelsPerPoint: number): Promise<AppearanceRaster | null> {
  const hold = holdAppearanceRaster(source, pageNumber, id, pixelsPerPoint);
  try {
    return await hold.raster;
  } finally {
    hold.release();
  }
}

const turns = async (count = 4): Promise<void> => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

interface RenderCall {
  canvases: Map<string, { width: number; height: number }>;
  cancelled: boolean;
}

/** A copy whose page renders pass through `around`: it gets the real render
 *  as a function and the call's record, and gives the promise the raster
 *  awaits. */
function wrapRenders(
  calls: RenderCall[],
  around: (real: () => Promise<unknown>, call: RenderCall, index: number) => Promise<unknown>,
): (copy: PDFDocumentProxy) => PDFDocumentProxy {
  return (copy) => ({
    canvasFactory: (copy as unknown as { canvasFactory: unknown }).canvasFactory,
    loadingTask: copy.loadingTask,
    getPage: async (pageNumber: number) => {
      const page = await copy.getPage(pageNumber);
      return {
        rotate: page.rotate,
        getAnnotations: () => page.getAnnotations(),
        getViewport: (params: { scale: number }) => page.getViewport(params),
        cleanup: () => page.cleanup(),
        render: (params: Parameters<typeof page.render>[0]) => {
          const call: RenderCall = { canvases: params.annotationCanvasMap as unknown as RenderCall['canvases'], cancelled: false };
          const index = calls.push(call) - 1;
          let task: ReturnType<typeof page.render> | undefined;
          const promise = around(() => (task = page.render(params)).promise, call, index);
          return { promise, cancel: () => { call.cancelled = true; task?.cancel(); } };
        },
      };
    },
  }) as unknown as PDFDocumentProxy;
}

describe.skipIf(!HAS_CANVAS)('the bitmap of a stamp appearance', () => {
  it('covers the annotation rectangle in the frame of the page before /Rotate', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    try {
      const { source } = sourceOf(bytes, pdf);
      for (const pageNumber of [1, 2]) {
        const [id] = await stampIds(pdf, pageNumber);
        const { canvas, pageRotate } = (await rasterOf(source, pageNumber, id, 2))!;
        expect({ width: canvas.width, height: canvas.height, pageRotate })
          .toEqual({ width: 400, height: 200, pageRotate: pageNumber === 1 ? 0 : 90 });
        expect(pixel(canvas, 100, 150)).toEqual(RED);
        expect(pixel(canvas, 300, 150)).toEqual(BLUE);
        // The top quarter of the appearance box is not painted.
        expect(pixel(canvas, 100, 20)).toEqual(CLEAR);
        expect(pixel(canvas, 300, 20)).toEqual(CLEAR);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('draws turned with the page into the edited box', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    try {
      const [id] = await stampIds(pdf, 1);
      const raster = (await rasterOf(sourceOf(bytes, pdf).source, 1, id, 1))!;
      const factory = (pdf as unknown as { canvasFactory: { create(w: number, h: number): { canvas: unknown; context: CanvasRenderingContext2D } } }).canvasFactory;
      const shown = (turn: QuarterTurn, width: number, height: number): unknown => {
        const target = factory.create(width, height);
        drawAppearanceRaster(target.context, raster, turn, width, height);
        return target.canvas;
      };
      // The red half is the left half of the appearance, the unpainted
      // quarter its top.
      const upright = shown(0, 80, 40);
      expect([pixel(upright, 20, 30), pixel(upright, 60, 30), pixel(upright, 20, 4)]).toEqual([RED, BLUE, CLEAR]);
      const quarter = shown(90, 40, 80);
      expect([pixel(quarter, 10, 20), pixel(quarter, 10, 60), pixel(quarter, 36, 20)]).toEqual([RED, BLUE, CLEAR]);
      const half = shown(180, 80, 40);
      expect([pixel(half, 60, 10), pixel(half, 20, 10), pixel(half, 60, 36)]).toEqual([RED, BLUE, CLEAR]);
      const threeQuarter = shown(270, 40, 80);
      expect([pixel(threeQuarter, 30, 60), pixel(threeQuarter, 30, 20), pixel(threeQuarter, 4, 60)]).toEqual([RED, BLUE, CLEAR]);
      // A second draw replaces the first.
      const target = factory.create(80, 40);
      drawAppearanceRaster(target.context, raster, 180, 80, 40);
      drawAppearanceRaster(target.context, raster, 0, 80, 40);
      expect([pixel(target.canvas, 20, 30), pixel(target.canvas, 20, 4)]).toEqual([RED, CLEAR]);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('never renders the shown document, and an ordinary render beside the raster draws the stamp in the page', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    try {
      const [id] = await stampIds(pdf, 1);
      const page = await pdf.getPage(1);
      const factory = (pdf as unknown as { canvasFactory: { create(w: number, h: number): { canvas: unknown; context: CanvasRenderingContext2D } } }).canvasFactory;
      const ordinary = async (): Promise<Pixel[]> => {
        const target = factory.create(400, 600);
        await page.render({ canvas: target.canvas as HTMLCanvasElement, canvasContext: target.context, viewport: page.getViewport({ scale: 1 }) }).promise;
        // The stamp sits at [50 400 250 500]: 100 to 200 from the top.
        return [pixel(target.canvas, 100, 170), pixel(target.canvas, 200, 170), pixel(target.canvas, 100, 300)];
      };
      const before = await ordinary();
      expect(before.slice(0, 2)).toEqual([RED, BLUE]);
      const rendersOfShown: unknown[] = [];
      const render = page.render.bind(page);
      page.render = ((params: Parameters<typeof render>[0]) => {
        rendersOfShown.push(params.isEditing ?? false);
        return render(params);
      }) as typeof page.render;
      const { source } = sourceOf(bytes, pdf);
      for (let round = 0; round < 5; round++) {
        const hold = holdAppearanceRaster(source, 1, id, 2 ** round);
        const [raster, during] = await Promise.all([hold.raster, ordinary()]);
        hold.release();
        expect(raster!.canvas.width).toBe(200 * 2 ** round);
        expect(during).toEqual(before);
      }
      expect(await ordinary()).toEqual(before);
      // Every render of the shown page was an ordinary one.
      expect(rendersOfShown).toEqual(Array.from({ length: 6 }, () => false));
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('renders again when the page lists the stamp and a render gives it no canvas, and keeps no result without it', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const [id] = await stampIds(pdf, 1);
      // The first render of each copy loses its canvases.
      const calls: RenderCall[] = [];
      const flaky = sourceOf(bytes, pdf, key, wrapRenders(calls, async (real, call, index) => {
        await real();
        if (index === 0) call.canvases.clear();
      }));
      const before = appearanceRasterRenderCount();
      const raster = await rasterOf(flaky.source, 1, id, 2);
      expect(raster!.canvas.width).toBe(400);
      expect(appearanceRasterRenderCount()).toBe(before + 2);
      // The result with the stamp is the one kept.
      expect(await rasterOf(flaky.source, 1, id, 2)).toBe(raster);
      expect(appearanceRasterRenderCount()).toBe(before + 2);

      // A stamp that never gets a canvas: the bound, then nothing kept.
      const lost: RenderCall[] = [];
      const never = sourceOf(bytes, pdf, key, wrapRenders(lost, async (real, call) => {
        await real();
        call.canvases.clear();
      }));
      const [second] = await stampIds(pdf, 2);
      expect(await rasterOf(never.source, 2, second, 2)).toBeNull();
      expect(lost.length).toBe(1 + APPEARANCE_RASTER_MISS_RETRIES);
      expect(await rasterOf(never.source, 2, second, 2)).toBeNull();
      expect(lost.length).toBe(2 * (1 + APPEARANCE_RASTER_MISS_RETRIES));
      // The next holder with a sound copy gets the bitmap.
      expect((await rasterOf(sourceOf(bytes, pdf, key).source, 2, second, 2))!.canvas.width).toBe(400);

      // An id the page does not list as a stamp gets one render and no more.
      const count = appearanceRasterRenderCount();
      expect(await rasterOf(sourceOf(bytes, pdf, key).source, 1, 'no-such-id', 4)).toBeNull();
      expect(appearanceRasterRenderCount()).toBe(count + 1);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('serves a new document over equal bytes from the bitmaps of the content key', async () => {
    const bytes = await twoToneStamps();
    const key = freshKey();
    retainAppearanceRasters(key);
    const first = await loadPdf(bytes);
    const [id] = await stampIds(first, 1);
    const [onSecondPage] = await stampIds(first, 2);
    const before = appearanceRasterRenderCount();
    const raster = await rasterOf(sourceOf(bytes, first, key).source, 1, id, 2);
    expect(appearanceRasterRenderCount()).toBe(before + 1);
    await first.loadingTask.destroy();
    const second = await loadPdf(bytes);
    try {
      retainAppearanceRasters(key);
      releaseAppearanceRasters(key);
      const { source } = sourceOf(bytes, second, key);
      expect(await rasterOf(source, 1, id, 2)).toBe(raster);
      // The same tier, another zoom inside it.
      expect(await rasterOf(source, 1, id, 1.5)).toBe(raster);
      expect(appearanceRasterRenderCount()).toBe(before + 1);
      // Another page and other bytes each render.
      await rasterOf(source, 2, onSecondPage, 2);
      const other = freshKey();
      retainAppearanceRasters(other);
      expect(await rasterOf(sourceOf(bytes, second, other).source, 1, id, 2)).not.toBe(raster);
      expect(appearanceRasterRenderCount()).toBe(before + 3);
      releaseAppearanceRasters(other);
      // The last document of the key takes the bitmaps with it.
      releaseAppearanceRasters(key);
      expect(appearanceRasterPageCount(key)).toBe(0);
      retainAppearanceRasters(key);
      expect(await rasterOf(source, 1, id, 2)).not.toBe(raster);
      expect(appearanceRasterRenderCount()).toBe(before + 4);
      releaseAppearanceRasters(key);
    } finally {
      await second.loadingTask.destroy();
    }
  });

  it('rasters again past a tier and keeps a stamp at one tier', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const { source } = sourceOf(bytes, pdf, key);
      const [id] = await stampIds(pdf, 1);
      const [other] = await stampIds(pdf, 2);
      const before = appearanceRasterRenderCount();
      const low = await rasterOf(source, 1, id, 1);
      const otherPage = await rasterOf(source, 2, other, 1);
      const high = await rasterOf(source, 1, id, 3);
      expect([low!.canvas.width, high!.canvas.width]).toEqual([200, 800]);
      expect(appearanceRasterRenderCount()).toBe(before + 3);
      expect(await rasterOf(source, 1, id, 4)).toBe(high);
      expect(await rasterOf(source, 2, other, 1)).toBe(otherPage);
      expect(appearanceRasterRenderCount()).toBe(before + 3);
      // The lower tier of the stamp left when the higher one was asked for.
      expect(await rasterOf(source, 1, id, 1)).not.toBe(low);
      expect(appearanceRasterRenderCount()).toBe(before + 4);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('gives one render to the stamps asked for in one turn, and empties the canvas of a stamp nobody asked for', async () => {
    const doc = await PDFDocument.load(await stampPages(1));
    const [page] = doc.getPages();
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    const first = annots.lookup(0, PDFDict);
    for (const y of [100, 250]) {
      const more = first.clone(doc.context);
      more.set(PDFName.of('Rect'), doc.context.obj([50, y, 250, y + 100]));
      annots.push(doc.context.register(more));
    }
    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    try {
      const [a, b, c] = await stampIds(pdf, 1);
      const calls: RenderCall[] = [];
      // The canvas of the third stamp is replaced by a record of its size.
      const { source } = sourceOf(bytes, pdf, null, wrapRenders(calls, async (real, call, index) => {
        await real();
        if (index === 0) call.canvases.set(c, { width: call.canvases.get(c)!.width, height: call.canvases.get(c)!.height });
      }));
      const before = appearanceRasterRenderCount();
      const holds = [holdAppearanceRaster(source, 1, a, 1), holdAppearanceRaster(source, 1, b, 1)];
      const [ra, rb] = await Promise.all(holds.map((hold) => hold.raster));
      expect(appearanceRasterRenderCount()).toBe(before + 1);
      expect([ra!.canvas.width, rb!.canvas.width]).toEqual([200, 200]);
      const unasked = calls[0].canvases.get(c)!;
      expect([unasked.width, unasked.height]).toEqual([0, 0]);
      // A stamp asked for later renders the page once more, and the two
      // bitmaps held stay as they are.
      const late = holdAppearanceRaster(source, 1, c, 1);
      expect((await late.raster)!.canvas.width).toBe(200);
      expect(appearanceRasterRenderCount()).toBe(before + 2);
      expect([ra!.canvas.width, rb!.canvas.width]).toEqual([200, 200]);
      for (const hold of [...holds, late]) hold.release();
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('keeps the bitmaps of a bounded count of pages, and every page a holder still holds', async () => {
    const pages = APPEARANCE_RASTER_PAGES + 3;
    const bytes = await stampPages(pages);
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const { source } = sourceOf(bytes, pdf, key);
      const ids: string[] = [];
      for (let n = 1; n <= pages; n++) ids.push((await stampIds(pdf, n))[0]);
      const held = holdAppearanceRaster(source, 1, ids[0], 1);
      const first = await held.raster;
      for (let n = 2; n <= pages; n++) await rasterOf(source, n, ids[n - 1], 1);
      // The held page stays; of the others the most recent stay.
      expect(appearanceRasterPageCount(key)).toBe(APPEARANCE_RASTER_PAGES);
      const before = appearanceRasterRenderCount();
      expect(await rasterOf(source, 1, ids[0], 1)).toBe(first);
      await rasterOf(source, pages, ids[pages - 1], 1);
      expect(appearanceRasterRenderCount()).toBe(before);
      await rasterOf(source, 2, ids[1], 1);
      expect(appearanceRasterRenderCount()).toBe(before + 1);
      // Released, the held page leaves when its turn comes.
      held.release();
      for (let n = 3; n <= pages; n++) await rasterOf(source, n, ids[n - 1], 1);
      expect(appearanceRasterPageCount(key)).toBe(APPEARANCE_RASTER_PAGES);
      const again = appearanceRasterRenderCount();
      expect(await rasterOf(source, 1, ids[0], 1)).not.toBe(first);
      expect(appearanceRasterRenderCount()).toBe(again + 1);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('cancels a render when its last holder leaves and keeps nothing of it', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const [id] = await stampIds(pdf, 1);
      const calls: RenderCall[] = [];
      let hang = true;
      const cancelled = (): Error => Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' });
      // A render that settles only when it is cancelled.
      const { source } = sourceOf(bytes, pdf, key, wrapRenders(calls, (real, call) =>
        hang
          ? new Promise((_, reject) => {
              const poll = setInterval(() => {
                if (!call.cancelled) return;
                clearInterval(poll);
                reject(cancelled());
              }, 1);
            })
          : real()));
      const one = holdAppearanceRaster(source, 1, id, 2);
      const two = holdAppearanceRaster(source, 1, id, 2);
      await turns();
      expect(calls.length).toBe(1);
      // One holder is left: the render goes on.
      one.release();
      await turns();
      expect(calls[0].cancelled).toBe(false);
      two.release();
      expect(await two.raster).toBeNull();
      expect(calls[0].cancelled).toBe(true);
      await turns();
      expect(appearanceRasterPageCount(key)).toBe(0);
      // No retry ran for a render nobody waits for.
      expect(calls.length).toBe(1);
      hang = false;
      expect((await rasterOf(source, 1, id, 2))!.canvas.width).toBe(400);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('runs a render again through the newest holder when its document was destroyed under it', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const [id] = await stampIds(pdf, 1);
      const calls: RenderCall[] = [];
      const opened = sourceOf(bytes, pdf, key, wrapRenders(calls, async (real, _call, index) => {
        if (index === 0) throw Object.assign(new Error('Worker was destroyed'), { name: 'AbortException' });
        return real();
      }));
      // An older holder whose document gives no bytes any more.
      const gone = holdAppearanceRaster({ pdf, contentKey: key, open: () => Promise.reject(new Error('destroyed')) }, 1, id, 2);
      const live = holdAppearanceRaster(opened.source, 1, id, 2);
      expect((await live.raster)!.canvas.width).toBe(400);
      expect(await gone.raster).toBe(await live.raster);
      // The copy of the cancelled render was closed and another opened.
      expect(opened.copies.length).toBe(2);
      expect(opened.copies[0].loadingTask.destroyed).toBe(true);
      gone.release();
      live.release();
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('opens again for the next render when no holder could open a copy', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const [id] = await stampIds(pdf, 1);
      const [other] = await stampIds(pdf, 2);
      let opens = 0;
      const closed: AppearanceRasterSource = { pdf, contentKey: key, open: () => { opens++; return Promise.reject(new Error('no bytes')); } };
      const dead = holdAppearanceRaster(closed, 1, id, 2);
      expect(await dead.raster).toBeNull();
      expect(opens).toBe(1);
      // The holder stays. The next render asks both holders again.
      const again = holdAppearanceRaster(closed, 2, other, 2);
      expect(await again.raster).toBeNull();
      expect(opens).toBe(3);
      // A later holder opens its own copy, with the two that cannot still there.
      const opened = sourceOf(bytes, pdf, key);
      const live = holdAppearanceRaster(opened.source, 1, id, 2);
      expect((await live.raster)!.canvas.width).toBe(400);
      expect([opened.copies.length, opens]).toEqual([1, 3]);
      live.release();
      dead.release();
      again.release();
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('keeps a copy another render still uses when one render retires it, and destroys it when that render is done', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const [first] = await stampIds(pdf, 1);
      const [second] = await stampIds(pdf, 2);
      const calls: RenderCall[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const until = async (done: () => boolean): Promise<void> => {
        while (!done()) await new Promise((resolve) => setTimeout(resolve, 1));
      };
      const opened = sourceOf(bytes, pdf, key, wrapRenders(calls, async (real, _call, index) => {
        if (index === 0) {
          // The render of page 1 is cancelled while the render of page 2 runs.
          await until(() => calls.length >= 2);
          throw Object.assign(new Error('Worker was destroyed'), { name: 'AbortException' });
        }
        if (index === 1) await gate;
        return real();
      }));
      const one = holdAppearanceRaster(opened.source, 1, first, 2);
      const two = holdAppearanceRaster(opened.source, 2, second, 2);
      // Page 1 renders again on a second copy while page 2 is still on the first.
      expect((await one.raster)!.canvas.width).toBe(400);
      expect(opened.copies.length).toBe(2);
      await turns();
      expect(opened.copies[0].loadingTask.destroyed).toBe(false);
      release();
      expect((await two.raster)!.canvas.width).toBe(400);
      // Page 2 rendered once: nothing aborted it.
      expect(calls.length).toBe(3);
      await turns();
      expect(opened.copies[0].loadingTask.destroyed).toBe(true);
      expect(opened.copies[1].loadingTask.destroyed).toBe(false);
      one.release();
      two.release();
      await turns();
      expect(opened.copies[1].loadingTask.destroyed).toBe(true);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('opens one copy for its holders and destroys it with the last holder or with the content key', async () => {
    const bytes = await twoToneStamps();
    const pdf = await loadPdf(bytes);
    const key = freshKey();
    retainAppearanceRasters(key);
    try {
      const [id] = await stampIds(pdf, 1);
      const [other] = await stampIds(pdf, 2);
      const opened = sourceOf(bytes, pdf, key);
      const one = holdAppearanceRaster(opened.source, 1, id, 2);
      await one.raster;
      const two = holdAppearanceRaster(opened.source, 2, other, 2);
      await two.raster;
      expect(opened.copies.length).toBe(1);
      one.release();
      await turns();
      expect(opened.copies[0].loadingTask.destroyed).toBe(false);
      // A holder that swaps its hold in one turn keeps the copy.
      two.release();
      const three = holdAppearanceRaster(opened.source, 2, other, 8);
      await three.raster;
      expect(opened.copies.length).toBe(1);
      three.release();
      await turns();
      expect(opened.copies[0].loadingTask.destroyed).toBe(true);
      // The bitmaps outlive the copy.
      const before = appearanceRasterRenderCount();
      const four = holdAppearanceRaster(opened.source, 1, id, 2);
      expect((await four.raster)!.canvas.width).toBe(400);
      expect([appearanceRasterRenderCount(), opened.copies.length]).toEqual([before, 1]);
      // The last document of the key closes a copy a holder still has open.
      const five = holdAppearanceRaster(opened.source, 1, id, 16);
      await five.raster;
      expect(opened.copies.length).toBe(2);
      releaseAppearanceRasters(key);
      await turns();
      expect(opened.copies[1].loadingTask.destroyed).toBe(true);
      expect(appearanceRasterPageCount(key)).toBe(0);
      four.release();
      five.release();
      retainAppearanceRasters(key);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });

  it('renders nothing for a page with no stamp', async () => {
    const bytes = await blankPage();
    const pdf = await loadPdf(bytes);
    try {
      const before = appearanceRasterRenderCount();
      expect(await rasterOf(sourceOf(bytes, pdf).source, 1, '1R', 2)).toBeNull();
      expect(appearanceRasterRenderCount()).toBe(before);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('keeps no failed render', async () => {
    const bytes = await twoToneStamps();
    const key = freshKey();
    retainAppearanceRasters(key);
    const pdf = await loadPdf(bytes);
    try {
      const [id] = await stampIds(pdf, 1);
      expect(await rasterOf({ pdf, contentKey: key, open: () => Promise.reject(new Error('no bytes')) }, 1, id, 2)).toBeNull();
      const calls: RenderCall[] = [];
      const broken = sourceOf(bytes, pdf, key, wrapRenders(calls, () => Promise.reject(new Error('render failed'))));
      expect(await rasterOf(broken.source, 1, id, 2)).toBeNull();
      // A failure is not a cancellation: it runs once.
      expect(calls.length).toBe(1);
      expect(appearanceRasterPageCount(key)).toBe(0);
      expect((await rasterOf(sourceOf(bytes, pdf, key).source, 1, id, 2))!.canvas.width).toBe(400);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });
});

describe('which imported stamps the canvas draws from their appearance', () => {
  const IMAGE: Omit<PageAnnotation, 'id'> =
    { kind: 'stamp', x: 0.2, y: 0.4, w: 0.3, h: 0.1, color: '#14213d', note: 'Scanned', imageData: solidPng(220, 30, 40) };
  const LABEL: Omit<PageAnnotation, 'id'> = { kind: 'stamp', x: 0.2, y: 0.4, w: 0.3, h: 0.1, color: '#2fbf71', note: 'APPROVED' };

  it('marks an image stamp read back from the file with the id pdf.js gives it', async () => {
    const once = await commit(await blankPage(), placing(IMAGE));
    const [stamp] = stampsOf(await importedPages(once));
    const pdf = await loadPdf(once);
    try {
      expect(stamp.imageData).toBeUndefined();
      expect([stamp.carriedAppearance]).toEqual(await stampIds(pdf, 1));
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('does not mark a label stamp, which the commit draws again', async () => {
    const once = await commit(await blankPage(), placing(LABEL));
    const [stamp] = stampsOf(await importedPages(once));
    expect({ kind: stamp.kind, note: stamp.note, carried: stamp.carriedAppearance }).toEqual({ kind: 'stamp', note: 'APPROVED', carried: undefined });
  });

  it('keeps the mark through a move, a second commit and the next read-back', async () => {
    const once = await commit(await blankPage(), placing(IMAGE));
    const moved = ([page, ...rest]: PageRef[]): PageRef[] =>
      [{ ...page, annotations: page.annotations!.map((a) => ({ ...a, x: 0.5, y: 0.1, geometryDiverged: true })) }, ...rest];
    expect(stampsOf(moved(await importedPages(once)))[0].carriedAppearance).toBeDefined();
    const twice = await commit(once, moved);
    const [stamp] = stampsOf(await importedPages(twice));
    expect(stamp.carriedAppearance).toBeDefined();
    expect(Number(stamp.x.toFixed(6))).toBe(0.5);
  });

  it.skipIf(!HAS_CANVAS)('rasters the image the read-back stamp paints', async () => {
    const once = await commit(await blankPage(), placing(IMAGE));
    const [stamp] = stampsOf(await importedPages(once));
    const pdf = await loadPdf(once);
    try {
      const raster = await rasterOf(sourceOf(once, pdf).source, 1, stamp.carriedAppearance!, 2);
      expect(raster).not.toBeNull();
      const { canvas } = raster!;
      // 0.3 by 0.1 of a 300 by 600 page, at two pixels per point.
      expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 180, height: 120 });
      for (const [x, y] of [[4, 4], [90, 60], [175, 115]]) expect(pixel(canvas, x, y)).toEqual([220, 30, 40, 255]);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
});

/** Two pages, the second with /Rotate 90. Each holds page content under
 *  every annotation, a free text at [50 400 250 500] whose appearance is red
 *  in its left half and blue in its right half and unpainted in its top
 *  half, a green square over the lower right corner of the free text, a
 *  two-tone stamp, and a line with no appearance. */
async function mixedAnnotations(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rotate of [0, 90]) {
    const page = doc.addPage([400, 600]);
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 600 });
    if (rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(rotate));
    const form = (content: string, width: number, height: number) => doc.context.register(doc.context.stream(content, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: {},
    }));
    const text = doc.context.obj({
      Type: 'Annot', Subtype: 'FreeText', Rect: [50, 400, 250, 500], F: 4, DA: PDFString.of('0 g /Helv 12 Tf'),
      AP: { N: form('1 0 0 rg 0 0 100 50 re f 0 0 1 rg 100 0 100 50 re f', 200, 100) },
    });
    const square = doc.context.obj({
      Type: 'Annot', Subtype: 'Square', Rect: [200, 350, 300, 450], F: 4, AP: { N: form('0 1 0 rg 0 0 100 100 re f', 100, 100) },
    });
    const stamp = doc.context.obj({
      Type: 'Annot', Subtype: 'Stamp', Rect: [50, 100, 250, 200], F: 4, AP: { N: form('1 0 0 rg 0 0 100 100 re f 0 0 1 rg 100 0 100 100 re f', 200, 100) },
    });
    const line = doc.context.obj({ Type: 'Annot', Subtype: 'Line', Rect: [300, 500, 380, 580], L: [300, 500, 380, 580], F: 4, C: [0, 0, 0] });
    page.node.set(PDFName.of('Annots'), doc.context.obj([text, square, stamp, line].map((a) => doc.context.register(a))));
  }
  return doc.save();
}

async function idsOf(pdf: PDFDocumentProxy, pageNumber: number): Promise<Record<string, string>> {
  const annotations = (await (await pdf.getPage(pageNumber)).getAnnotations()) as { id: string; subtype: string }[];
  return Object.fromEntries(annotations.map((a) => [a.subtype, a.id]));
}

const GREEN: Pixel = [0, 255, 0, 255];

describe.skipIf(!HAS_CANVAS)('the bitmap of an annotation that is no stamp', () => {
  it('covers its rectangle in the frame of the page before /Rotate, with its own pixels and no other', async () => {
    const bytes = await mixedAnnotations();
    const pdf = await loadPdf(bytes);
    try {
      const { source } = sourceOf(bytes, pdf);
      for (const pageNumber of [1, 2]) {
        const ids = await idsOf(pdf, pageNumber);
        const raster = (await rasterOf(source, pageNumber, ids.FreeText, 2))!;
        expect({ width: raster.canvas.width, height: raster.canvas.height, pageRotate: raster.pageRotate, rect: raster.rect, view: raster.view })
          .toEqual({ width: 400, height: 200, pageRotate: pageNumber === 1 ? 0 : 90, rect: [50, 400, 250, 500], view: [0, 0, 400, 600] });
        expect(pixel(raster.canvas, 100, 150)).toEqual(RED);
        expect(pixel(raster.canvas, 300, 150)).toEqual(BLUE);
        // The top half of the appearance box is not painted, and no page
        // content shows there.
        expect(pixel(raster.canvas, 100, 40)).toEqual(CLEAR);
        // The square over the lower right corner is not in the bitmap.
        expect(pixel(raster.canvas, 390, 190)).toEqual(BLUE);
        const square = (await rasterOf(source, pageNumber, ids.Square, 1))!;
        expect({ width: square.canvas.width, height: square.canvas.height, rect: square.rect }).toEqual({ width: 100, height: 100, rect: [200, 350, 300, 450] });
        for (const [x, y] of [[2, 2], [50, 50], [97, 97]]) expect(pixel(square.canvas, x, y)).toEqual(GREEN);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('takes one render of its own, and none in editing mode', async () => {
    const bytes = await mixedAnnotations();
    const pdf = await loadPdf(bytes);
    try {
      const ids = await idsOf(pdf, 1);
      const editing: boolean[] = [];
      const { source } = sourceOf(bytes, pdf, null, (copy) => ({
        canvasFactory: (copy as unknown as { canvasFactory: unknown }).canvasFactory,
        loadingTask: copy.loadingTask,
        getPage: async (pageNumber: number) => {
          const page = await copy.getPage(pageNumber);
          return new Proxy(page, {
            get: (target, key) => {
              if (key === 'render') {
                return (params: Parameters<typeof page.render>[0]) => {
                  editing.push((params as { isEditing?: boolean }).isEditing === true);
                  return target.render(params);
                };
              }
              const value = Reflect.get(target, key, target) as unknown;
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          });
        },
      }) as unknown as PDFDocumentProxy);
      const before = appearanceRasterRenderCount();
      expect((await rasterOf(source, 1, ids.FreeText, 1))!.canvas.width).toBe(200);
      expect(appearanceRasterRenderCount()).toBe(before + 1);
      expect(editing).toEqual([false]);
      // With a stamp in the same turn: one render for it, in editing mode,
      // and one for the square.
      const holds = [holdAppearanceRaster(source, 1, ids.Stamp, 1), holdAppearanceRaster(source, 1, ids.Square, 1)];
      const [stamp, square] = await Promise.all(holds.map((hold) => hold.raster));
      expect([stamp!.canvas.width, square!.canvas.width]).toEqual([200, 100]);
      expect(pixel(stamp!.canvas, 50, 50)).toEqual(RED);
      expect(pixel(square!.canvas, 50, 50)).toEqual(GREEN);
      expect(appearanceRasterRenderCount()).toBe(before + 3);
      expect(editing.slice(1).sort()).toEqual([false, true]);
      for (const hold of holds) hold.release();
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('gives no bitmap and no render to an annotation with no appearance', async () => {
    const doc = await PDFDocument.load(await mixedAnnotations());
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annots.get(3)]));
    const bytes = await doc.save();
    const pdf = await loadPdf(bytes);
    try {
      const ids = await idsOf(pdf, 1);
      expect(Object.keys(ids)).toEqual(['Line']);
      const before = appearanceRasterRenderCount();
      expect(await rasterOf(sourceOf(bytes, pdf).source, 1, ids.Line, 2)).toBeNull();
      expect(appearanceRasterRenderCount()).toBe(before);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('keeps a bitmap by content key, page, annotation and tier', async () => {
    const bytes = await mixedAnnotations();
    const key = freshKey();
    retainAppearanceRasters(key);
    const pdf = await loadPdf(bytes);
    try {
      const ids = await idsOf(pdf, 1);
      const { source } = sourceOf(bytes, pdf, key);
      const first = await rasterOf(source, 1, ids.FreeText, 2);
      const before = appearanceRasterRenderCount();
      expect(await rasterOf(source, 1, ids.FreeText, 2)).toBe(first);
      expect(await rasterOf(source, 1, ids.FreeText, 1.5)).toBe(first);
      expect(appearanceRasterRenderCount()).toBe(before);
      expect((await rasterOf(source, 1, ids.FreeText, 3))!.canvas.width).toBe(800);
      expect(await rasterOf(source, 2, (await idsOf(pdf, 2)).FreeText, 2)).not.toBe(first);
      expect(appearanceRasterRenderCount()).toBe(before + 2);
      expect(appearanceRasterPageCount(key)).toBe(2);
    } finally {
      releaseAppearanceRasters(key);
      await pdf.loadingTask.destroy();
    }
  });
});
