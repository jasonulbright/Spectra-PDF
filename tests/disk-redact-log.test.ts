// The disk Search & Redact run log. The log is the run's only durable record,
// so what is pinned is that every outcome reaches it — including the ones a
// reader most needs to find: what was skipped and why, and whether the run
// was allowed to touch signed documents or rewrite the originals.
import { describe, expect, it } from 'vitest';
import {
  diskRedactLogFileName,
  formatDiskRedactLog,
  type DiskRedactLogRun,
} from '../src/renderer/lib/disk-redact-log';
import type { DiskRedactReport } from '../src/renderer/lib/disk-redact';

const STARTED = new Date(2026, 7, 6, 9, 30, 5);
const FINISHED = new Date(2026, 7, 6, 9, 31, 20);

function run(report: DiskRedactReport, extra: Partial<DiskRedactLogRun> = {}): string {
  return formatDiskRedactLog({
    startedAt: STARTED,
    finishedAt: FINISHED,
    sourceRoot: 'C:\\cases',
    destRoot: 'C:\\cases-redacted',
    searchLabel: 'Jane Roe',
    marksOnly: false,
    includeSigned: false,
    report,
    ...extra,
  });
}

describe('the log name', () => {
  it('sorts chronologically and carries its own prefix', () => {
    expect(diskRedactLogFileName(STARTED)).toBe('search-redact-2026-08-06_093005.log');
  });
});

describe('the log body', () => {
  const report: DiskRedactReport = {
    cancelled: false,
    results: [
      { rel: 'a.pdf', status: 'redacted', regions: 3 },
      { rel: 'sub\\b.pdf', status: 'copied' },
      { rel: 'c.pdf', status: 'skipped', reason: 'certified to allow no changes' },
    ],
    skippedDirs: ['C:\\cases\\locked'],
  };

  it('states every count, the mode and what the run was allowed to touch', () => {
    const text = run(report);
    expect(text).toContain('1 redacted');
    expect(text).toContain('1 copied unchanged');
    expect(text).toContain('1 skipped');
    expect(text).toContain('Regions written: 3');
    expect(text).toContain('the marked content was removed');
    expect(text).toContain('refused (left untouched)');
  });

  it('names the skipped file and its reason on one greppable line', () => {
    expect(run(report)).toContain('[skipped]   c.pdf — certified to allow no changes');
  });

  it('names the in-place mode where the destination would be', () => {
    expect(run(report, { destRoot: '' })).toContain('IN PLACE');
  });

  it('says so when signed documents were included and only marks were written', () => {
    const text = run(report, { includeSigned: true, marksOnly: true });
    expect(text).toContain('INCLUDED');
    expect(text).toContain('no content removed');
  });

  it('reports a stop as a stop, not as a completed run', () => {
    expect(run({ ...report, cancelled: true })).toContain('STOPPED by the user');
  });

  it('a run that died before returning a record says so rather than reading as empty', () => {
    const text = run(
      { cancelled: false, results: [], skippedDirs: [] },
      { fatalError: 'the engine stopped responding' },
    );
    expect(text).toContain('FAILED — the engine stopped responding');
    expect(text).toContain('No per-file record');
  });

  it('carries the unreadable subfolders the walk reported', () => {
    expect(run(report)).toContain('C:\\cases\\locked');
  });
});
