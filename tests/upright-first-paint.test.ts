// The first paint of a page after its bytes change shows the new bytes. A
// page that had a NoRotate stamp in the replaced document is read from the
// new document before it is rendered: the first paint holds the new content,
// with a stamp upright when the new bytes hold one and with none when they
// do not. Every other page renders at once and reads nothing.

import { createRequire } from 'node:module';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({
  loadDocument: vi.fn(),
}));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import { loadPdf } from './support/saved-pdf';
import { pdfRectToDisplay, pdfRectToUprightDisplay } from '../src/renderer/lib/pdfx-build';
import { contentKeyOf, evictExcept, getDocumentProxy } from '../src/renderer/lib/pdfDocCache';
import { renderPageUpright, uprightDrawn, uprightStampsAmong } from '../src/renderer/lib/upright-stamps';
import type { PageRenderTask, UprightPage } from '../src/renderer/lib/upright-stamps';
import {
  recordAsksRepaint, recordUprightStamps, uprightCarried, uprightPagesOf, uprightStampsOn,
} from '../src/renderer/lib/upright-record';

const HAS_CANVAS = (() => {
  try {
    createRequire(import.meta.url).resolve('@napi-rs/canvas');
    return true;
  } catch {
    return false;
  }
})();

vi.mocked(loadDocument).mockImplementation((buffer) => loadPdf(buffer as Uint8Array));

type RenderParameters = Parameters<PDFPageProxy['render']>[0];
type Pixel = [number, number, number, number];
const RED: Pixel = [255, 0, 0, 255];
const BLUE: Pixel = [0, 0, 255, 255];
const GREEN: Pixel = [0, 255, 0, 255];
const MAGENTA: Pixel = [255, 0, 255, 255];
const WHITE: Pixel = [255, 255, 255, 255];

const BOX = { x: 0, y: 0, width: 400, height: 600 };
const ROTATE = 90;
const RECT: [number, number, number, number] = [150, 250, 250, 300];
/** Where the page content of the replaced bytes is painted, and of the new. */
const OLD_MARK: [number, number, number, number] = [20, 20, 80, 80];
const NEW_MARK: [number, number, number, number] = [300, 500, 380, 580];
const NO_ROTATE = 16;
const PRINT = 4;

interface Canvas2d {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
interface Target {
  canvas: { width: number; height: number; getContext(kind: '2d'): Canvas2d };
  context: CanvasRenderingContext2D;
}
const factoryOf = (pdf: PDFDocumentProxy) =>
  (pdf as unknown as { canvasFactory: { create(w: number, h: number): Target } }).canvasFactory;
const pixel = (target: Target, x: number, y: number): Pixel =>
  Array.from(target.canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Pixel;

/** Two pages. Page 1 has /Rotate 90, content painted at the old or the new
 *  mark, and with `stamp` a two-tone NoRotate stamp at RECT (red in its left
 *  half, blue in its right half). Page 2 has a stamp without the flag. */
async function bytesOf(content: 'old' | 'new', stamp: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const context = doc.context;
  const twoTone = context.register(context.stream('1 0 0 rg 0 0 50 30 re f 0 0 1 rg 50 0 50 30 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: {},
  }));
  const first = doc.addPage([BOX.width, BOX.height]);
  first.node.set(PDFName.of('Rotate'), context.obj(ROTATE));
  const [x0, y0, x1, y1] = content === 'old' ? OLD_MARK : NEW_MARK;
  const paint = content === 'old' ? '0 1 0 rg' : '1 0 1 rg';
  first.node.set(PDFName.of('Contents'), context.register(context.stream(`${paint} ${x0} ${y0} ${x1 - x0} ${y1 - y0} re f`)));
  if (stamp) {
    first.node.set(PDFName.of('Annots'), context.obj([
      context.register(context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: PRINT + NO_ROTATE, AP: { N: twoTone } })),
    ]));
  }
  const second = doc.addPage([BOX.width, BOX.height]);
  second.node.set(PDFName.of('Annots'), context.obj([
    context.register(context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: PRINT, AP: { N: twoTone } })),
  ]));
  return doc.save();
}

interface Painted {
  target: Target;
  task: PageRenderTask;
  /** `page.getAnnotations` calls of this render. */
  reads: number;
  /** `page.render` calls before the call returned. */
  startedInTurn: number;
  /** How many stamps the render drew upright. */
  upright: number;
}

/** One render of a page onto a new canvas, as a raster starts it. */
async function paint(pdf: PDFDocumentProxy, pageNumber: number): Promise<Painted> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const target = factoryOf(pdf).create(Math.floor(viewport.width), Math.floor(viewport.height));
  const params = { canvas: target.canvas as unknown as HTMLCanvasElement, canvasContext: target.context, viewport } as RenderParameters;
  let reads = 0;
  let renders = 0;
  const counted: UprightPage = {
    pageNumber,
    render: (given) => {
      renders++;
      return page.render(given);
    },
    getAnnotations: () => {
      reads++;
      return page.getAnnotations();
    },
  };
  const task = renderPageUpright(pdf, counted, params);
  const startedInTurn = renders;
  const upright = uprightDrawn(await task.promise);
  return { target, task, reads, startedInTurn, upright };
}

