// The appearance of an annotation the commit keeps as written (a stamp with
// `PageAnnotation.carriedAppearance`, any other import with
// `PageAnnotation.originalAppearance`), as a bitmap the canvas draws at the
// annotation's edited place.
//
// pdf.js has no render of one annotation. For stamps, a display render in
// editing mode with an annotation canvas map draws every stamp of the page
// on a canvas of its own; the page content goes to a main canvas of one pixel
// and is discarded. Each stamp canvas covers the annotation rectangle in the
// page's own frame, before /Rotate, top row first.
//
// An annotation of another kind gets no canvas of its own from pdf.js. Its
// bitmap is a display render of the page with an operation filter that keeps
// the operations of that annotation and the marked-content operations (which
// only change what is visible), on a canvas as large as its rectangle, with a
// viewport of no rotation moved so the rectangle's upper-left corner is the
// canvas origin. The bitmap covers the same area in the same frame as a stamp
// canvas.
//
// The editing-mode render sets a per-annotation flag in the worker that an
// ordinary render of the same page object clears, and its operator list stays
// with the page object. The raster therefore renders a document of its own
// over the same bytes: the shown document never sees an editing-mode render,
// the copy's page lists are let go page by page, and the copy is destroyed
// with its last holder. A copy is destroyed only when no render uses it: a
// destroy under a render in flight aborts that render.
//
// A viewer maps the appearance box onto /Rect (ISO 32000-2 12.5.5), so a
// moved or resized rectangle shows the same bitmap stretched onto the new
// rectangle and turned with the page. A stamp with the NoRotate flag keeps
// its orientation on the screen when the page turns (12.5.3, Table 167).
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { annotationOperations, operatorListOf } from './upright-stamps';

export type QuarterTurn = 0 | 90 | 180 | 270;

/** A canvas as the document's own factory makes it. */
export interface RasterCanvas {
  width: number;
  height: number;
}

export interface AppearanceRaster {
  canvas: RasterCanvas;
  /** The source page's /Rotate. */
  pageRotate: QuarterTurn;
  /** The annotation's rectangle in the file, in default user space. */
  rect: [number, number, number, number];
  /** The page's view box: its crop box as pdf.js gives it. */
  view: [number, number, number, number];
}

/** The longest side of a stamp canvas, in pixels. */
export const APPEARANCE_RASTER_MAX_SIDE = 4096;
/** The highest tier: pixels per point. */
export const APPEARANCE_RASTER_MAX_TIER = 32;
/** How many pages of one document keep their bitmaps. A page with a live
 *  holder is kept past this count. */
export const APPEARANCE_RASTER_PAGES = 8;
/** How many more renders a stamp gets when the page lists it and a render
 *  gives it no canvas. */
export const APPEARANCE_RASTER_MISS_RETRIES = 2;

export function quarterTurn(...angles: number[]): QuarterTurn {
  const sum = angles.reduce((total, angle) => total + (Number.isFinite(angle) ? Math.round(angle / 90) * 90 : 0), 0);
  return ((((sum % 360) + 360) % 360) as QuarterTurn);
}

/** How far the bitmap turns, clockwise, inside the annotation's box in the
 *  stored frame: the page's /Rotate plus the pending page rotation, and
 *  nothing for a NoRotate stamp. The view rotation is applied by the wrapper
 *  that turns the box itself. */
export function appearanceRasterTurn(pageRotate: number, pendingRotation: number, noRotate = false): QuarterTurn {
  return noRotate ? 0 : quarterTurn(pageRotate, pendingRotation);
}

/** The canvas transform [a b c d e f] that maps the bitmap's unit square
 *  (u to the right, v down) onto a box of `width` by `height` pixels after a
 *  clockwise `turn`. A point (u, v) lands at (a·u + c·v + e, b·u + d·v + f). */
