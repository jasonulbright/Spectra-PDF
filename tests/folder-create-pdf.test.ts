// One PDF per folder (lib/folder-create-pdf.ts): the driver's state machine
// with the engine and the filesystem injected — per-folder failure isolation,
// the mirror key, cancellation and the summary. The GROUPING and the
// within-folder ORDER are the engine's (tests/test_create_pdf_folders.py);
// nothing here re-implements them, which is the point of enumerating through
// the engine's own walk.
import { describe, expect, it, vi } from 'vitest';
import {
  folderLabel,
  runFolderCreatePdf,
  summarize,
  type FolderCreatePdfIo,
  type FolderListing,
} from '../src/renderer/lib/folder-create-pdf';
import { formatFolderCreatePdfLog } from '../src/renderer/lib/folder-create-pdf-log';

function listing(): FolderListing {
  return {
    source: 'C:\\scans',
    groups: [
      {
        rel: '',
        name: 'scans',
        output: 'scans.pdf',
        files: ['C:\\scans\\cover.png'],
        count: 1,
      },
      {
        rel: 'invoice',
        name: 'invoice',
        output: 'invoice.pdf',
        files: ['C:\\scans\\invoice\\page1.png', 'C:\\scans\\invoice\\page2.png'],
        count: 2,
      },
      {
        rel: 'invoice\\sub\\letter',
        name: 'letter',
        output: 'invoice\\sub\\letter.pdf',
        files: ['C:\\scans\\invoice\\sub\\letter\\a.png'],
        count: 1,
      },
    ],
    skippedDirs: [],
  };
}

