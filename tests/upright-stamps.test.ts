// A page render draws a stamp with the NoRotate flag upright: its upper-left
// corner at the place the page gives the upper-left corner of /Rect, its size
// that of /Rect (ISO 32000-2 12.5.3, Table 167 and the text after it). The
// box is the one the import gives the stamp, so the drawing and the selection
// box are one rectangle. Every other annotation of the page is drawn as a
// render of the page without that stamp draws it.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { loadPdf } from './support/saved-pdf';
import { pdfRectToDisplay, pdfRectToUprightDisplay } from '../src/renderer/lib/pdfx-build';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  BEGIN_ANNOTATION, END_ANNOTATION, annotationOperations, composeMatrix, renderMatrix, renderPageUpright, renderPageUprightOnce,
  uprightStampMatrix, uprightStampsAmong,
} from '../src/renderer/lib/upright-stamps';
import type { Matrix, UprightPage } from '../src/renderer/lib/upright-stamps';
import { bindUprightDocument, recordUprightStamps } from '../src/renderer/lib/upright-record';

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

const ROTATIONS = [0, 90, 180, 270] as const;
const BOX = { x: 0, y: 0, width: 400, height: 600 };
/** The upright box of this rectangle is inside the page for every rotation. */
const RECT: [number, number, number, number] = [150, 250, 250, 300];
const CONTROL: [number, number, number, number] = [60, 100, 160, 140];
const SQUARE: [number, number, number, number] = [300, 50, 340, 150];
const NO_ROTATE = 16;

type Pixel = [number, number, number, number];
const RED: Pixel = [255, 0, 0, 255];
const BLUE: Pixel = [0, 0, 255, 255];
const GREEN: Pixel = [0, 255, 0, 255];
const WHITE: Pixel = [255, 255, 255, 255];

interface Canvas2d {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
interface Target {
  canvas: { width: number; height: number; getContext(kind: '2d'): Canvas2d };
  context: CanvasRenderingContext2D;
}
const pixel = (target: Target, x: number, y: number): Pixel =>
  Array.from(target.canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Pixel;

const shownSize = (rotation: number): { width: number; height: number } =>
  ((rotation % 180) + 180) % 180 === 90 ? { width: BOX.height, height: BOX.width } : { width: BOX.width, height: BOX.height };

/** One page per /Rotate. Each holds a two-tone stamp at RECT with `flags`
 *  (red in its left half, blue in its right half, its top quarter not
 *  painted), a stamp without the NoRotate flag at CONTROL, and, with
 *  `square`, a green NoRotate square at SQUARE. */
async function fixture(flags: number, square = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rotate of ROTATIONS) {
    const page = doc.addPage([BOX.width, BOX.height]);
    if (rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(rotate));
    const twoTone = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 30 re f 0 0 1 rg 50 0 50 30 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: {},
    }));
    const annots = [
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: flags, AP: { N: twoTone } })),
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: CONTROL, F: 4, AP: { N: twoTone } })),
    ];
    if (square) {
      const green = doc.context.register(doc.context.stream('0 1 0 rg 0 0 40 100 re f', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 100], Resources: {},
      }));
      annots.push(doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: SQUARE, F: 4 + NO_ROTATE, AP: { N: green },
      })));
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj(annots));
  }
  return doc.save();
}

interface Shown {
  target: Target;
  width: number;
  height: number;
  /** How many stamps the render drew upright; null for a plain render. */
  upright: number | null;
}

interface ShowOptions {
  scale?: number;
  /** A turn on top of the page's /Rotate, in the viewport. */
  extra?: number;
  laterTurn?: number;
  plain?: boolean;
  /** A crop: the render's transform slides this point to the origin. */
  crop?: { x: number; y: number; width: number; height: number };
}

const factoryOf = (pdf: PDFDocumentProxy) =>
  (pdf as unknown as { canvasFactory: { create(w: number, h: number): Target } }).canvasFactory;

