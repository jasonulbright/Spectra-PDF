// Named Batch OCR presets.
//
// The Batch OCR dialog holds ~14 independent settings — two folder roots for
// filing, the repair/replace pair, in-place replacement, the MRC pair and the
// enhancement pair — and none of them survived closing it, so a folder someone
// processes every week was retyped every week.
//
// A preset is that settings object under a name. It is DIALOG-LOCAL and is not
// a second action system: guided actions carry no equivalent for the
// moved-root/error-root filing, for the repair-damaged pair, or for in-place
// replacement, so saving these settings AS an action would silently drop half
// of what the dialog was set to.
//
// A leaf module: no React, no Tauri, no engine. The normalizer and the store
// are the breakable parts, so they are the testable parts (there is no DOM
// test environment here).
//
// Storage follows the guided-actions store conventions — its own key, a
// validated reader that can never throw at a caller, and a write path every
// mutation goes through. Nothing in this dialog is a secret, and the
// normalizer refuses to carry a field it does not know, so a preset can never
// grow one by editing the stored JSON.

import { normalizeMrcPreset, type MrcPreset } from './mrc-presets';
import { DEFAULT_OCR_LANGUAGE } from '../ocr/languages';

/** Everything the Batch OCR dialog is set to, in one object. */
export interface BatchOcrSettings {
  /** The tree the run reads. Empty means "not chosen yet". */
  source: string;
  /** Where the searchable copies are mirrored. Always empty under `inPlace`. */
  dest: string;
  /** Recognition languages as tesseract codes, in the order they were ticked. */
  langs: string[];
  /** DESTRUCTIVE: replace each original with its searchable version. */
  inPlace: boolean;
  /** OPT-IN: processed originals are moved here. Always empty under `inPlace`. */
  movedRoot: string;
  /** OPT-IN: failed originals are moved here. */
  errorRoot: string;
  repairDamaged: boolean;
  /** Only meaningful with `repairDamaged`; forced off without it. */
  replaceRepairedOriginals: boolean;
  mrc: boolean;
  mrcPreset: MrcPreset;
  mrcVerifyText: boolean;
  enhance: boolean;
  enhanceOrientation: boolean;
}

export interface BatchOcrPreset {
  id: string;
  name: string;
  settings: BatchOcrSettings;
}

export const PRESET_NAME_MAX = 80;
export const PRESET_MAX = 100;

const KEY = 'spectra-batch-ocr-presets';

/**
 * What the dialog opens on with nothing saved.
 *
 * Every option that modifies the SOURCE tree is off: the standing guarantee of
 * a batch run is that it does not touch the originals, and the filing roots,
 * the repair pair and in-place replacement are the three ways to invert it.
 */
export function defaultBatchOcrSettings(): BatchOcrSettings {
  return {
    source: '',
    dest: '',
    langs: [DEFAULT_OCR_LANGUAGE],
    inPlace: false,
    movedRoot: '',
    errorRoot: '',
    repairDamaged: false,
    replaceRepairedOriginals: false,
    mrc: false,
    mrcPreset: normalizeMrcPreset(undefined),
    mrcVerifyText: false,
    enhance: false,
    enhanceOrientation: true,
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A switch reads as ON only when the stored value IS `true`.
 *
 * Not truthiness: every switch this normalizer reads either modifies the
 * source tree or rewrites page images, so a value the reader does not
 * understand has to resolve to the setting that does neither. A hand-edited or
 * half-written preset can therefore fail to turn something on; it can never
 * turn something on by accident. */
function flag(value: unknown): boolean {
  return value === true;
}

/**
 * Read an arbitrary stored value as settings.
 *
 * Per FIELD rather than all-or-nothing: a preset is a convenience, and
 * discarding somebody's whole saved run because one key is misspelled is worse
 * than resolving that key to its default — which, for every destructive
 * option, is off. Two dependencies are enforced here rather than left to the
 * component, because the CLI and the scheduler read this shape too:
 *
 *   - `inPlace` retires the destination and the processed-originals root. The
 *     processed file IS the original, so both would name a copy that is never
 *     written.
 *   - `replaceRepairedOriginals` means nothing without `repairDamaged`, and a
 *     preset carrying it alone would read as armed while doing nothing.
 */
export function normalizeBatchOcrSettings(raw: unknown): BatchOcrSettings {
  const base = defaultBatchOcrSettings();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const langs = Array.isArray(r.langs)
    ? r.langs.filter((l): l is string => typeof l === 'string' && l.trim() !== '')
    : [];
  const inPlace = flag(r.inPlace);
  const repairDamaged = flag(r.repairDamaged);
  return {
    source: str(r.source),
    dest: inPlace ? '' : str(r.dest),
    langs: langs.length > 0 ? langs : base.langs,
    inPlace,
    movedRoot: inPlace ? '' : str(r.movedRoot),
    errorRoot: str(r.errorRoot),
    repairDamaged,
    replaceRepairedOriginals: repairDamaged && flag(r.replaceRepairedOriginals),
    mrc: flag(r.mrc),
    mrcPreset: normalizeMrcPreset(typeof r.mrcPreset === 'string' ? r.mrcPreset : undefined),
    mrcVerifyText: flag(r.mrcVerifyText),
    enhance: flag(r.enhance),
    // The only switch whose SHIPPED default is on: orientation detection is
    // half of what enhancement means, and it is inert unless `enhance` is on.
    enhanceOrientation: r.enhanceOrientation === undefined ? true : flag(r.enhanceOrientation),
  };
}

function parsePreset(raw: unknown): BatchOcrPreset | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id === '') return null;
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (name === '' || name.length > PRESET_NAME_MAX) return null;
  return { id: p.id, name, settings: normalizeBatchOcrSettings(p.settings) };
}

