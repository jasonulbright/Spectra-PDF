// A NoRotate stamp of optional content is visible in the upright render
// exactly when a plain render of the page shows it. pdf.js puts an annotation
// with /OC between a marked-content pair outside its begin and end; a render
// that selects only the annotation's own operations never learns that the
// layer is off, and draws the stamp.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { loadPdf } from './support/saved-pdf';
import { pdfRectToDisplay, pdfRectToUprightDisplay } from '../src/renderer/lib/pdfx-build';
import { renderPageUpright, uprightStampsAmong } from '../src/renderer/lib/upright-stamps';
import type { UprightPage } from '../src/renderer/lib/upright-stamps';
import { bindUprightDocument, recordUprightStamps } from '../src/renderer/lib/upright-record';

const HAS_CANVAS = (() => {
  try {
    createRequire(import.meta.url).resolve('@napi-rs/canvas');
    return true;
  } catch {
    return false;
  }
})();

type RenderParameters = Parameters<PDFPageProxy['render']>[0];
type Pixel = [number, number, number, number];
const RED: Pixel = [255, 0, 0, 255];
const BLUE: Pixel = [0, 0, 255, 255];
const WHITE: Pixel = [255, 255, 255, 255];

const BOX = { x: 0, y: 0, width: 400, height: 600 };
const ROTATE = 90;
const RECT: [number, number, number, number] = [150, 250, 250, 300];
const CONTROL: [number, number, number, number] = [60, 100, 160, 140];
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
const allPixels = (target: Target): Buffer =>
  Buffer.from(target.canvas.getContext('2d').getImageData(0, 0, target.canvas.width, target.canvas.height).data);

/** The pages of the fixture, in order. Each has /Rotate 90, a two-tone
 *  NoRotate stamp at RECT and a stamp without the flag at CONTROL, both with
 *  the /OC of the page's case. Group `on` is on, group `off` is off. */
const CASES = [
  { name: 'a layer that is off', visible: false },
  { name: 'a layer that is on', visible: true },
  { name: 'a membership dictionary that needs every layer on', visible: false },
  { name: 'a membership dictionary that needs any layer on', visible: true },
  { name: 'a nested visibility expression that holds', visible: true },
  { name: 'a nested visibility expression that does not hold', visible: false },
] as const;
/** A page whose stamps have no /OC and whose content leaves a marked-content
 *  sequence of the layer that is off open. */
const OPEN_SEQUENCE_PAGE = CASES.length + 1;

async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const context = doc.context;
  const on = context.register(context.obj({ Type: 'OCG', Name: PDFString.of('on') }));
  const off = context.register(context.obj({ Type: 'OCG', Name: PDFString.of('off') }));
  doc.catalog.set(PDFName.of('OCProperties'), context.obj({
    OCGs: [on, off],
    D: { BaseState: 'ON', OFF: [off], Order: [on, off] },
  }));
  const memberships = [
    off,
    on,
    context.register(context.obj({ Type: 'OCMD', OCGs: [on, off], P: 'AllOn' })),
    context.register(context.obj({ Type: 'OCMD', OCGs: [on, off], P: 'AnyOn' })),
    context.register(context.obj({ Type: 'OCMD', VE: ['And', on, ['Not', off]] })),
    context.register(context.obj({ Type: 'OCMD', VE: ['And', on, ['Or', off, ['Not', on]]] })),
    null,
  ];
  for (const membership of memberships) {
    const page = doc.addPage([BOX.width, BOX.height]);
    page.node.set(PDFName.of('Rotate'), context.obj(ROTATE));
    const twoTone = context.register(context.stream('1 0 0 rg 0 0 50 30 re f 0 0 1 rg 50 0 50 30 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: {},
    }));
    const optional = membership ? { OC: membership } : {};
    page.node.set(PDFName.of('Annots'), context.obj([
      context.register(context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: RECT, F: PRINT + NO_ROTATE, AP: { N: twoTone }, ...optional })),
      context.register(context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: CONTROL, F: PRINT, AP: { N: twoTone }, ...optional })),
    ]));
    if (!membership) {
      page.node.set(PDFName.of('Resources'), context.obj({ Properties: { Layer: off } }));
      page.node.set(PDFName.of('Contents'), context.register(context.stream('/OC /Layer BDC 0 1 0 rg 10 10 20 20 re f')));
    }
  }
  return doc.save();
}

