// Disk-scope Search & Redact — the folder driver.
//
// Pure orchestration: every side effect (the engine, the filesystem) arrives
// injected through `DiskRedactIo`, so vitest exercises the whole state machine
// — per-file failure isolation, the signature gate, cancellation, the mirror's
// pass-through — with no Tauri (the batch-OCR precedent).
//
// Sources are read BY PATH and are never workspace members, so no ghost entry
// can exist for one; the engine is reached through `callRaw` at the IO seam
// for the same reason batch OCR is (the commit gate exists to make the engine
// read bytes matching a document on screen, and there is none here).
//
// The matcher, the hit rectangles and the selection model all come from
// `lib/search-redact.ts` — this module adds a folder and a mirror, nothing
// else.

import { rawEngineMessage } from './engine-messages';
import { hitKey, type SearchHit, type SearchRequest } from './search-redact';
import {
  signedEditDecision,
  type EditClass,
  type SignaturePolicy,
  type SignedEditReason,
} from './signatures';

export interface DiskEntry {
  /** Canonical absolute source path (engine input, copy input). */
  abs: string;
  /** Tree position relative to the source root (the mirror key). */
  rel: string;
}

/** What a file's own signatures said about the write this run intends. */
export interface SignedNote {
  reason: SignedEditReason;
  count: number;
  /** The decision refuses outright — no consent makes this file writable. */
  refused: boolean;
}

export interface DiskSearchResult {
  /** The hit keys of this file are built on `abs` — the file is not open, so
   * there is no workspace path to key them on. */
  abs: string;
  rel: string;
  hits: SearchHit[];
  /** Pages carrying no searchable text at all, reported rather than silently
   * searched-and-missed. Recognising them is Batch OCR's job. */
  pagesWithoutText: number[];
  truncated: boolean;
  /** An invalid regex, reported by the engine rather than raised. */
  error: string | null;
  /** Why this file cannot be written, in the engine's own English — the same
   * text the log carries. Null when the file is eligible. */
  skipReason: string | null;
  signed: SignedNote | null;
}

export interface DiskSearchReport {
  cancelled: boolean;
  files: DiskSearchResult[];
  skippedDirs: string[];
}

export type DiskFileStatus = 'redacted' | 'marked' | 'copied' | 'unchanged' | 'skipped';

export interface DiskFileResult {
  rel: string;
  status: DiskFileStatus;
  /** Rectangles written (redacted/marked only). */
  regions?: number;
  /** English, like the batch report's: the log is read by whoever audits the
   * run, whatever language the UI was in. */
  reason?: string;
}

export interface DiskRedactReport {
  cancelled: boolean;
  results: DiskFileResult[];
  skippedDirs: string[];
}

export type DiskPhase = 'searching' | 'redacting' | 'marking' | 'copying' | 'skipping';

export interface DiskProgress {
  fileIndex: number;
  fileCount: number;
  rel: string;
  phase: DiskPhase;
}

/** One region as the two write doors take it: a page, a rect, and the
 * appearance properties both producers share. */
export interface RedactRegion {
  page: number;
  rect: [number, number, number, number];
}

export interface DiskRedactIo {
  /** `search_text_regions` over one source path. Rejects on an unreadable or
   * password-protected file — the driver turns that into one file's result. */
  search(abs: string, request: SearchRequest): Promise<{
    hits: SearchHit[];
    truncated: boolean;
    pages_without_text: number[];
    error: string | null;
  }>;
  /** The cheap structural read the edit tier consults before every edit. */
  signaturePolicy(abs: string): Promise<SignaturePolicy>;
  /** `redact` (content removed) or `save_redaction_marks` (annotations
   * written), source → output. The shared appearance properties are the IO
   * layer's, not the driver's: they are the same persisted record both
   * existing producers read, and they ride onto every region there. */
  write(
    abs: string,
    output: string,
    regions: RedactRegion[],
    marksOnly: boolean,
  ): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  ensureParentDirs(path: string): Promise<void>;
}

export interface DiskRunOptions {
  onProgress?: (p: DiskProgress) => void;
  /** Polled between files; a true return stops after the in-flight one. */
  isCancelled?: () => boolean;
}

