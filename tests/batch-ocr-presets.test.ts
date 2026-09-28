// Named Batch OCR presets (lib/batch-ocr-presets.ts): the normalizer's safety
// rules, the name rules, and the store round trip (localStorage stubbed — no
// DOM env). The scheduler half of the freeze is pinned in Rust
// (src-tauri/src/scheduler.rs), because the command line is where it lands.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PRESET_MAX,
  PRESET_NAME_MAX,
  defaultBatchOcrSettings,
  duplicatePreset,
  duplicatePresetName,
  loadBatchOcrPresets,
  normalizeBatchOcrSettings,
  presetNameProblem,
  presetScheduleFields,
  removePreset,
  renamePreset,
  saveBatchOcrPresets,
  upsertPreset,
  type BatchOcrPreset,
  type BatchOcrSettings,
} from '../src/renderer/lib/batch-ocr-presets';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

beforeEach(() => store.clear());

function filled(): BatchOcrSettings {
  return {
    source: 'C:\\intake',
    dest: 'C:\\searchable',
    langs: ['eng', 'fra'],
    inPlace: false,
    movedRoot: 'C:\\done',
    errorRoot: 'C:\\failed',
    repairDamaged: true,
    replaceRepairedOriginals: true,
    mrc: true,
    mrcPreset: 'smallest',
    mrcVerifyText: true,
    enhance: true,
    enhanceOrientation: false,
    removeEmptyFolders: true,
    repairOnly: false,
  };
}

describe('the normalizer', () => {
  it('carries a full settings object through unchanged', () => {
    expect(normalizeBatchOcrSettings(filled())).toEqual(filled());
  });

  it('resolves an unreadable value to the setting that changes nothing', () => {
    // Every switch here either moves the user's own files or rewrites page
    // images. A value the reader does not understand must never resolve to the
    // one that acts.
    const junk = normalizeBatchOcrSettings({
      source: 42,
      dest: null,
      langs: 'eng',
      inPlace: 'true',
      movedRoot: {},
      errorRoot: [],
      repairDamaged: 1,
      replaceRepairedOriginals: 'yes',
      mrc: 'on',
      mrcPreset: 'enormous',
      mrcVerifyText: 1,
      enhance: 'yes',
    });
    expect(junk).toEqual(defaultBatchOcrSettings());
    expect(junk.inPlace).toBe(false);
    expect(junk.repairDamaged).toBe(false);
    expect(junk.mrc).toBe(false);
    expect(junk.mrcPreset).toBe('balanced');
  });

  it('is total over values that are not settings at all', () => {
    for (const raw of [null, undefined, 7, 'preset', [], true]) {
      expect(normalizeBatchOcrSettings(raw)).toEqual(defaultBatchOcrSettings());
    }
  });

  it('lets the in-place run retire the settings it makes meaningless', () => {
    const s = normalizeBatchOcrSettings({ ...filled(), inPlace: true });
    expect(s.inPlace).toBe(true);
    // The processed file IS the original: a destination and a
    // processed-originals folder both name a copy that is never written.
    expect(s.dest).toBe('');
    expect(s.movedRoot).toBe('');
    // The failed-originals root still applies — a failure leaves the original
    // in place, so there is something to file.
    expect(s.errorRoot).toBe('C:\\failed');
  });

  it('refuses to arm the replace half without the repair half', () => {
    const s = normalizeBatchOcrSettings({
      ...filled(),
      repairDamaged: false,
      replaceRepairedOriginals: true,
    });
    expect(s.replaceRepairedOriginals).toBe(false);
  });

  it('defaults orientation ON but honours an explicit off', () => {
    // The one switch whose shipped default is on; a preset written before it
    // existed must not silently lose it.
    expect(normalizeBatchOcrSettings({ enhance: true }).enhanceOrientation).toBe(true);
    expect(
      normalizeBatchOcrSettings({ enhance: true, enhanceOrientation: false }).enhanceOrientation,
    ).toBe(false);
  });

  it('drops empty language entries and falls back rather than recognising nothing', () => {
    expect(normalizeBatchOcrSettings({ langs: ['eng', '', 3] }).langs).toEqual(['eng']);
    expect(normalizeBatchOcrSettings({ langs: [] }).langs).toEqual(['eng']);
  });
});

