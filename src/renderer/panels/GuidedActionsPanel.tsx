import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { file, app, dialog, batch, actionFile } from '../lib/tauri-bridge';
import { getSettings } from '../lib/app-settings';
import { gsBlocked, requireGsPath } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from '../components/GsRequiredNotice';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerGuidedActionsHandlers } from '../testHarness';
import {
  STEP_CATALOG,
  actionFileJson,
  askedParamKeys,
  buildStepParams,
  editorParams,
  gsBlocker,
  inPlaceBlocker,
  loadGuidedActions,
  newStep,
  openDocumentBlocker,
  parseActionFile,
  saveGuidedActions,
  stepDefFor,
  terminalOutputName,
  validateAction,
  validateRunValues,
  type GuidedAction,
  type GuidedStepOp,
} from '../lib/guided-actions';
import { useTranslation } from 'react-i18next';
import { tChrome, tStepTitle, tStepParam, tStepOption, tStepHint } from '../i18n';

// Guided actions are named sequences of existing gated engine operations,
// authored in a compact editor and
// run over the OPEN document. Each step goes through the standard
// snapshot → call → reload shape, so a run is undoable step-by-step and
// stops on the first failure with the step named. Later slices (ledger):
// catalog growth (OCR, header/footer), ask-at-run params, folder mode,
// export/import as files.

type RunValues = Record<number, Record<string, string | number>>;

interface FolderReport {
  total: number;
  ok: number;
  failed: number;
  results: { rel: string; status: string; steps_applied?: number; error?: string }[];
  log_path?: string;
}

type PanelView =
  | { kind: 'list' }
  | { kind: 'edit'; action: GuidedAction; isNew: boolean }
  | {
      kind: 'prerun';
      action: GuidedAction;
      values: RunValues;
      error: string | null;
      folder?: { source: string; dest: string; inPlace?: boolean };
    }
  | { kind: 'run'; action: GuidedAction }
  | { kind: 'folderrun'; action: GuidedAction; report: FolderReport | null; error: string | null };

type StepStatus = 'pending' | 'running' | 'done' | { error: string };