export function appearanceRasterMatrix(turn: QuarterTurn, width: number, height: number): [number, number, number, number, number, number] {
  switch (turn) {
    case 90:
      return [0, height, -width, 0, width, 0];
    case 180:
      return [-width, 0, 0, -height, width, height];
    case 270:
      return [0, -height, width, 0, 0, height];
    default:
      return [width, 0, 0, height, 0, 0];
  }
}

/** The resolution tier for a stamp shown at `pixelsPerPoint` device pixels per
 *  point: the next power of two, so a zoom step inside one tier reuses the
 *  bitmap and a step past it rasters again at twice the resolution. */
export function appearanceRasterTier(pixelsPerPoint: number): number {
  const wanted = Number.isFinite(pixelsPerPoint) && pixelsPerPoint > 1 ? pixelsPerPoint : 1;
  return Math.min(APPEARANCE_RASTER_MAX_TIER, 2 ** Math.ceil(Math.log2(wanted)));
}

/** The pixels per point a stamp needs on the screen: its box in device pixels
 *  over its rectangle in points, on the side that asks for more. A stamp drawn
 *  smaller than its rectangle asks for less than the page zoom, an enlarged
 *  one for more. A side that swapped with a quarter turn pairs by length.
 *  `fallback` answers when a size is unknown. */
export function appearanceRasterDemand(
  box: { width: number; height: number },
  rectangle: { width: number; height: number } | null,
  fallback: number,
): number {
  if (!rectangle) return fallback;
  const [boxShort, boxLong] = [Math.abs(box.width), Math.abs(box.height)].sort((a, b) => a - b);
  const [short, long] = [Math.abs(rectangle.width), Math.abs(rectangle.height)].sort((a, b) => a - b);
  const demand = Math.max(long > 0 ? boxLong / long : 0, short > 0 ? boxShort / short : 0);
  return Number.isFinite(demand) && demand > 0 ? demand : fallback;
}

/** The render scale of a tier: the tier itself, lowered so the longest stamp
 *  side of the page stays inside `APPEARANCE_RASTER_MAX_SIDE` pixels. */
export function appearanceRasterScale(tier: number, longestSidePoints: number): number {
  const side = Number.isFinite(longestSidePoints) && longestSidePoints > 0 ? longestSidePoints : 1;
  return Math.min(tier, APPEARANCE_RASTER_MAX_SIDE / side);
}

/** One page's render at one tier. */
export function appearanceRasterKey(pageNumber: number, tier: number): string {
  return `${pageNumber}@${tier}`;
}

/** The document a stamp is shown from. */
export interface AppearanceRasterSource {
  /** The shown document. It is never rendered here. */
  pdf: PDFDocumentProxy;
  /** The content key of its bytes; null for a document the proxy cache did
   *  not load, whose bitmaps then live as long as the document object. */
  contentKey: string | null;
  /** Opens another document over the same bytes that nothing else renders. */
  open: () => Promise<PDFDocumentProxy>;
}

/** One holder's claim on one stamp's bitmap. */
export interface AppearanceRasterHold {
  /** The bitmap, or null when the stamp has none. */
  raster: Promise<AppearanceRaster | null>;
  /** The holder leaves. The last holder of a render in flight cancels it, and
   *  the last holder of a document closes its copy. */
  release: () => void;
}

interface CancellableTask {
  promise: Promise<unknown>;
  cancel: () => void;
}

interface Batch {
  pageNumber: number;
  tier: number;
  works: Set<Work>;
  abandoned: boolean;
  task: CancellableTask | null;
}

/** One stamp at one tier. */
interface Work {
  id: string;
  tier: number;
  result: Promise<AppearanceRaster | null>;
  settle: (raster: AppearanceRaster | null) => void;
  settled: boolean;
  holds: number;
  batch: Batch | null;
}

interface Member {
  open: () => Promise<PDFDocumentProxy>;
}

