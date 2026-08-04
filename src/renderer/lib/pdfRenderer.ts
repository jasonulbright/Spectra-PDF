import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfBuffer } from '../state/types';

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

export async function loadDocument(buffer: PdfBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
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
  return pdfjsLib.getDocument({ data, useWorkerFetch: false, useSystemFonts: true, ...ASSET_URLS })
    .promise;
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
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

export async function getPageCount(buffer: PdfBuffer): Promise<number> {
  const doc = await loadDocument(buffer);
  const count = doc.numPages;
  doc.loadingTask.destroy();
  return count;
}
