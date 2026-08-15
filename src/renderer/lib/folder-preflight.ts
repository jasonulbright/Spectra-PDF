// The droplet — a profile plus a folder.
//
// The RUN itself is the engine's (`engine/preflight_sweep.py`): one RPC per
// sweep, the mirror-tree discipline, the per-file JSON report and the
// `preflight-run-*.log`. That is the `guided_actions.run_action` shape and it
// is chosen for its reason — a scheduled run and a command line have to
// perform the same sweep with no renderer present at all, and a second driver
// here would be a second answer about what a fix run does.
//
// What lives HERE is the half a renderer owns: the settings a dialog holds and
// their saved presets, the two dependencies between those settings, and the
// LOCALIZED per-file reports. Those are emitted from `preflight-report.ts` —
// one report model, the UI locale, the same text and HTML the panel's export
// writes — because a Python twin of those emitters would be a second
// implementation of one model emitting English only.
//
// A leaf module: no React, no Tauri, no engine. Every side effect arrives
// through `FolderPreflightIo`, so vitest exercises the whole post-pass.

import {
  formatPreflightHtml,
  formatPreflightText,
  type PreflightReport,
} from './preflight-report';

/** What a sweep may do. `check` writes nothing to any source; `fix` repairs a
 * mirrored copy and re-checks it. */
export type SweepMode = 'check' | 'fix';

export const SWEEP_MODES: readonly SweepMode[] = ['check', 'fix'];

/** Everything the droplet dialog is set to, in one object. */
export interface FolderPreflightSettings {
  /** The tree the run reads. Empty means "not chosen yet". */
  source: string;
  /** Where the reports — and in fix mode the fixed copies — are mirrored.
   * Always empty under `inPlace`. */
  dest: string;
  /** A shipped profile id, or a user profile's id. */
  profileId: string;
  mode: SweepMode;
  /** DESTRUCTIVE: replace each original with its fixed version. Fix mode
   * only — a check writes nothing, so there is nothing to replace. */
  inPlace: boolean;
  /** OPT-IN: processed originals are moved here. Always empty under
   * `inPlace`, and meaningless in check mode, which processes nothing. */
  movedRoot: string;
  writeLog: boolean;
}

export interface FolderPreflightPreset {
  id: string;
  name: string;
  settings: FolderPreflightSettings;
}

export const PRESET_NAME_MAX = 80;
export const PRESET_MAX = 100;

const KEY = 'spectra-preflight-sweep-presets';

/**
 * What the dialog opens on with nothing saved.
 *
 * Check mode, and every option that touches the source tree off: a sweep's
 * standing guarantee is that it does not modify what it measured, and
 * `inPlace` and `movedRoot` are the two ways to invert it.
 */
export function defaultFolderPreflightSettings(
  profileId = '',
): FolderPreflightSettings {
  return {
    source: '',
    dest: '',
    profileId,
    mode: 'check',
    inPlace: false,
    movedRoot: '',
    writeLog: true,
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A switch reads as ON only when the stored value IS `true` — not
 * truthiness. Every switch here modifies the source tree, so a value the
 * reader does not understand resolves to the setting that does not. */
function flag(value: unknown): boolean {
  return value === true;
}

/**
 * Read an arbitrary stored value as settings.
 *
 * Per FIELD rather than all-or-nothing, and the two dependencies are enforced
 * here rather than in the component because the engine refuses each of them by
 * name and a preset that stored an impossible pair would only fail at run
 * time:
 *
 *   - `check` mode retires `inPlace` and `movedRoot`. A check writes nothing,
 *     so both would name a copy that is never made.
 *   - `inPlace` retires the destination and the processed-originals root. The
 *     processed file IS the original.
 */
export function normalizeFolderPreflightSettings(raw: unknown): FolderPreflightSettings {
  const base = defaultFolderPreflightSettings();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const mode: SweepMode = r.mode === 'fix' ? 'fix' : 'check';
  const inPlace = mode === 'fix' && flag(r.inPlace);
  return {
    source: str(r.source),
    dest: inPlace ? '' : str(r.dest),
    profileId: str(r.profileId),
    mode,
    inPlace,
    movedRoot: inPlace || mode === 'check' ? '' : str(r.movedRoot),
    writeLog: r.writeLog === undefined ? true : flag(r.writeLog),
  };
}

function parsePreset(raw: unknown): FolderPreflightPreset | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id === '') return null;
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (name === '' || name.length > PRESET_NAME_MAX) return null;
  return { id: p.id, name, settings: normalizeFolderPreflightSettings(p.settings) };
}

export function loadFolderPreflightPresets(): FolderPreflightPreset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: FolderPreflightPreset[] = [];
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