export function GuidedActionsPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call, callRaw, saveFile } = useEngine();
  const { confirmSignedEdit } = useOperations();
  const [actions, setActions] = useState<GuidedAction[]>(() => loadGuidedActions());
  const [view, setView] = useState<PanelView>({ kind: 'list' });
  const [editError, setEditError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [runStatuses, setRunStatuses] = useState<StepStatus[]>([]);
  const [running, setRunning] = useState(false);
  const gs = useGsCapability();
  // The run callbacks are memoised on their own inputs; a ref keeps the
  // plan-time check reading the CURRENT answer without making every run
  // handler depend on it.
  const gsRef = useRef(gs);
  gsRef.current = gs;

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
        terminalOutput = (await saveFile(terminalOutputName(action.steps[terminalIndex]))) ?? null;
        if (!terminalOutput) return;
      }
      // ONE signed-document decision for the whole run, before any step
      // touches the document: an in-place step here is always a whole-file
      // rewrite (`structural`), and asking per step would put the same dialog
      // in front of a user N times for one gesture. A run whose only steps
      // write elsewhere never asks. Taken before the first `file.snapshot`,
      // whose commit gate would otherwise flush pending page edits on the way
      // to refusing the run.
      const touchesDocument = action.steps.some((s) => !stepDefFor(s.op).terminalOutput);
      if (
        touchesDocument &&
        !(await confirmSignedEdit(activeFile.path, workingPath, 'structural'))
      ) {
        return;
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
            if (def.needsGs) extras.gs_path = await requireGsPath();
            if (def.needsFontDir) extras.font_dir = await app.getEditFontPath();
            if (def.needsTesseract) extras.tesseract_path = await app.getTesseractPath();
            if (def.needsSoffice) extras.soffice_path = await app.getSofficePath();
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
    [activeFile, running, call, reloadFile, saveFile, confirmSignedEdit],
  );

  /** Run entry: collect ask-at-run values first when any step wants them. */
  const runAction = useCallback(
    (action: GuidedAction) => {
      if (!activeFile || running) return;
      // An action that CREATES its document has nothing to create from when
      // it is pointed at one that already exists. The button is disabled and
      // says why, so this is belt-and-braces at the one place a keyboard or a
      // stale render could still reach.
      if (openDocumentBlocker(action) !== null) return;
      // PLAN time, not mid-run: a sequence whose fourth step needs an
      // interpreter must refuse before its first step has rewritten the
      // document three times.
      if (gsBlocker(action, !gsBlocked(gsRef.current)) !== null) return;
      const anyAsked = action.steps.some((s) => askedParamKeys(s).length > 0);
      if (anyAsked) {
        setView({ kind: 'prerun', action, values: {}, error: null });
        return;
      }
      void executeRun(action, {});
    },
    [activeFile, running, executeRun],
  );

  /** FOLDER mode: run the sequence over every PDF under a folder,
   * mirroring into a destination — the batch-OCR shape, engine-side, so one
   * RPC covers the whole run and the CLI/scheduled arms share it. Works with
   * no document open. */
  const executeFolderRun = useCallback(
    async (
      action: GuidedAction,
      values: RunValues,
      source: string,
      dest: string,
      inPlace = false,
    ) => {
      if (running) return;
      setView({ kind: 'folderrun', action, report: null, error: null });
      setRunning(true);
      try {
        const settings = getSettings();
        const logDir = settings.batchLogEnabled ? await batch.logDir(settings.batchLogDir) : '';
        if (settings.batchLogEnabled && settings.batchLogRetentionDays > 0) {
          await batch.pruneLogs(settings.batchLogRetentionDays, settings.batchLogDir).catch(() => 0);
        }
        const steps = action.steps.map((s, i) => ({
          op: s.op,
          params: buildStepParams(s, values[i]),
        }));
        const report = (await callRaw('run_action', {
          source,
          dest: inPlace ? '' : dest,
          steps,
          action_name: action.name,
          gs_path: await requireGsPath(),
          tesseract_path: await app.getTesseractPath(),
          // A folder run may START with a create_pdf step, so
          // the LibreOffice arm has to be reachable from here too.
          soffice_path: await app.getSofficePath(),
          font_dir: await app.getEditFontPath(),
          log_dir: logDir,
          write_log: settings.batchLogEnabled,
          in_place: inPlace,
        })) as unknown as FolderReport;
        setView({ kind: 'folderrun', action, report, error: null });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setView({ kind: 'folderrun', action, report: null, error: msg });
      } finally {
        setRunning(false);
      }
    },
    [running, callRaw],
  );

  const runActionOnFolder = useCallback(
    async (action: GuidedAction) => {
      if (running) return;
      if (gsBlocker(action, !gsBlocked(gsRef.current)) !== null) return;
      const source = await dialog.pickFolder(tChrome('panel.ga.pickSource'));
      if (!source) return;
      const dest = await dialog.pickFolder(tChrome('panel.ga.pickDest'));
      if (!dest) return;
      const anyAsked = action.steps.some((s) => askedParamKeys(s).length > 0);
      if (anyAsked) {
        setView({ kind: 'prerun', action, values: {}, error: null, folder: { source, dest } });
        return;
      }
      void executeFolderRun(action, {}, source, dest);
    },
    [running, executeFolderRun],
  );

  // In-place: run the sequence over a folder REPLACING the originals
  // (engine-side staging + verify + atomic swap per file). The two-step
  // confirm lives on the list row — this only fires from its Replace button.
  const runActionInPlace = useCallback(
    async (action: GuidedAction) => {
      if (running) return;
      // The engine refuses this too; refusing here means no folder picker
      // opens for a run that cannot happen.
      if (inPlaceBlocker(action) !== null) return;
      if (gsBlocker(action, !gsBlocked(gsRef.current)) !== null) return;
      const source = await dialog.pickFolder(tChrome('panel.ga.pickInPlace'));
      if (!source) return;
      const anyAsked = action.steps.some((s) => askedParamKeys(s).length > 0);
      if (anyAsked) {
        setView({
          kind: 'prerun',
          action,
          values: {},
          error: null,
          folder: { source, dest: '', inPlace: true },
        });
        return;
      }
      void executeFolderRun(action, {}, source, '', true);
    },
    [running, executeFolderRun],
  );
  const [confirmInPlace, setConfirmInPlace] = useState<string | null>(null);

  // Slice 4: actions travel as FILES — the `{name, steps}` shape the CLI
  // consumes (`run-action --action file.json`). Export strips secrets by the
  // same construction as the persist path (an exported file can never carry
  // a password); import validates against the catalog BY NAME and mints a
  // fresh id, so imports never collide with or overwrite an existing action.
  //
  // BOTH directions go around the capability-scoped filesystem plugin, whose
  // scope is the app's own temp tree: an action file's whole purpose is to
  // live wherever the user keeps it, so its destination is always one they
  // picked. The same shape as the preflight profile's, and for the same
  // reason a spec drives it — a scoped write against a user-chosen path
  // refuses only at run time, in the built binary.
  const executeExport = async (action: GuidedAction, path: string): Promise<void> => {
    await actionFile.write(path, actionFileJson(action));
  };
  const executeImport = async (path: string): Promise<void> => {
    const bytes = await actionFile.read(path);
    const action = parseActionFile(new TextDecoder().decode(bytes));
    persist([...bridgeRef.current.actions, action]);
  };
  const exportAction = async (action: GuidedAction): Promise<void> => {
    const name = action.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'action';
    const path = await saveFile(`${name}.json`);
    if (!path) return;
    try {
      await executeExport(action, path);
      setListError(null);
    } catch (e: unknown) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  };
  const importAction = async (): Promise<void> => {
    const path = await dialog.pickAnyFile();
    if (!path) return;
    try {
      await executeImport(path);
      setListError(null);
    } catch (e: unknown) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  };

  // Harness bridge: the terminal step's output, the folder pickers, and the
  // export/import dialogs are NATIVE — e2e injects the paths + ask-at-run
  // values and drives the REAL execute paths.
  const bridgeRef = useRef({ actions, executeRun, executeFolderRun, executeExport, executeImport });
  bridgeRef.current = { actions, executeRun, executeFolderRun, executeExport, executeImport };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerGuidedActionsHandlers({
      runWithOutput: async (actionId, values, output) => {
        const action = bridgeRef.current.actions.find((a) => a.id === actionId);
        if (!action) throw new Error(`runWithOutput: no action ${actionId}`);
        await bridgeRef.current.executeRun(action, values as RunValues, output);
      },
      runFolder: async (actionId, values, source, dest, inPlace) => {
        const action = bridgeRef.current.actions.find((a) => a.id === actionId);
        if (!action) throw new Error(`runFolder: no action ${actionId}`);
        await bridgeRef.current.executeFolderRun(
          action,
          values as RunValues,
          source,
          dest,
          inPlace ?? false,
        );
      },
      exportToPath: async (actionId, path) => {
        const action = bridgeRef.current.actions.find((a) => a.id === actionId);
        if (!action) throw new Error(`exportToPath: no action ${actionId}`);
        await bridgeRef.current.executeExport(action, path);
      },
      importFromPath: async (path) => bridgeRef.current.executeImport(path),
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
          {view.isNew ? tChrome('panel.ga.newAction') : tChrome('panel.ga.editAction')}
        </div>
        <input
          type="text"
          data-testid="action-name"
          value={action.name}
          onChange={(e) => setAction({ ...action, name: e.target.value })}
          placeholder={tChrome('panel.ga.namePlaceholder')}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        />
        <div className="flex flex-col gap-2" data-testid="action-steps">
          {action.steps.map((step, i) => {
            const def = stepDefFor(step.op);
            const shown = editorParams(step);
            return (
              <div
                key={i}
                data-testid={`action-step-${i}`}
                className="flex flex-col gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-neutral-200 flex-1">
                    {i + 1}. {tStepTitle(def.op, def.title)}
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
                    className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
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
                    className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    data-testid={`action-step-remove-${i}`}
                    onClick={() =>
                      setAction({ ...action, steps: action.steps.filter((_, j) => j !== i) })
                    }
                    className="text-xs danger-action is-quiet"
                  >
                    {tChrome('panel.ga.remove')}
                  </button>
                </div>
                {/* The step's parameters share one grid, so every control
                    starts at the same column no matter how long its label is.
                    Laid out as chips they took nine x-positions down nine
                    rows. `contents` on the label keeps the control associated
                    with its text while letting the three parts be grid
                    items. */}
                {shown.length > 0 && (
                  <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-center">
                    {shown.map((p) => {
                      // Secrets are never stored: no input, just the fact.
                      if (p.secret) {
                        return (
                          <span
                            key={p.key}
                            className="col-span-3 text-xs text-neutral-500 px-1.5 py-1 border border-dashed border-neutral-700 rounded"
                            data-testid={`action-step-${i}-${p.key}-secret`}
                          >
                            {tChrome('panel.ga.askedWhenRuns', { label: tStepParam(def.op, p.key, p.label) })}
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
                        <label
                          key={p.key}
                          className="contents text-xs text-neutral-400"
                          title={p.hint ? tStepHint(def.op, p.key, p.hint) : undefined}
                        >
                          <span className="text-xs text-neutral-400">
                            {tStepParam(def.op, p.key, p.label)}
                          </span>
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
                              className="w-full px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs disabled:opacity-60"
                            >
                              {p.options!.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {tStepOption(def.op, p.key, o.value, o.label)}
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
                              className="w-full px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs disabled:opacity-60"
                            />
                          )}
                          <span
                            className="flex items-center gap-1.5 text-xs text-neutral-500"
                            title={tChrome('panel.ga.askTitle')}
                          >
                            <input
                              type="checkbox"
                              data-testid={`action-step-${i}-${p.key}-ask`}
                              checked={isAsked}
                              onChange={toggleAsk}
                            />
                            {tChrome('panel.ga.ask')}
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
            {tChrome('panel.ga.saveAction')}
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
            {tChrome('panel.ga.cancel')}
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
      if (view.folder)
        void executeFolderRun(
          action,
          values,
          view.folder.source,
          view.folder.dest,
          view.folder.inPlace ?? false,
        );
      else void executeRun(action, values);
    };
    return (
      <div className="flex flex-col gap-4" data-testid="actions-prerun">
        <div className="text-sm font-medium text-neutral-300">
          {tChrome('panel.ga.beforeRunning', { name: action.name })}
        </div>
        {action.steps.map((step, i) => {
          const asked = askedParamKeys(step);
          if (asked.length === 0) return null;
          const def = stepDefFor(step.op);
          return (
            <div key={i} className="flex flex-col gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded">
              <div className="text-sm text-neutral-200">
                {i + 1}. {tStepTitle(def.op, def.title)}
                {def.terminalOutput && (
                  <span className="text-xs text-neutral-500">{tChrome('panel.ga.writesNewFile')}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {asked.map((key) => {
                  const p = def.params.find((x) => x.key === key)!;
                  return (
                    <label key={key} className="flex items-center gap-1 text-xs text-neutral-400">
                      {tStepParam(def.op, p.key, p.label)}
                      {p.kind === 'select' ? (
                        <select
                          data-testid={`prerun-${i}-${key}`}
                          value={String(values[i]?.[key] ?? p.defaultValue)}
                          onChange={(e) => setValue(i, key, e.target.value)}
                          className="px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
                        >
                          {p.options!.map((o) => (
                            <option key={o.value} value={o.value}>
                              {tStepOption(def.op, key, o.value, o.label)}
                            </option>
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
            {tChrome('panel.ga.start')}
          </button>
          <button
            type="button"
            data-testid="prerun-cancel"
            onClick={() => setView({ kind: 'list' })}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
          >
            {tChrome('panel.ga.cancel')}
          </button>
        </div>
      </div>
    );
  }

  // ── Folder-run view: spinner while the engine works, then the report ──
  if (view.kind === 'folderrun') {
    const { report, error } = view;
    return (
      <div className="flex flex-col gap-4" data-testid="actions-folderrun">
        <div className="text-sm font-medium text-neutral-300">
          {tChrome('panel.ga.folderRun', { name: view.action.name })}
        </div>
        {!report && !error && (
          <p className="text-sm text-neutral-400" data-testid="folderrun-busy" aria-live="polite">
            {tChrome('panel.ga.processing')}
          </p>
        )}
        {error && (
          <p className="text-sm text-red-400" data-testid="folderrun-error">{error}</p>
        )}
        {report && (
          <>
            <p className="text-sm text-neutral-200" data-testid="folderrun-summary">
              {tChrome('panel.ga.folderSummary', { ok: report.ok, failed: report.failed, total: report.total })}
            </p>
            {report.failed > 0 && (
              <div className="flex flex-col gap-1" data-testid="folderrun-errors">
                {report.results
                  .filter((r) => r.status === 'error')
                  .map((r) => (
                    <div key={r.rel} className="text-xs text-red-400" title={r.error}>
                      {r.rel} — {r.error}
                    </div>
                  ))}
              </div>
            )}
            {report.log_path && (
              <p className="text-xs text-neutral-500" data-testid="folderrun-log">
                {tChrome('panel.ga.log', { path: report.log_path })}
              </p>
            )}
          </>
        )}
        <div>
          <button
            type="button"
            data-testid="folderrun-close"
            disabled={running}
            onClick={() => setView({ kind: 'list' })}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm"
          >
            {tChrome('panel.ga.backToActions')}
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
        <div className="text-sm font-medium text-neutral-300">{tChrome('panel.ga.running', { name: view.action.name })}</div>
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
                <span className="flex-1 text-neutral-200">{tStepTitle(step.op, stepDefFor(step.op).title)}</span>
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
            {tChrome('panel.ga.done')}
          </p>
        )}
        {failed && (
          <p className="text-sm text-red-400" data-testid="run-failed">
            {tChrome('panel.ga.stopped')}
          </p>
        )}
        <div>
          <button
            type="button"
            data-testid="run-close"
            disabled={running}
            onClick={() => setView({ kind: 'list' })}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded text-sm"
          >
            {tChrome('panel.ga.backToActions')}
          </button>
        </div>
      </div>
    );
  }

  // ── List ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-neutral-300">{tChrome('panel.ga.heading')}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="action-import"
            title={tChrome('panel.ga.importTitle')}
            onClick={() => void importAction()}
            className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
          >
            {tChrome('panel.ga.import')}
          </button>
          <button
            type="button"
            data-testid="action-new"
            onClick={startNew}
            className="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded font-medium"
          >
            {tChrome('panel.ga.new')}
          </button>
        </div>
      </div>
      {listError && (
        <p className="text-sm text-red-400" data-testid="action-list-error">
          {listError}
        </p>
      )}
      <GsRequiredNotice capability={gs} testId="actions-gs" />
      {actions.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="actions-empty">
          {tChrome('panel.ga.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="actions-list">
          {actions.map((a) => {
            // An action that CREATES its document is a folder run by
            // construction — the two buttons that would point it at existing
            // files are disabled and say why, rather than failing at the
            // engine after a folder picker.
            const openBlocked = openDocumentBlocker(a);
            const inPlaceBlocked = inPlaceBlocker(a);
            const gsBlockedMsg = gsBlocker(a, !gsBlocked(gs));
            return (
            <div
              key={a.id}
              data-testid={`action-item-${a.id}`}
              className="flex items-center gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-neutral-200 truncate">{a.name}</div>
                {gsBlockedMsg !== null && (
                  <div className="text-xs text-amber-300" data-testid={`action-gs-${a.id}`}>
                    {gsBlockedMsg}
                  </div>
                )}
                <div className="text-xs text-neutral-500">
                  {a.steps.map((s) => tStepTitle(s.op, stepDefFor(s.op).title)).join(' → ')}
                </div>
              </div>
              <button
                type="button"
                data-testid={`action-run-${a.id}`}
                disabled={!activeFile || running || openBlocked !== null || gsBlockedMsg !== null}
                title={openBlocked ?? gsBlockedMsg ?? undefined}
                onClick={() => void runAction(a)}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
              >
                {tChrome('panel.ga.run')}
              </button>
              <button
                type="button"
                data-testid={`action-folder-${a.id}`}
                disabled={running || gsBlockedMsg !== null}
                title={gsBlockedMsg ?? tChrome('panel.ga.folderTitle')}
                onClick={() => void runActionOnFolder(a)}
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
              >
                {tChrome('panel.ga.folder')}
              </button>
              {confirmInPlace === a.id ? (
                <>
                  <span className="text-xs text-amber-400 self-center" data-testid={`action-inplace-warning-${a.id}`}>
                    {tChrome('panel.ga.inPlaceWarning')}
                  </span>
                  <button
                    type="button"
                    data-testid={`action-inplace-confirm-${a.id}`}
                    disabled={running}
                    onClick={() => {
                      setConfirmInPlace(null);
                      void runActionInPlace(a);
                    }}
                    className="px-2 py-1 text-xs text-white bg-red-700/90 hover:bg-red-600 disabled:opacity-60 rounded"
                  >
                    {tChrome('panel.ga.replace')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmInPlace(null)}
                    className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
                  >
                    {tChrome('panel.ga.keep')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid={`action-inplace-${a.id}`}
                  disabled={running || inPlaceBlocked !== null || gsBlockedMsg !== null}
                  title={inPlaceBlocked ?? gsBlockedMsg ?? tChrome('panel.ga.inPlaceTitle')}
                  onClick={() => setConfirmInPlace(a.id)}
                  className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
                >
                  {tChrome('panel.ga.inPlace')}
                </button>
              )}
              <button
                type="button"
                data-testid={`action-edit-${a.id}`}
                onClick={() => {
                  setEditError(null);
                  setView({ kind: 'edit', isNew: false, action: { ...a, steps: a.steps.map((s) => ({ ...s, params: { ...s.params } })) } });
                }}
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
              >
                {tChrome('panel.ga.edit')}
              </button>
              <button
                type="button"
                data-testid={`action-duplicate-${a.id}`}
                onClick={() =>
                  persist([
                    ...actions,
                    {
                      id: crypto.randomUUID(),
                      name: tChrome('panel.ga.copySuffix', { name: a.name }),
                      steps: a.steps.map((s) => ({ ...s, params: { ...s.params } })),
                    },
                  ])
                }
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
              >
                {tChrome('panel.ga.duplicate')}
              </button>
              <button
                type="button"
                data-testid={`action-export-${a.id}`}
                title={tChrome('panel.ga.exportTitle')}
                onClick={() => void exportAction(a)}
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
              >
                {tChrome('panel.ga.export')}
              </button>
              <button
                type="button"
                data-testid={`action-delete-${a.id}`}
                onClick={() => persist(actions.filter((x) => x.id !== a.id))}
                className="text-xs danger-action is-quiet"
              >
                {tChrome('panel.ga.delete')}
              </button>
            </div>
            );
          })}
        </div>
      )}
      {!activeFile && (
        <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.ga.open')} />
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
            {tStepTitle(d.op, d.title)}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="action-add-step"
        onClick={() => onAdd(op)}
        className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
      >
        {tChrome('panel.ga.addStep')}
      </button>
    </>
  );
}
