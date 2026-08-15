// The droplet's renderer half: the settings and their two dependencies, the
// saved presets, and the localized report post-pass.
//
// The RUN itself is the engine's, so what is pinned here is what a renderer
// owns — including the one property no engine test can reach: a run driven
// from the app writes a text and an HTML report beside every JSON one, and a
// single file's emit failing never ends the pass.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SWEEP_MODES,
  defaultFolderPreflightSettings,
  emitLocalizedReports,
  loadFolderPreflightPresets,
  normalizeFolderPreflightSettings,
  presetNameProblem,
  removePreset,
  reportSidecars,
  saveFolderPreflightPresets,
  summarize,
  sweepParams,
  sweepProblem,
  upsertPreset,
  type FolderPreflightIo,
  type FolderPreflightSettings,
  type SweepRunReport,
} from '../src/renderer/lib/folder-preflight';
import type { PreflightReport } from '../src/renderer/lib/preflight-report';

// No DOM test environment here, which is exactly why the store lives in the
// model and not in the component (the batch-OCR presets precedent).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;
(globalThis as unknown as { crypto: Crypto }).crypto ??= {
  randomUUID: () => `id-${store.size}-${Math.random()}`,
} as unknown as Crypto;

beforeEach(() => store.clear());

function settings(overrides: Partial<FolderPreflightSettings> = {}): FolderPreflightSettings {
  return {
    ...defaultFolderPreflightSettings('sheetfed_offset'),
    source: 'C:\\in',
    dest: 'C:\\out',
    ...overrides,
  };
}

function report(overrides: Partial<SweepRunReport> = {}): SweepRunReport {
  return {
    source: 'C:\\in',
    dest: 'C:\\out',
    mode: 'check',
    profile: { id: 'sheetfed_offset', name: 'Sheetfed offset (CMYK)', name_key: '' },
    total: 3,
    ok: 3,
    failed: 0,
    clean: 2,
    skipped_dirs: [],
    duration_ms: 10,
    in_place: false,
    results: [
      { rel: 'a.pdf', status: 'ok', report: 'C:\\out\\a.pdf.preflight.json' },
      { rel: 'b.pdf', status: 'ok', report: 'C:\\out\\b.pdf.preflight.json' },
      { rel: 'c.pdf', status: 'error', error: 'not a PDF' },
    ],
    ...overrides,
  };
}

const REPORT: PreflightReport = {
  file: 'a.pdf',
  profile: { id: 'sheetfed_offset', name: '', name_key: '', based_on: '' },
  categories: [],
  summary: {
    passed: 1, failed: 0, warnings: 0, needs_review: 0,
    not_applicable: 0, applicable: 1, total: 1,
  },
  unreadable: [],
  checks: [],
  images: 0,
  color_families: [],
} as unknown as PreflightReport;

describe('the settings', () => {
  it('opens on check mode with every source-touching option off', () => {
    const base = defaultFolderPreflightSettings();
    expect(base.mode).toBe('check');
    expect(base.inPlace).toBe(false);
    expect(base.movedRoot).toBe('');
  });

  it('reads an unknown mode as check, never as fix', () => {
    expect(normalizeFolderPreflightSettings({ mode: 'audit' }).mode).toBe('check');
    expect(SWEEP_MODES).toEqual(['check', 'fix']);
  });

  it('retires in-place and the processed root in check mode', () => {
    // A check writes nothing, so both would name a copy that is never made.
    const read = normalizeFolderPreflightSettings({
      mode: 'check', inPlace: true, movedRoot: 'C:\\done',
    });
    expect(read.inPlace).toBe(false);
    expect(read.movedRoot).toBe('');
  });

  it('retires the destination and the processed root under in-place', () => {
    const read = normalizeFolderPreflightSettings({
      mode: 'fix', inPlace: true, dest: 'C:\\out', movedRoot: 'C:\\done',
    });
    expect(read.dest).toBe('');
    expect(read.movedRoot).toBe('');
  });

  it('reads a switch as on only when the stored value IS true', () => {
    expect(normalizeFolderPreflightSettings({ mode: 'fix', inPlace: 1 }).inPlace)
      .toBe(false);
    expect(normalizeFolderPreflightSettings({ writeLog: 'yes' }).writeLog).toBe(false);
  });
});

describe('what stops a run before it starts', () => {
  it('names each impossible combination the engine would refuse', () => {
    expect(sweepProblem(settings({ source: '' }), [])).toBe('noSource');
    expect(sweepProblem(settings({ profileId: '' }), [])).toBe('noProfile');
    expect(sweepProblem(settings({ dest: '' }), [])).toBe('noDest');
    expect(sweepProblem(settings({ mode: 'check', inPlace: true }), []))
      .toBe('checkInPlace');
    expect(sweepProblem(settings({ mode: 'fix' }), [])).toBe('noFixups');
  });

  it('lets a fix run start when the profile carries a fixup', () => {
    expect(sweepProblem(settings({ mode: 'fix' }), ['fix_hairlines'])).toBeNull();
  });

  it('lets an in-place fix run start with no destination', () => {
    expect(sweepProblem(settings({ mode: 'fix', inPlace: true, dest: '' }),
      ['fix_hairlines'])).toBeNull();
  });
});

