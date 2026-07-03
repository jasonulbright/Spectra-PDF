import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfBuffer } from '../state/types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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
  return pdfjsLib.getDocument({ data, useWorkerFetch: false, useSystemFonts: true }).promise;
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
