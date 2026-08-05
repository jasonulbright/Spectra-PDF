// Real-IO assembly for the Batch OCR driver (Phase 6) — the thin layer
// between lib/batch-ocr.ts's pure state machine and the world: pdf.js
// standalone loads (NOT the workspace pdfDocCache — batch files are never
// workspace members and must not be retained by it), the shared tesseract
// worker client, the Rust batch fs commands, and the engine.
import { loadDocument } from './pdfRenderer';
import { extractPageText } from '../search/extract';
import { batch } from './tauri-bridge';
import { mrcBatchNote, type MrcReport } from './mrc-presets';
import type { BatchIo, BatchPdfDoc } from './batch-ocr';
import type { OcrApplyPage } from './ocr-apply';
import type { OcrResult } from '../ocr/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';

function wrapDoc(
  proxy: PDFDocumentProxy,
  path: string,
  recognizePage: (path: string, pageIndex: number) => Promise<OcrResult>,
): BatchPdfDoc {
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
    recognize(pageIndex) {
      // Native Tesseract via the engine — the app's ONE recognizer. The old
      // WASM path took the pdf.js proxy; the engine reads the file, which is
      // exactly what lets the same code run headlessly in the CLI.
      return recognizePage(path, pageIndex);
    },
    async destroy() {
      await proxy.loadingTask.destroy();
    },
  };
}

export function createBatchIo(
  engine: {
    applyOcrLayer: (source: string, output: string, pages: OcrApplyPage[]) => Promise<void>;
    /** Tier-1 structural repair (`engine/repair.py`) — a pikepdf/QPDF rewrite,
     * chosen over the heavier rebuild/recover tiers because it is fast and
     * NON-DESTRUCTIVE: annotations, bookmarks and metadata survive. An
     * unattended batch must not quietly downgrade a document to make it open. */
    repair: (source: string, output: string) => Promise<void>;
    /** Recognise one page of `path` (0-based index). */
    recognize: (path: string, pageIndex: number) => Promise<OcrResult>;
    /** O8: `compress` with `quality="mrc"` over `path`, in place. Resolves to
     * the engine's own report so the note can be shaped here rather than in
     * the pure driver. */
    compressMrc: (path: string, preset: string, verifyText: boolean) => Promise<MrcReport>;
  },
): BatchIo {
  return {
    async load(abs) {
      const bytes = await batch.readFileBuffer(abs);
      const proxy = await loadDocument(bytes);
      return wrapDoc(proxy, abs, engine.recognize);
    },
    applyOcrLayer: engine.applyOcrLayer,
    copyFile: (src, dest) => batch.copyFile(src, dest),
    ensureParentDirs: (path) => batch.ensureParentDirs(path),
    moveFile: (src, dest) => batch.moveFile(src, dest),
    // Read the mirror output BACK through pdf.js — the same reader the app
    // itself uses, so "valid" here means valid to the thing that will open it.
    // Page count is the cheap end of the check that still catches the failures
    // that matter before an original is moved: a truncated or zero-length
    // write, a corrupt xref, an engine that reported success and wrote
    // nothing. Any throw is a failure; this must never resolve true on doubt.
    async verifyOutput(path, expectedPages) {
      let proxy: Awaited<ReturnType<typeof loadDocument>> | null = null;
      try {
        const bytes = await batch.readFileBuffer(path);
        proxy = await loadDocument(bytes);
        return proxy.numPages === expectedPages;
      } catch {
        return false;
      } finally {
        if (proxy) await proxy.loadingTask.destroy().catch(() => {});
      }
    },
    async compressMrc(path, preset, verifyText) {
      return mrcBatchNote(await engine.compressMrc(path, preset, verifyText));
    },
    async repairToScratch(src) {
      const scratch = await batch.createScratch('repair');
      try {
        await engine.repair(src, scratch);
      } catch (err) {
        // Do not leave the empty/partial scratch behind for a repair that
        // never produced anything.
        await batch.deleteScratch(scratch).catch(() => {});
        throw err;
      }
      return scratch;
    },
    discardScratch: (path) => batch.deleteScratch(path),
  };
}