interface Shown {
  target: Target;
  /** How many stamp canvases the render drew; null for a plain render. */
  upright: number | null;
  /** The parameters of each `page.render` call. */
  renders: RenderParameters[];
  /** The pixels of the caller's canvas and of each stamp canvas when the
   *  first render settled. */
  afterFirst: { page: Buffer; stamps: Buffer[] } | null;
}

let keys = 0;

/** Records the upright stamps of every page of `pdf`, as the workspace index
 *  does, and binds the document to the record. */
async function record(pdf: PDFDocumentProxy): Promise<void> {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) pages.push(uprightStampsAmong(await (await pdf.getPage(n)).getAnnotations()));
  const key = `optional-content-test-${++keys}`;
  recordUprightStamps(key, pages);
  bindUprightDocument(pdf, key);
}

async function show(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  options: { plain?: boolean; extra?: Partial<RenderParameters> } = {},
): Promise<Shown> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const target = factoryOf(pdf).create(Math.floor(viewport.width), Math.floor(viewport.height));
  const params = {
    canvas: target.canvas as unknown as HTMLCanvasElement,
    canvasContext: target.context,
    viewport,
    ...options.extra,
  } as RenderParameters;
  if (options.plain) {
    await page.render(params).promise;
    return { target, upright: null, renders: [params], afterFirst: null };
  }
  const renders: RenderParameters[] = [];
  let afterFirst: Shown['afterFirst'] = null;
  const counted: UprightPage = {
    pageNumber,
    render: (given) => {
      renders.push(given);
      const task = page.render(given);
      if (renders.length === 1) {
        void task.promise.then(() => {
          const map = given.annotationCanvasMap as unknown as Map<string, Target['canvas']> | undefined;
          afterFirst = {
            page: allPixels(target),
            stamps: [...(map?.values() ?? [])].map((canvas) => allPixels({ canvas, context: target.context })),
          };
        }, () => {});
      }
      return task;
    },
  };
  const upright = (await renderPageUpright(pdf, counted, params).promise) as number;
  return { target, upright, renders, afterFirst };
}

const uprightBox = pdfRectToUprightDisplay(RECT, BOX, ROTATE);
const turnedBox = pdfRectToDisplay(RECT, BOX, ROTATE);
/** Points of the upright box: in the red half, in the blue half. */
const PROBES: Array<[number, number, Pixel]> = [[0.25, 0.6, RED], [0.75, 0.6, BLUE]];
const at = (box: { x: number; y: number; w: number; h: number }, u: number, v: number, target: Target): [number, number] =>
  [(box.x + u * box.w) * target.canvas.width, (box.y + v * box.h) * target.canvas.height];

const everyByte = (pixels: Buffer, value: number): boolean => pixels.every((byte) => byte === value);