export interface DiskApplyOptions extends DiskRunOptions {
  /** Empty writes each file where it stands (the consented in-place mode);
   * otherwise every enumerated file lands under this root. */
  destRoot: string;
  marksOnly: boolean;
  /** The user accepted that signed documents lose their signatures. A file
   * whose decision REFUSED is unaffected — no consent reaches it. */
  includeSigned: boolean;
}

// ── Path helpers ──────────────────────────────────────────────────────────

/** Join a mirror destination from the root and a source-relative key, in the
 * separator style the root already uses (the rel arrives from the Rust walk
 * with platform separators). */
export function joinDest(destRoot: string, rel: string): string {
  const sep = destRoot.includes('/') && !destRoot.includes('\\') ? '/' : '\\';
  const trimmed =
    destRoot.endsWith('\\') || destRoot.endsWith('/') ? destRoot.slice(0, -1) : destRoot;
  return `${trimmed}${sep}${rel}`;
}

/** The English text of a failure, for the report and the log — byte-identical
 * to what the engine sent, whatever language the UI is in. */
function messageOf(err: unknown): string {
  return rawEngineMessage(err);
}

/** English for a signature decision, for the log and the report. The UI
 * renders its own catalog string from the same `reason`. */
export function signedReasonText(note: SignedNote): string {
  switch (note.reason) {
    case 'certified-no-changes':
      return 'certified to allow no changes';
    case 'certified-form-fill':
      return 'certified for form filling only';
    case 'certified-annotate':
      return 'certified for annotation only';
    case 'certified-unknown':
      return 'certified at a level this build cannot read';
    case 'signed':
      return `signed (${note.count} signature${note.count === 1 ? '' : 's'})`;
  }
}

// ── The search sweep ──────────────────────────────────────────────────────

export async function runDiskSearch(
  entries: DiskEntry[],
  skippedDirs: string[],
  request: SearchRequest,
  marksOnly: boolean,
  io: DiskRedactIo,
  options: DiskRunOptions = {},
): Promise<DiskSearchReport> {
  const onProgress = options.onProgress ?? (() => {});
  const isCancelled = options.isCancelled ?? (() => false);
  // Applying a redaction rewrites page content and breaks every byte range;
  // writing a /Redact annotation is an annotation and the marks writer
  // preserves signatures through its incremental finalizer.
  const editClass: EditClass = marksOnly ? 'annotate' : 'structural';
  const files: DiskSearchResult[] = [];
  let cancelled = false;

  for (let i = 0; i < entries.length; i++) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    const entry = entries[i];
    onProgress({ fileIndex: i, fileCount: entries.length, rel: entry.rel, phase: 'searching' });
    const base = {
      abs: entry.abs,
      rel: entry.rel,
      hits: [] as SearchHit[],
      pagesWithoutText: [] as number[],
      truncated: false,
      error: null as string | null,
      skipReason: null as string | null,
      signed: null as SignedNote | null,
    };
    try {
      const raw = await io.search(entry.abs, request);
      const hits = (raw.hits ?? []).map((hit, index) => ({ ...hit, index }));
      const result: DiskSearchResult = {
        ...base,
        hits,
        pagesWithoutText: raw.pages_without_text ?? [],
        truncated: !!raw.truncated,
        error: raw.error ?? null,
      };
      // The signature read costs an engine call, so it is spent only on files
      // that have something to write. A file with no hits is never written to
      // anything but the mirror pass-through, which changes no bytes.
      if (hits.length > 0) {
        try {
          const policy = await io.signaturePolicy(entry.abs);
          const decision = signedEditDecision(policy, editClass);
          if (decision.kind !== 'proceed') {
            result.signed = {
              reason: decision.reason,
              count: policy.count,
              refused: decision.kind === 'refuse',
            };
          }
        } catch (err) {
          // A policy that cannot be read is not a policy that permits: the
          // file is reported rather than swept on an assumption.
          result.skipReason = messageOf(err);
        }
      }
      files.push(result);
    } catch (err) {
      files.push({ ...base, skipReason: messageOf(err) });
    }
  }

  return { cancelled, files, skippedDirs };
}