function io(overrides: Partial<FolderCreatePdfIo> = {}): FolderCreatePdfIo {
  return {
    buildFolder: vi.fn(async (files: string[]) => ({ pages: files.length })),
    ensureParentDirs: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('the run', () => {
  it('builds one document per folder, at the folder’s own place in the mirror', async () => {
    const built: [string[], string][] = [];
    const report = await runFolderCreatePdf(
      listing(),
      io({
        buildFolder: async (files, output) => {
          built.push([files, output]);
          return { pages: files.length };
        },
      }),
      { destRoot: 'C:\\out' },
    );
    expect(report.results.map((r) => r.status)).toEqual(['built', 'built', 'built']);
    expect(built.map(([, out]) => out)).toEqual([
      'C:\\out\\scans.pdf',
      'C:\\out\\invoice.pdf',
      'C:\\out\\invoice\\sub\\letter.pdf',
    ]);
    // The members reach the builder in the order the listing gave them —
    // the driver never re-sorts, because the order is the engine's answer.
    expect(built[1][0]).toEqual([
      'C:\\scans\\invoice\\page1.png',
      'C:\\scans\\invoice\\page2.png',
    ]);
  });

  it('creates each output’s parent before writing it', async () => {
    const dirs: string[] = [];
    await runFolderCreatePdf(
      listing(),
      io({ ensureParentDirs: async (p) => void dirs.push(p) }),
      { destRoot: 'C:\\out' },
    );
    expect(dirs).toContain('C:\\out\\invoice\\sub\\letter.pdf');
  });

  it('isolates one folder’s refusal from the rest of the run', async () => {
    const report = await runFolderCreatePdf(
      listing(),
      io({
        buildFolder: async (files) => {
          if (files[0].includes('invoice\\page1')) {
            throw new Error('nothing could be converted, so there is no PDF to write');
          }
          return { pages: files.length };
        },
      }),
      { destRoot: 'C:\\out' },
    );
    const totals = summarize(report);
    expect(totals.built).toBe(2);
    expect(totals.failed).toBe(1);
    const failed = report.results.find((r) => r.status === 'failed')!;
    expect(failed.rel).toBe('invoice');
    // The engine's own English, so the log reads the same in every locale.
    expect(failed.reason).toContain('nothing could be converted');
  });

  it('reports a member the builder could not read without failing the folder', async () => {
    const report = await runFolderCreatePdf(
      listing(),
      io({
        buildFolder: async (files) => ({
          pages: files.length - 1,
          warnings: ['page2.png: unreadable image'],
        }),
      }),
      { destRoot: 'C:\\out' },
    );
    expect(report.results.every((r) => r.status === 'built')).toBe(true);
    // Never a silent drop: the document was written and something is missing
    // from it, so the row says which file.
    expect(report.results[1].warnings).toEqual(['page2.png: unreadable image']);
  });

  it('stops after the folder in flight and says so', async () => {
    let seen = 0;
    const report = await runFolderCreatePdf(
      listing(),
      io({
        buildFolder: async (files) => {
          seen += 1;
          return { pages: files.length };
        },
      }),
      { destRoot: 'C:\\out', isCancelled: () => seen >= 1 },
    );
    expect(report.cancelled).toBe(true);
    expect(report.results).toHaveLength(1);
  });

  it('reports progress by folder, which is the run’s unit', async () => {
    const seen: string[] = [];
    await runFolderCreatePdf(listing(), io(), {
      destRoot: 'C:\\out',
      onProgress: (p) => {
        seen.push(`${p.folderIndex + 1}/${p.folderCount} ${p.output}`);
      },
    });
    expect(seen).toEqual([
      '1/3 scans.pdf',
      '2/3 invoice.pdf',
      '3/3 invoice\\sub\\letter.pdf',
    ]);
  });

  it('carries the walk’s unreadable subfolders into the report', async () => {
    const source = { ...listing(), skippedDirs: ['[WinError 5] Access is denied: locked'] };
    const report = await runFolderCreatePdf(source, io(), { destRoot: 'C:\\out' });
    expect(report.skippedDirs).toHaveLength(1);
  });

  it('is an empty run rather than a failure when nothing groups', async () => {
    const report = await runFolderCreatePdf(
      { source: 'C:\\scans', groups: [], skippedDirs: [] },
      io(),
      { destRoot: 'C:\\out' },
    );
    expect(report.results).toEqual([]);
    expect(summarize(report)).toEqual({ built: 0, failed: 0, pages: 0 });
  });
});

describe('the row label', () => {
  it('names the ROOT folder by its output, never by an empty string', async () => {
    const groups = listing().groups;
    expect(folderLabel(groups[0])).toBe('scans.pdf');
    expect(folderLabel(groups[1])).toBe('invoice');
  });
});

describe('the log', () => {
  it('records the route, every folder, and the totals', async () => {
    const report = await runFolderCreatePdf(listing(), io(), { destRoot: 'C:\\out' });
    const text = formatFolderCreatePdfLog({
      startedAt: new Date('2026-08-09T04:00:00'),
      finishedAt: new Date('2026-08-09T04:00:30'),
      sourceRoot: 'C:\\scans',
      destRoot: 'C:\\out',
      optionLabel: 'pictures only · 200 dpi',
      report,
    });
    expect(text).toContain('Spectra PDF — one PDF per folder log');
    expect(text).toContain('C:\\scans');
    expect(text).toContain('Result:       completed');
    expect(text).toContain('Folders: 3 processed — 3 built · 0 failed · 4 page(s) in total');
    expect(text).toContain('[built]   invoice -> invoice.pdf — 2 file(s), 2 page(s)');
  });

  it('records a failed folder’s reason and an unread member under its folder', async () => {
    const report = await runFolderCreatePdf(
      listing(),
      io({
        buildFolder: async (files) => {
          if (files[0].includes('cover')) throw new Error('unreadable image: cover.png');
          return { pages: files.length, warnings: ['a.png: unreadable image'] };
        },
      }),
      { destRoot: 'C:\\out' },
    );
    const text = formatFolderCreatePdfLog({
      startedAt: new Date('2026-08-09T04:00:00'),
      finishedAt: new Date('2026-08-09T04:00:30'),
      sourceRoot: 'C:\\scans',
      destRoot: 'C:\\out',
      optionLabel: '',
      report,
    });
    expect(text).toContain('[failed]  scans.pdf — unreadable image: cover.png');
    expect(text).toContain('! a.png: unreadable image');
    expect(text).toContain('Options:      the defaults');
  });

  it('says a stop happened, and that what finished stays written', async () => {
    const report = await runFolderCreatePdf(listing(), io(), {
      destRoot: 'C:\\out',
      isCancelled: () => true,
    });
    const text = formatFolderCreatePdfLog({
      startedAt: new Date('2026-08-09T04:00:00'),
      finishedAt: new Date('2026-08-09T04:00:01'),
      sourceRoot: 'C:\\scans',
      destRoot: 'C:\\out',
      optionLabel: '',
      report,
    });
    expect(text).toContain('STOPPED by the user');
    expect(text).toContain('(no folder held anything to assemble)');
  });
});
