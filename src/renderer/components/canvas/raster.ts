import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export const BASE_RASTER = 1100;
export const MAX_DETAIL = 4096;

export const dpr = (): number => Math.min(window.devicePixelRatio || 1, 2);

export const logRenderError =
  (label: string) =>
  (error: unknown): void => {
    if ((error as Error)?.name !== 'RenderingCancelledException') {
      console.error(label, error);
    }
  };

// ── Re-blit batching ─────────────────────────────────────────────────────
// A buffer swap (commit, undo, refresh) re-renders every near page of the
// affected file; pdf.js completions arrive staggered over hundreds of ms,
// and blitting each as it lands reads as an abrupt-swap RIPPLE across the
// strip (probe-classified in 18-phase3-polish.md — element identity and
// readiness survive a reorder commit; only pixels swap). Completed
// re-blits are therefore held briefly and flushed together inside one
// animation frame: the strip keeps its previous pixels a beat longer,
// then swaps in one visual step. First paints (fresh canvas, fade-in
// pending) are never held — scroll-in latency is untouched.

/** Flush when this long passes with no new completion arriving. */
export const REBLIT_QUIET_MS = 120;
/** Never hold the first queued re-blit longer than this (stragglers). */
export const REBLIT_MAX_HOLD_MS = 600;

let reblitQueue: Array<() => void> = [];
let reblitTimer: ReturnType<typeof setTimeout> | null = null;
let reblitFirstArrival = 0;

function flushReblits(): void {
  if (reblitTimer !== null) {
    clearTimeout(reblitTimer);
    reblitTimer = null;
  }
  const batch = reblitQueue;
  reblitQueue = [];
  if (batch.length === 0) return;
  requestAnimationFrame(() => {
    for (const blit of batch) blit();
  });
}

export function scheduleReblit(blit: () => void): void {
  const now = Date.now();
  if (reblitQueue.length === 0) reblitFirstArrival = now;
  reblitQueue.push(blit);
  if (reblitTimer !== null) clearTimeout(reblitTimer);
  const heldFor = now - reblitFirstArrival;
  if (heldFor >= REBLIT_MAX_HOLD_MS) {
    flushReblits();
    return;
  }
  reblitTimer = setTimeout(flushReblits, Math.min(REBLIT_QUIET_MS, REBLIT_MAX_HOLD_MS - heldFor));
}

interface BaseParams {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  naturalWidth: number;
  naturalHeight: number;
  baseRef: React.RefObject<HTMLCanvasElement | null>;
  isCancelled: () => boolean;
  onTask: (task: RenderTask) => void;
  onReady: () => void;
  /** True when this canvas already shows content (a buffer-swap re-render);
   *  routes the blit through the shared batcher instead of landing solo. */
  reblit?: boolean;
}

export async function renderBase({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  baseRef,
  isCancelled,
  onTask,
  onReady,
  reblit = false,
}: BaseParams): Promise<void> {
  const page = await pdf.getPage(pageNumber);
  if (isCancelled()) return;
  const scale = BASE_RASTER / Math.max(naturalWidth, naturalHeight);
  const viewport = page.getViewport({ scale });
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.floor(viewport.width));
  off.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport });
  onTask(task);
  await task.promise;
  if (isCancelled()) return;
  const paint = (): void => {
    // Re-checked at flush time — the effect may have been cancelled (or the
    // cell unmounted) while the blit sat in the batch window.
    if (isCancelled()) return;
    const canvas = baseRef.current;
    if (!canvas) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d')!.drawImage(off, 0, 0);
    onReady();
  };
  if (reblit) {
    scheduleReblit(paint);
  } else {
    paint();
  }
}

interface DetailGeometry {
  rect: DOMRect;
  layoutW: number;
  visLeft: number;
  visTop: number;
  visW: number;
  visH: number;
}

interface DetailParams {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  naturalWidth: number;
  geometry: DetailGeometry;
  detailCanvas: HTMLCanvasElement;
  isCancelled: () => boolean;
  onTask: (task: RenderTask) => void;
}

export async function renderDetail({
  pdf,
  pageNumber,
  naturalWidth,
  geometry,
  detailCanvas,
  isCancelled,
  onTask,
}: DetailParams): Promise<void> {
  const { rect, layoutW, visLeft, visTop, visW, visH } = geometry;
  const d = dpr();
  const capFactor = Math.min(1, MAX_DETAIL / (visW * d), MAX_DETAIL / (visH * d));
  const renderScale = (rect.width / naturalWidth) * d * capFactor;

  const page = await pdf.getPage(pageNumber);
  if (isCancelled()) return;
  const viewport = page.getViewport({ scale: renderScale });
  const fx0 = (visLeft - rect.left) / rect.width;
  const fy0 = (visTop - rect.top) / rect.height;
  const backingW = Math.max(1, Math.round(visW * d * capFactor));
  const backingH = Math.max(1, Math.round(visH * d * capFactor));

  const off = document.createElement('canvas');
  off.width = backingW;
  off.height = backingH;
  const task = page.render({
    canvas: off,
    canvasContext: off.getContext('2d')!,
    viewport,
    transform: [1, 0, 0, 1, -fx0 * viewport.width, -fy0 * viewport.height],
  });
  onTask(task);
  await task.promise;
  if (isCancelled()) return;

  detailCanvas.width = backingW;
  detailCanvas.height = backingH;
  detailCanvas.getContext('2d')!.drawImage(off, 0, 0);
  const effScale = rect.width / layoutW || 1;
  detailCanvas.style.display = 'block';
  detailCanvas.style.left = `${(visLeft - rect.left) / effScale}px`;
  detailCanvas.style.top = `${(visTop - rect.top) / effScale}px`;
  detailCanvas.style.width = `${visW / effScale}px`;
  detailCanvas.style.height = `${visH / effScale}px`;
}
