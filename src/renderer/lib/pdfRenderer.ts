import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfBuffer } from '../state/types';
import { renderPageUprightOnce } from './upright-stamps';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// ── The runtime-fetched asset base ───────────────────────────────────────
// pdf.js 6 does NOT inline its image decoders, CMaps, standard fonts or the
// CMYK ICC profile — it fetches each from a `getDocument` URL option that
// defaults to `null`, and a null option makes the decoder throw INSIDE the
// image pipeline: the page draws blank and nothing surfaces to the user.
// Three filters ride on it — /JBIG2Decode and /CCITTFaxDecode share
// `jbig2.wasm` (CCITTFaxStream delegates to JBig2CCITTFaxImage) and
// /JPXDecode is `openjpeg.wasm` — which is every scanner- and fax-derived
// PDF. scripts/sync-pdfjs-assets.mjs stages the files; this points at them.
//
// The URLs must be ABSOLUTE, not relative. pdf.js reads some of them from
// inside the WORKER (the ICC colour spaces use a synchronous XHR there), and
// the worker's base URL is the hashed asset chunk under `assets/`, not the
// document — a relative "pdfjs/wasm/" would resolve to `assets/pdfjs/wasm/`
// and 404. Resolving against `document.baseURI` covers both hosts the app
// runs under: the Vite dev server and the packaged `tauri.localhost` origin.
// pdf.js requires the trailing slash (`getFactoryUrlProp` throws without it).
const assetBase = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href;

const ASSET_URLS = {
  wasmUrl: assetBase('wasm'),
  iccUrl: assetBase('iccs'),
  cMapUrl: assetBase('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: assetBase('standard_fonts'),
} as const;

// ── One worker per document, booted ahead of time ────────────────────────
// Every document gets a pdf.js worker of its own, as before: `destroy()` on
// its loading task still terminates the thread, which is the only way to stop
// a parse that has wedged, and one document's crash never takes another's
// worker with it. What changes is WHEN the thread boots. Left to pdf.js, the
// worker is created inside `getDocument`, so every open paid the 1.26 MB
// worker script's fetch, compile and handshake (tens of milliseconds, the
// same for an 800-byte file as for a 200-page one) before the first page
// could be parsed. A spare is now kept booting in the background: a load
// takes it and starts the next one, so the boot overlaps whatever the app
// was doing before the document arrived — the file dialog, the engine's
// credential probes, the previous document's index.
let spare: pdfjsLib.PDFWorker | null = null;

function bootWorker(): pdfjsLib.PDFWorker {
  const worker = new pdfjsLib.PDFWorker();
  // A spare nobody ever takes must not surface its boot failure as an
  // unhandled rejection; the load that takes it awaits the same promise and
  // reports the failure where a document can be told about it.
  void worker.promise.catch(() => {});
  return worker;
}

/** Start booting the spare worker now, so the first open finds it ready.
 * Called once the shell has painted; harmless to call again. */
export function warmPdfWorker(): void {
  spare ??= bootWorker();
}

function takeWorker(): pdfjsLib.PDFWorker {
  const worker = spare ?? bootWorker();
  spare = bootWorker();
  return worker;
}

export async function loadDocument(buffer: PdfBuffer, password?: string): Promise<pdfjsLib.PDFDocumentProxy> {
  // Tauri IPC serializes file bytes as a number[]; other sources may pass an
  // ArrayBuffer or Uint8Array. Typed-array input is copied because pdf.js
  // transfers (detaches) the array it is given to its worker, and state
  // buffers are shared by several consumers.
  let data: Uint8Array;
  if (buffer instanceof Uint8Array) {
    data = buffer.slice();
  } else if (buffer instanceof ArrayBuffer) {
    data = new Uint8Array(buffer.slice(0));
  } else {
    data = new Uint8Array(buffer);
  }
  const worker = takeWorker();
  const task = pdfjsLib.getDocument({
    data,
    worker,
    useWorkerFetch: false,
    useSystemFonts: true,
    ...ASSET_URLS,
    ...(password !== undefined ? { password } : {}),
  });
  // pdf.js terminates a worker it created itself when the task is destroyed,
  // and leaves one it was handed alive. This worker belongs to this document
  // alone, so the task's `destroy` is made to take it down too — the holders
  // (`pdfDocCache`, `withOwnDocument`) keep calling `loadingTask.destroy()`
  // and keep getting the kill switch they had.
  const destroyTask = task.destroy.bind(task);
  task.destroy = async () => {
    try {
      await destroyTask();
    } finally {
      worker.destroy();
    }
  };
  // Bytes pdf.js refuses (not a PDF, wrong password) leave a task nobody
  // holds a proxy to, so nobody would ever destroy it; its worker goes now.
  void task.promise.catch(() => {
    void task.destroy().catch(() => {});
  });
  return task.promise;
}

export async function renderPageToCanvas(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  await renderPageUprightOnce(doc, page, { canvas, canvasContext: ctx, viewport });
  return canvas;
}
