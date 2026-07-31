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
import { TEST_HARNESS_ENABLED, registerScheduledRuns } from '../testHarness';

// Tools ▸ Scheduled Batch Runs (Phase 12, issue #1 request 5).
//
// The owner's ruling: scheduling is a GUI feature, not a documentation page —
// "so the user never has to touch task scheduler". This is the whole lifecycle:
// create, list, run-now, enable/disable, DELETE. Windows Task Scheduler does
// the timing, which is why a run fires with the app CLOSED; an in-app timer
// would silently not run on any morning nobody opened the app.
//
// The list is read back from the registered tasks themselves — there is no
// profile file that could disagree with what will actually fire.
//
// Guided-actions slice 5: the same lifecycle schedules a SAVED ACTION over a
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
  runType: 'batch-ocr',
  actionFile: '',
};

export function ScheduledRunsDialog({ onClose }: ScheduledRunsDialogProps): React.JSX.Element {
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
        setError('Choose which guided action to run.');
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
    setStatus('Creating the schedule…');
    try {
      await schedule.create(editing, password || undefined, actionJson);
      // The password only ever existed for this call — Windows stores it, we
      // do not (the .pfx signing-password posture).
      setPassword('');
      setEditing(null);
      setStatus('Schedule saved');
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
            Scheduled runs happen through Windows Task Scheduler, so they run even when Open
            PDF Studio is closed. Everything here is managed from this window — you never need
            to open Task Scheduler.
          </p>

          {runs === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-neutral-400" data-testid="schedule-empty">
              No scheduled runs yet.
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
                    Next: {r.nextRun || '—'} · Last: {r.lastRun || 'never'}
                    {r.lastResult ? ` (${r.lastResult})` : ''}
                  </div>
                  {r.profile ? (
                    <>
                      <div className="text-xs text-neutral-400 mt-0.5 truncate" title={r.profile.source}>
                        {r.profile.source} → {r.profile.dest}
                      </div>
                      {r.profile.runType === 'action' && (
                        <div
                          className="text-xs text-neutral-400 mt-0.5 truncate"
                          data-testid={`schedule-action-info-${r.name}`}
                          title={r.actionSteps.join(' → ')}
                        >
                          Guided action: {r.actionName || '(unnamed)'}
                          {r.actionSteps.length > 0 && ` — ${r.actionSteps.join(' → ')}`}
                        </div>
                      )}
                      {r.actionMissing && (
                        // It will still FIRE and fail — shown, never hidden.
                        <div className="text-xs text-amber-400 mt-0.5" data-testid={`schedule-action-missing-${r.name}`}>
                          Its action file is missing — the run will fail until the schedule is
                          recreated.
                        </div>
                      )}
                    </>
                  ) : (
                    // It will still FIRE, so it is shown rather than hidden.
                    <div className="text-xs text-amber-400 mt-0.5">
                      Edited outside this app — its settings cannot be shown here, but it will
                      still run.
                    </div>
                  )}
                  <div className="flex gap-2 mt-1.5">
                    <button
                      data-testid={`schedule-run-${r.name}`}
                      disabled={busy}
                      onClick={() => void act('Starting…', () => schedule.runNow(r.name))}
                      className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    >
                      Run now
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          'Updating…',
                          () =>
                            schedule.setEnabled(
                              r.name,
                              r.status.toLowerCase().includes('disabled'),
                            ),
                        )
                      }
                      className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    >
                      {r.status.toLowerCase().includes('disabled') ? 'Enable' : 'Disable'}
                    </button>
                    {r.profile && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setActionId('');
                          setEditing({ ...EMPTY, ...r.profile! });
                        }}
                        className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                      >
                        Edit
                      </button>
                    )}
                    <div className="flex-1" />
                    {confirmDelete === r.name ? (
                      <>
                        <span className="text-xs text-amber-400 self-center">Delete it?</span>
                        <button
                          data-testid={`schedule-delete-confirm-${r.name}`}
                          disabled={busy}
                          onClick={() => {
                            setConfirmDelete(null);
                            void act('Deleting…', () => schedule.remove(r.name));
                          }}
                          className="px-2 py-0.5 text-xs bg-red-700/80 hover:bg-red-600 disabled:opacity-50 rounded"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-0.5 text-xs text-neutral-400 hover:text-neutral-200"
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        data-testid={`schedule-delete-${r.name}`}
                        disabled={busy}
                        onClick={() => setConfirmDelete(r.name)}
                        className="px-2 py-0.5 text-xs text-neutral-400 hover:text-red-400 disabled:opacity-50"
                      >
                        Delete
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
              Close
            </button>
            <button
              data-testid="schedule-new"
              onClick={() => {
                setActionId('');
                setEditing({ ...EMPTY, logDir: getSettings().batchLogDir });
                setError(null);
              }}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
            >
              New scheduled run
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="schedule-form">
          <Field label="Name">
            <input
              data-testid="schedule-name"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
            />
          </Field>

          <Field label="What runs">
            <select
              data-testid="schedule-runtype"
              value={editing.runType === 'action' ? 'action' : 'batch-ocr'}
              onChange={(e) => setEditing({ ...editing, runType: e.target.value })}
              className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
            >
              <option value="batch-ocr">Batch OCR (make searchable)</option>
              <option value="action">Guided action</option>
            </select>
          </Field>

          {editing.runType === 'action' && (
            <Field label="Guided action">
              <select
                data-testid="schedule-action"
                value={actionId}
                onChange={(e) => setActionId(e.target.value)}
                className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              >
                <option value="">
                  {editing.actionFile ? '(keep the current action)' : 'Choose an action…'}
                </option>
                {libraryActions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.steps.map((s) => stepDefFor(s.op).title).join(' → ')}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 mt-1">
                The schedule keeps its own copy of the action; edit the schedule to pick up
                later changes. Actions that ask for values when they run can’t be scheduled.
              </p>
            </Field>
          )}

          <FolderField
            label="Source folder"
            testid="schedule-source"
            value={editing.source}
            onPick={() => void pick('Choose the folder to process', (p) => setEditing({ ...editing, source: p }))}
          />
          <FolderField
            label="Destination folder"
            testid="schedule-dest"
            value={editing.dest}
            onPick={() => void pick('Choose the destination folder', (p) => setEditing({ ...editing, dest: p }))}
          />

          {editing.runType !== 'action' && (
            <Field label={`Recognition languages — ${describeLanguages(langs)}`}>
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
                    <span className="text-neutral-300">{l.label}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}

          <div className="flex gap-3">
            <Field label="Runs">
              <select
                data-testid="schedule-frequency"
                value={editing.frequency}
                onChange={(e) =>
                  setEditing({ ...editing, frequency: e.target.value as ScheduleProfile['frequency'] })
                }
                className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              >
                <option value="daily">Every day</option>
                <option value="weekly">Weekly</option>
              </select>
            </Field>
            <Field label="At">
              <input
                data-testid="schedule-time"
                value={editing.time}
                onChange={(e) => setEditing({ ...editing, time: e.target.value })}
                placeholder="09:30"
                className="w-24 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              />
            </Field>
            {editing.frequency === 'weekly' && (
              <Field label="Days">
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
              {editing.runType === 'action' ? 'Account' : 'Filing and account'}
              <span className="text-neutral-500"> — optional</span>
            </summary>
            <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
              {editing.runType !== 'action' && (
                <>
                  <FolderField
                    label="Move processed originals to"
                    testid="schedule-moved"
                    value={editing.movedRoot}
                    onPick={() => void pick('Choose where processed originals go', (p) => setEditing({ ...editing, movedRoot: p }))}
                    onClear={() => setEditing({ ...editing, movedRoot: '' })}
                  />
                  <FolderField
                    label="Move failed originals to"
                    testid="schedule-errors"
                    value={editing.errorRoot}
                    onPick={() => void pick('Choose where failed originals go', (p) => setEditing({ ...editing, errorRoot: p }))}
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
                    <span className="text-sm text-neutral-300">Try to repair damaged files</span>
                  </label>
                </>
              )}

              <Field label="Run as (blank = you)">
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
                  <Field label="Password (leave blank for a managed service account)">
                    <input
                      data-testid="schedule-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
                    />
                  </Field>
                  <p className="text-xs text-neutral-500 -mt-1">
                    Windows stores this, not Open PDF Studio. The account also needs the “Log on
                    as a batch job” right on this machine, or the schedule is created but never
                    runs.
                  </p>
                  <FolderField
                    label="Log folder (required when running as another account)"
                    testid="schedule-logdir"
                    value={editing.logDir}
                    onPick={() => void pick('Choose where run logs are written', (p) => setEditing({ ...editing, logDir: p }))}
                  />
                  <p className="text-xs text-neutral-500 -mt-1">
                    The default log location belongs to whichever account runs the batch, so a
                    run under another account would write its log where you cannot see it.
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
              Cancel
            </button>
            <button
              data-testid="schedule-save"
              disabled={busy}
              onClick={() => void save()}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {busy ? 'Saving…' : 'Save schedule'}
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
        Open log folder
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
          Choose…
        </button>
        <span data-testid={testid} className="text-sm text-neutral-300 truncate" title={value}>
          {value || 'Not set'}
        </span>
        {onClear && value !== '' && (
          <button
            onClick={onClear}
            className="px-2 py-0.5 text-xs text-neutral-500 hover:text-neutral-300 shrink-0"
          >
            Clear
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
        aria-label="Scheduled Batch Runs"
        data-testid="schedule-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[620px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">Scheduled Batch Runs</h3>
          <button
            data-testid="schedule-x"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            Close
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
