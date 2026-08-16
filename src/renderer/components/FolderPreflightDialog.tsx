import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../hooks/useEngine';
import { FolderRow, SweepShell } from './FolderSweepUi';
import { useSweepFolders } from '../hooks/useSweepFolders';
import { batch, dialog, app } from '../lib/tauri-bridge';
import { getSettings } from '../lib/app-settings';
import { ensureGsPath } from '../panels/SettingsPanel';
import { tChrome, tChromeCount } from '../i18n';
import { TEST_HARNESS_ENABLED, registerFolderPreflight } from '../testHarness';
import {
  DEFAULT_PROFILE_ID,
  loadUserProfiles,
  pickerOrder,
  type PreflightProfile,
} from '../lib/preflight-profile';
import { profileName } from '../lib/preflight-report';
import {
  emitLocalizedReports,
  loadFolderPreflightPresets,
  presetNameProblem,
  removePreset,
  saveFolderPreflightPresets,
  summarize,
  sweepParams,
  sweepProblem,
  upsertPreset,
  type EmitProgress,
  type EmitResult,
  type FolderPreflightPreset,
  type FolderPreflightSettings,
  type SweepMode,
  type SweepRunReport,
} from '../lib/folder-preflight';
import { createFolderPreflightIo } from '../lib/folder-preflight-io';
import { claimOutputRoot } from '../lib/output-root-claim';

// Tools ▸ Preflight a Folder…: a profile plus a folder — the droplet.
//
// Needs NO open document and never opens one: sources are read by path, so no
// workspace entry exists for any of them, and the engine is reached through
// `callRaw` for the reason batch OCR is — the commit gate exists to make the
// engine read bytes matching a document on screen, and there is none here.
//
// The RUN is one engine call (`run_preflight_sweep`), which is the
// guided-actions shape and is chosen for its reason: a scheduled run and a
// command line have to perform the same sweep with no renderer present. What
// this dialog adds afterwards is the LOCALIZED per-file reports, emitted from
// the one report model the panel's export uses.
//
// Check mode writes nothing to any source. Fix mode writes to a MIRROR, or —
// only when the run says so — replaces the originals it processed.

type Phase = 'setup' | 'running' | 'done';

export interface FolderPreflightDialogProps {
  onClose: () => void;
}

