// Batch OCR run log (Phase 12, issue #1 request 4) — the text of one run.
//
// Pure formatting, no IO: the caller hands it a finished run and gets back a
// filename and a body, which Rust writes into the app-data log folder. Kept
// pure for the same reason the driver is (vitest drives the whole shape with
// no Tauri), and kept SEPARATE from the driver because the log is written once
// per run, from the report, and the driver must not grow an IO concern.
//
// Why a log at all, when the dialog already shows a report: the report dies
// with the dialog, and every per-file detail beyond the first few lives inside
// a scroll box. A batch that runs for forty minutes over a thousand files —
// and, once the CLI arm lands, one that runs at 09:30 with nobody watching —
// needs an artefact you can read afterwards and grep. That is what this is.
//
// Format rules that exist for grep, not for looks:
//   - one file per line, status first, in fixed-width brackets, so
//     `findstr /C:"[skipped]"` is a complete answer to "what failed?";
//   - the source-relative path next, unquoted, because it is the key the user
//     matches against their own tree;
//   - the honesty notes the report carries (partial recognition, "no text
//     recognized") are carried here too — a log that reads cleaner than the
//     screen would be a log that lies.

import type { BatchReport, BatchFileResult } from './batch-ocr';

export interface BatchLogRun {
  startedAt: Date;
  finishedAt: Date;
  sourceRoot: string;
  destRoot: string;
  /** The Tesseract language string actually used (e.g. `eng+fra`). */
  lang: string;
  /** Human names for those languages, for a reader who doesn't know the codes. */
  langLabel: string;
  report: BatchReport;
  /** What the run was configured to do with the ORIGINALS (requests 2/3).
   * Recorded even when nothing was enabled: a log that does not say what the
   * run was allowed to touch cannot be audited after the fact, and this is the
   * one setting that moves the user's own files. */
  filing?: {
    movedRoot?: string;
    errorRoot?: string;
    repairDamaged?: boolean;
    replaceRepairedOriginals?: boolean;
  };
  /** Set when the run ended on a structural failure rather than finishing. */
  fatalError?: string;
}

/** Two digits, zero-padded — the only number shaping this file needs. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Local wall-clock, sortable, no timezone maths. A batch user reasons about
 * "the 09:30 run", not about UTC. */
export function formatTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** The log's own name. Colons are illegal in Windows filenames, so the clock
 * part is run together; the date-first shape sorts chronologically in Explorer
 * and is the pattern the retention sweep matches on. */
export function batchLogFileName(startedAt: Date): string {
  const d = startedAt;
  return (
    `batch-ocr-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`
  );
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** One file's line. `status` is padded so the paths align in a fixed-width
 * viewer — the whole point of reading a log in Notepad. */
function fileLine(r: BatchFileResult): string {
  const tag = `[${r.status}]`.padEnd(10);
  let line: string;
  if (r.status === 'ocr') {
    const pages = r.pagesOcrd ?? 0;
    line = `${tag}${r.rel} — ${pages} page${pages === 1 ? '' : 's'} made searchable`;
    if (r.reason) line += ` (${r.reason})`;
  } else {
    line = r.reason ? `${tag}${r.rel} — ${r.reason}` : `${tag}${r.rel}`;
  }
  // O8: the size saving — or the reason there was none — is the whole point
  // of having asked for MRC, so it is never left to inference. Byte-identical
  // to engine/batch_ocr.py's `_file_line`, like every other field here.
  if (r.mrc) line += ` [${r.mrc}]`;
  if (r.repaired) {
    line += r.repairedOriginalReplaced
      ? ' [repaired; original replaced]'
      : ' [repaired]';
  }
  if (r.movedTo) line += ` -> original moved to ${r.movedTo}`;
  // `!!` so a move that did NOT happen is as greppable as a file that failed.
  // The user asked for their folders reorganised; what stayed put is the thing
  // they need to find.
  if (r.moveError) line += ` !! original NOT moved: ${r.moveError}`;
  return line;
}

function describeFiling(filing: BatchLogRun['filing']): string {
  if (!filing) return 'none (source folder untouched)';
  const parts: string[] = [];
  if (filing.movedRoot) parts.push(`processed originals -> ${filing.movedRoot}`);
  if (filing.errorRoot) parts.push(`failed originals -> ${filing.errorRoot}`);
  if (filing.repairDamaged) {
    parts.push(
      filing.replaceRepairedOriginals
        ? 'repair damaged files (replacing the originals)'
        : 'repair damaged files',
    );
  }
  return parts.length === 0 ? 'none (source folder untouched)' : parts.join(' · ');
}

export function formatBatchLog(run: BatchLogRun): string {
  const { report } = run;
  let ocrd = 0;
  let copiedClean = 0;
  let copiedNoText = 0;
  let skipped = 0;
  for (const r of report.results) {
    if (r.status === 'ocr') ocrd += 1;
    else if (r.status === 'copied') {
      if (r.reason) copiedNoText += 1;
      else copiedClean += 1;
    } else skipped += 1;
  }

  const outcome = run.fatalError
    ? `FAILED — ${run.fatalError}`
    : report.cancelled
      ? 'STOPPED by the user (files finished before the stop remain in the destination)'
      : 'completed';

  const lines: string[] = [
    'Spectra PDF — Batch OCR log',
    `Started:      ${formatTimestamp(run.startedAt)}`,
    `Finished:     ${formatTimestamp(run.finishedAt)}  (${formatDuration(
      run.finishedAt.getTime() - run.startedAt.getTime(),
    )})`,
    `Source:       ${run.sourceRoot}`,
    `Destination:  ${run.destRoot}`,
    `Languages:    ${run.lang} (${run.langLabel})`,
    `Filing:       ${describeFiling(run.filing)}`,
    `Result:       ${outcome}`,
    '',
  ];

  // A structural failure throws out of the driver, which means it never
  // returned a per-file record — and files mirrored before the failure are
  // still on disk. Printing "0 processed" there would read as "nothing
  // happened", which is the one thing we know is not true.
  if (run.fatalError && report.results.length === 0) {
    lines.push(
      'No per-file record: the run failed before returning one. Any files already',
    );
    lines.push('written before the failure remain in the destination folder.');
  } else {
    lines.push(
      `Files: ${report.results.length} processed — ${ocrd} made searchable · ` +
        `${copiedClean} copied (already searchable) · ` +
        `${copiedNoText} copied (no text recognized) · ${skipped} skipped`,
    );
    // The originals line only exists when the run was allowed to touch them.
    // A count of files that did NOT move is carried even at zero: "0 not moved"
    // is a statement, and its absence would be ambiguous.
    const moved = report.results.filter((r) => r.movedTo).length;
    const notMoved = report.results.filter((r) => r.moveError).length;
    const repairedCount = report.results.filter((r) => r.repaired).length;
    if (moved > 0 || notMoved > 0 || repairedCount > 0) {
      lines.push(
        `Originals: ${moved} moved · ${notMoved} NOT moved (see the !! lines) · ` +
          `${repairedCount} repaired`,
      );
    }
    lines.push('');
    if (report.results.length === 0) lines.push('(no files were processed)');
    else for (const r of report.results) lines.push(fileLine(r));
  }

  if (report.skippedDirs.length > 0) {
    lines.push('');
    lines.push('Unreadable subfolders (missing from the mirror):');
    for (const d of report.skippedDirs) lines.push(`  ${d}`);
  }

  // Trailing newline: a log file that does not end in one appends badly and
  // reads badly in every tool that counts lines.
  lines.push('');
  return lines.join('\r\n');
}
