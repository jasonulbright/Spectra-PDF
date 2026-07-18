// Batch OCR (Phase 6) — the folder-mirror driver. Design:
// docs/architecture/20-phase6-batch-ocr.md.
//
// Pure orchestration: every side effect (fs, pdf.js, the tesseract worker,
// the engine) arrives injected through `BatchIo`, so vitest exercises the
// whole state machine — classification, cancellation, per-file failure
// isolation, report aggregation — with no WASM and no Tauri (the 2m
// faked-client precedent).
//
// Word→rect conversion is byte-identical to the workspace "Make searchable"
// flow: displayRectToPdf(word, page.view-box, page.rotate) — see
// lib/ocr-apply.ts and the geometry construction in WorkspaceCanvasView's
// handleApplyOcr. One conversion idiom everywhere.

import { displayRectToPdf } from './pdfx-build';
import type { PageGeometry } from './redaction';
import type { OcrApplyPage } from './ocr-apply';
import type { OcrResult, OcrWord } from '../ocr/types';

export interface BatchEntry {
  /** Canonical absolute source path (engine + copy input). */
  abs: string;
  /** Tree position relative to the source root (the mirror key). */
  rel: string;
}

export type BatchFileStatus = 'ocr' | 'copied' | 'skipped';

export interface BatchFileResult {
  rel: string;
  status: BatchFileStatus;
  /** Pages that received an OCR layer (status 'ocr'). */
  pagesOcrd?: number;
  /** Why the file was skipped, or an honesty note on a copied/ocr file —
   * e.g. scanned pages where recognition found no text. A mixed file (some
   * scanned pages recognized, some blank) carries the shortfall here so
   * "made searchable" never silently overstates (review-caught). */
  reason?: string;
}

export interface BatchReport {
  cancelled: boolean;
  results: BatchFileResult[];
  /** Directories the enumeration could not read (from the Rust walk) —
   * carried into the report so the run never has silent holes. */
  skippedDirs: string[];
}

export interface BatchProgress {
  fileIndex: number; // 0-based index of the file being worked
  fileCount: number;
  rel: string;
  phase: 'loading' | 'scanning' | 'recognizing' | 'writing' | 'copying';
  /** 1-based page being recognized and the count of pages to recognize —
   * only meaningful in the 'recognizing' phase. */
  page?: number;
  pageCount?: number;
}

/** The pdf.js surface the driver needs from one loaded source file. */
export interface BatchPdfDoc {
  numPages: number;
  needsOcr(pageIndex: number): Promise<boolean>;
  geometry(pageIndex: number): Promise<PageGeometry>;
  recognize(pageIndex: number, jobId: string): Promise<OcrResult>;
  destroy(): Promise<void>;
}

export interface BatchIo {
  /** Load one source file for scanning/recognition. Must throw on
   * encrypted/corrupt input (the driver classifies via classifyLoadError). */
  load(abs: string): Promise<BatchPdfDoc>;
  /** Engine apply_ocr_layer: read `source`, write `output`. Parents of
   * `output` must already exist — the driver calls ensureParentDirs first. */
  applyOcrLayer(source: string, output: string, pages: OcrApplyPage[]): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  ensureParentDirs(path: string): Promise<void>;
}

export interface BatchRunOptions {
  onProgress?: (p: BatchProgress) => void;
  /** Polled between units of work; a true return stops after the in-flight
   * file (completed mirror files remain — the report says what finished). */
  isCancelled?: () => boolean;
}

// ── Path helpers (vitest-covered) ─────────────────────────────────────────

/** Join a mirror destination path from the destination root and a source-
 * relative key. Uses the separator style the root already uses; the rel
 * arrives from the Rust walk with platform separators. */
export function joinDest(destRoot: string, rel: string): string {
  const sep = destRoot.includes('/') && !destRoot.includes('\\') ? '/' : '\\';
  const trimmed = destRoot.endsWith('\\') || destRoot.endsWith('/')
    ? destRoot.slice(0, -1)
    : destRoot;
  return `${trimmed}${sep}${rel}`;
}

/** True when dest is the source root or inside it — refused before a run
 * starts: dest === source would overwrite the originals in place (the
 * surprise-mutation class the phase doc forbids), and dest inside source
 * makes the mirror a subtree of what it mirrors. Windows: case-insensitive
 * on canonical strings. */
export function destConflictsWithSource(sourceRoot: string, destRoot: string): boolean {
  const norm = (p: string): string => {
    let s = p.toLowerCase().replace(/\//g, '\\');
    while (s.endsWith('\\')) s = s.slice(0, -1);
    return s;
  };
  const src = norm(sourceRoot);
  const dest = norm(destRoot);
  return dest === src || dest.startsWith(`${src}\\`);
}

/** Human classification for a load failure. pdf.js names password failures
 * `PasswordException`; everything else reads as a damaged/unreadable file. */
export function classifyLoadError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'PasswordException') return 'password-protected';
  const msg = err instanceof Error ? err.message : String(err);
  return `unreadable: ${msg}`;
}

// ── The run ───────────────────────────────────────────────────────────────

/** How many recognitions are in flight per file — matches the search
 * engine's auto-OCR concurrency (the worker pool itself is capped at 2). */
