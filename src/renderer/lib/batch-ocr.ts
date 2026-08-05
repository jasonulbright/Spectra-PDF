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
import { rawEngineMessage } from './engine-messages';
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
  /** Where the ORIGINAL was moved to, when a moved/error root was given
   * (Phase 12 requests 2/3). Absent means the source is where it always was. */
  movedTo?: string;
  /** A requested move (or repaired-original replacement) that did NOT happen.
   * Never changes the file's status — the OCR result stands on its own — but
   * never silent either: the user asked for their tree to be reorganised and
   * has to be told which files were left behind. */
  moveError?: string;
  /** O8: what the MRC pass did to this file, or why it did nothing. Present
   * only when the run asked for MRC. Never a failure of its own — the
   * searchable copy is the deliverable and it already exists. */
  mrc?: string;
  /** The source failed to load and tier-1 repair made it readable. */
  repaired?: boolean;
  /** The repaired bytes were written back over the damaged original. */
  repairedOriginalReplaced?: boolean;
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
  phase:
    | 'loading'
    | 'scanning'
    | 'recognizing'
    | 'writing'
    | 'copying'
    | 'repairing'
    | 'moving'
    | 'compressing';
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
  /** Byte copy, creating parents, overwriting an existing destination. Used
   * for the mirror pass-through AND — only when the user opted into it — to
   * write repaired bytes back over a damaged original. */
  copyFile(src: string, dest: string): Promise<void>;
  ensureParentDirs(path: string): Promise<void>;
  /** Move a SOURCE file into a moved/error mirror. Resolves to the path
   * actually written (a collision is suffixed, never overwritten). Called ONLY
   * when the run was given the corresponding root. */
  moveFile(src: string, dest: string): Promise<string>;
  /** Is the mirror output at `path` a readable PDF of `expectedPages` pages?
   * Called only before a source is about to move — see the run loop. */
  verifyOutput(path: string, expectedPages: number): Promise<boolean>;
  /** O8: MRC-compress the mirror output IN PLACE. Resolves to the note that
   * goes on the result and into the log, or rejects — a rejection is a note,
   * never a file failure (the searchable copy is already written). Called
   * only when the run asked for MRC. */
  compressMrc(path: string, preset: string, verifyText: boolean): Promise<string>;
  /** Tier-1 engine repair of a damaged source into a scratch file; resolves to
   * the scratch path. Called only when `repairDamaged` is on. */
  repairToScratch(src: string): Promise<string>;
  /** Delete a scratch file from `repairToScratch`. */
  discardScratch(path: string): Promise<void>;
}

export interface BatchRunOptions {
  onProgress?: (p: BatchProgress) => void;
  /** Polled between units of work; a true return stops after the in-flight
   * file (completed mirror files remain — the report says what finished). */
  isCancelled?: () => boolean;
  /** OPT-IN (request 2). Move each successfully processed ORIGINAL into a
   * mirror under this root. Undefined is the default and the standing
   * guarantee: batch OCR does not modify the source tree. */
  movedRoot?: string;
  /** OPT-IN (request 3). Move each FAILED original into a mirror under this
   * root, instead of only naming it in a report. */
  errorRoot?: string;
  /** OPT-IN (request 3). Run tier-1 repair on a source that will not load and
   * process the repaired copy if that works. */
  repairDamaged?: boolean;
  /** OPT-IN (request 3, "move repaired files back"). Write the repaired bytes
   * back over the damaged original, healing the source tree. Requires
   * `repairDamaged`; the repaired copy is the pre-OCR one, deliberately — the
   * user asked for their file fixed, not for a searchable derivative of it. */
  replaceRepairedOriginals?: boolean;
  /** OPT-IN (O8, issue #5). MRC-compress each mirrored file AFTER recognition
   * — the order is § 5.4's and it is structural here, since the file MRC
   * reads is the recognised output. */
  mrc?: { preset: string; verifyText: boolean };
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
  const { movedRoot, errorRoot, repairDamaged, replaceRepairedOriginals, mrc } = options;
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
    // Set when tier-1 repair produced a readable copy: the file the run then
    // works FROM, and the bytes "put the repaired original back" writes back.
    let scratch: string | null = null;
    // The single result for this entry. Everything below assigns it rather
    // than pushing, because the tail — verify, heal, move — has to run on
    // every outcome, and the old `continue`-per-branch shape had no tail.
    let result: BatchFileResult | null = null;
    let expectedPages = 0;
    let broke = false;

