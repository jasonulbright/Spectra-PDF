// Real-IO assembly for the Batch OCR driver (Phase 6) — the thin layer
// between lib/batch-ocr.ts's pure state machine and the world: pdf.js
// standalone loads (NOT the workspace pdfDocCache — batch files are never
// workspace members and must not be retained by it), the shared tesseract
// worker client, the Rust batch fs commands, and the engine.
import { loadDocument } from './pdfRenderer';
import { extractPageText } from '../search/extract';
import { batch } from './tauri-bridge';
import type { BatchIo, BatchPdfDoc } from './batch-ocr';
import type { OcrApplyPage } from './ocr-apply';
import type { OcrClient } from '../ocr/ocr-client';
import type { PDFDocumentProxy } from 'pdfjs-dist';

function wrapDoc(proxy: PDFDocumentProxy, client: OcrClient): BatchPdfDoc {
  return {
    numPages: proxy.numPages,
    async needsOcr(pageIndex) {
      return (await extractPageText(proxy, pageIndex)).needsOcr;
    },
    async geometry(pageIndex) {
      // Identical to the workspace "Make searchable" geometry (one idiom):
      // crop-intersected page.view box + baked /Rotate.
      const p = await proxy.getPage(pageIndex + 1);
      const [vx0, vy0, vx1, vy1] = p.view;
      return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
    },
    recognize(pageIndex, jobId) {
      return client.recognize(proxy, pageIndex, jobId);
    },
    async destroy() {
      await proxy.loadingTask.destroy();
    },
  };
}

export function createBatchIo(
  client: OcrClient,
  applyOcrLayer: (source: string, output: string, pages: OcrApplyPage[]) => Promise<void>,
): BatchIo {
  return {
    async load(abs) {
      const bytes = await batch.readFileBuffer(abs);
      const proxy = await loadDocument(bytes);
      return wrapDoc(proxy, client);
    },
    applyOcrLayer,
    copyFile: (src, dest) => batch.copyFile(src, dest),
    ensureParentDirs: (path) => batch.ensureParentDirs(path),
  };
}
