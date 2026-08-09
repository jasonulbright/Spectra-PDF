// One PDF per folder — the driver.
//
// Pure orchestration: every side effect (the engine, the filesystem) arrives
// injected through `FolderCreatePdfIo`, so vitest exercises the whole state
// machine — per-folder failure isolation, the mirror key, cancellation — with
// no Tauri (the batch-OCR and folder-export precedent).
//
// The run's UNIT is a DIRECTORY, not a file: a folder of page images is one
// document, which is what a flatbed produces. The grouping and the ordering
// inside a group are NOT decided here — they come from the engine's own
// `list_source_folders`, the same function the CLI and a guided action walk,
// so a preview and a run can never disagree about which page comes first.
//
// Sources are read BY PATH and are never workspace members, so the engine is
// reached through `callRaw` at the IO seam for the reason batch OCR does: the
// commit gate exists to make the engine read bytes matching a document on
// screen, and there is none here.

import { engineMessageOf, joinDest } from './folder-sweep';

/** One directory that will become one PDF, as the engine listed it. */
export interface SourceFolder {
  /** Tree position relative to the source root; empty for the root itself. */
  rel: string;
  /** The directory's own name. */
  name: string;
  /** Where the PDF lands, relative to the destination root — `a/b.pdf` for a
   * folder at `a/b`, so the file takes the FOLDER'S place in the tree. */
  output: string;
  /** Absolute member paths, in the order they will be assembled. */
  files: string[];
  count: number;
}

export interface FolderListing {
  source: string;
  groups: SourceFolder[];
  skippedDirs: string[];
}

/**
 * Read the engine's listing into the shape this module speaks.
 *
 * The engine names its fields in snake_case (`skipped_dirs`); everything above
 * the seam is camelCase. The translation lives HERE, in the pure module, and
 * not inline at the IO seam, because it is the breakable part: reading a field
 * the engine does not send yields `undefined`, and the first `.length` on it
 * takes the whole React tree down with an uncaught TypeError — which is
 * exactly how this function came to exist.
 *
 * Total by construction: a missing or misshapen field becomes an empty list
 * rather than `undefined`, and a group that is not an object is dropped rather
 * than half-read.
 */
export function parseFolderListing(raw: unknown): FolderListing {
  const empty: FolderListing = { source: '', groups: [], skippedDirs: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty;
  const r = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const groups: SourceFolder[] = [];
  if (Array.isArray(r.groups)) {
    for (const entry of r.groups) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const g = entry as Record<string, unknown>;
      const files = strings(g.files);
      if (typeof g.output !== 'string' || files.length === 0) continue;
      groups.push({
        rel: typeof g.rel === 'string' ? g.rel : '',
        name: typeof g.name === 'string' ? g.name : '',
        output: g.output,
        files,
        // The engine's own count, but never a number the file list contradicts.
        count: typeof g.count === 'number' ? g.count : files.length,
      });
    }
  }
  return {
    source: typeof r.source === 'string' ? r.source : '',
    groups,
    skippedDirs: strings(r.skipped_dirs),
  };
}

export type FolderStatus = 'built' | 'failed';

export interface FolderResult {
  /** The SOURCE folder's tree position — what a reader matches against the
   * tree they picked, not the name the output took. Empty is the root. */
  rel: string;
  /** The mirror path written, destination-relative. */
  output: string;
  status: FolderStatus;
  /** How many files the folder contributed. */
  files: number;
  /** Pages in the assembled document. */
  pages?: number;
  /** English, like the other sweep reports': the log is read by whoever audits
   * the run, whatever language the UI was in. */
  reason?: string;
  /** A member that could not be read, named. Never a silent drop. */
  warnings?: string[];
}

export interface FolderCreatePdfReport {
  cancelled: boolean;
  results: FolderResult[];
  skippedDirs: string[];
}

export interface FolderProgress {
  folderIndex: number;
  folderCount: number;
  /** What is being assembled, for the progress line — the output's own name. */
  output: string;
}

export interface BuildResult {
  pages: number;
  warnings?: string[];
}

export interface FolderCreatePdfIo {
  /** `create_pdf` over one folder's ordered members. Rejects on a folder
   * nothing in it could convert; the driver turns that into one row. */
  buildFolder(files: string[], output: string): Promise<BuildResult>;
  ensureParentDirs(path: string): Promise<void>;
}

export interface FolderCreatePdfOptions {
  destRoot: string;
  onProgress?: (p: FolderProgress) => void;
  /** Polled between folders; a true return stops after the in-flight one. */
  isCancelled?: () => boolean;
}

export async function runFolderCreatePdf(
  listing: FolderListing,
  io: FolderCreatePdfIo,
  options: FolderCreatePdfOptions,
): Promise<FolderCreatePdfReport> {
  const onProgress = options.onProgress ?? (() => {});
  const isCancelled = options.isCancelled ?? (() => false);
  const results: FolderResult[] = [];
  let cancelled = false;

  for (let i = 0; i < listing.groups.length; i++) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    const group = listing.groups[i];
    onProgress({ folderIndex: i, folderCount: listing.groups.length, output: group.output });
    const dest = joinDest(options.destRoot, group.output);
    try {
      await io.ensureParentDirs(dest);
      const built = await io.buildFolder(group.files, dest);
      results.push({
        rel: group.rel,
        output: group.output,
        status: 'built',
        files: group.count,
        pages: built.pages,
        ...(built.warnings && built.warnings.length > 0 ? { warnings: built.warnings } : {}),
      });
    } catch (err) {
      // A folder whose files cannot be converted is a RESULT. One folder's
      // refusal never ends a run over a tree of them.
      results.push({
        rel: group.rel,
        output: group.output,
        status: 'failed',
        files: group.count,
        reason: engineMessageOf(err),
      });
    }
  }

  return { cancelled, results, skippedDirs: listing.skippedDirs };
}

export interface FolderSummary {
  built: number;
  failed: number;
  /** Pages across every document that was built. */
  pages: number;
}

export function summarize(report: FolderCreatePdfReport): FolderSummary {
  const out: FolderSummary = { built: 0, failed: 0, pages: 0 };
  for (const r of report.results) {
    if (r.status === 'built') {
      out.built += 1;
      out.pages += r.pages ?? 0;
    } else {
      out.failed += 1;
    }
  }
  return out;
}

/** What a listing row is called on screen. The ROOT folder has no relative
 * path, and rendering an empty string would leave a blank row where the run's
 * largest group usually sits. */
export function folderLabel(group: SourceFolder | FolderResult): string {
  return group.rel === '' ? group.output : group.rel;
}
