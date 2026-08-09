import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { dialog, schedule, batch } from '../lib/tauri-bridge';
import type { ScheduleProfile, ScheduledRun } from '../lib/tauri-bridge';
import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import { toTesseractLang, describeLanguages } from '../ocr/language-selection';
import { getSettings } from '../lib/app-settings';
import {
  actionFileJson,
  loadGuidedActions,
  stepDefFor,
  unattendedBlocker,
} from '../lib/guided-actions';
import {
  loadBatchOcrPresets,
  presetScheduleFields,
} from '../lib/batch-ocr-presets';
import { normalizeMrcPreset } from '../lib/mrc-presets';
import { TEST_HARNESS_ENABLED, registerScheduledRuns } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tOcrLanguage, tStepTitle } from '../i18n';

// Tools ▸ Scheduled Batch Runs owns the complete lifecycle: create, list, run
// now, enable, disable, and delete. Windows Task Scheduler performs
// the timing, which is why a run fires with the app CLOSED; an in-app timer
// would silently not run on any morning nobody opened the app.
//
// The list is read back from the registered tasks themselves — there is no
// profile file that could disagree with what will actually fire.
//
// Guided actions: the same lifecycle schedules a SAVED ACTION over a
// folder (run_action was built engine-side for exactly this). The action is
// frozen to a machine-scoped file at creation — a scheduled task must not
// depend on the GUI's localStorage (wrong profile under a service account,
// and the run fires with the app closed). Actions with ask-at-run values
// (secrets included — never persisted, by rule) are refused here: a headless
// run has nobody to ask, and a task that fails every time must not register.

export interface ScheduledRunsDialogProps {
  onClose: () => void;
}

const EMPTY: ScheduleProfile = {
  name: '',
  source: '',
  dest: '',
  lang: DEFAULT_OCR_LANGUAGE,
  movedRoot: '',
  errorRoot: '',
  repairDamaged: false,
  replaceRepairedOriginals: false,
  logDir: '',
  frequency: 'daily',
  time: '09:30',
  days: 'MON,TUE,WED,THU,FRI',
  account: '',
  inPlace: false,
  mrc: false,
  mrcPreset: 'balanced',
  mrcVerifyText: false,
  enhance: false,
  enhanceOrientation: true,
  runType: 'batch-ocr',
  actionFile: '',
};

