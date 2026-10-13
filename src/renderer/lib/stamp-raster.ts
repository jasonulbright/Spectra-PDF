// The appearance of a stamp the commit carries as written
// (`PageAnnotation.carriedAppearance`), as a bitmap the canvas draws at the
// stamp's edited place and size.
//
// pdf.js has no render of one annotation. A display render in editing mode
// with an annotation canvas map draws every stamp of the page on a canvas of
// its own; the page content goes to a main canvas of one pixel and is
// discarded. Each stamp canvas covers the annotation rectangle in the page's
// own frame, before /Rotate, top row first.
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

export type QuarterTurn = 0 | 90 | 180 | 270;

/** A canvas as the document's own factory makes it. */
export interface RasterCanvas {
  width: number;
  height: number;
}

export interface StampRaster {
  canvas: RasterCanvas;
  /** The source page's /Rotate. */
  pageRotate: QuarterTurn;
}

/** The longest side of a stamp canvas, in pixels. */
export const STAMP_RASTER_MAX_SIDE = 4096;
/** The highest tier: pixels per point. */
export const STAMP_RASTER_MAX_TIER = 32;
/** How many pages of one document keep their bitmaps. A page with a live
 *  holder is kept past this count. */
export const STAMP_RASTER_PAGES = 8;
/** How many more renders a stamp gets when the page lists it and a render
 *  gives it no canvas. */
export const STAMP_RASTER_MISS_RETRIES = 2;

export function quarterTurn(...angles: number[]): QuarterTurn {
  const sum = angles.reduce((total, angle) => total + (Number.isFinite(angle) ? Math.round(angle / 90) * 90 : 0), 0);
  return ((((sum % 360) + 360) % 360) as QuarterTurn);
}

/** How far the bitmap turns, clockwise, inside the annotation's box in the
 *  stored frame: the page's /Rotate plus the pending page rotation, and
 *  nothing for a NoRotate stamp. The view rotation is applied by the wrapper
 *  that turns the box itself. */
export function stampRasterTurn(pageRotate: number, pendingRotation: number, noRotate = false): QuarterTurn {
  return noRotate ? 0 : quarterTurn(pageRotate, pendingRotation);
}

/** The canvas transform [a b c d e f] that maps the bitmap's unit square
 *  (u to the right, v down) onto a box of `width` by `height` pixels after a
 *  clockwise `turn`. A point (u, v) lands at (a·u + c·v + e, b·u + d·v + f). */
