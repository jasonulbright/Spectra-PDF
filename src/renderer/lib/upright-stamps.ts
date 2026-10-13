// A page render that draws stamps with the NoRotate flag upright.
//
// ISO 32000-2 12.5.3 (Table 167 and the text after it): the appearance of a
// NoRotate annotation is not turned with the page, and the upper-left corner
// of its rectangle in default user space stays at its place on the page.
//
// pdf.js maps every appearance onto /Rect in page space, so a page render
// turns such a stamp with the page.
//
// Which stamps stand upright comes from the record of the workspace index
// (`upright-record.ts`). A render reads no annotations. A page the record
// lists no stamp for, and a page with no record, gets `page.render(params)`
// in the turn of the call: the task pdf.js returns is the task the caller
// gets.
//
// The exception is a page with no record in a document that replaced one
// with an upright stamp on that page (`uprightCarried`). A plain render of it
// would show a stamp turned with the page, and the pixels of the replaced
// document show other bytes. Its render reads the annotations of the page
// from the document first, once per document object and page, and then
// renders: the first paint shows the new bytes with the stamps they hold
// upright. The read settles when the document is destroyed, and the render
// then rejects as cancelled.
//
// A page with an upright stamp gets two renders of one operator list, each
// with an operation filter, on the caller's canvas:
// 1. Only the operations of the upright stamps and every marked-content
//    operation of the list, with an annotation canvas map: pdf.js draws each
//    stamp on a canvas of its own, in the page's frame before /Rotate, top
//    row first. pdf.js puts an annotation with /OC between a marked-content
//    pair outside its begin and end, and a marked-content operation changes
//    the visibility state only. With all of them the state at each stamp is
//    the state of a plain render, so a stamp of a layer that is off gets an
//    empty canvas.
// 2. Every other operation, with no map. Every other annotation, also one
//    pdf.js would give a canvas of its own (a button, a read-only text field,
//    a NoRotate annotation of another kind), is drawn by the page render on
//    the page's pixel grid, in /Annots order, with its blend mode. This
//    render paints the whole canvas, so nothing of the first one stays.
// The stamp canvases are then drawn upright from the corner. They lie above
// the page and every other annotation, in /Annots order among themselves.
//
// The filters and the map are read on the main thread only: the operator list
// and its cache key are those of a plain render. Both renders get the
// caller's parameters, so one optional-content configuration and one intent
// decide the visibility in both. A render with a print intent gives no
// annotation a canvas of its own: its second render is the caller's own.
import type { PDFPageProxy } from 'pdfjs-dist';
import { readUprightStamps, uprightCarried, uprightDocumentGone, uprightRenderPlan, uprightStampsOn } from './upright-record';
import type { PdfRect, UprightStamp } from './upright-record';

export { uprightStampsAmong } from './upright-record';
export type { PdfRect, UprightStamp } from './upright-record';

/** [a b c d e f]: a point (x, y) lands at (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

type RenderParameters = Parameters<PDFPageProxy['render']>[0];

/** A render in flight. On a page with an upright stamp the promise gives how
 *  many stamps were drawn upright; on every other page the task is the one
 *  pdf.js returned. */
export interface PageRenderTask {
  promise: Promise<unknown>;
  cancel: () => void;
  /** The stamps the render draws upright. Absent on a plain render, and
   *  while a render that reads the page first has not read it. */
  readonly upright?: readonly UprightStamp[];
}

/** The part of a page a render needs. A page with no `getAnnotations` is
 *  never read. */
export interface UprightPage {
  readonly pageNumber: number;
  render: (params: RenderParameters) => { promise: Promise<unknown>; cancel: () => void };
  getAnnotations?: () => Promise<unknown[]>;
}

/** How many stamps a settled render drew upright. */
export function uprightDrawn(settled: unknown): number {
  return typeof settled === 'number' ? settled : 0;
}

/** `first`, then `then`. */
export function composeMatrix(then: readonly number[], first: readonly number[]): Matrix {
  return [
    then[0] * first[0] + then[2] * first[1],
    then[1] * first[0] + then[3] * first[1],
    then[0] * first[2] + then[2] * first[3],
    then[1] * first[2] + then[3] * first[3],
    then[0] * first[4] + then[2] * first[5] + then[4],
    then[1] * first[4] + then[3] * first[5] + then[5],
  ];
}

/** Default user space to canvas pixels for a render with `viewportTransform`
 *  and the render's own `transform`. */
export function renderMatrix(viewportTransform: readonly number[], transform?: readonly number[] | null): Matrix {
  return transform ? composeMatrix(transform, viewportTransform) : [...viewportTransform.slice(0, 6)] as Matrix;
}

/** Canvas pixels per unit of default user space, along x and along y. */
export function matrixScale(matrix: readonly number[]): [number, number] {
  return [Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3])];
}