export function FolderPreflightDialog({
  onClose,
}: FolderPreflightDialogProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { call, callRaw } = useEngine();

  const [phase, setPhase] = useState<Phase>('setup');
  const {
    source,
    dest,
    setDest,
    selectSource,
    entries,
    scanning,
    conflict,
    identityConflict,
    error,
    setError,
  } = useSweepFolders();

  const [shipped, setShipped] = useState<PreflightProfile[]>([]);
  const [userProfiles] = useState<PreflightProfile[]>(() => loadUserProfiles());
  const [profileId, setProfileId] = useState<string>(DEFAULT_PROFILE_ID);
  const [mode, setMode] = useState<SweepMode>('check');
  const [inPlace, setInPlace] = useState(false);
  const [movedRoot, setMovedRoot] = useState('');
  const [writeLog, setWriteLog] = useState(true);

  const [presets, setPresets] = useState<FolderPreflightPreset[]>(() =>
    loadFolderPreflightPresets(),
  );
  const [presetName, setPresetName] = useState('');

  const [report, setReport] = useState<SweepRunReport | null>(null);
  const [emitted, setEmitted] = useState<EmitResult | null>(null);
  const [progress, setProgress] = useState<EmitProgress | null>(null);

  const phaseRef = useRef<Phase>('setup');
  phaseRef.current = phase;
  const sourceBtnRef = useRef<HTMLButtonElement>(null);
  const doneCloseBtnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (phase === 'done') doneCloseBtnRef.current?.focus();
    else if (phase === 'setup') sourceBtnRef.current?.focus();
  }, [phase]);

  // The shipped profiles are ENGINE constants — the same authority the panel
  // reads, rather than a second list of what `sheetfed_offset` means.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = (await call('list_preflight_profiles', {})) as unknown as {
          profiles: PreflightProfile[];
        };
        if (!cancelled) setShipped(res.profiles ?? []);
      } catch {
        if (!cancelled) setShipped([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [call]);

  const profiles = useMemo(
    () => pickerOrder(shipped, userProfiles),
    [shipped, userProfiles],
  );
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null,
    [profiles, profileId],
  );

  const settings: FolderPreflightSettings = useMemo(
    () => ({
      source: source ?? '',
      dest: dest ?? '',
      profileId: activeProfile?.id ?? '',
      mode,
      inPlace,
      movedRoot,
      writeLog,
    }),
    [source, dest, activeProfile, mode, inPlace, movedRoot, writeLog],
  );

  const problem = sweepProblem(settings, activeProfile?.fixups.map((f) => f.id) ?? []);
  const ready =
    phase === 'setup' &&
    !scanning &&
    !conflict &&
    problem === null &&
    entries !== null &&
    entries.length > 0;

  const applyPreset = useCallback(
    (preset: FolderPreflightPreset): void => {
      const s = preset.settings;
      setMode(s.mode);
      setInPlace(s.inPlace);
      setMovedRoot(s.movedRoot);
      setWriteLog(s.writeLog);
      if (s.profileId) setProfileId(s.profileId);
      if (s.dest) setDest(s.dest);
      setPresetName(preset.name);
      if (s.source) void selectSource(s.source);
    },
    [setDest, selectSource],
  );

  const savePreset = useCallback((): void => {
    const problemKey = presetNameProblem(presetName, presets);
    if (problemKey) {
      setError(
        tChrome(
          `dialog.preflightSweep.preset.${problemKey}` as Parameters<typeof tChrome>[0],
        ),
      );
      return;
    }
    const next = upsertPreset(presets, presetName, settings);
    setPresets(next);
    saveFolderPreflightPresets(next);
    setError(null);
  }, [presetName, presets, settings, setError]);

  const deletePreset = useCallback(
    (id: string): void => {
      const next = removePreset(presets, id);
      setPresets(next);
      saveFolderPreflightPresets(next);
    },
    [presets],
  );

  const run = useCallback(async (): Promise<void> => {
    if (!activeProfile || source === null) return;
    // Two windows sweeping into one output tree overwrite each other file by
    // file, and neither the commit gate nor the per-file lock spans windows.
    // An in-place run writes over its own sources and owns no output tree.
    const root = await claimOutputRoot(inPlace ? '' : (dest ?? ''));
    if (!root.granted) {
      setError(root.message);
      return;
    }
    setPhase('running');
    setError(null);
    setProgress(null);
    setReport(null);
    setEmitted(null);
    const appSettings = getSettings();
    try {
      const io = createFolderPreflightIo(callRaw);
      const logDir =
        writeLog && appSettings.batchLogEnabled
          ? await batch.logDir(appSettings.batchLogDir)
          : '';
      const params = sweepParams(
        { ...settings, writeLog: logDir !== '' },
        // A user profile travels as the RULE itself; a shipped one by id, so
        // the engine resolves its own constant rather than a copy of it.
        shipped.some((p) => p.id === activeProfile.id) ? activeProfile.id : activeProfile,
        {
          gs: await ensureGsPath(),
          fonts: await app.getEditFontPath(),
          tesseract: await app.getTesseractPath(),
          logDir,
        },
      );
      const result = await io.run(params);
      setReport(result);
      // The localized half. A run started from the command line stops at the
      // JSON — a command line has no locale — so this is the arm that exists
      // only because the app does.
      setEmitted(await emitLocalizedReports(result, io, new Date(), setProgress));
      if (logDir) {
        await batch
          .pruneLogs(appSettings.batchLogRetentionDays, appSettings.batchLogDir)
          .catch(() => 0);
      }
      setPhase('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('setup');
    } finally {
      await root.release();
    }
  }, [activeProfile, source, settings, shipped, writeLog, inPlace, dest, callRaw, setError]);

  const runAnother = useCallback((): void => {
    setReport(null);
    setEmitted(null);
    setProgress(null);
    setPhase('setup');
  }, []);

  // The native folder pickers cannot be WebDriver-driven, so the harness
  // injects paths into the same selectSource/setDest flow the buttons run and
  // then drives the same run the button calls.
  const harnessDeps = { selectSource, setDest, setProfileId, setMode, run };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  const stateRef = useRef({ entries, report, emitted, profiles });
  stateRef.current = { entries, report, emitted, profiles };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerFolderPreflight({
      setSource: (path) => harnessRef.current.selectSource(path),
      setDest: (path) => harnessRef.current.setDest(path),
      setProfile: (id) => harnessRef.current.setProfileId(id),
      setMode: (next) => harnessRef.current.setMode(next as SweepMode),
      run: () => harnessRef.current.run(),
      snapshot: () => ({
        phase: phaseRef.current,
        fileCount: stateRef.current.entries?.length ?? null,
        profiles: stateRef.current.profiles.map((p) => p.id),
        report: stateRef.current.report,
        reportsWritten: stateRef.current.emitted?.written ?? 0,
      }),
    });
    return () => registerFolderPreflight(null);
  }, []);

  const totals = report ? summarize(report) : null;

  return (
    <SweepShell
      title={tChrome('dialog.preflightSweep.title')}
      testid="folder-preflight-dialog"
      closeTestid="folder-preflight-x"
      onClose={phase === 'running' ? () => {} : onClose}
    >
      {phase === 'setup' && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-neutral-500">{tChrome('dialog.preflightSweep.blurb')}</p>

          <FolderRow
            label={tChrome('dialog.batch.sourceLabel')}
            testid="folder-preflight-source"
            value={source}
            buttonRef={sourceBtnRef}
            onPick={() => {
              void (async () => {
                const path = await dialog.pickFolder(
                  tChrome('dialog.preflightSweep.pickSource'),
                );
                if (path) await selectSource(path);
              })();
            }}
            note={
              scanning
                ? tChrome('dialog.batch.scanning')
                : entries !== null
                  ? tChromeCount('dialog.batch.found', entries.length)
                  : null
            }
          />

          {!inPlace && (
            <FolderRow
              label={tChrome('dialog.preflightSweep.destLabel')}
              testid="folder-preflight-dest"
              value={dest}
              onPick={() => {
                void (async () => {
                  const path = await dialog.pickFolder(tChrome('dialog.common.pickDest'));
                  if (path) setDest(path);
                })();
              }}
              note={null}
            />
          )}
          {conflict && (
            <p className="text-sm text-red-400" data-testid="folder-preflight-conflict">
              {tChrome(
                identityConflict
                  ? 'dialog.batch.conflictIdentity'
                  : 'dialog.batch.conflictInside',
              )}
            </p>
          )}

          <div>
            <label
              className="block text-sm text-neutral-400 mb-1"
              htmlFor="folder-preflight-profile"
            >
              {tChrome('dialog.preflightSweep.profile')}
            </label>
            <select
              id="folder-preflight-profile"
              data-testid="folder-preflight-profile"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={activeProfile?.id ?? ''}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {profileName({
                    id: p.id,
                    name: p.name,
                    name_key: p.name_key ?? '',
                    based_on: p.based_on ?? '',
                  })}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="folder-preflight-mode">
              {tChrome('dialog.preflightSweep.mode')}
            </label>
            <select
              id="folder-preflight-mode"
              data-testid="folder-preflight-mode"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={mode}
              onChange={(e) => {
                const next = e.target.value as SweepMode;
                setMode(next);
                // A check writes nothing, so there is nothing for either of
                // these to name. Cleared rather than left armed and ignored.
                if (next === 'check') {
                  setInPlace(false);
                  setMovedRoot('');
                }
              }}
            >
              <option value="check">{tChrome('dialog.preflightSweep.modeCheck')}</option>
              <option value="fix">{tChrome('dialog.preflightSweep.modeFix')}</option>
            </select>
            <p className="text-xs text-neutral-500 mt-1">
              {tChrome(
                mode === 'check'
                  ? 'dialog.preflightSweep.modeCheckNote'
                  : 'dialog.preflightSweep.modeFixNote',
              )}
            </p>
          </div>

          {mode === 'fix' && (
            <>
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  data-testid="folder-preflight-in-place"
                  checked={inPlace}
                  onChange={(e) => {
                    setInPlace(e.target.checked);
                    if (e.target.checked) {
                      setDest(null);
                      setMovedRoot('');
                    }
                  }}
                />
                {tChrome('dialog.preflightSweep.inPlace')}
              </label>
              {inPlace && (
                <p className="text-xs text-amber-400">
                  {tChrome('dialog.preflightSweep.inPlaceWarning')}
                </p>
              )}
              {!inPlace && (
                <FolderRow
                  label={tChrome('dialog.batch.movedLabel')}
                  testid="folder-preflight-moved"
                  value={movedRoot || null}
                  onPick={() => {
                    void (async () => {
                      const path = await dialog.pickFolder(
                        tChrome('dialog.common.pickProcessed'),
                      );
                      if (path) setMovedRoot(path);
                    })();
                  }}
                  note={tChrome('dialog.preflightSweep.movedNote')}
                />
              )}
            </>
          )}

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid="folder-preflight-log"
              checked={writeLog}
              onChange={(e) => setWriteLog(e.target.checked)}
            />
            {tChrome('dialog.preflightSweep.writeLog')}
          </label>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-40">
              <span className="block text-sm text-neutral-400 mb-1">
                {tChrome('dialog.preflightSweep.presetName')}
              </span>
              <input
                data-testid="folder-preflight-preset-name"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="folder-preflight-preset-save"
              onClick={savePreset}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
            >
              {tChrome('dialog.common.save')}
            </button>
          </div>
          {presets.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="folder-preflight-presets">
              {presets.map((preset) => (
                <div key={preset.id} className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    data-testid={`folder-preflight-preset-${preset.id}`}
                    onClick={() => applyPreset(preset)}
                    className="flex-1 text-start text-neutral-300 hover:text-neutral-100 truncate"
                  >
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(preset.id)}
                    className="px-2 py-0.5 text-xs bg-neutral-800 hover:bg-neutral-700 rounded"
                  >
                    {tChrome('dialog.common.delete')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {problem !== null && (
            <p className="text-xs text-neutral-500" data-testid="folder-preflight-problem">
              {tChrome(
                `dialog.preflightSweep.problem.${problem}` as Parameters<typeof tChrome>[0],
              )}
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void run()}
              data-testid="folder-preflight-run"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
            >
              {tChrome('dialog.preflightSweep.run')}
            </button>
          </div>
        </div>
      )}

      {/* The sweep is ONE engine call, so there is no between-files seam to
          stop at — and a Stop button that cannot stop anything is worse than
          none. The progress bar tracks the report pass, which is the half
          this side performs. */}
      {phase === 'running' && (
        <div className="flex flex-col gap-3" data-testid="folder-preflight-running">
          <p className="text-sm text-neutral-300 truncate">
            {progress
              ? tChrome('dialog.preflightSweep.progressReports', {
                  index: progress.fileIndex + 1,
                  count: progress.fileCount,
                  rel: progress.rel,
                })
              : tChrome('dialog.preflightSweep.progressRunning')}
          </p>
          <div className="h-1.5 bg-neutral-800 rounded overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{
                width: `${
                  progress
                    ? Math.round(
                        ((progress.fileIndex + 1) / Math.max(1, progress.fileCount)) * 100,
                      )
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {phase === 'done' && report && totals && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-200" data-testid="folder-preflight-summary">
            {[
              tChrome('dialog.preflightSweep.sumClean', { count: totals.clean }),
              tChrome('dialog.preflightSweep.sumDirty', { count: totals.dirty }),
              tChrome('dialog.preflightSweep.sumFailed', { count: totals.failed }),
            ].join(' · ')}
          </p>

          <div className="max-h-[45vh] overflow-auto text-xs text-neutral-400 flex flex-col gap-0.5">
            {/* Failures first: a folder run's one unreadable file is the row a
                reader is looking for, and it is never silence. */}
            {report.results
              .filter((r) => r.status === 'error')
              .map((r) => (
                <div key={r.rel} className="text-amber-400 truncate">
                  {tChrome('dialog.preflightSweep.rowFailed', {
                    rel: r.rel,
                    reason: r.error ?? '',
                  })}
                </div>
              ))}
            {report.results
              .filter((r) => r.status === 'ok')
              .map((r) => (
                <div key={r.rel} className="truncate">
                  {tChrome('dialog.preflightSweep.rowChecked', {
                    rel: r.rel,
                    failed: r.after?.failed ?? 0,
                    review: r.after?.needs_review ?? 0,
                  })}
                  {(r.applied?.length ?? 0) > 0 &&
                    tChrome('dialog.preflightSweep.rowFixed', {
                      fixups: (r.applied ?? []).join(', '),
                    })}
                </div>
              ))}
          </div>

          {report.skipped_dirs.length > 0 && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.batch.unreadableDirs', { dirs: report.skipped_dirs.join(', ') })}
            </p>
          )}
          {emitted && emitted.errors.length > 0 && (
            <p className="text-xs text-amber-400" data-testid="folder-preflight-emit-errors">
              {tChrome('dialog.preflightSweep.reportErrors', {
                count: emitted.errors.length,
              })}
            </p>
          )}
          {report.log_path && (
            <p className="text-xs text-neutral-500">
              {tChrome('dialog.batch.logWritten', { path: report.log_path })}
            </p>
          )}
          {report.log_error && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.batch.logError', { message: report.log_error })}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={runAnother}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
            >
              {tChrome('dialog.preflightSweep.again')}
            </button>
            <button
              type="button"
              ref={doneCloseBtnRef}
              onClick={onClose}
              data-testid="folder-preflight-close"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
            >
              {tChrome('dialog.common.close')}
            </button>
          </div>
        </div>
      )}
    </SweepShell>
  );
}