describe.skipIf(!HAS_CANVAS)('a NoRotate stamp of optional content', () => {
  it.each(CASES.map((entry, index) => [entry.name, entry.visible, index + 1] as const))(
    'with /OC of %s: visible is %s, as in a plain render',
    async (_name, visible, pageNumber) => {
      const pdf = await loadPdf(await fixture());
      try {
        await record(pdf);
        const plain = await show(pdf, pageNumber, { plain: true });
        // The control: pdf.js alone draws the stamp on its turned rectangle
        // when the optional content is visible, and not at all otherwise.
        expect(pixel(plain.target, ...at(turnedBox, 0.5, 0.6, plain.target)).join() !== WHITE.join()).toBe(visible);
        const shown = await show(pdf, pageNumber);
        expect(shown.renders.length).toBe(2);
        if (visible) {
          expect(shown.upright).toBe(1);
          for (const [u, v, colour] of PROBES) {
            expect([u, v, pixel(shown.target, ...at(uprightBox, u, v, shown.target))]).toEqual([u, v, colour]);
          }
          expect(pixel(shown.target, ...at(turnedBox, 0.5, 0.6, shown.target))).toEqual(WHITE);
        } else {
          // Not drawn by the first render: the page canvas holds the
          // background only and the stamp's own canvas holds nothing.
          expect(everyByte(shown.afterFirst!.page, 255)).toBe(true);
          expect(shown.afterFirst!.stamps.map((pixels) => everyByte(pixels, 0))).toEqual([true]);
          // Not drawn by the second render, and not drawn afterwards.
          expect(allPixels(shown.target).equals(allPixels(plain.target))).toBe(true);
          for (const [u, v] of PROBES) {
            expect([u, v, pixel(shown.target, ...at(uprightBox, u, v, shown.target))]).toEqual([u, v, WHITE]);
          }
        }
        // The stamp without the flag is drawn by the page, as in a plain render.
        const control = pdfRectToDisplay(CONTROL, BOX, ROTATE);
        for (const [u, v] of [[0.25, 0.5], [0.75, 0.5]]) {
          expect(pixel(shown.target, ...at(control, u, v, shown.target))).toEqual(pixel(plain.target, ...at(control, u, v, plain.target)));
        }
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  );

  it('a marked-content sequence the page content leaves open decides the stamp as it does in a plain render', async () => {
    const pdf = await loadPdf(await fixture());
    try {
      await record(pdf);
      const plain = await show(pdf, OPEN_SEQUENCE_PAGE, { plain: true });
      const plainShows = pixel(plain.target, ...at(turnedBox, 0.5, 0.6, plain.target)).join() !== WHITE.join();
      const shown = await show(pdf, OPEN_SEQUENCE_PAGE);
      const [u, v, colour] = PROBES[0];
      expect(pixel(shown.target, ...at(uprightBox, u, v, shown.target))).toEqual(plainShows ? colour : WHITE);
      if (!plainShows) expect(allPixels(shown.target).equals(allPixels(plain.target))).toBe(true);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('both renders get the caller\'s optional-content configuration: a layer the configuration turns off hides the stamp', async () => {
    const pdf = await loadPdf(await fixture());
    try {
      await record(pdf);
      const configured = async (name: string, visible: boolean) => {
        const config = await pdf.getOptionalContentConfig({ intent: 'display' });
        for (const [id, group] of config as unknown as Iterable<[string, { name: string }]>) {
          if (group.name === name) config.setVisibility(id, visible);
        }
        return config;
      };
      // Page 2: the layer is on in the file and off in the configuration.
      const offNow = Promise.resolve(await configured('on', false));
      const hidden = await show(pdf, 2, { extra: { optionalContentConfigPromise: offNow } });
      expect(hidden.renders.map((given) => given.optionalContentConfigPromise)).toEqual([offNow, offNow]);
      expect(hidden.renders[0].optionalContentConfigPromise).toBe(offNow);
      expect(hidden.renders[1].optionalContentConfigPromise).toBe(offNow);
      const plainHidden = await show(pdf, 2, {
        plain: true,
        extra: { optionalContentConfigPromise: Promise.resolve(await configured('on', false)) },
      });
      expect(allPixels(hidden.target).equals(allPixels(plainHidden.target))).toBe(true);
      expect(pixel(hidden.target, ...at(uprightBox, 0.25, 0.6, hidden.target))).toEqual(WHITE);
      // Page 1: the layer is off in the file and on in the configuration.
      const onNow = Promise.resolve(await configured('off', true));
      const visible = await show(pdf, 1, { extra: { optionalContentConfigPromise: onNow } });
      expect(visible.upright).toBe(1);
      for (const [u, v, colour] of PROBES) {
        expect([u, v, pixel(visible.target, ...at(uprightBox, u, v, visible.target))]).toEqual([u, v, colour]);
      }
      expect(pixel(visible.target, ...at(turnedBox, 0.5, 0.6, visible.target))).toEqual(WHITE);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('a render with a print intent is the caller\'s own render: pdf.js gives no annotation a canvas of its own there', async () => {
    const pdf = await loadPdf(await fixture());
    try {
      await record(pdf);
      for (const pageNumber of [1, 2]) {
        const shown = await show(pdf, pageNumber, { extra: { intent: 'print' } });
        const plain = await show(pdf, pageNumber, { plain: true, extra: { intent: 'print' } });
        expect(shown.upright).toBe(0);
        expect(shown.renders.length).toBe(2);
        expect(shown.renders[0].intent).toBe('print');
        expect((shown.renders[1] as { operationsFilter?: unknown }).operationsFilter).toBeUndefined();
        expect(shown.renders[1].annotationCanvasMap).toBeUndefined();
        expect(allPixels(shown.target).equals(allPixels(plain.target))).toBe(true);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
});