const RECOGNIZE_CONCURRENCY = 2;

export async function runBatchOcr(
  entries: BatchEntry[],
  destRoot: string,
  skippedDirs: string[],
  io: BatchIo,
  options: BatchRunOptions = {},
): Promise<BatchReport> {
  const onProgress = options.onProgress ?? (() => {});
  const isCancelled = options.isCancelled ?? (() => false);
  const results: BatchFileResult[] = [];
  let cancelled = false;

  for (let i = 0; i < entries.length; i++) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    const entry = entries[i];
    const dest = joinDest(destRoot, entry.rel);
    const base = { fileIndex: i, fileCount: entries.length, rel: entry.rel };

    let doc: BatchPdfDoc | null = null;
    try {
      onProgress({ ...base, phase: 'loading' });
      try {
        doc = await io.load(entry.abs);
      } catch (err) {
        results.push({ rel: entry.rel, status: 'skipped', reason: classifyLoadError(err) });
        continue;
      }

      onProgress({ ...base, phase: 'scanning' });
      const needing: number[] = [];
      for (let p = 0; p < doc.numPages; p++) {
        if (await doc.needsOcr(p)) needing.push(p);
      }

      if (needing.length === 0) {
        onProgress({ ...base, phase: 'copying' });
        await io.copyFile(entry.abs, dest);
        results.push({ rel: entry.rel, status: 'copied' });
        continue;
      }

      // Recognize the scanned pages through the shared worker pool, a small
      // window at a time. A page whose recognition fails fails the FILE (a
      // mirror entry that silently lacked one page's text would read as
      // "made searchable" while not being so).
      //
      // allSettled, not all: on cancellation/error the sibling worker may
      // still hold an in-flight recognize — the driver must reach quiescence
      // before `destroy()` runs in the finally, and a dangling rejection
      // after Promise.all settles would surface as an unhandled rejection.
      const pages: OcrApplyPage[] = [];
      let done = 0;
      let next = 0;
      const workOne = async (): Promise<void> => {
        while (next < needing.length) {
          if (isCancelled()) throw new BatchCancelledError();
          const pageIndex = needing[next++];
          const result = await doc!.recognize(pageIndex, `batch:${i}:${pageIndex}`);
          done += 1;
          onProgress({ ...base, phase: 'recognizing', page: done, pageCount: needing.length });
          const geometry = await doc!.geometry(pageIndex);
          const words = convertWords(result.words, geometry);
          if (words.length > 0) pages.push({ page: pageIndex + 1, words });
        }
      };
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(RECOGNIZE_CONCURRENCY, needing.length) }, workOne),
      );
      const rejections = settled.filter(
        (s): s is PromiseRejectedResult => s.status === 'rejected',
      );
      if (rejections.length > 0) {
        // A cancelAll() from the dialog rejects in-flight recognitions with
        // Error('cancelled') — same meaning as the driver's own sentinel.
        const allCancel = rejections.every(
          (r) =>
            r.reason instanceof BatchCancelledError ||
            (r.reason instanceof Error && r.reason.message === 'cancelled'),
        );
        if (allCancel || isCancelled()) throw new BatchCancelledError();
        throw rejections[0].reason;
      }

      if (pages.length === 0) {
        // Scanned pages, but recognition produced no usable words (blank
        // scans). Nothing to persist — mirror the file as-is, honestly noted.
        onProgress({ ...base, phase: 'copying' });
        await io.copyFile(entry.abs, dest);
        results.push({ rel: entry.rel, status: 'copied', reason: 'no text recognized' });
        continue;
      }

      pages.sort((a, b) => a.page - b.page);
      onProgress({ ...base, phase: 'writing' });
      await io.ensureParentDirs(dest);
      await io.applyOcrLayer(entry.abs, dest, pages);
      results.push({
        rel: entry.rel,
        status: 'ocr',
        pagesOcrd: pages.length,
        ...(pages.length < needing.length
          ? {
              reason: `${needing.length - pages.length} of ${needing.length} scanned pages had no recognizable text`,
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof BatchCancelledError) {
        cancelled = true;
        break;
      }
      results.push({
        rel: entry.rel,
        status: 'skipped',
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (doc) await doc.destroy().catch(() => {});
    }
  }

  return { cancelled, results, skippedDirs };
}

class BatchCancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

function convertWords(words: OcrWord[], geometry: PageGeometry): { text: string; rect: [number, number, number, number] }[] {
  return words
    .filter((w) => w.text.trim().length > 0)
    .map((w) => ({
      text: w.text,
      rect: displayRectToPdf(w, geometry.box, geometry.bakedRotate),
    }));
}

// ── Report shaping (shared by the dialog and the harness) ────────────────

export interface BatchSummary {
  ocrd: number;
  copied: number;
  skipped: number;
}

export function summarize(report: BatchReport): BatchSummary {
  let ocrd = 0;
  let copied = 0;
  let skipped = 0;
  for (const r of report.results) {
    if (r.status === 'ocr') ocrd += 1;
    else if (r.status === 'copied') copied += 1;
    else skipped += 1;
  }
  return { ocrd, copied, skipped };
}