export function stampRasterMatrix(turn: QuarterTurn, width: number, height: number): [number, number, number, number, number, number] {
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
export function stampRasterTier(pixelsPerPoint: number): number {
  const wanted = Number.isFinite(pixelsPerPoint) && pixelsPerPoint > 1 ? pixelsPerPoint : 1;
  return Math.min(STAMP_RASTER_MAX_TIER, 2 ** Math.ceil(Math.log2(wanted)));
}

/** The pixels per point a stamp needs on the screen: its box in device pixels
 *  over its rectangle in points, on the side that asks for more. A stamp drawn
 *  smaller than its rectangle asks for less than the page zoom, an enlarged
 *  one for more. A side that swapped with a quarter turn pairs by length.
 *  `fallback` answers when a size is unknown. */
export function stampRasterDemand(
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
 *  side of the page stays inside `STAMP_RASTER_MAX_SIDE` pixels. */
export function stampRasterScale(tier: number, longestSidePoints: number): number {
  const side = Number.isFinite(longestSidePoints) && longestSidePoints > 0 ? longestSidePoints : 1;
  return Math.min(tier, STAMP_RASTER_MAX_SIDE / side);
}

/** One page's render at one tier. */
export function stampRasterKey(pageNumber: number, tier: number): string {
  return `${pageNumber}@${tier}`;
}

/** The document a stamp is shown from. */
export interface StampRasterSource {
  /** The shown document. It is never rendered here. */
  pdf: PDFDocumentProxy;
  /** The content key of its bytes; null for a document the proxy cache did
   *  not load, whose bitmaps then live as long as the document object. */
  contentKey: string | null;
  /** Opens another document over the same bytes that nothing else renders. */
  open: () => Promise<PDFDocumentProxy>;
}

/** One holder's claim on one stamp's bitmap. */
export interface StampRasterHold {
  /** The bitmap, or null when the stamp has none. */
  raster: Promise<StampRaster | null>;
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
  result: Promise<StampRaster | null>;
  settle: (raster: StampRaster | null) => void;
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
export function retainStampRasters(contentKey: string): void {
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
export function releaseStampRasters(contentKey: string): void {
  const store = cache.get(contentKey);
  if (!store) return;
  if (--store.documents > 0) return;
  cache.delete(contentKey);
  store.pages.clear();
  store.batches.clear();
  retireCopy(store, store.copy);
}

/** How many page renders have started since the module loaded. */
export function stampRasterRenderCount(): number {
  return renders;
}

/** How many pages hold bitmaps for the bytes `contentKey` names. */
export function stampRasterPageCount(contentKey: string): number {
  return cache.get(contentKey)?.pages.size ?? 0;
}

interface CanvasFactory {
  create(width: number, height: number): { canvas: RasterCanvas; context: unknown };
  destroy(entry: { canvas: RasterCanvas; context: unknown }): void;
}

/** Whether a rejection is a render that was cancelled or whose document was
 *  destroyed under it, by the class name pdf.js gives it. */
export function isStampRenderCancellation(error: unknown): boolean {
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

class Abandoned extends Error {
  constructor() {
    super('stamp raster: no holder is left');
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
  /** The ids the page lists as stamps with a rectangle. */
  listed: Set<string>;
  rasters: Map<string, StampRaster>;
}

async function renderPage(copy: Copy, batch: Batch): Promise<PageRender> {
  const pdf = await copy.document;
  if (!pdf) throw new Error('stamp raster: no document gives its bytes');
  const page = await pdf.getPage(batch.pageNumber);
  const annotations = (await page.getAnnotations()) as { id?: string; subtype?: string; rect?: number[] | null }[];
  const listed = new Set<string>();
  let longest = 0;
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Stamp' || !Array.isArray(annotation.rect)) continue;
    if (annotation.id) listed.add(annotation.id);
    longest = Math.max(longest, Math.abs(annotation.rect[2] - annotation.rect[0]), Math.abs(annotation.rect[3] - annotation.rect[1]));
  }
  const rasters = new Map<string, StampRaster>();
  if (longest <= 0) return { listed, rasters };
  if (batch.abandoned) throw new Abandoned();
  renders++;
  const factory = (pdf as unknown as { canvasFactory: CanvasFactory }).canvasFactory;
  const main = factory.create(1, 1);
  const canvases = new Map<string, RasterCanvas>();
  try {
    const task = page.render({
      canvas: main.canvas as unknown as HTMLCanvasElement,
      canvasContext: main.context as CanvasRenderingContext2D,
      viewport: page.getViewport({ scale: stampRasterScale(batch.tier, longest) }),
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
  const pageRotate = quarterTurn(page.rotate);
  for (const [id, canvas] of canvases) {
    if (wanted.has(id) && listed.has(id) && canvas.width > 0 && canvas.height > 0) {
      rasters.set(id, { canvas, pageRotate });
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
        if (!isStampRenderCancellation(error) || batch.abandoned || attempt >= STAMP_RASTER_MISS_RETRIES) return drop();
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
      if (attempt >= STAMP_RASTER_MISS_RETRIES) return drop();
      await cleanPage(copy, batch.pageNumber);
    } finally {
      leaveCopy(copy);
    }
  }
}

function trim(store: Store): void {
  if (store.pages.size <= STAMP_RASTER_PAGES) return;
  for (const [pageNumber, stamps] of [...store.pages]) {
    if (store.pages.size <= STAMP_RASTER_PAGES) return;
    if ([...stamps.values()].some((work) => work.holds > 0)) continue;
    store.pages.delete(pageNumber);
    if (store.copy) void cleanPage(store.copy, pageNumber);
  }
}

function storeOf(source: StampRasterSource): Store {
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
export function holdStampRaster(
  source: StampRasterSource,
  pageNumber: number,
  annotationId: string,
  pixelsPerPoint: number,
): StampRasterHold {
  const store = storeOf(source);
  const tier = stampRasterTier(pixelsPerPoint);
  const member: Member = { open: source.open };
  store.members.add(member);

  let stamps = store.pages.get(pageNumber);
  if (stamps) store.pages.delete(pageNumber);
  else stamps = new Map();
  store.pages.set(pageNumber, stamps);

  let work = stamps.get(annotationId);
  if (!work || work.tier !== tier) {
    const key = stampRasterKey(pageNumber, tier);
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
    let settle!: (raster: StampRaster | null) => void;
    const result = new Promise<StampRaster | null>((resolve) => { settle = resolve; });
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
export function drawStampRaster(
  context: Pick<CanvasRenderingContext2D, 'setTransform' | 'clearRect' | 'drawImage'>,
  raster: StampRaster,
  turn: QuarterTurn,
  width: number,
  height: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(...stampRasterMatrix(turn, width, height));
  context.drawImage(raster.canvas as unknown as CanvasImageSource, 0, 0, 1, 1);
  context.setTransform(1, 0, 0, 1, 0, 0);
}
