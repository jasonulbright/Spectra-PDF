// The folder form-preparation run log. What a reader of this file needs is a
// countable record of what was written and what was refused, so the pins are
// the lines a grep depends on: the fixed-width status tag, the count of
// FIELDS beside the count of candidates that produced them, and a refusal
// that names its reason.
import { describe, expect, it } from 'vitest';
import { formatPrepLog, prepLogFileName } from '../src/renderer/lib/folder-prep-log';
import type { PrepReport } from '../src/renderer/lib/folder-prep';

const STARTED = new Date(2026, 0, 2, 3, 4, 5);
const FINISHED = new Date(2026, 0, 2, 3, 6, 35);

function run(report: PrepReport, extra: Record<string, unknown> = {}) {
  return formatPrepLog({
    startedAt: STARTED,
    finishedAt: FINISHED,
    sourceRoot: 'C:\\src',
    destRoot: 'D:\\out',
    scanLabel: 'auto (English)',
    includeSigned: false,
    report,
    ...extra,
  });
}

describe('the prep log name', () => {
  it('carries the prefix the retention sweep matches on', () => {
    expect(prepLogFileName(STARTED)).toBe('form-prep-2026-01-02_030405.log');
  });
});

describe('the prep log body', () => {
  it('counts the fields created and the candidates behind them', () => {
    const text = run({
      cancelled: false,
      skippedDirs: [],
      results: [
        { rel: 'a.pdf', status: 'prepared', fields: 3, candidates: 6 },
        { rel: 'sub\\b.pdf', status: 'copied' },
      ],
    });
    expect(text).toContain('[prepared]  a.pdf — 3 fields from 6 candidates');
    expect(text).toContain('Fields created: 3');
    expect(text).toContain('1 prepared');
  });

  it('names why a file was skipped', () => {
    const text = run({
      cancelled: false,
      skippedDirs: [],
      results: [
        { rel: 'a.pdf', status: 'skipped', reason: 'certified to allow no changes' },
      ],
    });
    expect(text).toContain('[skipped]   a.pdf — certified to allow no changes');
  });

  it('says the originals were rewritten when there is no destination', () => {
    const text = run(
      { cancelled: false, skippedDirs: [], results: [] },
      { destRoot: '' },
    );
    expect(text).toContain('IN PLACE');
  });

  it('records that signed documents were included', () => {
    const text = run(
      { cancelled: false, skippedDirs: [], results: [] },
      { includeSigned: true },
    );
    expect(text).toContain('INCLUDED');
  });

  it('says a stop left what it had already written', () => {
    const text = run({
      cancelled: true,
      skippedDirs: [],
      results: [{ rel: 'a.pdf', status: 'prepared', fields: 1, candidates: 1 }],
    });
    expect(text).toContain('STOPPED by the user');
  });

  it('does not read as "nothing happened" when the run failed structurally', () => {
    const text = run(
      { cancelled: false, skippedDirs: [], results: [] },
      { fatalError: 'the engine stopped responding' },
    );
    expect(text).toContain('FAILED — the engine stopped responding');
    expect(text).toContain('No per-file record');
  });

  it('names the subfolders the walk could not read', () => {
    const text = run({
      cancelled: false,
      skippedDirs: ['C:\\src\\locked'],
      results: [],
    });
    expect(text).toContain('C:\\src\\locked');
  });
});
