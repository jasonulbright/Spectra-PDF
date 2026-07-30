import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, app } from '../lib/tauri-bridge';
import { ensureGsPath } from './SettingsPanel';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerGuidedActionsHandlers } from '../testHarness';
import {
  STEP_CATALOG,
  askedParamKeys,
  buildStepParams,
  loadGuidedActions,
  newStep,
  saveGuidedActions,
  stepDefFor,
  validateAction,
  validateRunValues,
  type GuidedAction,
  type GuidedStepOp,
} from '../lib/guided-actions';

// Guided actions (parity map § 2 — the king's Action Wizard), slice 1: named
// sequences of existing gated engine ops, authored in a compact editor and
// run over the OPEN document. Each step goes through the standard
// snapshot → call → reload shape, so a run is undoable step-by-step and
// stops on the first failure with the step named. Later slices (ledger):
// catalog growth (OCR, header/footer), ask-at-run params, folder mode,
// export/import as files.

type RunValues = Record<number, Record<string, string | number>>;

type PanelView =
  | { kind: 'list' }
  | { kind: 'edit'; action: GuidedAction; isNew: boolean }
  | { kind: 'prerun'; action: GuidedAction; values: RunValues; error: string | null }
  | { kind: 'run'; action: GuidedAction };

type StepStatus = 'pending' | 'running' | 'done' | { error: string };