export function loadBatchOcrPresets(): BatchOcrPreset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: BatchOcrPreset[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      const parsed = parsePreset(entry);
      // A duplicate id would make "delete this one" ambiguous.
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id);
        out.push(parsed);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function saveBatchOcrPresets(presets: readonly BatchOcrPreset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets.slice(0, PRESET_MAX)));
  } catch {
    /* storage full or unavailable — the dialog still runs, unnamed */
  }
}

/** Why this name cannot be saved, as a refusal key, or null. */
export type PresetNameProblem = 'empty' | 'tooLong' | 'duplicate' | 'full';

export function presetNameProblem(
  name: string,
  presets: readonly BatchOcrPreset[],
  /** The preset being renamed, which may keep its own name. */
  exceptId?: string,
): PresetNameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'empty';
  if (trimmed.length > PRESET_NAME_MAX) return 'tooLong';
  const clash = presets.some(
    (p) => p.id !== exceptId && p.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  if (clash) return 'duplicate';
  if (exceptId === undefined && presets.length >= PRESET_MAX) return 'full';
  return null;
}

/** Save under a name, replacing a preset of that name rather than adding a
 * second one — the name is what the user addresses a preset by, so two rows
 * reading the same would make the picker a coin toss. */
export function upsertPreset(
  presets: readonly BatchOcrPreset[],
  name: string,
  settings: BatchOcrSettings,
  id?: string,
): BatchOcrPreset[] {
  const trimmed = name.trim();
  const index = presets.findIndex(
    (p) => p.id === id || p.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  const next = [...presets];
  const clean = normalizeBatchOcrSettings(settings);
  if (index === -1) {
    next.push({ id: crypto.randomUUID(), name: trimmed, settings: clean });
  } else {
    next[index] = { ...next[index], name: trimmed, settings: clean };
  }
  return next;
}

export function renamePreset(
  presets: readonly BatchOcrPreset[],
  id: string,
  name: string,
): BatchOcrPreset[] {
  const trimmed = name.trim();
  return presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
}

export function removePreset(
  presets: readonly BatchOcrPreset[],
  id: string,
): BatchOcrPreset[] {
  return presets.filter((p) => p.id !== id);
}

/**
 * The scheduler profile fields a preset supplies.
 *
 * A scheduled run is registered with Windows Task Scheduler and fires with the
 * app closed, possibly under a service account — so it can never read this
 * store. The preset is therefore EXPANDED into the task's own command line at
 * scheduling time and is frozen there: editing the preset afterwards changes
 * nothing about a task already registered, and the schedule form shows the
 * expanded values before it saves, so what will fire is what was on screen.
 *
 * `lang` is the '+'-joined form the recognizer takes, which is also the form
 * the profile has always carried.
 */
export function presetScheduleFields(settings: BatchOcrSettings): {
  source: string;
  dest: string;
  lang: string;
  movedRoot: string;
  errorRoot: string;
  repairDamaged: boolean;
  replaceRepairedOriginals: boolean;
  inPlace: boolean;
  mrc: boolean;
  mrcPreset: string;
  mrcVerifyText: boolean;
  enhance: boolean;
  enhanceOrientation: boolean;
} {
  const s = normalizeBatchOcrSettings(settings);
  return {
    source: s.source,
    dest: s.dest,
    lang: s.langs.join('+'),
    movedRoot: s.movedRoot,
    errorRoot: s.errorRoot,
    repairDamaged: s.repairDamaged,
    replaceRepairedOriginals: s.replaceRepairedOriginals,
    inPlace: s.inPlace,
    mrc: s.mrc,
    mrcPreset: s.mrcPreset,
    mrcVerifyText: s.mrcVerifyText,
    enhance: s.enhance,
    enhanceOrientation: s.enhanceOrientation,
  };
}
