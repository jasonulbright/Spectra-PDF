// The folder-export driver: the mirror key, per-file failure isolation,
// cancellation, and the run log the sweep leaves behind.
//
// Every side effect is injected, so the whole state machine runs with no Tauri
// and no engine (the batch-OCR precedent).
import { describe, it, expect } from 'vitest';
import {
  runFolderExport,
  summarize,
  type FolderExportIo,
} from '../src/renderer/lib/folder-export';
import {
  folderExportLogFileName,
  formatFolderExportLog,
} from '../src/renderer/lib/folder-export-log';
import type { DiskEntry } from '../src/renderer/lib/folder-sweep';
import type { ExportOptionValues } from '../src/renderer/lib/export-targets';

const VALUES: ExportOptionValues = {
  pages: '',
  layout: 'reading',
  pageBreaks: false,
  sheetPer: 'table',
  includeUntabled: false,
  slideSize: 'page',
};

const ENTRIES: DiskEntry[] = [
  { abs: 'C:\\src\\alpha.pdf', rel: 'alpha.pdf' },
  { abs: 'C:\\src\\sub\\beta.pdf', rel: 'sub\\beta.pdf' },
];

interface Call {
  abs: string;
  output: string;
  format: string;
  params: Record<string, unknown>;
}

function io(
  behaviour: (abs: string) => unknown,
  calls: Call[] = [],
  dirs: string[] = [],
): FolderExportIo {
  return {
    async exportFile(abs, output, format, params) {
      calls.push({ abs, output, format, params });
      const result = behaviour(abs);
      if (result instanceof Error) throw result;
      return result as never;
    },
    async ensureParentDirs(path) {
      dirs.push(path);
    },
  };
}

describe('the folder-export sweep', () => {
  it('mirrors the tree, swapping each name for the target extension', async () => {
    const calls: Call[] = [];
    const report = await runFolderExport(ENTRIES, [], io(() => ({ tables: [{}], pages_analyzed: [1] }), calls), {
      destRoot: 'D:\\out',
      format: 'xlsx',
      values: VALUES,
    });
    expect(calls.map((c) => c.output)).toEqual([
      'D:\\out\\alpha.xlsx',
      'D:\\out\\sub\\beta.xlsx',
    ]);
    expect(report.results.map((r) => r.out)).toEqual(['alpha.xlsx', 'sub\\beta.xlsx']);
    // The SOURCE's tree position keys every row: it is what a reader matches
    // against the folder they picked.
    expect(report.results.map((r) => r.rel)).toEqual(['alpha.pdf', 'sub\\beta.pdf']);
  });

  it("builds one parameter set from the target's own declared options", async () => {
    const calls: Call[] = [];
    await runFolderExport(ENTRIES, [], io(() => ({ output: 'x' }), calls), {
      destRoot: 'D:\\out',
      format: 'docx',
      values: { ...VALUES, pages: '1,2' },
    });
    // A target that declares nothing is sent nothing: the engine refuses an
    // undeclared option, so a page scope here would fail every file.
    expect(calls[0].params).toEqual({ fmt: 'docx' });
    expect(calls[0].params).toBe(calls[1].params);
  });

  it("records a producer's refusal as one file's result and keeps going", async () => {
    const report = await runFolderExport(
      ENTRIES,
      [],
      io((abs) =>
        abs.includes('alpha')
          ? new Error('no table was found in this document')
          : { tables: [{}], pages_analyzed: [1] },
      ),
      { destRoot: 'D:\\out', format: 'xlsx', values: VALUES },
    );
    expect(report.results[0]).toEqual({
      rel: 'alpha.pdf',
      status: 'skipped',
      reason: 'no table was found in this document',
    });
    expect(report.results[1].status).toBe('exported');
    expect(summarize(report)).toEqual({ exported: 1, skipped: 1 });
  });

  it('stops after the in-flight file and says so', async () => {
    let seen = 0;
    const report = await runFolderExport(ENTRIES, [], io(() => ({ output: 'x' })), {
      destRoot: 'D:\\out',
      format: 'txt',
      values: VALUES,
      onProgress: () => {
        seen += 1;
      },
      isCancelled: () => seen >= 1,
    });
    expect(report.cancelled).toBe(true);
    expect(report.results).toHaveLength(1);
  });

  it('creates the mirror subfolder before writing into it', async () => {
    const dirs: string[] = [];
    await runFolderExport(ENTRIES, [], io(() => ({ output: 'x' }), [], dirs), {
      destRoot: 'D:\\out',
      format: 'txt',
      values: VALUES,
    });
    expect(dirs).toEqual(['D:\\out\\alpha.txt', 'D:\\out\\sub\\beta.txt']);
  });

  it('carries the unreadable subfolders the enumeration reported', async () => {
    const report = await runFolderExport(ENTRIES, ['C:\\src\\locked'], io(() => ({ output: 'x' })), {
      destRoot: 'D:\\out',
      format: 'txt',
      values: VALUES,
    });
    expect(report.skippedDirs).toEqual(['C:\\src\\locked']);
  });
});

describe('the folder-export run log', () => {
  const started = new Date(2026, 0, 2, 3, 4, 5);
  const finished = new Date(2026, 0, 2, 3, 4, 35);

  it('names itself with the prefix the retention sweep matches', () => {
    expect(folderExportLogFileName(started)).toBe('folder-export-2026-01-02_030405.log');
  });

  it('states the outcome, both counts, and every file either way', () => {
    const text = formatFolderExportLog({
      startedAt: started,
      finishedAt: finished,
      sourceRoot: 'C:\\src',
      destRoot: 'D:\\out',
      format: 'xlsx',
      optionLabel: 'sheet per table',
      report: {
        cancelled: false,
        results: [
          { rel: 'alpha.pdf', status: 'exported', out: 'alpha.xlsx', produced: '2 tables from 3 pages' },
          { rel: 'sub\\beta.pdf', status: 'skipped', reason: 'no table was found in this document' },
        ],
        skippedDirs: ['C:\\src\\locked'],
      },
    });
    expect(text).toContain('Format:       xlsx');
    expect(text).toContain('Result:       completed');
    expect(text).toContain('2 processed — 1 exported · 1 skipped');
    expect(text).toContain('[exported]  alpha.pdf -> alpha.xlsx — 2 tables from 3 pages');
    expect(text).toContain('[skipped]   sub\\beta.pdf — no table was found in this document');
    expect(text).toContain('C:\\src\\locked');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('never reports a structural failure as nothing having happened', () => {
    const text = formatFolderExportLog({
      startedAt: started,
      finishedAt: finished,
      sourceRoot: 'C:\\src',
      destRoot: 'D:\\out',
      format: 'txt',
      optionLabel: '',
      report: { cancelled: false, results: [], skippedDirs: [] },
      fatalError: 'the engine stopped responding',
    });
    expect(text).toContain('FAILED — the engine stopped responding');
    expect(text).toContain('No per-file record');
    expect(text).not.toContain('0 processed');
    // An empty option line still says something rather than trailing off.
    expect(text).toContain('Options:      the target defaults');
  });
});