describe('the engine call', () => {
  it('carries the profile as given and clears the destination in place', () => {
    const params = sweepParams(
      settings({ mode: 'fix', inPlace: true, dest: 'C:\\out' }),
      'sheetfed_offset',
      { gs: 'gs.exe', fonts: 'F', tesseract: 'T', logDir: 'L' },
    );
    expect(params.dest).toBe('');
    expect(params.in_place).toBe(true);
    expect(params.profile).toBe('sheetfed_offset');
    expect(params.log_dir).toBe('L');
  });

  it('sends no log folder when the run is not writing one', () => {
    const params = sweepParams(settings({ writeLog: false }), {},
      { gs: '', fonts: '', tesseract: '', logDir: 'L' });
    expect(params.write_log).toBe(false);
    expect(params.log_dir).toBe('');
  });
});

describe('the report artifacts', () => {
  it('names the sidecars after the JSON the engine wrote', () => {
    expect(reportSidecars('C:\\out\\a.pdf.preflight.json')).toEqual({
      text: 'C:\\out\\a.pdf.preflight.txt',
      html: 'C:\\out\\a.pdf.preflight.html',
    });
  });

  it('writes a text and an HTML report for every measured document', async () => {
    const written: string[] = [];
    const io: FolderPreflightIo = {
      run: async () => report(),
      readReport: async () => REPORT,
      writeReport: async (path) => {
        written.push(path);
        return path;
      },
    };
    const result = await emitLocalizedReports(report(), io, new Date(2026, 7, 15));
    expect(result.written).toBe(2);
    expect(result.errors).toEqual([]);
    expect(written).toEqual([
      'C:\\out\\a.pdf.preflight.txt',
      'C:\\out\\a.pdf.preflight.html',
      'C:\\out\\b.pdf.preflight.txt',
      'C:\\out\\b.pdf.preflight.html',
    ]);
  });

  it('records one row’s failure and keeps going', async () => {
    const io: FolderPreflightIo = {
      run: async () => report(),
      readReport: async (path) => {
        if (path.includes('a.pdf')) throw new Error('unreadable');
        return REPORT;
      },
      writeReport: async (path) => path,
    };
    const result = await emitLocalizedReports(report(), io, new Date());
    expect(result.written).toBe(1);
    expect(result.errors).toEqual([{ rel: 'a.pdf', reason: 'unreadable' }]);
  });

  it('emits nothing for a row that produced no report', async () => {
    const io: FolderPreflightIo = {
      run: async () => report(),
      readReport: async () => REPORT,
      writeReport: async (path) => path,
    };
    const only = report({ results: [{ rel: 'c.pdf', status: 'error', error: 'x' }] });
    expect((await emitLocalizedReports(only, io, new Date())).written).toBe(0);
  });
});

describe('the totals', () => {
  it('counts clean the way the engine and the log do', () => {
    expect(summarize(report())).toEqual({ clean: 2, dirty: 1, failed: 0, total: 3 });
  });
});

describe('the presets', () => {
  it('round-trips through the store', () => {
    const saved = upsertPreset([], 'Weekly press', settings({ mode: 'fix' }));
    saveFolderPreflightPresets(saved);
    const read = loadFolderPreflightPresets();
    expect(read).toHaveLength(1);
    expect(read[0].name).toBe('Weekly press');
    expect(read[0].settings.mode).toBe('fix');
  });

  it('replaces a preset of the same name rather than adding a second', () => {
    const first = upsertPreset([], 'Weekly', settings());
    const second = upsertPreset(first, 'weekly', settings({ mode: 'fix' }));
    expect(second).toHaveLength(1);
    expect(second[0].settings.mode).toBe('fix');
  });

  it('normalizes what it stores, so an impossible pair cannot be saved', () => {
    const saved = upsertPreset([], 'Bad', settings({ mode: 'check', inPlace: true }));
    expect(saved[0].settings.inPlace).toBe(false);
  });

  it('refuses a name that cannot address a preset', () => {
    const saved = upsertPreset([], 'Weekly', settings());
    expect(presetNameProblem('  ', saved)).toBe('empty');
    expect(presetNameProblem('x'.repeat(200), saved)).toBe('tooLong');
    expect(presetNameProblem('weekly', saved)).toBe('duplicate');
    expect(presetNameProblem('weekly', saved, saved[0].id)).toBeNull();
  });

  it('drops a stored row that cannot be addressed', () => {
    store.set('spectra-preflight-sweep-presets', JSON.stringify([
      { id: '', name: 'no id', settings: {} },
      { id: 'a', name: '', settings: {} },
      { id: 'b', name: 'fine', settings: {} },
      { id: 'b', name: 'duplicate id', settings: {} },
    ]));
    const read = loadFolderPreflightPresets();
    expect(read.map((p) => p.name)).toEqual(['fine']);
  });

  it('removes by id', () => {
    const saved = upsertPreset([], 'Weekly', settings());
    expect(removePreset(saved, saved[0].id)).toEqual([]);
  });
});