interface Store {
  /** Cached documents over these bytes. */
  documents: number;
  /** Page number → stamp id → its bitmap; least recently asked page first. */
  pages: Map<number, Map<string, Work>>;
  /** Renders that have not started, by page and tier. */
  batches: Map<string, Batch>;
  /** Live holders, newest last. */
  members: Set<Member>;
  /** The copy new renders take. */
  copy: Copy | null;
}

/** One opened copy. A retired copy takes no new render and is destroyed when
 *  the last render that took it has finished. */
interface Copy {
  document: Promise<PDFDocumentProxy | null>;
  users: number;
  retired: boolean;
}

const newStore = (): Store => ({ documents: 0, pages: new Map(), batches: new Map(), members: new Set(), copy: null });

const cache = new Map<string, Store>();
const unkeyed = new WeakMap<PDFDocumentProxy, Store>();
let renders = 0;

function destroyCopy(copy: Copy): void {
  void copy.document.then((doc) => doc?.loadingTask.destroy()).catch(() => {});
}

/** `copy` takes no new render. It is destroyed now when no render uses it,
 *  and otherwise when the last one leaves it. */
function retireCopy(store: Store, copy: Copy | null): void {
  if (!copy || copy.retired) return;
  copy.retired = true;
  if (store.copy === copy) store.copy = null;
  if (copy.users === 0) destroyCopy(copy);
}

function leaveCopy(copy: Copy): void {
  if (--copy.users === 0 && copy.retired) destroyCopy(copy);
}

/** A document over the bytes `contentKey` names is live. */
export function retainAppearanceRasters(contentKey: string): void {
  let store = cache.get(contentKey);
  if (!store) {
    store = newStore();
    cache.set(contentKey, store);
  }
  store.documents++;
}

/** A document over the bytes `contentKey` names was evicted. The last one
 *  takes the bitmaps of those bytes, the renders in flight and the copy with
 *  it. */
export function releaseAppearanceRasters(contentKey: string): void {
  const store = cache.get(contentKey);
  if (!store) return;
  if (--store.documents > 0) return;
  cache.delete(contentKey);
  store.pages.clear();
  store.batches.clear();
  retireCopy(store, store.copy);
}

/** How many page renders have started since the module loaded. */
export function appearanceRasterRenderCount(): number {
  return renders;
}

/** How many pages hold bitmaps for the bytes `contentKey` names. */
export function appearanceRasterPageCount(contentKey: string): number {
  return cache.get(contentKey)?.pages.size ?? 0;
}

interface CanvasFactory {
  create(width: number, height: number): { canvas: RasterCanvas; context: unknown };
  destroy(entry: { canvas: RasterCanvas; context: unknown }): void;
}

/** Whether a rejection is a render that was cancelled or whose document was
 *  destroyed under it, by the class name pdf.js gives it. */