async function show(pdf: PDFDocumentProxy, pageNumber: number, options: ShowOptions = {}): Promise<Shown> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: options.scale ?? 1, rotation: (page.rotate + (options.extra ?? 0)) % 360 });
  const width = options.crop?.width ?? Math.floor(viewport.width);
  const height = options.crop?.height ?? Math.floor(viewport.height);
  const target = factoryOf(pdf).create(width, height);
  const params = {
    canvas: target.canvas as unknown as HTMLCanvasElement,
    canvasContext: target.context,
    viewport,
    ...(options.crop ? { transform: [1, 0, 0, 1, -options.crop.x, -options.crop.y] } : {}),
  };
  if (options.plain) {
    await page.render(params).promise;
    return { target, width, height, upright: null };
  }
  const upright = await renderPageUprightOnce(pdf, page, params, options.laterTurn ?? 0);
  return { target, width, height, upright };
}

/** Three points of a box of the stamp's appearance, as fractions of the box:
 *  in the red half, in the blue half, and in the quarter that is not painted. */
const PROBES: Array<[number, number, Pixel]> = [[0.25, 0.6, RED], [0.75, 0.6, BLUE], [0.25, 0.1, WHITE]];

describe('which stamps of a page stand upright', () => {
  it('takes a stamp with the flag, an appearance and a rectangle with an area', () => {
    const stamp = { id: '5R', subtype: 'Stamp', noRotate: true, hasAppearance: true, rect: [250, 300, 150, 250] };
    expect(uprightStampsAmong([stamp])).toEqual([{ id: '5R', rect: [150, 250, 250, 300] }]);
    expect(uprightStampsAmong([
      { ...stamp, noRotate: false },
      { ...stamp, hasAppearance: false },
      { ...stamp, subtype: 'Square' },
      { ...stamp, rect: [150, 250, 150, 300] },
      { ...stamp, rect: null },
      { ...stamp, id: undefined },
    ])).toEqual([]);
  });

});

describe('where an upright stamp lands on the canvas', () => {
  /** The corners of the unit square through `matrix`. */
  const corners = (matrix: Matrix): number[][] =>
    [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => [
      Number((matrix[0] * u + matrix[2] * v + matrix[4]).toFixed(6)) + 0,
      Number((matrix[1] * u + matrix[3] * v + matrix[5]).toFixed(6)) + 0,
    ]);

  /** A canvas point after a clockwise CSS quarter turn of a canvas of
   *  `width` by `height`, in the turned canvas's own frame. */
  const turned = ([x, y]: number[], turn: number, width: number, height: number): number[] =>
    turn === 90 ? [height - y, x] : turn === 180 ? [width - x, height - y] : turn === 270 ? [y, width - x] : [x, y];

  /** The viewport matrix pdf.js gives a page of BOX at `rotation`, scale 1. */
  const viewportMatrix = (rotation: number): Matrix =>
    rotation === 90 ? [0, 1, 1, 0, 0, 0]
      : rotation === 180 ? [-1, 0, 0, 1, BOX.width, 0]
        : rotation === 270 ? [0, -1, -1, 0, BOX.height, BOX.width]
          : [1, 0, 0, -1, 0, BOX.height];

  it.each(ROTATIONS.flatMap((rotate) => ROTATIONS.map((later) => [rotate, later] as const)))(
    'page /Rotate %i, a later turn of %i: the box the import gives the stamp for the total rotation',
    (rotate, later) => {
      const size = shownSize(rotate);
      const matrix = uprightStampMatrix(RECT, viewportMatrix(rotate), later);
      const shown = corners(matrix).map((point) => turned(point, later, size.width, size.height));
      const total = shownSize(rotate + later);
      const box = pdfRectToUprightDisplay(RECT, BOX, rotate + later);
      const x = Number((box.x * total.width).toFixed(6));
      const y = Number((box.y * total.height).toFixed(6));
      // Top-left, top-right, bottom-right, bottom-left: the stamp is upright.
      expect(shown).toEqual([[x, y], [x + 100, y], [x + 100, y + 50], [x, y + 50]]);
    },
  );

  it('applies the transform of the render after the viewport', () => {
    expect(renderMatrix([2, 0, 0, -2, 0, 1200], [1, 0, 0, 1, -30, -40])).toEqual([2, 0, 0, -2, -30, 1160]);
    expect(renderMatrix([2, 0, 0, -2, 0, 1200])).toEqual([2, 0, 0, -2, 0, 1200]);
    expect(composeMatrix([1, 0, 0, 1, 5, 7], [0, 1, 1, 0, 0, 0])).toEqual([0, 1, 1, 0, 5, 7]);
  });
});