export function saveFolderPreflightPresets(
  presets: readonly FolderPreflightPreset[],
): void {
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
  presets: readonly FolderPreflightPreset[],
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
 * second one — the name is what a preset is addressed by. */
export function upsertPreset(
  presets: readonly FolderPreflightPreset[],
  name: string,
  settings: FolderPreflightSettings,
  id?: string,
): FolderPreflightPreset[] {
  const trimmed = name.trim();
  const index = presets.findIndex(
    (p) => p.id === id || p.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  const next = [...presets];
  const clean = normalizeFolderPreflightSettings(settings);
  if (index === -1) {
    next.push({ id: crypto.randomUUID(), name: trimmed, settings: clean });
  } else {
    next[index] = { ...next[index], name: trimmed, settings: clean };
  }
  return next;
}

export function removePreset(
  presets: readonly FolderPreflightPreset[],
  id: string,
): FolderPreflightPreset[] {
  return presets.filter((p) => p.id !== id);
}

// ── the run ───────────────────────────────────────────────────────────────

/** One check's five numbers, as the engine reports them. */
export interface SweepSummary {
  passed: number;
  failed: number;
  warnings: number;
  needs_review: number;
  not_applicable: number;
  applicable: number;
  total: number;
}

export interface SweepFileRow {
  rel: string;
  status: 'ok' | 'error';
  before?: SweepSummary;
  after?: SweepSummary;
  /** The fixups that ran, in the engine's own order. */
  applied?: string[];
  refused?: { fixup: string; reason: string }[];
  order?: string[];
  /** The JSON report this row wrote. */
  report?: string;
  error?: string;
  moved_to?: string;
  move_error?: string;
}

export interface SweepRunReport {
  source: string;
  dest: string;
  mode: SweepMode;
  profile: { id: string; name: string; name_key: string };
  total: number;
  ok: number;
  failed: number;
  clean: number;
  skipped_dirs: string[];
  results: SweepFileRow[];
  duration_ms: number;
  in_place: boolean;
  log_path?: string;
  log_error?: string;
}

/** Why this run cannot start, as a refusal key, or null. The ENGINE refuses
 * each of these by name too; this is what keeps the button from offering a run
 * that is already known to be impossible. */
export type SweepProblem =
  | 'noSource'
  | 'noDest'
  | 'noProfile'
  | 'checkInPlace'
  | 'noFixups';

export function sweepProblem(
  settings: FolderPreflightSettings,
  profileFixups: readonly string[],
): SweepProblem | null {
  if (!settings.source) return 'noSource';
  if (!settings.profileId) return 'noProfile';
  if (settings.mode === 'check' && settings.inPlace) return 'checkInPlace';
  if (!settings.inPlace && !settings.dest) return 'noDest';
  if (settings.mode === 'fix' && profileFixups.length === 0) return 'noFixups';
  return null;
}

/** The engine call one settings object becomes. A user profile travels as the
 * RULE itself; a shipped one by id, so the engine resolves its own constant
 * rather than a copy of it. */
export function sweepParams(
  settings: FolderPreflightSettings,
  profile: unknown,
  tools: { gs: string; fonts: string; tesseract: string; logDir: string },
): Record<string, unknown> {
  return {
    source: settings.source,
    dest: settings.inPlace ? '' : settings.dest,
    mode: settings.mode,
    profile,
    in_place: settings.inPlace,
    move_processed_root: settings.movedRoot,
    write_log: settings.writeLog,
    log_dir: settings.writeLog ? tools.logDir : '',
    gs_path: tools.gs,
    font_dir: tools.fonts,
    tesseract_path: tools.tesseract,
  };
}

/** Where a row's localized reports go: beside the JSON the engine wrote, with
 * its `.json` replaced. Three artifacts for one document, all named after it,
 * so a reader who sorts the mirror sees them together. */
export function reportSidecars(jsonPath: string): { text: string; html: string } {
  const stem = jsonPath.replace(/\.json$/i, '');
  return { text: `${stem}.txt`, html: `${stem}.html` };
}

export interface FolderPreflightIo {
  /** `run_preflight_sweep` — one RPC for the whole sweep. */
  run(params: Record<string, unknown>): Promise<SweepRunReport>;
  /** Read back one row's JSON report so it can be emitted in the UI locale. */
  readReport(path: string): Promise<PreflightReport>;
  /** Write one localized artifact; returns the path written. */
  writeReport(path: string, contents: string): Promise<string>;
}

export interface EmitProgress {
  fileIndex: number;
  fileCount: number;
  rel: string;
}

export interface EmitResult {
  written: number;
  /** English, like every sweep report's: one row's emit failing never ends
   * the pass, and the reason is recorded against that row. */
  errors: { rel: string; reason: string }[];
}

/**
 * The localized half of a run: one text and one HTML report per document,
 * beside the JSON the engine already wrote.
 *
 * A run started from the command line stops at the JSON, deliberately — a
 * command line has no locale. This is the arm that exists only because the app
 * does.
 */
export async function emitLocalizedReports(
  report: SweepRunReport,
  io: FolderPreflightIo,
  runAt: Date,
  onProgress?: (p: EmitProgress) => void,
): Promise<EmitResult> {
  const rows = report.results.filter((r) => r.status === 'ok' && r.report);
  const out: EmitResult = { written: 0, errors: [] };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    onProgress?.({ fileIndex: i, fileCount: rows.length, rel: row.rel });
    try {
      const parsed = await io.readReport(row.report as string);
      const emitted = { documentName: row.rel, runAt, report: parsed };
      const sidecars = reportSidecars(row.report as string);
      await io.writeReport(sidecars.text, formatPreflightText(emitted));
      await io.writeReport(sidecars.html, formatPreflightHtml(emitted));
      out.written += 1;
    } catch (err) {
      out.errors.push({
        rel: row.rel,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export interface SweepTotals {
  clean: number;
  dirty: number;
  failed: number;
  total: number;
}

/** What a run produced, counted the way the dialog states it. `clean` is the
 * engine's own count — a document with nothing failed and nothing left to
 * review — so the dialog and the log agree about what "clean" means. */
export function summarize(report: SweepRunReport): SweepTotals {
  return {
    clean: report.clean,
    dirty: report.ok - report.clean,
    failed: report.failed,
    total: report.total,
  };
}