export function isAppearanceRenderCancellation(error: unknown): boolean {
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

class Abandoned extends Error {
  constructor() {
    super('appearance raster: no holder is left');
    this.name = 'RenderingCancelledException';
  }
}

/** Takes the copy the store renders, opened through the newest holder whose
 *  document still gives its bytes. The caller leaves it with `leaveCopy`. A
 *  copy no holder could open is retired at once, so the next render opens
 *  again through the holders of that time. */
function takeCopy(store: Store): Copy {
  let copy = store.copy;
  if (!copy) {
    const made: Copy = { document: Promise.resolve(null), users: 0, retired: false };
    made.document = (async () => {
      for (const member of [...store.members].reverse()) {
        try {
          return await member.open();
        } catch {
          // The holder's document is gone; an older holder's may not be.
        }
      }
      retireCopy(store, made);
      return null;
    })();
    store.copy = copy = made;
  }
  copy.users++;
  return copy;
}

interface PageRender {
  /** The ids the page lists as annotations a render gives a bitmap: stamps
   *  with a rectangle, and annotations of another kind with a rectangle and
   *  an appearance. */
  listed: Set<string>;
  rasters: Map<string, AppearanceRaster>;
}

type Rect = [number, number, number, number];
const rectOf = (rect: number[]): Rect =>
  [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];

interface RasterViewport {
  convertToViewportPoint: (x: number, y: number) => number[];
}

/** One annotation that is no stamp, on a canvas as large as its rectangle:
 *  a display render of the page that runs the operations of that annotation
 *  and no other drawing. Null when the page's operator list holds no
 *  operation of it. */
async function renderOne(
  pdf: PDFDocumentProxy, page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>, batch: Batch, id: string, rect: Rect,
): Promise<RasterCanvas | null> {
  const scale = appearanceRasterScale(batch.tier, Math.max(rect[2] - rect[0], rect[3] - rect[1]));
  const width = Math.max(1, Math.ceil((rect[2] - rect[0]) * scale));
  const height = Math.max(1, Math.ceil((rect[3] - rect[1]) * scale));
  // The upper-left corner of the rectangle, in the frame with no rotation.
  const [left, top] = (page.getViewport({ scale, rotation: 0 }) as unknown as RasterViewport).convertToViewportPoint(rect[0], rect[3]);
  const factory = (pdf as unknown as { canvasFactory: CanvasFactory }).canvasFactory;
  const own = factory.create(width, height);
  const operations = annotationOperations(new Set([id]));
  let drawn = false;
  renders++;
  try {
    const task = page.render({
      canvas: own.canvas as unknown as HTMLCanvasElement,
      canvasContext: own.context as CanvasRenderingContext2D,
      viewport: page.getViewport({ scale, rotation: 0, offsetX: -left, offsetY: -top }),
      operationsFilter: (index: number) => {
        const held = operations.holds(index);
        if (held) drawn = true;
        return held || operations.marks(index);
      },
      background: 'rgba(0,0,0,0)',
    });
    batch.task = task;
    operations.read(operatorListOf(task));
    await task.promise;
  } catch (error) {
    own.canvas.width = 0;
    own.canvas.height = 0;
    throw error;
  } finally {
    batch.task = null;
  }
  if (drawn) return own.canvas;
  own.canvas.width = 0;
  own.canvas.height = 0;
  return null;
}

async function renderPage(copy: Copy, batch: Batch): Promise<PageRender> {
  const pdf = await copy.document;
  if (!pdf) throw new Error('appearance raster: no document gives its bytes');
  const page = await pdf.getPage(batch.pageNumber);
  const annotations = (await page.getAnnotations()) as { id?: string; subtype?: string; rect?: number[] | null; hasAppearance?: boolean }[];
  const listed = new Set<string>();
  const rects = new Map<string, Rect>();
  const others = new Set<string>();
  let longest = 0;
  for (const annotation of annotations) {
    if (!Array.isArray(annotation.rect) || annotation.rect.length < 4) continue;
    if (annotation.subtype !== 'Stamp') {
      if (!annotation.id || annotation.hasAppearance !== true) continue;
      const rect = rectOf(annotation.rect);
      if (!(rect[2] - rect[0] > 0) || !(rect[3] - rect[1] > 0)) continue;
      listed.add(annotation.id);
      others.add(annotation.id);
      rects.set(annotation.id, rect);
      continue;
    }
    if (annotation.id) {
      listed.add(annotation.id);
      rects.set(annotation.id, rectOf(annotation.rect));
    }
    longest = Math.max(longest, Math.abs(annotation.rect[2] - annotation.rect[0]), Math.abs(annotation.rect[3] - annotation.rect[1]));
  }
  const rasters = new Map<string, AppearanceRaster>();
  const view = (Array.isArray((page as unknown as { view?: number[] }).view) ? (page as unknown as { view: number[] }).view.slice(0, 4) : [0, 0, 0, 0]) as Rect;
  const turned = quarterTurn(page.rotate);
  // Each annotation that is no stamp gets a render of its own.
  for (const work of [...batch.works]) {
    const rect = others.has(work.id) ? rects.get(work.id) : undefined;
    if (!rect) continue;
    if (batch.abandoned) throw new Abandoned();
    const canvas = await renderOne(pdf, page, batch, work.id, rect);
    if (canvas) rasters.set(work.id, { canvas, pageRotate: turned, rect, view });
  }
  // The stamp render runs for a batch that asks for anything else.
  if (longest <= 0 || ![...batch.works].some((work) => !others.has(work.id))) return { listed, rasters };
  if (batch.abandoned) throw new Abandoned();
  renders++;
  const factory = (pdf as unknown as { canvasFactory: CanvasFactory }).canvasFactory;
  const main = factory.create(1, 1);
  const canvases = new Map<string, RasterCanvas>();
  try {
    const task = page.render({
      canvas: main.canvas as unknown as HTMLCanvasElement,
      canvasContext: main.context as CanvasRenderingContext2D,
      viewport: page.getViewport({ scale: appearanceRasterScale(batch.tier, longest) }),
      annotationCanvasMap: canvases as unknown as Map<string, HTMLCanvasElement>,
      isEditing: true,
      background: 'rgba(0,0,0,0)',
    });
    batch.task = task;
    await task.promise;
  } finally {
    batch.task = null;
    factory.destroy(main);
  }
  const wanted = new Set([...batch.works].map((work) => work.id));
  for (const [id, canvas] of canvases) {
    const rect = rects.get(id);
    if (wanted.has(id) && listed.has(id) && !others.has(id) && rect && canvas.width > 0 && canvas.height > 0) {
      rasters.set(id, { canvas, pageRotate: turned, rect, view });
    } else {
      // A stamp nobody asked for gives its pixels back at once.
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  return { listed, rasters };
}

function forget(store: Store, pageNumber: number, work: Work): void {
  const stamps = store.pages.get(pageNumber);
  if (stamps?.get(work.id) === work) stamps.delete(work.id);
  if (stamps?.size === 0) store.pages.delete(pageNumber);
}

/** Lets the copy's page go: its operator lists and decoded objects. */
async function cleanPage(copy: Copy, pageNumber: number): Promise<void> {
  try {
    const pdf = await copy.document;
    (await pdf?.getPage(pageNumber))?.cleanup();
  } catch {
    // The copy is gone, and its pages with it.
  }
}

async function run(store: Store, batch: Batch): Promise<void> {
  const drop = (): void => {
    for (const work of batch.works) {
      forget(store, batch.pageNumber, work);
      work.settle(null);
    }
    batch.works.clear();
  };
  for (let attempt = 0; ; attempt++) {
    if (batch.abandoned || batch.works.size === 0) return drop();
    const copy = takeCopy(store);
    try {
      let rendered: PageRender;
      try {
        rendered = await renderPage(copy, batch);
      } catch (error) {
        // A cancelled render says nothing about the bytes. With a holder left
        // it runs again through a copy the newest holder opens; a failure, and
        // a cancellation past the bound, leave no entry. The cancelled copy is
        // retired, never destroyed here: another render may still use it.
        if (!isAppearanceRenderCancellation(error) || batch.abandoned || attempt >= APPEARANCE_RASTER_MISS_RETRIES) return drop();
        retireCopy(store, copy);
        continue;
      }
      for (const work of [...batch.works]) {
        const raster = rendered.rasters.get(work.id);
        if (raster) {
          batch.works.delete(work);
          work.batch = null;
          work.settle(raster);
        } else if (!rendered.listed.has(work.id)) {
          // The page lists no such stamp: no render gives it a canvas.
          batch.works.delete(work);
          forget(store, batch.pageNumber, work);
          work.settle(null);
        }
      }
      if (batch.works.size === 0) return;
      // A listed stamp without a canvas is never kept as a result.
      if (attempt >= APPEARANCE_RASTER_MISS_RETRIES) return drop();
      await cleanPage(copy, batch.pageNumber);
    } finally {
      leaveCopy(copy);
    }
  }
}

function trim(store: Store): void {
  if (store.pages.size <= APPEARANCE_RASTER_PAGES) return;
  for (const [pageNumber, stamps] of [...store.pages]) {
    if (store.pages.size <= APPEARANCE_RASTER_PAGES) return;
    if ([...stamps.values()].some((work) => work.holds > 0)) continue;
    store.pages.delete(pageNumber);
    if (store.copy) void cleanPage(store.copy, pageNumber);
  }
}

function storeOf(source: AppearanceRasterSource): Store {
  const keyed = source.contentKey === null ? undefined : cache.get(source.contentKey);
  if (keyed) return keyed;
  let store = unkeyed.get(source.pdf);
  if (!store) {
    store = newStore();
    unkeyed.set(source.pdf, store);
  }
  return store;
}

/** Holds the bitmap of one stamp of one page for a view that needs
 *  `pixelsPerPoint` device pixels per point. Stamps asked for in one turn
 *  share one render. A stamp is kept at one tier, the tier asked for last; a
 *  bitmap of another tier stays with the holders that have it. A stamp with
 *  no bitmap is not kept, so the next holder renders again. */
export function holdAppearanceRaster(
  source: AppearanceRasterSource,
  pageNumber: number,
  annotationId: string,
  pixelsPerPoint: number,
): AppearanceRasterHold {
  const store = storeOf(source);
  const tier = appearanceRasterTier(pixelsPerPoint);
  const member: Member = { open: source.open };
  store.members.add(member);

  let stamps = store.pages.get(pageNumber);
  if (stamps) store.pages.delete(pageNumber);
  else stamps = new Map();
  store.pages.set(pageNumber, stamps);

  let work = stamps.get(annotationId);
  if (!work || work.tier !== tier) {
    const key = appearanceRasterKey(pageNumber, tier);
    let batch = store.batches.get(key);
    if (!batch) {
      const fresh: Batch = { pageNumber, tier, works: new Set(), abandoned: false, task: null };
      batch = fresh;
      store.batches.set(key, fresh);
      queueMicrotask(() => {
        if (store.batches.get(key) === fresh) store.batches.delete(key);
        void run(store, fresh);
      });
    }
    let settle!: (raster: AppearanceRaster | null) => void;
    const result = new Promise<AppearanceRaster | null>((resolve) => { settle = resolve; });
    const made: Work = { id: annotationId, tier, result, settle: () => {}, settled: false, holds: 0, batch };
    made.settle = (raster) => {
      if (made.settled) return;
      made.settled = true;
      settle(raster);
    };
    batch.works.add(made);
    stamps.set(annotationId, made);
    work = made;
  }
  const held = work;
  held.holds++;
  trim(store);

  let released = false;
  return {
    raster: held.result,
    release: () => {
      if (released) return;
      released = true;
      held.holds--;
      if (held.holds === 0 && !held.settled) {
        const batch = held.batch;
        batch?.works.delete(held);
        forget(store, pageNumber, held);
        held.settle(null);
        if (batch && batch.works.size === 0) {
          batch.abandoned = true;
          batch.task?.cancel();
        }
      }
      store.members.delete(member);
      // A holder that swaps one hold for another in the same turn keeps the copy.
      if (store.members.size === 0) queueMicrotask(() => { if (store.members.size === 0) retireCopy(store, store.copy); });
      trim(store);
    },
  };
}

/** Draws `raster` over the whole of a canvas of `width` by `height` pixels,
 *  turned clockwise by `turn`. */
export function drawAppearanceRaster(
  context: Pick<CanvasRenderingContext2D, 'setTransform' | 'clearRect' | 'drawImage'>,
  raster: AppearanceRaster,
  turn: QuarterTurn,
  width: number,
  height: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(...appearanceRasterMatrix(turn, width, height));
  context.drawImage(raster.canvas as unknown as CanvasImageSource, 0, 0, 1, 1);
  context.setTransform(1, 0, 0, 1, 0, 0);
}
