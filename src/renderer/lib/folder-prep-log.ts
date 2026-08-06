// Folder form-preparation run log — the text of one run.
//
// Pure formatting, no IO, for the reason the batch log is: a report dies with
// the dialog it is drawn in, and a sweep over hundreds of forms needs an
// artefact that can be read and grepped afterwards. The timestamp, duration
// and filename helpers are the shared ones — one log-name pattern, one
// retention sweep.
//
// What a reader of this log needs to count is FIELDS, so a prepared file
// always states how many it got and how many candidates were accepted to make
// them: a radio group is one field however many options it carries.

import { formatDuration, formatTimestamp, sweepLogFileName } from './batch-log';
import { summarize, type PrepFileResult, type PrepReport } from './folder-prep';

export interface PrepLogRun {
  startedAt: Date;
  finishedAt: Date;
  sourceRoot: string;
  /** Empty in the in-place mode, which writes each file where it stands. */
  destRoot: string;
  /** How the scan arm was configured, and in which languages. */
  scanLabel: string;
  includeSigned: boolean;
  report: PrepReport;
  fatalError?: string;
}

export function prepLogFileName(startedAt: Date): string {
  return sweepLogFileName('form-prep-', startedAt);
}

function fileLine(r: PrepFileResult): string {
  const tag = `[${r.status}]`.padEnd(12);
  let line = `${tag}${r.rel}`;
  if (r.fields !== undefined) {
    line += ` — ${r.fields} field${r.fields === 1 ? '' : 's'}`;
    line += ` from ${r.candidates ?? 0} candidate${r.candidates === 1 ? '' : 's'}`;
  }
  if (r.reason) line += ` — ${r.reason}`;
  return line;
}

export function formatPrepLog(run: PrepLogRun): string {
  const { report } = run;
  const totals = summarize(report);
  const outcome = run.fatalError
    ? `FAILED — ${run.fatalError}`
    : report.cancelled
      ? 'STOPPED by the user (files finished before the stop remain written)'
      : 'completed';

  const lines: string[] = [
    'Spectra PDF — Prepare Forms folder log',
    `Started:      ${formatTimestamp(run.startedAt)}`,
    `Finished:     ${formatTimestamp(run.finishedAt)}  (${formatDuration(
      run.finishedAt.getTime() - run.startedAt.getTime(),
    )})`,
    `Source:       ${run.sourceRoot}`,
    `Destination:  ${run.destRoot || 'IN PLACE — the source files were rewritten'}`,
    `Scanned pages: ${run.scanLabel}`,
    `Signed files: ${
      run.includeSigned
        ? 'INCLUDED — their signatures were invalidated'
        : 'refused (left untouched)'
    }`,
    `Result:       ${outcome}`,
    '',
  ];

  if (run.fatalError && report.results.length === 0) {
    lines.push(
      'No per-file record: the run failed before returning one. Any files already',
    );
    lines.push('written before the failure remain where the run put them.');
  } else {
    lines.push(
      `Files: ${report.results.length} processed — ${totals.prepared} prepared · ` +
        `${totals.copied} copied unchanged · ${totals.unchanged} left alone · ` +
        `${totals.skipped} skipped`,
    );
    lines.push(`Fields created: ${totals.fields}`);
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
