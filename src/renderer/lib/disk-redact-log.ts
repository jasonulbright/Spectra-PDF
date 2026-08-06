// Disk Search & Redact run log — the text of one run.
//
// Pure formatting, no IO, for the reason the batch log is: a report dies with
// the dialog it is drawn in, and a sweep over a thousand documents needs an
// artefact that can be read and grepped afterwards. The timestamp, duration
// and filename helpers are the batch log's own — one log-name pattern, one
// retention sweep.
//
// The line format is the batch log's too, and for the same greppability
// reasons: status first in fixed-width brackets, then the source-relative
// path unquoted, then the honesty note. What is redacted is the one thing a
// reader needs to count, so a written file always states its rectangle count.

import { formatDuration, formatTimestamp, pad } from './batch-log';
import type { DiskFileResult, DiskRedactReport } from './disk-redact';
import { summarize } from './disk-redact';

export interface DiskRedactLogRun {
  startedAt: Date;
  finishedAt: Date;
  sourceRoot: string;
  /** Empty in the in-place mode, which writes each file where it stands. */
  destRoot: string;
  /** What the run searched for, as one readable line. */
  searchLabel: string;
  marksOnly: boolean;
  includeSigned: boolean;
  report: DiskRedactReport;
  fatalError?: string;
}

/** The log's own name. Shares the batch log's date-first shape so one folder
 * sorts chronologically, and carries its own prefix so the retention sweep
 * matches it by name like the others. */
export function diskRedactLogFileName(startedAt: Date): string {
  const d = startedAt;
  return (
    `search-redact-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`
  );
}

function fileLine(r: DiskFileResult): string {
  const tag = `[${r.status}]`.padEnd(12);
  let line = `${tag}${r.rel}`;
  if (r.regions !== undefined) {
    line += ` — ${r.regions} region${r.regions === 1 ? '' : 's'}`;
  }
  if (r.reason) line += ` — ${r.reason}`;
  return line;
}

export function formatDiskRedactLog(run: DiskRedactLogRun): string {
  const { report } = run;
  const totals = summarize(report);
  const outcome = run.fatalError
    ? `FAILED — ${run.fatalError}`
    : report.cancelled
      ? 'STOPPED by the user (files finished before the stop remain written)'
      : 'completed';

  const lines: string[] = [
    'Spectra PDF — Search & Redact folder log',
    `Started:      ${formatTimestamp(run.startedAt)}`,
    `Finished:     ${formatTimestamp(run.finishedAt)}  (${formatDuration(
      run.finishedAt.getTime() - run.startedAt.getTime(),
    )})`,
    `Source:       ${run.sourceRoot}`,
    `Destination:  ${run.destRoot || 'IN PLACE — the source files were rewritten'}`,
    `Searched for: ${run.searchLabel}`,
    `Mode:         ${
      run.marksOnly
        ? 'marks only — /Redact annotations written, no content removed'
        : 'apply — the marked content was removed'
    }`,
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
      `Files: ${report.results.length} processed — ${totals.redacted} redacted · ` +
        `${totals.marked} marked · ${totals.copied} copied unchanged · ` +
        `${totals.unchanged} left alone · ${totals.skipped} skipped`,
    );
    lines.push(`Regions written: ${totals.regions}`);
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
