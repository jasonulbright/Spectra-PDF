// A cut-off picture is reported by the engine and said wherever it was
// imported: the result of one conversion, the folder driver and its run log.
import { describe, expect, it, vi } from 'vitest';
import { CUT_OFF_LOG_TEXT, incompleteSources } from '../src/renderer/lib/cut-off';
import { runFolderCreatePdf, type FolderCreatePdfIo, type FolderListing } from '../src/renderer/lib/folder-create-pdf';
import { formatFolderCreatePdfLog } from '../src/renderer/lib/folder-create-pdf-log';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ITEM = { path: 'C:\\photos\\set\\b-cut.heic', pages: '2' };

describe('reading the engine report', () => {
  it('keeps well-formed entries and drops everything else', () => {
    expect(incompleteSources([ITEM, { path: 'x' }, null, 'y', { path: 1, pages: '1' }])).toEqual([ITEM]);
    for (const value of [undefined, null, true, 'x', {}]) expect(incompleteSources(value)).toEqual([]);
  });

  it('uses the engine’s run-log sentence', () => {
    const engine = readFileSync(resolve(__dirname, '../src/engine/heif_check.py'), 'utf8');
    expect(engine).toContain(`LOG_TEXT = "${CUT_OFF_LOG_TEXT}"`);
  });
});

describe('the folder run', () => {
  const listing: FolderListing = {
    source: 'C:\\photos',
    groups: [{ rel: 'set', name: 'set', output: 'set.pdf', files: [ITEM.path], count: 1 }],
    skippedDirs: [],
  };

  async function run(built: { pages: number; incomplete?: (typeof ITEM)[] }) {
    const io: FolderCreatePdfIo = { buildFolder: vi.fn(async () => built), ensureParentDirs: vi.fn(async () => {}) };
    return runFolderCreatePdf(listing, io, { destRoot: 'C:\\out' } as never);
  }

  function logOf(report: Awaited<ReturnType<typeof run>>): string {
    return formatFolderCreatePdfLog({
      startedAt: new Date(0),
      finishedAt: new Date(1000),
      source: 'C:\\photos',
      dest: 'C:\\out',
      report,
    } as never);
  }

  it('carries the cut-off member to the row and the log', async () => {
    const report = await run({ pages: 2, incomplete: [ITEM] });
    expect(report.results[0].incomplete).toEqual([ITEM]);
    expect(logOf(report)).toContain(`! b-cut.heic (PDF pages: 2): ${CUT_OFF_LOG_TEXT}`);
  });

  it('says nothing for whole members', async () => {
    const report = await run({ pages: 2 });
    expect(report.results[0].incomplete).toBeUndefined();
    expect(logOf(report)).not.toContain('cut off');
  });
});