/** Is this file writable by this run? A refusing signature decision is never
 * consentable; a warning one is, once the run says signed documents are in. */
export function fileIsEligible(file: DiskSearchResult, includeSigned: boolean): boolean {
  if (file.skipReason !== null) return false;
  if (file.signed === null) return true;
  return !file.signed.refused && includeSigned;
}

/** The English reason a file cannot be written, or null when it can. */
export function ineligibleReason(
  file: DiskSearchResult,
  includeSigned: boolean,
): string | null {
  if (file.skipReason !== null) return file.skipReason;
  if (file.signed === null) return null;
  if (fileIsEligible(file, includeSigned)) return null;
  return signedReasonText(file.signed);
}

/** Every hit key the run may act on, so a "check everything" control cannot
 * offer a file the run would refuse. */
export function selectableKeys(
  files: DiskSearchResult[],
  includeSigned: boolean,
): string[] {
  const keys: string[] = [];
  for (const file of files) {
    if (!fileIsEligible(file, includeSigned)) continue;
    for (const hit of file.hits) keys.push(hitKey(file.abs, hit));
  }
  return keys;
}

// ── The apply sweep ───────────────────────────────────────────────────────

export async function runDiskApply(
  files: DiskSearchResult[],
  selected: ReadonlySet<string>,
  io: DiskRedactIo,
  options: DiskApplyOptions,
): Promise<DiskRedactReport> {
  const onProgress = options.onProgress ?? (() => {});
  const isCancelled = options.isCancelled ?? (() => false);
  const { destRoot, marksOnly, includeSigned } = options;
  const inPlace = destRoot === '';
  const results: DiskFileResult[] = [];
  let cancelled = false;

  for (let i = 0; i < files.length; i++) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    const file = files[i];
    const base = { fileIndex: i, fileCount: files.length, rel: file.rel };
    const dest = inPlace ? file.abs : joinDest(destRoot, file.rel);
    const reason = ineligibleReason(file, includeSigned);
    if (reason !== null) {
      // A file the run may not write is not mirrored either: an unreadable or
      // refused source has no output, and the report says which it was. It
      // still reports progress — a sweep whose first hundred files are all
      // refused would otherwise show no movement at all.
      onProgress({ ...base, phase: 'skipping' });
      results.push({ rel: file.rel, status: 'skipped', reason });
      continue;
    }

    const regions: RedactRegion[] = [];
    for (const hit of file.hits) {
      if (!selected.has(hitKey(file.abs, hit))) continue;
      for (const entry of hit.rects) regions.push({ page: hit.page, rect: entry.rect });
    }

    try {
      if (regions.length === 0) {
        if (inPlace) {
          onProgress({ ...base, phase: 'skipping' });
          results.push({ rel: file.rel, status: 'unchanged' });
          continue;
        }
        onProgress({ ...base, phase: 'copying' });
        await io.copyFile(file.abs, dest);
        results.push({ rel: file.rel, status: 'copied' });
        continue;
      }
      onProgress({ ...base, phase: marksOnly ? 'marking' : 'redacting' });
      await io.ensureParentDirs(dest);
      await io.write(file.abs, dest, regions, marksOnly);
      results.push({
        rel: file.rel,
        status: marksOnly ? 'marked' : 'redacted',
        regions: regions.length,
      });
    } catch (err) {
      results.push({ rel: file.rel, status: 'skipped', reason: messageOf(err) });
    }
  }

  return { cancelled, results, skippedDirs: [] };
}

export interface DiskSummary {
  redacted: number;
  marked: number;
  copied: number;
  unchanged: number;
  skipped: number;
  regions: number;
}

export function summarize(report: DiskRedactReport): DiskSummary {
  const out: DiskSummary = {
    redacted: 0,
    marked: 0,
    copied: 0,
    unchanged: 0,
    skipped: 0,
    regions: 0,
  };
  for (const r of report.results) {
    out[r.status] += 1;
    out.regions += r.regions ?? 0;
  }
  return out;
}