export function ScheduledRunsDialog({ onClose }: ScheduledRunsDialogProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const [runs, setRuns] = useState<ScheduledRun[] | null>(null);
  const [editing, setEditing] = useState<ScheduleProfile | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // The saved-action library (fresh at dialog mount) + which one a new/edited
  // action schedule runs. '' while EDITING an existing action schedule means
  // "keep the frozen copy already on disk".
  const [libraryActions] = useState(() => loadGuidedActions());
  const [actionId, setActionId] = useState('');
  // The Batch OCR dialog's named presets. A preset is EXPANDED into the form
  // here and frozen into the task's command line on save — a scheduled task
  // fires with the app closed, possibly under a service account, so it can
  // never read the store a preset lives in. Editing the preset afterwards
  // therefore changes nothing about a task already registered, and what the
  // form shows after the expansion is exactly what will run.
  const [libraryPresets] = useState(() => loadBatchOcrPresets());
  const [presetId, setPresetId] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRuns(await schedule.list());
      setError(null);
    } catch (e: unknown) {
      setRuns([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const langs = editing ? editing.lang.split('+').filter(Boolean) : [];

  const save = useCallback(async () => {
    if (!editing) return;
    let actionJson: string | undefined;
    if (editing.runType === 'action') {
      const chosen = libraryActions.find((a) => a.id === actionId);
      if (!chosen && !editing.actionFile) {
        setError(tChrome('dialog.schedule.needAction'));
        return;
      }
      if (chosen) {
        // Never register a task that will not fire: ask-at-run values
        // (secrets included) have nobody to answer them headlessly.
        const blocker = unattendedBlocker(chosen);
        if (blocker) {
          setError(blocker);
          return;
        }
        // The frozen copy is the SAME sanitized construction the export
        // writes — it can never carry a password.
        actionJson = actionFileJson(chosen);
      }
    }
    setBusy(true);
    setError(null);
    setStatus(tChrome('dialog.schedule.creating'));
    try {
      await schedule.create(editing, password || undefined, actionJson);
      // The password only ever existed for this call — Windows stores it, we
      // do not (the .pfx signing-password posture).
      setPassword('');
      setEditing(null);
      setStatus(tChrome('dialog.schedule.saved'));
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }, [editing, password, refresh, libraryActions, actionId]);

  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      setStatus(label);
      try {
        await fn();
        setStatus('');
        await refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Harness: the native folder pickers are not WebDriver-drivable, so a spec
  // injects a whole profile through the SAME create path the form uses.
  const createRef = useRef<(p: ScheduleProfile, actionJson?: string) => Promise<string>>(null!);
  createRef.current = (p, actionJson) => schedule.create(p, undefined, actionJson);
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerScheduledRuns({
      create: (p, actionJson) => createRef.current(p as unknown as ScheduleProfile, actionJson),
      list: () => schedule.list(),
      remove: (name) => schedule.remove(name),
    });
    return () => registerScheduledRuns(null);
  }, []);

  const pick = async (label: string, apply: (path: string) => void): Promise<void> => {
    const path = await dialog.pickFolder(label);
    if (path) apply(path);
  };

  return (
    <Shell onClose={onClose}>
      {editing === null ? (
        <div className="flex flex-col gap-3" data-testid="schedule-list-view">
          <p className="text-xs text-neutral-500">
            {tChrome('dialog.schedule.blurb')}
          </p>

          {runs === null ? (
            <p className="text-sm text-neutral-400">{tChrome('dialog.common.loading')}</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-neutral-400" data-testid="schedule-empty">
              {tChrome('dialog.schedule.empty')}
            </p>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto" data-testid="schedule-list">
              {runs.map((r) => (
                <div
                  key={r.name}
                  data-testid={`schedule-row-${r.name}`}
                  className="px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-neutral-200 flex-1 truncate">{r.name}</span>
                    <span className="text-xs text-neutral-500">{r.status}</span>
                  </div>
                  <div className="text-xs text-neutral-500 mt-0.5">
                    {tChrome(
                      r.lastResult
                        ? 'dialog.schedule.timingResult'
                        : 'dialog.schedule.timing',
                      {
                        next: r.nextRun || tChrome('dialog.schedule.none'),
                        last: r.lastRun || tChrome('dialog.schedule.never'),
                        result: r.lastResult,
                      },
                    )}
                  </div>
                  {r.profile ? (
                    <>
                      <div className="text-xs text-neutral-400 mt-0.5 truncate" title={r.profile.source}>
                        {/* An in-place run has no destination, so the route
                            line says what it does instead of naming an empty
                            folder as the second half of an arrow. */}
                        {r.profile.inPlace
                          ? tChrome('dialog.schedule.routeInPlace', { source: r.profile.source })
                          : tChrome('dialog.common.route', {
                              source: r.profile.source,
                              dest: r.profile.dest,
                            })}
                      </div>
                      {r.profile.runType === 'action' && (
                        <div
                          className="text-xs text-neutral-400 mt-0.5 truncate"
                          data-testid={`schedule-action-info-${r.name}`}
                          title={r.actionSteps.join(' → ')}
                        >
                          {tChrome(
                            r.actionSteps.length > 0
                              ? 'dialog.schedule.guidedActionSteps'
                              : 'dialog.schedule.guidedAction',
                            {
                              name: r.actionName || tChrome('dialog.schedule.unnamedAction'),
                              steps: r.actionSteps.join(' → '),
                            },
                          )}
                        </div>
                      )}
                      {r.actionMissing && (
                        // It will still FIRE and fail — shown, never hidden.
                        <div className="text-xs text-amber-400 mt-0.5" data-testid={`schedule-action-missing-${r.name}`}>
                          {tChrome('dialog.schedule.actionMissing')}
                        </div>
                      )}
                    </>
                  ) : (
                    // It will still FIRE, so it is shown rather than hidden.
                    <div className="text-xs text-amber-400 mt-0.5">
                      {tChrome('dialog.schedule.foreign')}
                    </div>
                  )}
                  <div className="flex gap-2 mt-1.5">
                    <button
                      data-testid={`schedule-run-${r.name}`}
                      disabled={busy}
                      onClick={() => void act(tChrome('dialog.schedule.starting'), () => schedule.runNow(r.name))}
                      className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    >
                      {tChrome('dialog.schedule.runNow')}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        // The toggle reads the BOOLEAN, never the status
                        // TEXT: Windows localizes that string, so the old
                        // `status.includes('disabled')` test inverted the
                        // button on any non-English machine.
                        void act(tChrome('dialog.schedule.updating'), () =>
                          schedule.setEnabled(r.name, !r.enabled),
                        )
                      }
                      className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    >
                      {tChrome(r.enabled ? 'dialog.schedule.disable' : 'dialog.schedule.enable')}
                    </button>
                    {r.profile && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setActionId('');
                          setPresetId('');
                          setEditing({ ...EMPTY, ...r.profile! });
                        }}
                        className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                      >
                        {tChrome('dialog.schedule.edit')}
                      </button>
                    )}
                    <div className="flex-1" />
                    {confirmDelete === r.name ? (
                      <>
                        <span className="text-xs text-amber-400 self-center">{tChrome('dialog.common.deleteIt')}</span>
                        <button
                          data-testid={`schedule-delete-confirm-${r.name}`}
                          disabled={busy}
                          onClick={() => {
                            setConfirmDelete(null);
                            void act(tChrome('dialog.schedule.deleting'), () => schedule.remove(r.name));
                          }}
                          className="px-2 py-0.5 text-xs bg-red-700/80 hover:bg-red-600 disabled:opacity-50 rounded"
                        >
                          {tChrome('dialog.common.delete')}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-0.5 text-xs text-neutral-400 hover:text-neutral-200"
                        >
                          {tChrome('dialog.common.keep')}
                        </button>
                      </>
                    ) : (
                      <button
                        data-testid={`schedule-delete-${r.name}`}
                        disabled={busy}
                        onClick={() => setConfirmDelete(r.name)}
                        className="px-2 py-0.5 text-xs text-neutral-400 hover:text-red-400 disabled:opacity-50"
                      >
                        {tChrome('dialog.common.delete')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400" data-testid="schedule-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              data-testid="schedule-close"
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              {tChrome('dialog.common.close')}
            </button>
            <button
              data-testid="schedule-new"
              onClick={() => {
                setActionId('');
                setPresetId('');
                setEditing({ ...EMPTY, logDir: getSettings().batchLogDir });
                setError(null);
              }}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
            >
              {tChrome('dialog.schedule.new')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="schedule-form">
          <Field label={tChrome('dialog.schedule.name')}>
            <input
              data-testid="schedule-name"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
            />
          </Field>

          <Field label={tChrome('dialog.schedule.whatRuns')}>
            <select
              data-testid="schedule-runtype"
              value={editing.runType === 'action' ? 'action' : 'batch-ocr'}
              onChange={(e) => setEditing({ ...editing, runType: e.target.value })}
              className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
            >
              <option value="batch-ocr">{tChrome('dialog.schedule.runTypeOcr')}</option>
              <option value="action">{tChrome('dialog.schedule.runTypeAction')}</option>
            </select>
          </Field>

          {editing.runType === 'action' && (
            <Field label={tChrome('dialog.schedule.actionLabel')}>
              <select
                data-testid="schedule-action"
                value={actionId}
                onChange={(e) => setActionId(e.target.value)}
                className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              >
                <option value="">
                  {tChrome(
                    editing.actionFile
                      ? 'dialog.schedule.keepAction'
                      : 'dialog.common.chooseAction',
                  )}
                </option>
                {libraryActions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {tChrome('dialog.common.actionOption', {
                      name: a.name,
                      steps: a.steps
                        .map((s) => tStepTitle(s.op, stepDefFor(s.op).title))
                        .join(' → '),
                    })}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 mt-1">
                {tChrome('dialog.schedule.actionNote')}
              </p>
            </Field>
          )}

          {editing.runType !== 'action' && libraryPresets.length > 0 && (
            <Field
              label={tChrome('dialog.schedule.presetLabel', {
                batch: tChrome('dialog.batch.title'),
              })}
            >
              <select
                data-testid="schedule-preset"
                value={presetId}
                onChange={(e) => {
                  const chosen = libraryPresets.find((p) => p.id === e.target.value);
                  setPresetId(e.target.value);
                  if (chosen) setEditing({ ...editing, ...presetScheduleFields(chosen.settings) });
                }}
                className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              >
                <option value="">{tChrome('dialog.schedule.presetNone')}</option>
                {libraryPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 mt-1">
                {tChrome('dialog.schedule.presetNote')}
              </p>
            </Field>
          )}

          <FolderField
            label={tChrome('dialog.schedule.sourceLabel')}
            testid="schedule-source"
            value={editing.source}
            onPick={() => void pick(tChrome('dialog.schedule.pickSource'), (p) => setEditing({ ...editing, source: p }))}
          />
          {editing.runType !== 'action' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="schedule-inplace"
                checked={editing.inPlace}
                onChange={() => {
                  const next = !editing.inPlace;
                  // In place, the processed file IS the original, so a
                  // destination and a processed-originals root both name a
                  // copy that is never written. Rust refuses either alongside
                  // it; clearing them here is what keeps the form honest.
                  setEditing(
                    next
                      ? { ...editing, inPlace: true, dest: '', movedRoot: '' }
                      : { ...editing, inPlace: false },
                  );
                }}
                className="rounded bg-neutral-900 border-neutral-600"
              />
              <span className="text-sm text-neutral-300">{tChrome('dialog.batch.inPlace')}</span>
            </label>
          )}
          {!editing.inPlace && (
            <FolderField
              label={tChrome('dialog.schedule.destLabel')}
              testid="schedule-dest"
              value={editing.dest}
              onPick={() => void pick(tChrome('dialog.common.pickDest'), (p) => setEditing({ ...editing, dest: p }))}
            />
          )}

          {editing.runType !== 'action' && (
            <Field label={tChrome('dialog.schedule.languages', { summary: describeLanguages(langs) })}>
              <div className="max-h-28 overflow-y-auto rounded border border-neutral-700 bg-neutral-800 p-2 grid grid-cols-3 gap-x-3 gap-y-1">
                {OCR_LANGUAGES.map((l) => (
                  <label key={l.code} className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={langs.includes(l.code)}
                      onChange={() => {
                        const next = langs.includes(l.code)
                          ? langs.filter((c) => c !== l.code)
                          : [...langs, l.code];
                        setEditing({ ...editing, lang: toTesseractLang(next) });
                      }}
                      className="rounded bg-neutral-900 border-neutral-600"
                    />
                    <span className="text-neutral-300">{tOcrLanguage(l.code)}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}

          {/* The two page-image options, in run order: enhancement corrects
              what will be read, MRC replaces what was read. Both belong on
              this form as well as in the dialog — a schedule read back from a
              task that carries them must be re-savable without dropping them. */}
          {editing.runType !== 'action' && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="schedule-enhance"
                  checked={editing.enhance}
                  onChange={() => setEditing({ ...editing, enhance: !editing.enhance })}
                  className="rounded bg-neutral-900 border-neutral-600"
                />
                <span className="text-sm text-neutral-300">{tChrome('dialog.batch.enhance')}</span>
              </label>
              {editing.enhance && (
                <label className="flex items-center gap-2 cursor-pointer ps-6">
                  <input
                    type="checkbox"
                    data-testid="schedule-enhance-orientation"
                    checked={editing.enhanceOrientation}
                    onChange={() =>
                      setEditing({ ...editing, enhanceOrientation: !editing.enhanceOrientation })
                    }
                    className="rounded bg-neutral-900 border-neutral-600"
                  />
                  <span className="text-sm text-neutral-300">
                    {tChrome('dialog.batch.enhanceOrientation')}
                  </span>
                </label>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="schedule-mrc"
                  checked={editing.mrc}
                  onChange={() => setEditing({ ...editing, mrc: !editing.mrc })}
                  className="rounded bg-neutral-900 border-neutral-600"
                />
                <span className="text-sm text-neutral-300">{tChrome('dialog.batch.mrc')}</span>
              </label>
              {editing.mrc && (
                <div className="flex flex-col gap-2 ps-6">
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-neutral-400">{tChrome('dialog.batch.mrcPreset')}</span>
                    <select
                      data-testid="schedule-mrc-preset"
                      aria-label={tChrome('dialog.batch.mrcPreset')}
                      value={normalizeMrcPreset(editing.mrcPreset)}
                      onChange={(e) =>
                        setEditing({ ...editing, mrcPreset: normalizeMrcPreset(e.target.value) })
                      }
                      className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
                    >
                      <option value="archival">{tChrome('panel.compress.mrcPresetArchival')}</option>
                      <option value="balanced">{tChrome('panel.compress.mrcPresetBalanced')}</option>
                      <option value="smallest">{tChrome('panel.compress.mrcPresetSmallest')}</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="schedule-mrc-verify"
                      checked={editing.mrcVerifyText}
                      onChange={() =>
                        setEditing({ ...editing, mrcVerifyText: !editing.mrcVerifyText })
                      }
                      className="rounded bg-neutral-900 border-neutral-600"
                    />
                    <span className="text-sm text-neutral-300">{tChrome('dialog.batch.mrcVerify')}</span>
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <Field label={tChrome('dialog.schedule.runs')}>
              <select
                data-testid="schedule-frequency"
                value={editing.frequency}
                onChange={(e) =>
                  setEditing({ ...editing, frequency: e.target.value as ScheduleProfile['frequency'] })
                }
                className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              >
                <option value="daily">{tChrome('dialog.schedule.daily')}</option>
                <option value="weekly">{tChrome('dialog.schedule.weekly')}</option>
              </select>
            </Field>
            <Field label={tChrome('dialog.schedule.at')}>
              <input
                data-testid="schedule-time"
                value={editing.time}
                onChange={(e) => setEditing({ ...editing, time: e.target.value })}
                placeholder="09:30"
                className="w-24 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              />
            </Field>
            {editing.frequency === 'weekly' && (
              <Field label={tChrome('dialog.schedule.days')}>
                <input
                  value={editing.days}
                  onChange={(e) => setEditing({ ...editing, days: e.target.value })}
                  placeholder="MON,TUE"
                  className="w-40 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
                />
              </Field>
            )}
          </div>

          <details className="rounded border border-neutral-800 bg-neutral-950/40">
            <summary className="px-3 py-2 text-sm text-neutral-300 cursor-pointer select-none">
              {tChrome(
                editing.runType === 'action'
                  ? 'dialog.schedule.accountSection'
                  : 'dialog.schedule.filingSection',
              )}
            </summary>
            <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
              {editing.runType !== 'action' && !editing.inPlace && (
                <>
                  <FolderField
                    label={tChrome('dialog.schedule.movedLabel')}
                    testid="schedule-moved"
                    value={editing.movedRoot}
                    onPick={() => void pick(tChrome('dialog.common.pickProcessed'), (p) => setEditing({ ...editing, movedRoot: p }))}
                    onClear={() => setEditing({ ...editing, movedRoot: '' })}
                  />
                  <FolderField
                    label={tChrome('dialog.schedule.errorsLabel')}
                    testid="schedule-errors"
                    value={editing.errorRoot}
                    onPick={() => void pick(tChrome('dialog.schedule.pickErrors'), (p) => setEditing({ ...editing, errorRoot: p }))}
                    onClear={() => setEditing({ ...editing, errorRoot: '' })}
                  />
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="schedule-repair"
                      checked={editing.repairDamaged}
                      onChange={() => setEditing({ ...editing, repairDamaged: !editing.repairDamaged })}
                      className="rounded bg-neutral-900 border-neutral-600"
                    />
                    <span className="text-sm text-neutral-300">{tChrome('dialog.schedule.repair')}</span>
                  </label>
                </>
              )}

              <Field label={tChrome('dialog.schedule.accountLabel')}>
                <input
                  data-testid="schedule-account"
                  value={editing.account}
                  onChange={(e) => setEditing({ ...editing, account: e.target.value })}
                  placeholder="DOMAIN\user  or  DOMAIN\gmsa$"
                  className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
                />
              </Field>
              {editing.account.trim() !== '' && (
                <>
                  <Field label={tChrome('dialog.schedule.passwordLabel')}>
                    <input
                      data-testid="schedule-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
                    />
                  </Field>
                  <p className="text-xs text-neutral-500 -mt-1">
                    {tChrome('dialog.schedule.passwordNote')}
                  </p>
                  <FolderField
                    label={tChrome('dialog.schedule.logDirLabel')}
                    testid="schedule-logdir"
                    value={editing.logDir}
                    onPick={() => void pick(tChrome('dialog.schedule.pickLogDir'), (p) => setEditing({ ...editing, logDir: p }))}
                  />
                  <p className="text-xs text-neutral-500 -mt-1">
                    {tChrome('dialog.schedule.logDirNote')}
                  </p>
                </>
              )}
            </div>
          </details>

          {error && (
            <p className="text-sm text-red-400" data-testid="schedule-form-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setEditing(null);
                setPassword('');
                setError(null);
              }}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              {tChrome('dialog.common.cancel')}
            </button>
            <button
              data-testid="schedule-save"
              disabled={busy}
              onClick={() => void save()}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {tChrome(busy ? 'dialog.common.saving' : 'dialog.schedule.save')}
            </button>
          </div>
        </div>
      )}
      {status && <p className="text-xs text-neutral-500 mt-2">{status}</p>}
      <button
        data-testid="schedule-open-logs"
        onClick={() => void batch.openLogFolder(getSettings().batchLogDir).catch(() => {})}
        className="mt-2 text-xs text-neutral-500 underline hover:text-neutral-300"
      >
        {tChrome('dialog.schedule.openLogs')}
      </button>
    </Shell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <span className="block text-xs text-neutral-400 mb-1">{label}</span>
      {children}
    </div>
  );
}

function FolderField({
  label,
  testid,
  value,
  onPick,
  onClear,
}: {
  label: string;
  testid: string;
  value: string;
  onPick: () => void;
  onClear?: () => void;
}): React.JSX.Element {
  return (
    <div>
      <span className="block text-xs text-neutral-400 mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <button
          data-testid={`${testid}-pick`}
          onClick={onPick}
          className="px-2.5 py-1 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium shrink-0"
        >
          {tChrome('dialog.common.choose')}
        </button>
        <span
          data-testid={testid}
          className={`text-sm text-neutral-300 truncate${value ? ' ltr-notation' : ''}`}
          title={value}
        >
          {value || tChrome('dialog.common.notSet')}
        </span>
        {onClear && value !== '' && (
          <button
            onClick={onClear}
            className="px-2 py-0.5 text-xs text-neutral-500 hover:text-neutral-300 shrink-0"
          >
            {tChrome('dialog.common.clear')}
          </button>
        )}
      </div>
    </div>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  const shellRef = useAppModal(onClose);
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.schedule.title')}
        data-testid="schedule-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[620px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.schedule.title')}</h3>
          <button
            data-testid="schedule-x"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