export function GuidedActionsPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [actions, setActions] = useState<GuidedAction[]>(() => loadGuidedActions());
  const [view, setView] = useState<PanelView>({ kind: 'list' });
  const [editError, setEditError] = useState<string | null>(null);
  const [runStatuses, setRunStatuses] = useState<StepStatus[]>([]);
  const [running, setRunning] = useState(false);

  const persist = (list: GuidedAction[]): void => {
    setActions(list);
    saveGuidedActions(list);
  };

  const reloadFile = useCallback(
    async (snapshotPath: string) => {
      if (!activeFile) return;
      const buf = await file.readBuffer(activeFile.workingPath);
      const pages = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({
        type: 'UPDATE_FILE',
        path: activeFile.path,
        pageCount: pages.pages,
        buffer: buf,
        snapshotPath,
      });
    },
    [activeFile, call, dispatch],
  );

  const executeRun = useCallback(
    async (action: GuidedAction, values: RunValues, terminalOverride?: string) => {
      if (!activeFile || running) return;
      const workingPath = activeFile.workingPath;
      // A terminal step (encrypt) writes a NEW file — pick it up front so a
      // long run never stalls mid-way on a dialog. Cancelling the pick
      // cancels the run before anything touches the document. (e2e injects
      // the path via the harness bridge — the dialog is native.)
      let terminalOutput: string | null = terminalOverride ?? null;
      const terminalIndex = action.steps.findIndex((s) => stepDefFor(s.op).terminalOutput);
      if (terminalIndex !== -1 && !terminalOutput) {
        terminalOutput = (await saveFile('encrypted.pdf')) ?? null;
        if (!terminalOutput) return;
      }
      setView({ kind: 'run', action });
      setRunStatuses(action.steps.map(() => 'pending'));
      setRunning(true);
      try {
        for (let i = 0; i < action.steps.length; i++) {
          const step = action.steps[i];
          setRunStatuses((s) => s.map((v, j) => (j === i ? 'running' : v)));
          try {
            const def = stepDefFor(step.op);
            const extras: Record<string, string> = {};
            if (def.needsGs) extras.gs_path = await ensureGsPath();
            if (def.needsFontDir) extras.font_dir = await app.getEditFontPath();
            if (def.needsTesseract) extras.tesseract_path = await app.getTesseractPath();
            if (def.terminalOutput) {
              // Writes the picked file; the open document is untouched, so
              // there is nothing to snapshot or reload.
              await call(step.op, {
                file: workingPath,
                output: terminalOutput!,
                ...buildStepParams(step, values[i]),
                ...extras,
              });
            } else {
              const snapshotPath = await file.snapshot(workingPath);
              await call(step.op, {
                file: workingPath,
                output: workingPath,
                ...buildStepParams(step, values[i]),
                ...extras,
              });
              await reloadFile(snapshotPath);
            }
            setRunStatuses((s) => s.map((v, j) => (j === i ? 'done' : v)));
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setRunStatuses((s) => s.map((v, j) => (j === i ? { error: msg } : v)));
            return; // stop on the first failure — prior steps stay, undoable
          }
        }
      } finally {
        setRunning(false);
      }
    },
    [activeFile, running, call, reloadFile, saveFile],
  );

  /** Run entry: collect ask-at-run values first when any step wants them. */
  const runAction = useCallback(
    (action: GuidedAction) => {
      if (!activeFile || running) return;
      const anyAsked = action.steps.some((s) => askedParamKeys(s).length > 0);
      if (anyAsked) {
        setView({ kind: 'prerun', action, values: {}, error: null });
        return;
      }
      void executeRun(action, {});
    },
    [activeFile, running, executeRun],
  );

  // Harness bridge: the terminal step's output is a NATIVE save dialog —
  // e2e injects the path + ask-at-run values and drives the REAL executeRun.
  const bridgeRef = useRef({ actions, executeRun });
  bridgeRef.current = { actions, executeRun };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerGuidedActionsHandlers({
      runWithOutput: async (actionId, values, output) => {
        const action = bridgeRef.current.actions.find((a) => a.id === actionId);
        if (!action) throw new Error(`runWithOutput: no action ${actionId}`);
        await bridgeRef.current.executeRun(action, values as RunValues, output);
      },
    });
    return () => registerGuidedActionsHandlers(null);
  }, []);

  const startNew = (): void => {
    setEditError(null);
    setView({
      kind: 'edit',
      isNew: true,
      action: { id: crypto.randomUUID(), name: '', steps: [] },
    });
  };

  const saveEdited = (action: GuidedAction, isNew: boolean): void => {
    const problem = validateAction(action);
    if (problem) {
      setEditError(problem);
      return;
    }
    persist(isNew ? [...actions, action] : actions.map((a) => (a.id === action.id ? action : a)));
    setEditError(null);
    setView({ kind: 'list' });
  };

  // ── Editor ────────────────────────────────────────────────────────────
  if (view.kind === 'edit') {
    const action = view.action;
    const setAction = (next: GuidedAction): void => setView({ ...view, action: next });
    return (
      <div className="flex flex-col gap-4" data-testid="actions-editor">
        <div className="text-sm font-medium text-neutral-300">
          {view.isNew ? 'New guided action' : 'Edit guided action'}
        </div>
        <input
          type="text"
          data-testid="action-name"
          value={action.name}
          onChange={(e) => setAction({ ...action, name: e.target.value })}
          placeholder="Action name"
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        />
        <div className="flex flex-col gap-2" data-testid="action-steps">
          {action.steps.map((step, i) => {
            const def = stepDefFor(step.op);
            return (
              <div
                key={i}
                data-testid={`action-step-${i}`}
                className="flex flex-col gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-neutral-200 flex-1">
                    {i + 1}. {def.title}
                  </span>
                  <button
                    type="button"
                    data-testid={`action-step-up-${i}`}
                    disabled={i === 0}
                    onClick={() => {
                      const steps = [...action.steps];
                      [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
                      setAction({ ...action, steps });
                    }}
                    className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-testid={`action-step-down-${i}`}
                    disabled={i === action.steps.length - 1}
                    onClick={() => {
                      const steps = [...action.steps];
                      [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
                      setAction({ ...action, steps });
                    }}
                    className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    data-testid={`action-step-remove-${i}`}
                    onClick={() =>
                      setAction({ ...action, steps: action.steps.filter((_, j) => j !== i) })
                    }
                    className="px-1.5 py-0.5 text-xs text-neutral-400 hover:text-red-400"
                  >
                    Remove
                  </button>
                </div>
                {def.params.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {def.params.map((p) => {
                      // Secrets are never stored: no input, just the fact.
                      if (p.secret) {
                        return (
                          <span
                            key={p.key}
                            className="text-xs text-neutral-500 px-1.5 py-1 border border-dashed border-neutral-700 rounded"
                            data-testid={`action-step-${i}-${p.key}-secret`}
                          >
                            {p.label}: asked when the action runs
                          </span>
                        );
                      }
                      const isAsked = (step.ask ?? []).includes(p.key);
                      const toggleAsk = (): void => {
                        const ask = new Set(step.ask ?? []);
                        if (ask.has(p.key)) ask.delete(p.key);
                        else ask.add(p.key);
                        const steps = [...action.steps];
                        steps[i] = { ...step, ask: [...ask] };
                        setAction({ ...action, steps });
                      };
                      return (
                        <label key={p.key} className="flex items-center gap-1 text-xs text-neutral-400" title={p.hint}>
                          {p.label}
                          {p.kind === 'select' ? (
                            <select
                              data-testid={`action-step-${i}-${p.key}`}
                              value={String(step.params[p.key] ?? p.defaultValue)}
                              disabled={isAsked}
                              onChange={(e) => {
                                const steps = [...action.steps];
                                steps[i] = {
                                  ...step,
                                  params: { ...step.params, [p.key]: e.target.value },
                                };
                                setAction({ ...action, steps });
                              }}
                              className="px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs disabled:opacity-40"
                            >
                              {p.options!.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={p.kind === 'number' ? 'number' : p.kind}
                              data-testid={`action-step-${i}-${p.key}`}
                              value={String(step.params[p.key] ?? p.defaultValue)}
                              min={p.min}
                              max={p.max}
                              step={p.step}
                              disabled={isAsked}
                              onChange={(e) => {
                                const steps = [...action.steps];
                                steps[i] = {
                                  ...step,
                                  params: { ...step.params, [p.key]: e.target.value },
                                };
                                setAction({ ...action, steps });
                              }}
                              className="px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs w-32 disabled:opacity-40"
                            />
                          )}
                          <span
                            className="flex items-center gap-0.5 text-neutral-500"
                            title="Ask for this value each time the action runs"
                          >
                            <input
                              type="checkbox"
                              data-testid={`action-step-${i}-${p.key}-ask`}
                              checked={isAsked}
                              onChange={toggleAsk}
                            />
                            ask
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <AddStepPicker
            onAdd={(op) => setAction({ ...action, steps: [...action.steps, newStep(op)] })}
          />
        </div>
        {editError && (
          <p className="text-sm text-red-400" data-testid="action-edit-error">
            {editError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="action-save"
            onClick={() => saveEdited(action, view.isNew)}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
          >
            Save action
          </button>
          <button
            type="button"
            data-testid="action-cancel"
            onClick={() => {
              setEditError(null);
              setView({ kind: 'list' });
            }}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Pre-run form (ask-at-run values; secrets are always here) ─────────
  if (view.kind === 'prerun') {
    const { action, values } = view;
    const setValue = (stepIdx: number, key: string, v: string): void =>
      setView({
        ...view,
        values: { ...values, [stepIdx]: { ...values[stepIdx], [key]: v } },
      });
    const start = (): void => {
      for (let i = 0; i < action.steps.length; i++) {
        if (askedParamKeys(action.steps[i]).length === 0) continue;
        const problem = validateRunValues(action.steps[i], values[i] ?? {});
        if (problem) {
          setView({ ...view, error: problem });
          return;
        }
      }
      void executeRun(action, values);
    };
    return (
      <div className="flex flex-col gap-4" data-testid="actions-prerun">
        <div className="text-sm font-medium text-neutral-300">
          Before running “{action.name}”
        </div>
        {action.steps.map((step, i) => {
          const asked = askedParamKeys(step);
          if (asked.length === 0) return null;
          const def = stepDefFor(step.op);
          return (
            <div key={i} className="flex flex-col gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded">
              <div className="text-sm text-neutral-200">
                {i + 1}. {def.title}
                {def.terminalOutput && (
                  <span className="text-xs text-neutral-500"> — writes a new file you pick next</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {asked.map((key) => {
                  const p = def.params.find((x) => x.key === key)!;
                  return (
                    <label key={key} className="flex items-center gap-1 text-xs text-neutral-400">
                      {p.label}
                      {p.kind === 'select' ? (
                        <select
                          data-testid={`prerun-${i}-${key}`}
                          value={String(values[i]?.[key] ?? p.defaultValue)}
                          onChange={(e) => setValue(i, key, e.target.value)}
                          className="px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
                        >
                          {p.options!.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={p.kind === 'number' ? 'number' : p.kind}
                          data-testid={`prerun-${i}-${key}`}
                          value={String(values[i]?.[key] ?? '')}
                          min={p.min}
                          max={p.max}
                          step={p.step}
                          onChange={(e) => setValue(i, key, e.target.value)}
                          className="px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs w-40"
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
        {view.error && (
          <p className="text-sm text-red-400" data-testid="prerun-error">{view.error}</p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="prerun-start"
            onClick={start}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
          >
            Start
          </button>
          <button
            type="button"
            data-testid="prerun-cancel"
            onClick={() => setView({ kind: 'list' })}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Run view ──────────────────────────────────────────────────────────
  if (view.kind === 'run') {
    const failed = runStatuses.find((s) => typeof s === 'object');
    const allDone = runStatuses.length > 0 && runStatuses.every((s) => s === 'done');
    return (
      <div className="flex flex-col gap-4" data-testid="actions-run">
        <div className="text-sm font-medium text-neutral-300">Running “{view.action.name}”</div>
        <div className="flex flex-col gap-1">
          {view.action.steps.map((step, i) => {
            const s = runStatuses[i] ?? 'pending';
            return (
              <div
                key={i}
                data-testid={`run-step-${i}`}
                data-status={typeof s === 'object' ? 'error' : s}
                className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800/60 border border-neutral-800 rounded text-sm"
              >
                <span className="w-4 text-center">
                  {s === 'done' ? '✓' : s === 'running' ? '…' : typeof s === 'object' ? '✕' : '·'}
                </span>
                <span className="flex-1 text-neutral-200">{stepDefFor(step.op).title}</span>
                {typeof s === 'object' && (
                  <span className="text-xs text-red-400" title={s.error}>
                    {s.error.length > 60 ? `${s.error.slice(0, 59)}…` : s.error}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {allDone && (
          <p className="text-sm text-green-400" data-testid="run-done">
            Done — every step applied. Each step is one Undo.
          </p>
        )}
        {failed && (
          <p className="text-sm text-red-400" data-testid="run-failed">
            Stopped at the failed step; earlier steps stay applied (undoable).
          </p>
        )}
        <div>
          <button
            type="button"
            data-testid="run-close"
            disabled={running}
            onClick={() => setView({ kind: 'list' })}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm"
          >
            Back to actions
          </button>
        </div>
      </div>
    );
  }

  // ── List ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-neutral-300">Guided actions</div>
        <button
          type="button"
          data-testid="action-new"
          onClick={startNew}
          className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded font-medium"
        >
          New action…
        </button>
      </div>
      {actions.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="actions-empty">
          No actions yet. An action runs a sequence of steps — compress,
          watermark, encrypt… — over the open document with one click.
        </p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="actions-list">
          {actions.map((a) => (
            <div
              key={a.id}
              data-testid={`action-item-${a.id}`}
              className="flex items-center gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-neutral-200 truncate">{a.name}</div>
                <div className="text-xs text-neutral-500">
                  {a.steps.map((s) => stepDefFor(s.op).title).join(' → ')}
                </div>
              </div>
              <button
                type="button"
                data-testid={`action-run-${a.id}`}
                disabled={!activeFile || running}
                onClick={() => void runAction(a)}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              >
                Run
              </button>
              <button
                type="button"
                data-testid={`action-edit-${a.id}`}
                onClick={() => {
                  setEditError(null);
                  setView({ kind: 'edit', isNew: false, action: { ...a, steps: a.steps.map((s) => ({ ...s, params: { ...s.params } })) } });
                }}
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
              >
                Edit
              </button>
              <button
                type="button"
                data-testid={`action-duplicate-${a.id}`}
                onClick={() =>
                  persist([
                    ...actions,
                    {
                      id: crypto.randomUUID(),
                      name: `${a.name} (copy)`,
                      steps: a.steps.map((s) => ({ ...s, params: { ...s.params } })),
                    },
                  ])
                }
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
              >
                Duplicate
              </button>
              <button
                type="button"
                data-testid={`action-delete-${a.id}`}
                onClick={() => persist(actions.filter((x) => x.id !== a.id))}
                className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {!activeFile && (
        <NoFileOpen onOpen={openNewFiles} message="Open a PDF to run an action on it" />
      )}
      <StatusBar message="" busy={running} />
    </div>
  );
}

function AddStepPicker({ onAdd }: { onAdd: (op: GuidedStepOp) => void }): React.ReactElement {
  const [op, setOp] = useState<GuidedStepOp>(STEP_CATALOG[0].op);
  return (
    <>
      <select
        data-testid="action-add-op"
        value={op}
        onChange={(e) => setOp(e.target.value as GuidedStepOp)}
        className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
      >
        {STEP_CATALOG.map((d) => (
          <option key={d.op} value={d.op}>
            {d.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="action-add-step"
        onClick={() => onAdd(op)}
        className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
      >
        Add step
      </button>
    </>
  );
}