describe('the name rules', () => {
  const presets: BatchOcrPreset[] = [
    { id: 'a', name: 'Nightly scans', settings: defaultBatchOcrSettings() },
  ];

  it('names the problem rather than saving a preset nobody can address', () => {
    expect(presetNameProblem('  ', presets)).toBe('empty');
    expect(presetNameProblem('x'.repeat(PRESET_NAME_MAX + 1), presets)).toBe('tooLong');
    expect(presetNameProblem('nightly SCANS', presets)).toBe('duplicate');
    expect(presetNameProblem('Weekly', presets)).toBe(null);
  });

  it('lets a preset keep its own name while renaming', () => {
    expect(presetNameProblem('Nightly scans', presets, 'a')).toBe(null);
  });

  it('refuses a new preset once the library is full, but still allows renames', () => {
    const full = Array.from({ length: PRESET_MAX }, (_, i) => ({
      id: `p${i}`,
      name: `Preset ${i}`,
      settings: defaultBatchOcrSettings(),
    }));
    expect(presetNameProblem('One more', full)).toBe('full');
    expect(presetNameProblem('Renamed', full, 'p0')).toBe(null);
  });
});

describe('the library', () => {
  it('saves under a name and recalls exactly what was set', () => {
    const next = upsertPreset([], 'Nightly scans', filled());
    saveBatchOcrPresets(next);
    const back = loadBatchOcrPresets();
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('Nightly scans');
    expect(back[0].settings).toEqual(filled());
  });

  it('replaces the preset of that name rather than adding a second', () => {
    const first = upsertPreset([], 'Nightly scans', filled());
    const second = upsertPreset(first, 'nightly scans', {
      ...filled(),
      mrc: false,
      mrcVerifyText: false,
    });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].settings.mrc).toBe(false);
  });

  it('renames without capturing whatever the dialog is set to now', () => {
    const saved = upsertPreset([], 'Typo', filled());
    const renamed = renamePreset(saved, saved[0].id, 'Nightly scans');
    expect(renamed[0].name).toBe('Nightly scans');
    expect(renamed[0].settings).toEqual(filled());
  });

  it('removes one without disturbing the others', () => {
    const two = upsertPreset(upsertPreset([], 'A', filled()), 'B', defaultBatchOcrSettings());
    const left = removePreset(two, two[0].id);
    expect(left.map((p) => p.name)).toEqual(['B']);
  });

  it('survives a store holding something that is not a preset list', () => {
    for (const raw of ['not json', '{}', '[1,2,3]', '[{"name":"no id"}]', '[{"id":"x"}]']) {
      store.set('spectra-batch-ocr-presets', raw);
      expect(loadBatchOcrPresets()).toEqual([]);
    }
  });

  it('keeps the first of two rows sharing an id', () => {
    // A duplicate id would make "delete this one" ambiguous.
    store.set(
      'spectra-batch-ocr-presets',
      JSON.stringify([
        { id: 'x', name: 'First', settings: {} },
        { id: 'x', name: 'Second', settings: {} },
      ]),
    );
    expect(loadBatchOcrPresets().map((p) => p.name)).toEqual(['First']);
  });
});

describe('duplicating a preset', () => {
  const copyName = (base: string, n: number): string =>
    n === 1 ? `${base} (copy)` : `${base} (copy ${n})`;

  it('removes empty folders only when the stored value is true', () => {
    expect(defaultBatchOcrSettings().removeEmptyFolders).toBe(false);
    expect(normalizeBatchOcrSettings({ removeEmptyFolders: 'yes' }).removeEmptyFolders).toBe(false);
    expect(normalizeBatchOcrSettings({ removeEmptyFolders: true }).removeEmptyFolders).toBe(true);
  });

  it('adds a copy with identical settings under a new id and a free name', () => {
    const presets = upsertPreset([], 'Weekly', filled());
    const done = duplicatePreset(presets, presets[0].id, copyName);
    expect(done).not.toBeNull();
    expect(done!.presets).toHaveLength(2);
    const copy = done!.presets.find((p) => p.id === done!.id)!;
    expect(copy.id).not.toBe(presets[0].id);
    expect(copy.name).toBe('Weekly (copy)');
    expect(copy.settings).toEqual(presets[0].settings);
  });

  it('never shares mutable state with its source', () => {
    const presets = upsertPreset([], 'Weekly', filled());
    const done = duplicatePreset(presets, presets[0].id, copyName)!;
    const copy = done.presets.find((p) => p.id === done.id)!;
    expect(copy.settings).not.toBe(presets[0].settings);
    expect(copy.settings.langs).not.toBe(presets[0].settings.langs);
    copy.settings.langs.push('deu');
    copy.settings.source = 'C:\\other';
    expect(presets[0].settings.langs).toEqual(['eng', 'fra']);
    expect(presets[0].settings.source).toBe('C:\\intake');
  });

  it('numbers further copies and compares names without case', () => {
    let presets = upsertPreset([], 'Weekly', filled());
    presets = upsertPreset(presets, 'WEEKLY (COPY)', filled());
    expect(duplicatePresetName('Weekly', presets, copyName)).toBe('Weekly (copy 2)');
    const done = duplicatePreset(presets, presets[0].id, copyName)!;
    expect(duplicatePresetName('Weekly', done.presets, copyName)).toBe('Weekly (copy 3)');
  });

  it('shortens a long name so the copy still fits', () => {
    const long = 'x'.repeat(PRESET_NAME_MAX);
    const name = duplicatePresetName(long, [], copyName)!;
    expect(name.length).toBeLessThanOrEqual(PRESET_NAME_MAX);
    expect(name.endsWith(' (copy)')).toBe(true);
    expect(presetNameProblem(name, [])).toBeNull();
  });

  it('refuses when the library is full or the source is missing', () => {
    const full: BatchOcrPreset[] = Array.from({ length: PRESET_MAX }, (_, i) => ({
      id: `id${i}`,
      name: `P${i}`,
      settings: filled(),
    }));
    expect(duplicatePreset(full, 'id0', copyName)).toBeNull();
    expect(duplicatePreset([], 'missing', copyName)).toBeNull();
  });

  it('survives the store round trip as two independent presets', () => {
    const presets = upsertPreset([], 'Weekly', filled());
    saveBatchOcrPresets(duplicatePreset(presets, presets[0].id, copyName)!.presets);
    const loaded = loadBatchOcrPresets();
    expect(loaded.map((p) => p.name)).toEqual(['Weekly', 'Weekly (copy)']);
    expect(new Set(loaded.map((p) => p.id)).size).toBe(2);
  });
});