describe.skipIf(!HAS_CANVAS)('a page render with a NoRotate stamp', () => {
  it('the viewport matrix of the test is the one pdf.js gives', async () => {
    const pdf = await loadPdf(await fixture(4 + NO_ROTATE));
    try {
      for (const [index, rotate] of ROTATIONS.entries()) {
        const page = await pdf.getPage(index + 1);
        const expected = rotate === 90 ? [0, 1, 1, 0, 0, 0]
          : rotate === 180 ? [-1, 0, 0, 1, BOX.width, 0]
            : rotate === 270 ? [0, -1, -1, 0, BOX.height, BOX.width]
              : [1, 0, 0, -1, 0, BOX.height];
        expect(page.getViewport({ scale: 1 }).transform.map((value: number) => value + 0)).toEqual(expected);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it.each(ROTATIONS.map((rotate, index) => [rotate, index + 1] as const))(
    'page /Rotate %i: the stamp is upright at the box of the import, and its turned rectangle holds no stamp',
    async (rotate, pageNumber) => {
      const pdf = await loadPdf(await fixture(4 + NO_ROTATE));
      try {
        const shown = await show(pdf, pageNumber);
        expect(shown.upright).toBe(1);
        const box = pdfRectToUprightDisplay(RECT, BOX, rotate);
        for (const [u, v, colour] of PROBES) {
          expect([u, v, pixel(shown.target, (box.x + u * box.w) * shown.width, (box.y + v * box.h) * shown.height)]).toEqual([u, v, colour]);
        }
        const turnedBox = pdfRectToDisplay(RECT, BOX, rotate);
        const centre: [number, number] = [(turnedBox.x + turnedBox.w / 2) * shown.width, (turnedBox.y + turnedBox.h * 0.6) * shown.height];
        const plain = await show(pdf, pageNumber, { plain: true });
        if (rotate === 0) {
          // The two boxes are one box on a page that is not rotated.
          expect(pixel(shown.target, ...centre)).toEqual(pixel(plain.target, ...centre));
        } else {
          // pdf.js alone draws the stamp turned, on the turned rectangle.
          expect(pixel(plain.target, ...centre)).not.toEqual(WHITE);
          expect(pixel(shown.target, ...centre)).toEqual(WHITE);
        }
        // A stamp without the flag is drawn by the page, turned with it.
        const control = pdfRectToDisplay(CONTROL, BOX, rotate);
        for (const [u, v] of [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
          const at: [number, number] = [(control.x + u * control.w) * shown.width, (control.y + v * control.h) * shown.height];
          expect(pixel(shown.target, ...at)).toEqual(pixel(plain.target, ...at));
        }
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  );

  it.each(ROTATIONS.flatMap((rotate, index) => [90, 180, 270].map((extra) => [rotate, extra, index + 1] as const)))(
    'page /Rotate %i with a turn of %i in the viewport, at twice the size: upright at the box of the total rotation',
    async (rotate, extra, pageNumber) => {
      const pdf = await loadPdf(await fixture(4 + NO_ROTATE));
      try {
        const shown = await show(pdf, pageNumber, { scale: 2, extra });
        const box = pdfRectToUprightDisplay(RECT, BOX, rotate + extra);
        for (const [u, v, colour] of PROBES) {
          expect([u, v, pixel(shown.target, (box.x + u * box.w) * shown.width, (box.y + v * box.h) * shown.height)]).toEqual([u, v, colour]);
        }
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  );

  it.each(ROTATIONS.flatMap((rotate, index) => [90, 180, 270].map((later) => [rotate, later, index + 1] as const)))(
    'page /Rotate %i on a canvas that is turned by %i afterwards: upright after that turn',
    async (rotate, later, pageNumber) => {
      const pdf = await loadPdf(await fixture(4 + NO_ROTATE));
      try {
        const shown = await show(pdf, pageNumber, { laterTurn: later });
        const total = shownSize(rotate + later);
        const box = pdfRectToUprightDisplay(RECT, BOX, rotate + later);
        // A point of the turned canvas, back in the frame of the canvas.
        const back = (x: number, y: number): [number, number] =>
          later === 90 ? [y, shown.height - x] : later === 180 ? [shown.width - x, shown.height - y] : [shown.width - y, x];
        for (const [u, v, colour] of PROBES) {
          const at = back((box.x + u * box.w) * total.width, (box.y + v * box.h) * total.height);
          expect([u, v, pixel(shown.target, ...at)]).toEqual([u, v, colour]);
        }
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  );

  it('a render of a part of the page puts the stamp at its place in that part', async () => {
    const pdf = await loadPdf(await fixture(4 + NO_ROTATE));
    try {
      // Page 2 has /Rotate 90.
      const box = pdfRectToUprightDisplay(RECT, BOX, 90);
      const size = shownSize(90);
      const crop = { x: Math.round(box.x * size.width) - 20, y: Math.round(box.y * size.height) - 10, width: 160, height: 90 };
      const shown = await show(pdf, 2, { crop });
      for (const [u, v, colour] of PROBES) {
        expect([u, v, pixel(shown.target, 20 + u * 100, 10 + v * 50)]).toEqual([u, v, colour]);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('another annotation with a canvas of its own is drawn where the page draws it', async () => {
    const pdf = await loadPdf(await fixture(4 + NO_ROTATE, true));
    try {
      for (const [index, rotate] of ROTATIONS.entries()) {
        const shown = await show(pdf, index + 1);
        const plain = await show(pdf, index + 1, { plain: true });
        const box = pdfRectToDisplay(SQUARE, BOX, rotate);
        for (const [u, v] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.8], [0.2, 0.8], [0.8, 0.2]]) {
          const at: [number, number] = [(box.x + u * box.w) * shown.width, (box.y + v * box.h) * shown.height];
          expect([rotate, u, v, pixel(plain.target, ...at)]).toEqual([rotate, u, v, GREEN]);
          expect([rotate, u, v, pixel(shown.target, ...at)]).toEqual([rotate, u, v, GREEN]);
        }
        // Just outside the rectangle nothing is drawn.
        const outside: [number, number] = [(box.x + box.w / 2) * shown.width, box.y * shown.height - 4];
        expect(pixel(shown.target, ...outside)).toEqual(WHITE);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('a hidden NoRotate stamp is drawn by nobody', async () => {
    const pdf = await loadPdf(await fixture(2 + NO_ROTATE));
    try {
      const shown = await show(pdf, 2);
      expect(shown.upright).toBe(0);
      const box = pdfRectToUprightDisplay(RECT, BOX, 90);
      expect(pixel(shown.target, (box.x + 0.25 * box.w) * shown.width, (box.y + 0.6 * box.h) * shown.height)).toEqual(WHITE);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
});

// A page that holds, in /Annots order: a checkbox and a read-only text field
// whose appearances multiply with what lies under them, a highlight under
// both, the two-tone stamp with `stampFlags`, a green NoRotate square, and a
// Multiply highlight over the square. pdf.js draws the form fields after
// every other annotation. It gives the read-only field and the square a
// canvas of their own when a render has an annotation canvas map.
const CHECK: [number, number, number, number] = [40, 500, 70, 530];
const FIELD: [number, number, number, number] = [80, 500, 160, 530];
const MARK: [number, number, number, number] = [30, 505, 170, 525];
const SQUARE_MARK: [number, number, number, number] = [290, 80, 350, 100];
const HIDDEN = 2;
const READ_ONLY = 1;

async function mixedFixture(stampFlags: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rotate of ROTATIONS) {
    const page = doc.addPage([BOX.width, BOX.height]);
    if (rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(rotate));
    const form = (content: string, width: number, height: number, resources: Record<string, Record<string, Record<string, string>>> = {}) =>
      doc.context.register(doc.context.stream(content, {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: resources,
      }));
    const multiply = { ExtGState: { GS: { Type: 'ExtGState', BM: 'Multiply' } } };
    const quad = ([x0, y0, x1, y1]: number[]): number[] => [x0, y1, x1, y1, x0, y0, x1, y0];
    const annots = [
      doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFString.of('check'), V: 'Yes', AS: 'Yes', Rect: CHECK, F: 4,
        AP: { N: { Yes: form('/GS gs 0.2 0.4 0.6 rg 0 0 30 30 re f', 30, 30, multiply), Off: form('', 30, 30) } },
      }),
      doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('field'), Ff: READ_ONLY, Rect: FIELD, F: 4,
        AP: { N: form('/GS gs 0.2 0.4 0.6 rg 0 0 80 30 re f', 80, 30, multiply) },
      }),
      doc.context.obj({
        Type: 'Annot', Subtype: 'Highlight', Rect: MARK, QuadPoints: quad(MARK), C: [1, 1, 0], F: 4,
        AP: { N: form('1 1 0 rg 0 0 140 20 re f', 140, 20) },
      }),
      doc.context.obj({
        Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: stampFlags,
        AP: { N: form('1 0 0 rg 0 0 50 30 re f 0 0 1 rg 50 0 50 30 re f', 100, 40) },
      }),
      doc.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: SQUARE, F: 4 + NO_ROTATE,
        AP: { N: form('0 1 0 rg 0 0 40 100 re f', 40, 100) },
      }),
      doc.context.obj({
        Type: 'Annot', Subtype: 'Highlight', Rect: SQUARE_MARK, QuadPoints: quad(SQUARE_MARK), C: [1, 0, 1], F: 4,
        AP: { N: form('/GS gs 1 0 1 rg 0 0 60 20 re f', 60, 20, multiply) },
      }),
    ];
    page.node.set(PDFName.of('Annots'), doc.context.obj(annots.map((annot) => doc.context.register(annot))));
  }
  return doc.save();
}

const allPixels = (shown: Shown): Uint8ClampedArray =>
  shown.target.canvas.getContext('2d').getImageData(0, 0, shown.width, shown.height).data;

/** The pixels that differ between two renders of one size, outside `box`
 *  (canvas pixels, grown by two on every side). */
function differingOutside(a: Shown, b: Shown, box: { x: number; y: number; w: number; h: number }): number {
  const left = Math.floor(box.x) - 2;
  const top = Math.floor(box.y) - 2;
  const right = Math.ceil(box.x + box.w) + 2;
  const bottom = Math.ceil(box.y + box.h) + 2;
  const first = allPixels(a);
  const second = allPixels(b);
  let differing = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (x >= left && x < right && y >= top && y < bottom) continue;
      const at = (y * a.width + x) * 4;
      if (first[at] !== second[at] || first[at + 1] !== second[at + 1] || first[at + 2] !== second[at + 2] || first[at + 3] !== second[at + 3]) differing++;
    }
  }
  return differing;
}

describe.skipIf(!HAS_CANVAS)('the other annotations of a page with a NoRotate stamp', () => {
  it.each(ROTATIONS.map((rotate, index) => [rotate, index + 1] as const))(
    'page /Rotate %i: every pixel outside the upright box is the pixel of a render of the page without the stamp',
    async (rotate, pageNumber) => {
      const withStamp = await loadPdf(await mixedFixture(4 + NO_ROTATE));
      const without = await loadPdf(await mixedFixture(HIDDEN + NO_ROTATE));
      try {
        for (const scale of [1, 1.37]) {
          const shown = await show(withStamp, pageNumber, { scale });
          const plain = await show(without, pageNumber, { scale, plain: true });
          expect(shown.upright).toBe(1);
          const box = pdfRectToUprightDisplay(RECT, BOX, rotate);
          const upright = { x: box.x * shown.width, y: box.y * shown.height, w: box.w * shown.width, h: box.h * shown.height };
          expect([scale, differingOutside(shown, plain, upright)]).toEqual([scale, 0]);
          for (const [u, v, colour] of PROBES) {
            expect([u, v, pixel(shown.target, upright.x + u * upright.w, upright.y + v * upright.h)]).toEqual([u, v, colour]);
          }
          // The form fields multiply with the highlight under them, and the
          // second highlight multiplies with the NoRotate square under it.
          const centreOf = (rect: [number, number, number, number], u: number, v: number): [number, number] => {
            const d = pdfRectToDisplay(rect, BOX, rotate);
            return [(d.x + u * d.w) * shown.width, (d.y + v * d.h) * shown.height];
          };
          const fieldUnderMark: [number, number, number, number] = [FIELD[0], MARK[1], FIELD[2], MARK[3]];
          const checkUnderMark: [number, number, number, number] = [CHECK[0], MARK[1], CHECK[2], MARK[3]];
          const squareUnderMark: [number, number, number, number] = [SQUARE[0], SQUARE_MARK[1], SQUARE[2], SQUARE_MARK[3]];
          expect(pixel(shown.target, ...centreOf(fieldUnderMark, 0.5, 0.5))).toEqual([51, 102, 0, 255]);
          expect(pixel(shown.target, ...centreOf(checkUnderMark, 0.5, 0.5))).toEqual([51, 102, 0, 255]);
          expect(pixel(shown.target, ...centreOf(squareUnderMark, 0.5, 0.5))).toEqual([0, 0, 0, 255]);
          expect(pixel(shown.target, ...centreOf(SQUARE, 0.5, 0.1))).toEqual(GREEN);
        }
      } finally {
        await withStamp.loadingTask.destroy();
        await without.loadingTask.destroy();
      }
    },
  );

  it('a later CSS turn and a cropped render change no pixel outside the upright box either', async () => {
    const withStamp = await loadPdf(await mixedFixture(4 + NO_ROTATE));
    const without = await loadPdf(await mixedFixture(HIDDEN + NO_ROTATE));
    try {
      const turned = await show(withStamp, 2, { laterTurn: 90 });
      const plain = await show(without, 2, { plain: true });
      // The stamp is drawn turned back about its corner: its box on the canvas
      // is 50 wide and 100 high, and ends at the corner's row.
      const corner = pdfRectToUprightDisplay(RECT, BOX, 90);
      const x = corner.x * turned.width;
      const y = corner.y * turned.height;
      expect(differingOutside(turned, plain, { x, y: y - 100, w: 50, h: 100 })).toBe(0);
      const crop = { x: 0, y: 0, width: 200, height: 400 };
      const part = await show(withStamp, 2, { crop });
      const plainPart = await show(without, 2, { crop, plain: true });
      expect(differingOutside(part, plainPart, { x: 0, y: 0, w: 0, h: 0 })).toBe(0);
    } finally {
      await withStamp.loadingTask.destroy();
      await without.loadingTask.destroy();
    }
  });
});

describe.skipIf(!HAS_CANVAS)('a render that reads the record', () => {
  let keys = 0;

  it('a page with no record is rendered by pdf.js alone: its task, its pixels, no read of the annotations', async () => {
    const pdf = await loadPdf(await fixture(4 + NO_ROTATE));
    try {
      const page = await pdf.getPage(2);
      let reads = 0;
      const read = page.getAnnotations.bind(page);
      (page as unknown as { getAnnotations: unknown }).getAnnotations = (...args: Parameters<typeof read>) => {
        reads++;
        return read(...args);
      };
      const viewport = page.getViewport({ scale: 1 });
      const target = factoryOf(pdf).create(Math.floor(viewport.width), Math.floor(viewport.height));
      const params = { canvas: target.canvas as unknown as HTMLCanvasElement, canvasContext: target.context, viewport };
      const task = renderPageUpright(pdf, page, params);
      expect(task.upright).toBeUndefined();
      expect((task as unknown as { _internalRenderTask?: unknown })._internalRenderTask).toBeDefined();
      await task.promise;
      expect(reads).toBe(0);
      const plain = await show(pdf, 2, { plain: true });
      expect(Buffer.from(allPixels({ target, width: plain.width, height: plain.height, upright: null })).equals(Buffer.from(allPixels(plain)))).toBe(true);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('a page the record lists a stamp for is drawn upright with two renders and no read of the annotations', async () => {
    const pdf = await loadPdf(await fixture(4 + NO_ROTATE));
    try {
      const page = await pdf.getPage(2);
      const listed = uprightStampsAmong(await page.getAnnotations());
      expect(listed.map((stamp) => stamp.rect)).toEqual([RECT]);
      const key = `test-key-${++keys}`;
      recordUprightStamps(key, [undefined, listed]);
      bindUprightDocument(pdf, key);
      let reads = 0;
      const renders: Array<Record<string, unknown>> = [];
      const counted: UprightPage & { getAnnotations: () => Promise<unknown[]> } = {
        pageNumber: page.pageNumber,
        getAnnotations: () => {
          reads++;
          return page.getAnnotations();
        },
        render: (params) => {
          renders.push(params as unknown as Record<string, unknown>);
          return page.render(params);
        },
      };
      const viewport = page.getViewport({ scale: 1 });
      const target = factoryOf(pdf).create(Math.floor(viewport.width), Math.floor(viewport.height));
      const params = { canvas: target.canvas as unknown as HTMLCanvasElement, canvasContext: target.context, viewport };
      const task = renderPageUpright(pdf, counted, params);
      expect(task.upright).toBe(listed);
      expect(await task.promise).toBe(1);
      expect(reads).toBe(0);
      expect(renders.length).toBe(2);
      expect(renders[0].annotationCanvasMap).toBeInstanceOf(Map);
      expect(typeof renders[0].operationsFilter).toBe('function');
      expect(renders[1].annotationCanvasMap).toBeUndefined();
      expect(typeof renders[1].operationsFilter).toBe('function');
      expect(renders.map((given) => given.canvas)).toEqual([params.canvas, params.canvas]);
      const box = pdfRectToUprightDisplay(RECT, BOX, 90);
      for (const [u, v, colour] of PROBES) {
        expect([u, v, pixel(target, (box.x + u * box.w) * target.canvas.width, (box.y + v * box.h) * target.canvas.height)]).toEqual([u, v, colour]);
      }
      // Page 1 has no record: it is not read and not drawn upright here.
      expect(renderPageUpright(pdf, await pdf.getPage(1), params).upright).toBeUndefined();
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('a hidden stamp the record lists gets no canvas: the page render is the caller\'s own and nothing is drawn', async () => {
    const pdf = await loadPdf(await fixture(HIDDEN + NO_ROTATE));
    try {
      const page = await pdf.getPage(2);
      const key = `test-key-${++keys}`;
      recordUprightStamps(key, [undefined, [{ id: 'none', rect: RECT }]]);
      bindUprightDocument(pdf, key);
      const renders: unknown[] = [];
      const counted: UprightPage = {
        pageNumber: 2,
        render: (params) => {
          renders.push(params);
          return page.render(params);
        },
      };
      const viewport = page.getViewport({ scale: 1 });
      const target = factoryOf(pdf).create(Math.floor(viewport.width), Math.floor(viewport.height));
      const params = { canvas: target.canvas as unknown as HTMLCanvasElement, canvasContext: target.context, viewport };
      expect(await renderPageUpright(pdf, counted, params).promise).toBe(0);
      expect(renders.length).toBe(2);
      expect(renders[1]).toBe(params);
      const plain = await show(pdf, 2, { plain: true });
      expect(Buffer.from(allPixels({ target, width: plain.width, height: plain.height, upright: null })).equals(Buffer.from(allPixels(plain)))).toBe(true);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
});

describe('the operations of an annotation in an operator list', () => {
  const OTHER = 31;
  const list = {
    fnArray: [OTHER, BEGIN_ANNOTATION, OTHER, END_ANNOTATION, BEGIN_ANNOTATION, OTHER, OTHER, END_ANNOTATION, BEGIN_ANNOTATION, END_ANNOTATION],
    argsArray: [null, ['4R', [0, 0, 1, 1]], null, null, ['5R', [0, 0, 1, 1]], null, [1], null, ['6R'], null],
  };

  it('the op codes are those of pdf.js', () => {
    expect([BEGIN_ANNOTATION, END_ANNOTATION]).toEqual([pdfjs.OPS.beginAnnotation, pdfjs.OPS.endAnnotation]);
  });

  it('holds an annotation from its begin to its end, and nothing else', () => {
    const scan = annotationOperations(new Set(['5R']));
    scan.read(list);
    expect(list.fnArray.map((_, index) => scan.holds(index))).toEqual([false, false, false, false, true, true, true, true, false, false]);
  });

  it('gives one answer for an index whatever was asked before', () => {
    const scan = annotationOperations(new Set(['4R', '6R']));
    scan.read(list);
    expect(scan.holds(9)).toBe(true);
    expect(scan.holds(2)).toBe(true);
    expect(scan.holds(5)).toBe(false);
    expect(scan.holds(2)).toBe(true);
    expect(scan.holds(0)).toBe(false);
    expect(scan.holds(8)).toBe(true);
  });

  it('reads a list that grows while it is asked', () => {
    const growing = { fnArray: [OTHER, BEGIN_ANNOTATION, OTHER], argsArray: [null, ['5R'], null] as Array<unknown[] | null> };
    const scan = annotationOperations(new Set(['5R']));
    scan.read(growing);
    expect([scan.holds(1), scan.holds(2)]).toEqual([true, true]);
    growing.fnArray.push(END_ANNOTATION, OTHER);
    growing.argsArray.push(null, null);
    expect([scan.holds(3), scan.holds(4)]).toEqual([true, false]);
  });

  it('holds nothing without a list', () => {
    const scan = annotationOperations(new Set(['5R']));
    expect(scan.holds(4)).toBe(false);
    scan.read(null);
    expect(scan.holds(4)).toBe(false);
  });
});

describe('the two renders of a page with an upright stamp', () => {
  const viewport = { transform: [1, 0, 0, -1, 0, 600] };
  const stamp = { id: '5R', rect: RECT };
  const context = { save: () => {}, restore: () => {}, setTransform: () => {}, drawImage: () => {} };
  const params = { canvasContext: context, viewport } as unknown as Parameters<PDFPageProxy['render']>[0];
  let documents = 0;

  /** A document whose page 1 the record lists `stamp` for. */
  const recorded = (): object => {
    const pdf = {};
    const key = `fake-key-${++documents}`;
    recordUprightStamps(key, [[stamp]]);
    bindUprightDocument(pdf, key);
    return pdf;
  };

  it('a cancel during the first render reaches it, and the second never starts', async () => {
    let renders = 0;
    let cancels = 0;
    let fail!: (error: unknown) => void;
    const page: UprightPage = {
      pageNumber: 1,
      render: () => {
        renders++;
        return {
          promise: new Promise((_, reject) => { fail = reject; }),
          cancel: () => {
            cancels++;
            fail(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
          },
        };
      },
    };
    const task = renderPageUpright(recorded(), page, params);
    expect(renders).toBe(1);
    task.cancel();
    await expect(task.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    expect([renders, cancels]).toEqual([1, 1]);
  });

  it('a cancel between the two renders rejects as a cancelled render and starts no second one', async () => {
    let renders = 0;
    let settle!: () => void;
    const page: UprightPage = {
      pageNumber: 1,
      render: () => {
        renders++;
        return { promise: new Promise<void>((resolve) => { settle = resolve; }), cancel: () => {} };
      },
    };
    const task = renderPageUpright(recorded(), page, params);
    settle();
    task.cancel();
    await expect(task.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    expect(renders).toBe(1);
  });

  it('a cancel during the second render reaches it', async () => {
    const cancelled: number[] = [];
    let renders = 0;
    let fail!: (error: unknown) => void;
    const page: UprightPage = {
      pageNumber: 1,
      render: (given) => {
        const index = ++renders;
        if (index === 1) {
          (given.annotationCanvasMap as unknown as Map<string, unknown>).set('5R', { width: 100, height: 50 });
          return { promise: Promise.resolve(), cancel: () => { cancelled.push(1); } };
        }
        return {
          promise: new Promise((_, reject) => { fail = reject; }),
          cancel: () => {
            cancelled.push(2);
            fail(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
          },
        };
      },
    };
    const task = renderPageUpright(recorded(), page, params);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renders).toBe(2);
    task.cancel();
    await expect(task.promise).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    expect(cancelled).toEqual([2]);
  });

  it('draws each stamp canvas once, in the order of the map, after the second render, and empties it', async () => {
    const events: unknown[] = [];
    const first = { width: 100, height: 50 };
    const second = { width: 100, height: 50 };
    const stranger = { width: 40, height: 100 };
    const pdf = {};
    recordUprightStamps('fake-key-two-stamps', [[stamp, { id: '7R', rect: CONTROL }]]);
    bindUprightDocument(pdf, 'fake-key-two-stamps');
    let renders = 0;
    const page: UprightPage = {
      pageNumber: 1,
      render: (given) => {
        events.push(`render ${++renders}`);
        const map = given.annotationCanvasMap as unknown as Map<string, unknown> | undefined;
        map?.set('7R', second);
        map?.set('9R', stranger);
        map?.set('5R', first);
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    };
    const counting = { ...context, drawImage: (canvas: unknown) => { events.push(canvas); } };
    expect(await renderPageUpright(pdf, page, { ...params, canvasContext: counting } as unknown as typeof params).promise).toBe(2);
    expect(events.length).toBe(4);
    expect(events.slice(0, 2)).toEqual(['render 1', 'render 2']);
    expect(events[2]).toBe(second);
    expect(events[3]).toBe(first);
    expect([first, second, stranger]).toEqual([{ width: 0, height: 0 }, { width: 0, height: 0 }, { width: 0, height: 0 }]);
  });
});
