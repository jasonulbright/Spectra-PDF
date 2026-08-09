// One-PDF-per-folder run log — the text of one run.
//
// Pure formatting, no IO, for the reason the batch log is: a report dies with
// the dialog it is drawn in, and a run over a hundred scan folders needs an
// artefact that can be read and grepped afterwards. The timestamp, duration
// and filename helpers are the batch log's own — one log-name pattern, one
// retention sweep.
//
// The line format is the other sweep logs': status first in fixed-width
// brackets, then the SOURCE folder unquoted, then the output it produced and
// what it holds. A member the builder could not read gets its own indented
// line under its folder — the run succeeded and something is still missing
// from the document, which is exactly the case a reader is auditing for.

import { formatDuration, formatTimestamp, sweepLogFileName } from './batch-log';
import type { FolderCreatePdfReport, FolderResult } from './folder-create-pdf';
import { folderLabel, summarize } from './folder-create-pdf';

export interface FolderCreatePdfLogRun {
  startedAt: Date;
  finishedAt: Date;
  sourceRoot: string;
  destRoot: string;
  /** The options the run carried, as one readable line. */
  optionLabel: string;
  report: FolderCreatePdfReport;
  fatalError?: string;
}

export function folderCreatePdfLogFileName(startedAt: Date): string {
  return sweepLogFileName('create-pdf-folders-', startedAt);
}

function folderLine(r: FolderResult): string {
  const tag = `[${r.status}]`.padEnd(10);
  if (r.status === 'built') {
    return `${tag}${folderLabel(r)} -> ${r.output} — ${r.files} file(s), ${r.pages} page(s)`;
  }
  return `${tag}${folderLabel(r)} — ${r.reason ?? ''}`;
}

export function formatFolderCreatePdfLog(run: FolderCreatePdfLogRun): string {
  const { report } = run;
  const totals = summarize(report);
  const outcome = run.fatalError
    ? `FAILED — ${run.fatalError}`
    : report.cancelled
      ? 'STOPPED by the user (documents finished before the stop remain written)'
      : 'completed';

  const lines: string[] = [
    'Spectra PDF — one PDF per folder log',
    `Started:      ${formatTimestamp(run.startedAt)}`,
    `Finished:     ${formatTimestamp(run.finishedAt)}  (${formatDuration(
      run.finishedAt.getTime() - run.startedAt.getTime(),
    )})`,
    `Source:       ${run.sourceRoot}`,
    `Destination:  ${run.destRoot}`,
    `Options:      ${run.optionLabel || 'the defaults'}`,
    `Result:       ${outcome}`,
    '',
  ];

  if (run.fatalError && report.results.length === 0) {
    lines.push(
      'No per-folder record: the run failed before returning one. Any documents already',
    );
    lines.push('written before the failure remain in the destination folder.');
  } else {
    lines.push(
      `Folders: ${report.results.length} processed — ${totals.built} built · ` +
        `${totals.failed} failed · ${totals.pages} page(s) in total`,
    );
    lines.push('');
    if (report.results.length === 0) lines.push('(no folder held anything to assemble)');
    else {
      for (const r of report.results) {
        lines.push(folderLine(r));
        for (const warning of r.warnings ?? []) lines.push(`            ! ${warning}`);
      }
    }
  }

  if (report.skippedDirs.length > 0) {
    lines.push('');
    lines.push('Unreadable subfolders (missing from the sweep):');
    for (const d of report.skippedDirs) lines.push(`  ${d}`);
  }

  lines.push('');
  return lines.join('\r\n');
}
