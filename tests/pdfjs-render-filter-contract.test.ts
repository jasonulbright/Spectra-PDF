// What `lib/upright-stamps.ts` needs from the installed pdf.js, each need
// checked alone and named in the failure. A page with an upright stamp is
// drawn with two renders that select operations by index. That needs:
// 1. `operationsFilter` among the render parameters, asked once per operation
//    with the index of the operation in the list the task runs;
// 2. that list on the render task (`_internalRenderTask.operatorList`, with
//    `fnArray` and `argsArray`), which is not public API;
// 3. an annotation as `beginAnnotation` (its id first) to `endAnnotation`;
// 4. the optional content of an annotation as a marked-content pair in the
//    same list, and the op codes of the marked-content operations.
// When one of these fails after a pdf.js upgrade, the pixel tests of
// `upright-stamps.test.ts` fail too; this file says why.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadPdf } from './support/saved-pdf';
import {
  BEGIN_ANNOTATION, BEGIN_MARKED_CONTENT, BEGIN_MARKED_CONTENT_PROPS, END_ANNOTATION, END_MARKED_CONTENT, operatorListOf,
} from '../src/renderer/lib/upright-stamps';

const HAS_CANVAS = (() => {
  try {
    createRequire(import.meta.url).resolve('@napi-rs/canvas');
    return true;
  } catch {
    return false;
  }
})();

const UPGRADE = `pdf.js ${pdfjs.version}: lib/upright-stamps.ts cannot select the operations of a stamp.`;

/** One page with a NoRotate stamp of an optional content group. */
async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const context = doc.context;
  const group = context.register(context.obj({ Type: 'OCG', Name: PDFString.of('layer') }));
  doc.catalog.set(PDFName.of('OCProperties'), context.obj({ OCGs: [group], D: { BaseState: 'ON', Order: [group] } }));
  const page = doc.addPage([200, 200]);
  const appearance = context.register(context.stream('1 0 0 rg 0 0 50 30 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 30], Resources: {},
  }));
  page.node.set(PDFName.of('Annots'), context.obj([
    context.register(context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [20, 20, 70, 50], F: 20, AP: { N: appearance }, OC: group })),
  ]));
  return doc.save();
}

interface Rendered {
  asked: number[];
  list: { fnArray: ArrayLike<number>; argsArray: ArrayLike<ArrayLike<unknown> | null | undefined> } | null;
  stampId: string;
}

async function render(pdf: PDFDocumentProxy): Promise<Rendered> {
  const page = await pdf.getPage(1);
  const [stamp] = (await page.getAnnotations()) as Array<{ id: string }>;
  const viewport = page.getViewport({ scale: 1 });
  const factory = (pdf as unknown as { canvasFactory: { create(w: number, h: number): { canvas: unknown; context: unknown } } }).canvasFactory;
  const target = factory.create(viewport.width, viewport.height);
  const asked: number[] = [];
  const task = page.render({
    canvas: target.canvas as HTMLCanvasElement,
    canvasContext: target.context as CanvasRenderingContext2D,
    viewport,
    operationsFilter: (index: number) => {
      asked.push(index);
      return true;
    },
  });
  const list = operatorListOf(task);
  await task.promise;
  return { asked, list, stampId: stamp.id };
}

describe('the op codes lib/upright-stamps.ts holds as literals', () => {
  it('are those of the installed pdf.js', () => {
    expect({
      beginAnnotation: BEGIN_ANNOTATION,
      endAnnotation: END_ANNOTATION,
      beginMarkedContent: BEGIN_MARKED_CONTENT,
      beginMarkedContentProps: BEGIN_MARKED_CONTENT_PROPS,
      endMarkedContent: END_MARKED_CONTENT,
    }, `${UPGRADE} pdf.js OPS has other codes: change the literals.`).toEqual({
      beginAnnotation: pdfjs.OPS.beginAnnotation,
      endAnnotation: pdfjs.OPS.endAnnotation,
      beginMarkedContent: pdfjs.OPS.beginMarkedContent,
      beginMarkedContentProps: pdfjs.OPS.beginMarkedContentProps,
      endMarkedContent: pdfjs.OPS.endMarkedContent,
    });
  });
});

describe.skipIf(!HAS_CANVAS)('what the operation filter of a page render needs from pdf.js', () => {
  it('page.render asks `operationsFilter` about operations', async () => {
    const pdf = await loadPdf(await fixture());
    try {
      const { asked } = await render(pdf);
      expect(asked.length, `${UPGRADE} page.render no longer calls the \`operationsFilter\` render parameter.`).toBeGreaterThan(0);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('the render task holds the operator list it runs', async () => {
    const pdf = await loadPdf(await fixture());
    try {
      const { list } = await render(pdf);
      expect(
        list !== null,
        `${UPGRADE} The task of page.render no longer has \`_internalRenderTask.operatorList\` with \`fnArray\` and \`argsArray\`.`,
      ).toBe(true);
      expect(
        typeof list!.fnArray.length === 'number' && list!.fnArray.length === list!.argsArray.length && list!.fnArray.length > 0,
        `${UPGRADE} \`fnArray\` and \`argsArray\` of the task's operator list are not two lists of one length.`,
      ).toBe(true);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('the filter is asked once per operation of that list, by its index', async () => {
    const pdf = await loadPdf(await fixture());
    try {
      const { asked, list } = await render(pdf);
      expect(list, `${UPGRADE} No operator list on the task.`).not.toBeNull();
      expect(
        asked,
        `${UPGRADE} The indexes \`operationsFilter\` is asked are not the indexes of the task's operator list.`,
      ).toEqual(Array.from({ length: list!.fnArray.length }, (_, index) => index));
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it('an annotation is beginAnnotation with its id first, to endAnnotation, inside the marked-content pair of its /OC', async () => {
    const pdf = await loadPdf(await fixture());
    try {
      const { list, stampId } = await render(pdf);
      expect(list, `${UPGRADE} No operator list on the task.`).not.toBeNull();
      const codes = Array.from({ length: list!.fnArray.length }, (_, index) => list!.fnArray[index]);
      const begin = codes.indexOf(pdfjs.OPS.beginAnnotation);
      const end = codes.indexOf(pdfjs.OPS.endAnnotation);
      expect(begin >= 0 && end > begin, `${UPGRADE} The list holds no beginAnnotation to endAnnotation span.`).toBe(true);
      expect(
        list!.argsArray[begin]?.[0],
        `${UPGRADE} The first argument of beginAnnotation is not the id \`getAnnotations\` gives the annotation.`,
      ).toBe(stampId);
      const before = codes.lastIndexOf(pdfjs.OPS.beginMarkedContentProps, begin);
      const after = codes.indexOf(pdfjs.OPS.endMarkedContent, end);
      expect(
        before >= 0 && after > end && list!.argsArray[before]?.[0] === 'OC',
        `${UPGRADE} The /OC of an annotation is no longer a beginMarkedContentProps("OC") before beginAnnotation and an endMarkedContent after endAnnotation.`,
      ).toBe(true);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
});