    try {
      onProgress({ ...base, phase: 'loading' });
      try {
        doc = await io.load(entry.abs);
      } catch (err) {
        const classification = classifyLoadError(err);
        // A password failure is NOT a repair candidate: a structural rewrite
        // cannot supply a password, and trying would replace a clear
        // "password-protected" with a confusing repair error.
        if (repairDamaged && classification !== 'password-protected') {
          onProgress({ ...base, phase: 'repairing' });
          try {
            scratch = await io.repairToScratch(entry.abs);
            doc = await io.load(scratch);
          } catch (repairErr) {
            doc = null;
            result = {
              rel: entry.rel,
              status: 'skipped',
              reason: `${classification}; repair did not help: ${messageOf(repairErr)}`,
            };
          }
        } else {
          result = { rel: entry.rel, status: 'skipped', reason: classification };
        }
      }

      // From here on the run works from `working`, which is the repaired copy
      // when there is one — so the mirror gets the readable file, not the
      // damaged bytes that failed to load in the first place.
      const working = scratch ?? entry.abs;

      if (doc) {
      expectedPages = doc.numPages;
      onProgress({ ...base, phase: 'scanning' });
      const needing: number[] = [];
      for (let p = 0; p < doc.numPages; p++) {
        if (await doc.needsOcr(p)) needing.push(p);
      }

      if (needing.length === 0) {
        onProgress({ ...base, phase: 'copying' });
        await io.copyFile(working, dest);
        result = { rel: entry.rel, status: 'copied' };
      } else {

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
          const recognized = await doc!.recognize(pageIndex, `batch:${i}:${pageIndex}`);
          done += 1;
          onProgress({ ...base, phase: 'recognizing', page: done, pageCount: needing.length });
          const geometry = await doc!.geometry(pageIndex);
          const words = convertWords(recognized.words, geometry);
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
        await io.copyFile(working, dest);
        result = { rel: entry.rel, status: 'copied', reason: 'no text recognized' };
      } else {
        pages.sort((a, b) => a.page - b.page);
        onProgress({ ...base, phase: 'writing' });
        await io.ensureParentDirs(dest);
        await io.applyOcrLayer(working, dest, pages);
        result = {
          rel: entry.rel,
          status: 'ocr',
          pagesOcrd: pages.length,
          ...(pages.length < needing.length
            ? {
                reason: `${needing.length - pages.length} of ${needing.length} scanned pages had no recognizable text`,
              }
            : {}),
        };
      }
      }
      }

      // ── The tail: verify, heal, move ──────────────────────────────────
      //
      // Everything that touches the user's SOURCE tree happens here, once,
      // after the file's outcome is known — never inside a success branch.
      if (result) {
        // O8 — MRC, after recognition (the file it reads IS the recognised
        // output, which makes § 5.4's order structural rather than
        // documented) and before the verification below (which may let an
        // original move on the strength of the output; verifying bytes about
        // to be replaced would verify the wrong file). A failure here is a
        // note, never a status change: the searchable copy is the deliverable
        // the user asked for and it is already written.
        if (mrc && result.status !== 'skipped') {
          onProgress({ ...base, phase: 'compressing' });
          try {
            result.mrc = await io.compressMrc(dest, mrc.preset, mrc.verifyText);
          } catch (err) {
            result.mrc = `MRC compression did not apply: ${messageOf(err)}`;
          }
        }

        // Verification runs only when a source is about to move, which is the
        // constraint as written: "verify the output is a valid PDF BEFORE the
        // source moves". Verifying on every ordinary run would double the IO
        // of the default path to protect a source nothing is going to touch.
        if (result.status !== 'skipped' && (movedRoot || (scratch && replaceRepairedOriginals))) {
          const ok = await io.verifyOutput(dest, expectedPages).catch(() => false);
          if (!ok) {
            // The mirror file stays where it is — deleting it would be a
            // second surprise — but the run did NOT produce a usable
            // searchable copy, so the source is not expendable and the
            // status must not claim success.
            result = {
              rel: entry.rel,
              status: 'skipped',
              reason:
                'the copy in the destination could not be read back as a valid PDF — the original was left untouched',
            };
          }
        }

        if (scratch) {
          result.repaired = true;
          if (replaceRepairedOriginals && result.status !== 'skipped') {
            try {
              await io.copyFile(scratch, entry.abs);
              result.repairedOriginalReplaced = true;
            } catch (err) {
              result.moveError = `the repaired copy could not replace the original: ${messageOf(err)}`;
            }
          }
        }

        const moveRoot = result.status === 'skipped' ? errorRoot : movedRoot;
        if (moveRoot) {
          onProgress({ ...base, phase: 'moving' });
          try {
            result.movedTo = await io.moveFile(entry.abs, joinDest(moveRoot, entry.rel));
          } catch (err) {
            // A failed move never changes the STATUS — the OCR result stands
            // on its own — but it is never silent either: the user asked for
            // their tree reorganised and must be told what stayed put.
            result.moveError = result.moveError
              ? `${result.moveError}; move failed: ${messageOf(err)}`
              : messageOf(err);
          }
        }
      }
    } catch (err) {
      if (err instanceof BatchCancelledError) {
        cancelled = true;
        broke = true;
      } else {
        result = { rel: entry.rel, status: 'skipped', reason: messageOf(err) };
        // A file that failed mid-work is an error like any other. The move is
        // attempted here rather than in the tail because the tail is inside
        // the try this catch belongs to.
        if (errorRoot) {
          try {
            result.movedTo = await io.moveFile(entry.abs, joinDest(errorRoot, entry.rel));
          } catch (moveErr) {
            result.moveError = messageOf(moveErr);
          }
        }
      }
    } finally {
      if (doc) await doc.destroy().catch(() => {});
      // After the tail, so "put the repaired original back" still has its bytes.
      if (scratch) await io.discardScratch(scratch).catch(() => {});
    }
    if (broke) break;
    if (result) results.push(result);
  }

  return { cancelled, results, skippedDirs };
}

/**
 * The ENGLISH text of a failure, for the batch REPORT.
 *
 * N12 slice D: a report `reason` is written byte-identically into the batch
 * log (`lib/batch-log.ts`, pinned by tests/batch-log.test.ts) and read back by
 * whoever audits the run, so it stays English regardless of the UI language —
 * the same boundary the operation log sits on. `rawEngineMessage` returns an
 * engine refusal's original bytes; anything else is already its own text.
 */
function messageOf(err: unknown): string {
  return rawEngineMessage(err);
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