/** The unit square (u to the right, v down) onto the upright box of `rect`:
 *  its top-left corner at the place the page gives the upper-left corner of
 *  the rectangle, its size that of the rectangle. `laterTurn` is a clockwise
 *  quarter turn the whole canvas gets after the render (a CSS rotation); the
 *  box is turned back by it about the corner, so it stands upright after
 *  that turn. */
export function uprightStampMatrix(rect: PdfRect, page: readonly number[], laterTurn = 0): Matrix {
  const [x0, y0, x1, y1] = rect;
  const [scaleX, scaleY] = matrixScale(page);
  const width = (x1 - x0) * scaleX;
  const height = (y1 - y0) * scaleY;
  const turn = ((Math.round(laterTurn / 90) % 4) + 4) % 4;
  const [cos, sin] = turn === 1 ? [0, -1] : turn === 2 ? [-1, 0] : turn === 3 ? [0, 1] : [1, 0];
  return [
    width * cos,
    width * sin,
    -height * sin,
    height * cos,
    page[0] * x0 + page[2] * y1 + page[4],
    page[1] * x0 + page[3] * y1 + page[5],
  ];
}

interface OwnCanvas {
  width: number;
  height: number;
}

type DrawContext = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'setTransform' | 'drawImage'>;

/** Draws the part of `canvas` that holds `rect` through `matrix`. The canvas
 *  is as large as the rectangle rounded up to whole pixels. */
function drawOwnCanvas(context: DrawContext, canvas: OwnCanvas, rect: PdfRect, page: readonly number[], matrix: Matrix): void {
  if (!(canvas.width > 0) || !(canvas.height > 0)) return;
  const [scaleX, scaleY] = matrixScale(page);
  const width = Math.min(canvas.width, (rect[2] - rect[0]) * scaleX);
  const height = Math.min(canvas.height, (rect[3] - rect[1]) * scaleY);
  if (!(width > 0) || !(height > 0)) return;
  context.save();
  context.setTransform(...matrix);
  context.drawImage(canvas as unknown as CanvasImageSource, 0, 0, width, height, 0, 0, 1, 1);
  context.restore();
}

class RenderCancelled extends Error {
  constructor() {
    super('page render: cancelled before a render of it started');
    this.name = 'RenderingCancelledException';
  }
}

/** pdf.js `OPS.beginAnnotation` and `OPS.endAnnotation`. The operations of an
 *  annotation run from one to the other, and its id is the first argument of
 *  the first. */
export const BEGIN_ANNOTATION = 80;
export const END_ANNOTATION = 81;
/** pdf.js `OPS.beginMarkedContent`, `OPS.beginMarkedContentProps` and
 *  `OPS.endMarkedContent`: the operations that change whether content is
 *  visible, and draw nothing. */
export const BEGIN_MARKED_CONTENT = 69;
export const BEGIN_MARKED_CONTENT_PROPS = 70;
export const END_MARKED_CONTENT = 71;

interface OperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<ArrayLike<unknown> | null | undefined>;
}

/** The operator list a render task runs. pdf.js fills it while the render
 *  runs; an entry is there before the filter is asked about its index. */
export function operatorListOf(task: unknown): OperatorList | null {
  const list = (task as { _internalRenderTask?: { operatorList?: Partial<OperatorList> } } | null)?._internalRenderTask?.operatorList;
  return list && list.fnArray && list.argsArray ? (list as OperatorList) : null;
}

/** Which operations of a list belong to the annotations of `ids`. The list
 *  is read up to the index asked for, so the answer for an index does not
 *  depend on the order of the questions. With no list no operation does. */
export function annotationOperations(ids: ReadonlySet<string>): {
  read: (list: OperatorList | null) => void;
  holds: (index: number) => boolean;
  /** Whether the operation is a marked-content operation. */
  marks: (index: number) => boolean;
} {
  let list: OperatorList | null = null;
  let scanned = 0;
  let open = -1;
  const closed: number[] = [];
  return {
    read: (given) => {
      list = given;
    },
    holds: (index) => {
      if (!list) return false;
      for (; scanned <= index && scanned < list.fnArray.length; scanned++) {
        const fn = list.fnArray[scanned];
        if (fn === BEGIN_ANNOTATION) {
          const id = list.argsArray[scanned]?.[0];
          open = typeof id === 'string' && ids.has(id) ? scanned : -1;
        } else if (fn === END_ANNOTATION && open >= 0) {
          closed.push(open, scanned);
          open = -1;
        }
      }
      if (open >= 0 && index >= open) return true;
      for (let k = 0; k < closed.length; k += 2) if (index >= closed[k] && index <= closed[k + 1]) return true;
      return false;
    },
    marks: (index) => {
      const fn = list?.fnArray[index];
      return fn === BEGIN_MARKED_CONTENT || fn === BEGIN_MARKED_CONTENT_PROPS || fn === END_MARKED_CONTENT;
    },
  };
}

