// Folder-scope export — the driver.
//
// Pure orchestration: every side effect (the engine, the filesystem) arrives
// injected through `FolderExportIo`, so vitest exercises the whole state
// machine — per-file failure isolation, the mirror key, cancellation — with no
// Tauri (the batch-OCR precedent).
//
// Sources are read BY PATH and are never workspace members, so no ghost entry
// can exist for one; the engine is reached through `callRaw` at the IO seam for
// the reason batch OCR does (the commit gate exists to make the engine read
// bytes matching a document on screen, and there is none here).
//
// No signature gate: the run READS each source and writes a different document
// beside it. `folder-sweep.ts`'s eligibility rule decides whether a run may
// REWRITE a file, and this run rewrites nothing, so a signed document exports
// like any other.

import { engineMessageOf, joinDest, type DiskEntry } from './folder-sweep';
import {
  EXPORT_TARGETS,
  exportParams,
  exportRel,
  producedText,
  type ExportDocumentResult,
  type ExportFormat,
  type ExportImagesResult,
  type ExportOptionValues,
} from './export-targets';

export type ExportFileStatus = 'exported' | 'skipped';

export interface ExportFileResult {
  /** The SOURCE's tree position — the key a reader matches against the tree
   * they picked, not the name the output took. */
  rel: string;
  status: ExportFileStatus;
  /** The mirror path written, source-relative, with the target's extension. */
  out?: string;
  /** English, for the log: what the producer reported making. */
  produced?: string;
  /** English, like the other sweep reports': the log is read by whoever audits
   * the run, whatever language the UI was in. */
  reason?: string;
}

export interface FolderExportReport {
  cancelled: boolean;
  results: ExportFileResult[];
  skippedDirs: string[];
}

export interface ExportProgress {
  fileIndex: number;
  fileCount: number;
  rel: string;
}

export interface FolderExportIo {
  /** `export_document` or `export_images` over one source path, whichever door
   * the target names. Rejects on an unreadable or password-protected file, and
   * on a document the producer refuses — the driver turns either into one
   * file's result. */
  exportFile(
    abs: string,
    output: string,
    format: ExportFormat,
    params: Record<string, unknown>,
  ): Promise<ExportDocumentResult | ExportImagesResult>;
  ensureParentDirs(path: string): Promise<void>;
}

export interface FolderExportOptions {
  /** Every enumerated file lands under this root, at its own tree position. */
  destRoot: string;
  format: ExportFormat;
  values: ExportOptionValues;
  onProgress?: (p: ExportProgress) => void;
  /** Polled between files; a true return stops after the in-flight one. */
  isCancelled?: () => boolean;
}

export async function runFolderExport(
  entries: DiskEntry[],
  skippedDirs: string[],
  io: FolderExportIo,
  options: FolderExportOptions,
): Promise<FolderExportReport> {
  const onProgress = options.onProgress ?? (() => {});
  const isCancelled = options.isCancelled ?? (() => false);
  const { destRoot, format, values } = options;
  // Built once: the option set is a property of the TARGET, so it cannot
  // differ between two files of one run.
  const params = exportParams(format, values);
  const results: ExportFileResult[] = [];
  let cancelled = false;

  for (let i = 0; i < entries.length; i++) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    const entry = entries[i];
    const outRel = exportRel(entry.rel, format);
    onProgress({ fileIndex: i, fileCount: entries.length, rel: entry.rel });
    try {
      const dest = joinDest(destRoot, outRel);
      await io.ensureParentDirs(dest);
      const result = await io.exportFile(entry.abs, dest, format, params);
      results.push({
        rel: entry.rel,
        status: 'exported',
        out: outRel,
        produced: producedText(format, result),
      });
    } catch (err) {
      // A producer's refusal is a RESULT. A document with no tables in it
      // cannot become a spreadsheet, and the engine says so in a sentence; the
      // run records that sentence against that file and continues. One file's
      // refusal never ends a folder run.
      results.push({ rel: entry.rel, status: 'skipped', reason: engineMessageOf(err) });
    }
  }

  return { cancelled, results, skippedDirs };
}

export interface ExportSummary {
  exported: number;
  skipped: number;
}

export function summarize(report: FolderExportReport): ExportSummary {
  const out: ExportSummary = { exported: 0, skipped: 0 };
  for (const r of report.results) out[r.status] += 1;
  return out;
}

/** Which engine door a chosen target is produced by — the dialog needs it to
 * decide which tool path the call has to carry. */
export function exportDoor(format: ExportFormat): 'export_document' | 'export_images' {
  return EXPORT_TARGETS[format].door;
}