const uprightBox = pdfRectToUprightDisplay(RECT, BOX, ROTATE);
const turnedBox = pdfRectToDisplay(RECT, BOX, ROTATE);
const at = (box: { x: number; y: number; w: number; h: number }, u: number, v: number, target: Target): Pixel =>
  pixel(target, (box.x + u * box.w) * target.canvas.width, (box.y + v * box.h) * target.canvas.height);
const centre = (rect: [number, number, number, number], target: Target): Pixel =>
  at(pdfRectToDisplay(rect, BOX, ROTATE), 0.5, 0.5, target);

/** What the first page shows: the content marks, the two halves of the
 *  upright box, and the centre of the rectangle as the page turns it. */
const seen = (target: Target) => ({
  oldMark: centre(OLD_MARK, target),
  newMark: centre(NEW_MARK, target),
  uprightLeft: at(uprightBox, 0.25, 0.6, target),
  uprightRight: at(uprightBox, 0.75, 0.6, target),
  turned: at(turnedBox, 0.5, 0.5, target),
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The workspace index lands for `pdf`: the record of every page. */
async function indexLands(pdf: PDFDocumentProxy): Promise<void> {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) pages.push(uprightStampsAmong(await (await pdf.getPage(n)).getAnnotations()));
  recordUprightStamps(await contentKeyOf(pdf)!, pages);
}

async function placed(path: string, bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdf = await getDocumentProxy(path, bytes);
  await contentKeyOf(pdf);
  await flush();
  return pdf;
}

describe.skipIf(!HAS_CANVAS)('the first paint of a page after its bytes change', () => {
  afterAll(async () => {
    evictExcept(new Set());
    await flush();
  });

  it('shows the new content with the stamp upright, from one read of the page; another page reads nothing', async () => {
    const path = 'C:/first-paint-kept.pdf';
    const before = await placed(path, await bytesOf('old', true));
    await indexLands(before);
    const old = await paint(before, 1);
    expect([old.reads, old.upright]).toEqual([0, 1]);
    expect(seen(old.target)).toEqual({ oldMark: GREEN, newMark: WHITE, uprightLeft: RED, uprightRight: BLUE, turned: WHITE });

    // The bytes change. The index of the new bytes has not landed.
    const after = await placed(path, await bytesOf('new', true));
    expect(after).not.toBe(before);
    expect(uprightStampsOn(after, 0)).toBeUndefined();
    expect([uprightCarried(after, 0), uprightCarried(after, 1)]).toEqual([true, false]);

    const first = await paint(after, 1);
    expect([first.reads, first.startedInTurn, first.upright]).toEqual([1, 0, 1]);
    expect(seen(first.target)).toEqual({ oldMark: WHITE, newMark: MAGENTA, uprightLeft: RED, uprightRight: BLUE, turned: WHITE });

    // The page is known now: the next render starts at once and reads nothing.
    const again = await paint(after, 1);
    expect([again.reads, again.startedInTurn, again.upright]).toEqual([0, 1, 1]);

    // A page the replaced document had no upright stamp on: pdf.js's own
    // task, started in the turn of the call, with no read.
    const other = await paint(after, 2);
    expect([other.reads, other.startedInTurn, other.task.upright]).toEqual([0, 1, undefined]);
    expect('_internalRenderTask' in other.task).toBe(true);

    // The record of the index equals what the read gave: no repaint.
    await indexLands(after);
    expect(uprightStampsOn(after, 0)).toEqual(first.task.upright);
    expect(recordAsksRepaint(uprightStampsOn(after, 0), true, first.task.upright)).toBe(false);
  });

  it('shows the new content and no stamp when the new bytes hold none', async () => {
    const path = 'C:/first-paint-deleted.pdf';
    const before = await placed(path, await bytesOf('old', true));
    await indexLands(before);
    expect(seen((await paint(before, 1)).target)).toMatchObject({ oldMark: GREEN, uprightLeft: RED, uprightRight: BLUE });

    const after = await placed(path, await bytesOf('new', false));
    const first = await paint(after, 1);
    expect([first.reads, first.startedInTurn, first.upright, first.task.upright]).toEqual([1, 0, 0, undefined]);
    expect(seen(first.target)).toEqual({ oldMark: WHITE, newMark: MAGENTA, uprightLeft: WHITE, uprightRight: WHITE, turned: WHITE });
    // The page holds no upright stamp: its replacement is told nothing.
    expect(uprightPagesOf(after)).toEqual([]);
    const again = await paint(after, 1);
    expect([again.reads, again.startedInTurn]).toEqual([0, 1]);
  });

  it('a document that is replaced before its index lands hands the page on by what the read found', async () => {
    const path = 'C:/first-paint-chain.pdf';
    const before = await placed(path, await bytesOf('old', true));
    await indexLands(before);
    const middle = await placed(path, await bytesOf('new', true));
    expect((await paint(middle, 1)).upright).toBe(1);
    const last = await placed(path, await bytesOf('old', false));
    expect(uprightCarried(last, 0)).toBe(true);
    const first = await paint(last, 1);
    expect([first.reads, first.upright]).toEqual([1, 0]);
    expect(seen(first.target)).toEqual({ oldMark: GREEN, newMark: WHITE, uprightLeft: WHITE, uprightRight: WHITE, turned: WHITE });
  });
});
