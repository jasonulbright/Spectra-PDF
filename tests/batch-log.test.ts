import { describe, it, expect } from 'vitest';
import {
  formatBatchLog,
  batchLogFileName,
  formatDuration,
  formatTimestamp,
  type BatchLogRun,
} from '../src/renderer/lib/batch-log';
import type { BatchReport } from '../src/renderer/lib/batch-ocr';

// Fixed local-time instants — the formatter is local-clock by design (a batch
// user reasons about "the 09:30 run"), so the tests construct local Dates too
// and never assert a UTC offset.
const started = new Date(2026, 6, 25, 9, 30, 12); // 2026-07-25 09:30:12
const finished = new Date(2026, 6, 25, 9, 47, 3); // +16m 51s

function run(report: BatchReport, extra: Partial<BatchLogRun> = {}): BatchLogRun {
  return {
    startedAt: started,
    finishedAt: finished,
    sourceRoot: 'C:\\scans\\inbox',
    destRoot: 'D:\\searchable',
    lang: 'eng+fra',
    langLabel: 'English, French',
    report,
    ...extra,
  };
}

const empty: BatchReport = { cancelled: false, results: [], skippedDirs: [] };

describe('batchLogFileName', () => {
  it('is date-first, colon-free and sortable', () => {
    expect(batchLogFileName(started)).toBe('batch-ocr-2026-07-25_093012.log');
  });

  it('zero-pads every component', () => {
    expect(batchLogFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'batch-ocr-2026-01-02_030405.log',
    );
  });

  it('matches the pattern the Rust retention sweep will only ever delete', () => {
    // Guard on the contract, not the cosmetics: `is_batch_log_name` in
    // commands.rs requires this prefix/suffix, no separators, and <= 64 chars.
    const name = batchLogFileName(new Date(2026, 11, 31, 23, 59, 59));
    expect(name.startsWith('batch-ocr-')).toBe(true);
    expect(name.endsWith('.log')).toBe(true);
    expect(name).not.toMatch(/[\\/]/);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe('formatTimestamp', () => {
  it('renders local wall-clock', () => {
    expect(formatTimestamp(started)).toBe('2026-07-25 09:30:12');
  });
});

describe('formatDuration', () => {
  it('reads seconds under a minute', () => {
    expect(formatDuration(48_000)).toBe('48s');
  });
  it('reads minutes and seconds', () => {
    expect(formatDuration(16 * 60_000 + 51_000)).toBe('16m 51s');
  });
  it('reads hours for a long unattended run', () => {
    expect(formatDuration(3 * 3_600_000 + 4 * 60_000 + 9_000)).toBe('3h 04m 09s');
  });
  it('never goes negative on a clock that moved', () => {
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('formatBatchLog', () => {
  it('carries the run header', () => {
    const text = formatBatchLog(run(empty));
    expect(text).toContain('Started:      2026-07-25 09:30:12');
    expect(text).toContain('Finished:     2026-07-25 09:47:03  (16m 51s)');
    expect(text).toContain('Source:       C:\\scans\\inbox');
    expect(text).toContain('Destination:  D:\\searchable');
    expect(text).toContain('Languages:    eng+fra (English, French)');
    expect(text).toContain('Result:       completed');
  });

  it('gives one greppable line per file, status first', () => {
    const text = formatBatchLog(
      run({
        cancelled: false,
        skippedDirs: [],
        results: [
          { rel: 'invoices\\jan.pdf', status: 'ocr', pagesOcrd: 12 },
          { rel: 'reports\\q1.pdf', status: 'copied' },
          { rel: 'locked\\payroll.pdf', status: 'skipped', reason: 'password-protected' },
        ],
      }),
    );
    expect(text).toContain('[ocr]     invoices\\jan.pdf — 12 pages made searchable');
    expect(text).toContain('[copied]  reports\\q1.pdf');
    expect(text).toContain('[skipped] locked\\payroll.pdf — password-protected');
    // The whole point of the fixed-width tag: one filter answers "what failed".
    const failures = text.split('\r\n').filter((l) => l.startsWith('[skipped]'));
    expect(failures).toHaveLength(1);
  });

  it('singularises a one-page file', () => {
    const text = formatBatchLog(
      run({ cancelled: false, skippedDirs: [], results: [{ rel: 'a.pdf', status: 'ocr', pagesOcrd: 1 }] }),
    );
    expect(text).toContain('1 page made searchable');
  });

  it('keeps the honesty notes rather than reading cleaner than the screen', () => {
    const text = formatBatchLog(
      run({
        cancelled: false,
        skippedDirs: [],
        results: [
          {
            rel: 'mixed.pdf',
            status: 'ocr',
            pagesOcrd: 8,
            reason: '3 of 11 scanned pages had no recognizable text',
          },
          { rel: 'blank.pdf', status: 'copied', reason: 'no text recognized' },
        ],
      }),
    );
    expect(text).toContain('(3 of 11 scanned pages had no recognizable text)');
    expect(text).toContain('[copied]  blank.pdf — no text recognized');
  });

  it('counts the two kinds of copy separately', () => {
    const text = formatBatchLog(
      run({
        cancelled: false,
        skippedDirs: [],
        results: [
          { rel: 'a.pdf', status: 'ocr', pagesOcrd: 2 },
          { rel: 'b.pdf', status: 'copied' },
          { rel: 'c.pdf', status: 'copied', reason: 'no text recognized' },
          { rel: 'd.pdf', status: 'skipped', reason: 'unreadable: boom' },
        ],
      }),
    );
    expect(text).toContain(
      'Files: 4 processed — 1 made searchable · 1 copied (already searchable) · ' +
        '1 copied (no text recognized) · 1 skipped',
    );
  });

  it('says a stopped run was stopped, and that finished files remain', () => {
    const text = formatBatchLog(
      run({ cancelled: true, skippedDirs: [], results: [{ rel: 'a.pdf', status: 'ocr', pagesOcrd: 1 }] }),
    );
    expect(text).toContain('Result:       STOPPED by the user');
    expect(text).toContain('remain in the destination');
  });

  it('lists unreadable subfolders so the mirror has no silent holes', () => {
    const text = formatBatchLog(
      run({ cancelled: false, results: [], skippedDirs: ['C:\\scans\\inbox\\restricted'] }),
    );
    expect(text).toContain('Unreadable subfolders (missing from the mirror):');
    expect(text).toContain('  C:\\scans\\inbox\\restricted');
  });

  it('never reports "0 processed" for a run that died mid-flight', () => {
    // The driver throws out without a per-file record, but files mirrored
    // before the failure are still on disk — "nothing happened" is the one
    // thing the log must not imply.
    const text = formatBatchLog(run(empty, { fatalError: 'engine exited' }));
    expect(text).toContain('Result:       FAILED — engine exited');
    expect(text).toContain('No per-file record');
    expect(text).toContain('remain in the destination folder');
    expect(text).not.toContain('0 processed');
    expect(text).not.toContain('(no files were processed)');
  });

  it('does say so when a clean run genuinely had no files', () => {
    const text = formatBatchLog(run(empty));
    expect(text).toContain('Files: 0 processed');
    expect(text).toContain('(no files were processed)');
  });

  it('uses CRLF and ends with a newline', () => {
    const text = formatBatchLog(run(empty));
    expect(text).toContain('\r\n');
    expect(text.endsWith('\r\n')).toBe(true);
  });
});