function renderWithStamps(
  page: UprightPage,
  params: RenderParameters,
  stamps: readonly UprightStamp[],
  context: DrawContext,
  laterTurn: number,
): PageRenderTask {
  let cancelled = false;
  let inner: { cancel: () => void } | null = null;
  const ids = new Set(stamps.map((stamp) => stamp.id));
  const promise = (async (): Promise<number> => {
    const canvases = new Map<string, unknown>();
    const own = annotationOperations(ids);
    const first = page.render({
      ...params,
      annotationCanvasMap: canvases as unknown as Map<string, HTMLCanvasElement>,
      operationsFilter: (index) => own.holds(index) || own.marks(index),
    });
    inner = first;
    own.read(operatorListOf(first));
    await first.promise;
    if (cancelled) throw new RenderCancelled();
    const others = annotationOperations(ids);
    // With no stamp canvas the page draws every annotation itself.
    const second = page.render(canvases.size === 0 ? params : { ...params, operationsFilter: (index) => !others.holds(index) });
    inner = second;
    others.read(operatorListOf(second));
    await second.promise;
    const rects = new Map(stamps.map((stamp) => [stamp.id, stamp.rect]));
    const matrix = renderMatrix(params.viewport.transform, params.transform as number[] | undefined);
    let drawn = 0;
    for (const [id, held] of canvases) {
      const rect = rects.get(id);
      for (const canvas of (Array.isArray(held) ? held : [held]) as OwnCanvas[]) {
        if (rect) {
          drawOwnCanvas(context, canvas, rect, matrix, uprightStampMatrix(rect, matrix, laterTurn));
          if (canvas.width > 0 && canvas.height > 0) drawn++;
        }
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return drawn;
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      inner?.cancel();
    },
    upright: stamps,
  };
}

function renderKnown(
  page: UprightPage,
  params: RenderParameters,
  stamps: readonly UprightStamp[] | undefined,
  laterTurn: number,
): PageRenderTask {
  if (stamps === undefined || stamps.length === 0) return page.render(params);
  const context = (params.canvasContext ?? params.canvas?.getContext('2d')) as DrawContext | null | undefined;
  return context ? renderWithStamps(page, params, stamps, context, laterTurn) : page.render(params);
}

type ReadablePage = UprightPage & { getAnnotations: () => Promise<unknown[]> };

function renderAfterRead(pdf: object, page: ReadablePage, params: RenderParameters, laterTurn: number): PageRenderTask {
  let cancelled = false;
  let inner: PageRenderTask | null = null;
  const promise = readUprightStamps(pdf, page).then(() => {
    // A render that starts on a destroyed document may never settle.
    if (cancelled || uprightDocumentGone(pdf, page)) throw new RenderCancelled();
    inner = renderKnown(page, params, uprightStampsOn(pdf, page.pageNumber - 1), laterTurn);
    return inner.promise;
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      inner?.cancel();
    },
    get upright() {
      return inner?.upright;
    },
  };
}

/** `page.render(params)`, with every upright stamp of the page drawn
 *  upright. `laterTurn` is the clockwise quarter turn the caller gives the
 *  canvas after the render. A page the record lists no stamp for, and a page
 *  with no record, gets `page.render(params)` in this turn and the task of
 *  that render is returned as it is. A page with no record in a document that
 *  replaced one with an upright stamp on it is read from the document first
 *  (`uprightRenderPlan`). */
export function renderPageUpright(pdf: object, page: UprightPage, params: RenderParameters, laterTurn = 0): PageRenderTask {
  const pageIndex = page.pageNumber - 1;
  const stamps = uprightStampsOn(pdf, pageIndex);
  const plan = uprightRenderPlan(stamps, stamps === undefined && uprightCarried(pdf, pageIndex));
  if (plan === 'read' && page.getAnnotations) return renderAfterRead(pdf, page as ReadablePage, params, laterTurn);
  return renderKnown(page, params, stamps, laterTurn);
}

/** A render whose result is used once and never painted again. A page with
 *  no record is read once first (`readUprightStamps`); a page with a record
 *  starts its render in this turn. Gives how many stamps were drawn upright.
 *  A document that is destroyed during the read rejects as a cancelled
 *  render: a render that starts on a destroyed document may never settle. */
export function renderPageUprightOnce(
  pdf: object,
  page: UprightPage & { getAnnotations: () => Promise<unknown[]> },
  params: RenderParameters,
  laterTurn = 0,
): Promise<number> {
  if (uprightStampsOn(pdf, page.pageNumber - 1) !== undefined) {
    return renderPageUpright(pdf, page, params, laterTurn).promise.then(uprightDrawn);
  }
  return readUprightStamps(pdf, page).then(() => {
    if (uprightDocumentGone(pdf, page)) throw new RenderCancelled();
    return renderPageUpright(pdf, page, params, laterTurn).promise;
  }).then(uprightDrawn);
}
