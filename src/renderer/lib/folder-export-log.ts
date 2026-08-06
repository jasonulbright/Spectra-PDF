// Folder-scope export run log — the text of one run.
//
// Pure formatting, no IO, for the reason the batch log is: a report dies with
// the dialog it is drawn in, and a sweep over a thousand documents needs an
// artefact that can be read and grepped afterwards. The timestamp, duration and
// filename helpers are the batch log's own — one log-name pattern, one
// retention sweep.
//
// The line format is the other sweep logs': status first in fixed-width
// brackets, then the SOURCE-relative path unquoted, then what was produced or
// why nothing was. The output's own name follows the source's on the same line,
// because a folder of `.pdf` sources and a folder of `.xlsx` outputs are two
// different trees and a reader matching one against the other needs both.

import { formatDuration, formatTimestamp, sweepLogFileName } from './batch-log';
import type { ExportFileResult, FolderExportReport } from './folder-export';
import { summarize } from './folder-export';

export interface FolderExportLogRun {
  startedAt: Date;
  finishedAt: Date;
  sourceRoot: string;
  destRoot: string;
  /** The target key, as the protocol spells it. */
  format: string;
  /** The options the run carried, as one readable line. */
  optionLabel: string;
  report: FolderExportReport;
  fatalError?: string;
}

/** The log's own name. Shares the batch log's date-first shape so one folder
 * sorts chronologically, and carries its own prefix so the retention sweep
 * matches it by name like the others. */
export function folderExportLogFileName(startedAt: Date): string {
  return sweepLogFileName('folder-export-', startedAt);
}

function fileLine(r: ExportFileResult): string {
  const tag = `[${r.status}]`.padEnd(12);
  let line = `${tag}${r.rel}`;
  if (r.out) line += ` -> ${r.out}`;
  if (r.produced) line += ` — ${r.produced}`;
  if (r.reason) line += ` — ${r.reason}`;
  return line;
}

export function formatFolderExportLog(run: FolderExportLogRun): string {
  const { report } = run;
  const totals = summarize(report);
  const outcome = run.fatalError
    ? `FAILED — ${run.fatalError}`
    : report.cancelled
      ? 'STOPPED by the user (files finished before the stop remain written)'
      : 'completed';

  const lines: string[] = [
    'Spectra PDF — folder export log',
    `Started:      ${formatTimestamp(run.startedAt)}`,
    `Finished:     ${formatTimestamp(run.finishedAt)}  (${formatDuration(
      run.finishedAt.getTime() - run.startedAt.getTime(),
    )})`,
    `Source:       ${run.sourceRoot}`,
    `Destination:  ${run.destRoot}`,
    `Format:       ${run.format}`,
    `Options:      ${run.optionLabel || 'the target defaults'}`,
    `Result:       ${outcome}`,
    '',
  ];

  if (run.fatalError && report.results.length === 0) {
    lines.push(
      'No per-file record: the run failed before returning one. Any files already',
    );
    lines.push('written before the failure remain in the destination folder.');
  } else {
    lines.push(
      `Files: ${report.results.length} processed — ${totals.exported} exported · ` +
        `${totals.skipped} skipped`,
    );
    lines.push('');
    if (report.results.length === 0) lines.push('(no files were processed)');
    else for (const r of report.results) lines.push(fileLine(r));
  }

  if (report.skippedDirs.length > 0) {
    lines.push('');
    lines.push('Unreadable subfolders (missing from the sweep):');
    for (const d of report.skippedDirs) lines.push(`  ${d}`);
  }

  lines.push('');
  return lines.join('\r\n');
}