describe('what a schedule freezes', () => {
  it('hands every setting to the profile, with the languages joined', () => {
    const fields = presetScheduleFields(filled());
    expect(fields).toEqual({
      source: 'C:\\intake',
      dest: 'C:\\searchable',
      lang: 'eng+fra',
      movedRoot: 'C:\\done',
      errorRoot: 'C:\\failed',
      repairDamaged: true,
      replaceRepairedOriginals: true,
      inPlace: false,
      mrc: true,
      mrcPreset: 'smallest',
      mrcVerifyText: true,
      enhance: true,
      enhanceOrientation: false,
      removeEmptyFolders: true,
      repairOnly: false,
    });
  });

  it('expands a repair-only preset without the recognition-only switches', () => {
    const fields = presetScheduleFields({ ...filled(), repairOnly: true });
    expect(fields.repairOnly).toBe(true);
    expect(fields.mrc).toBe(false);
    expect(fields.mrcVerifyText).toBe(false);
    expect(fields.enhance).toBe(false);
    expect(fields.enhanceOrientation).toBe(true);
    expect(fields.repairDamaged).toBe(false);
    expect(fields.replaceRepairedOriginals).toBe(true);
  });

  it('normalizes on the way out, so a schedule cannot be built from a shape the run refuses', () => {
    const fields = presetScheduleFields({ ...filled(), inPlace: true });
    expect(fields.dest).toBe('');
    expect(fields.movedRoot).toBe('');
  });
});

describe('repair-only mode', () => {
  it('is off by default and for a preset saved before it existed', () => {
    expect(defaultBatchOcrSettings().repairOnly).toBe(false);
    const { repairOnly: _dropped, ...old } = filled();
    void _dropped;
    expect(normalizeBatchOcrSettings(old).repairOnly).toBe(false);
    expect(normalizeBatchOcrSettings({ ...old, repairOnly: 'yes' }).repairOnly).toBe(false);
  });

  it('survives a save and a reload, keeping the stored recognition settings', () => {
    const saved = upsertPreset([], 'Repair nightly', { ...filled(), repairOnly: true });
    saveBatchOcrPresets(saved);
    const [back] = loadBatchOcrPresets();
    expect(back.settings.repairOnly).toBe(true);
    expect(back.settings.mrc).toBe(true);
    expect(back.settings.langs).toEqual(['eng', 'fra']);
  });

  it('keeps "replace the original" armed without the damaged-file switch', () => {
    const s = normalizeBatchOcrSettings({
      ...filled(),
      repairOnly: true,
      repairDamaged: false,
      replaceRepairedOriginals: true,
    });
    expect(s.replaceRepairedOriginals).toBe(true);
    const ocr = normalizeBatchOcrSettings({
      ...filled(),
      repairDamaged: false,
      replaceRepairedOriginals: true,
    });
    expect(ocr.replaceRepairedOriginals).toBe(false);
  });
});
