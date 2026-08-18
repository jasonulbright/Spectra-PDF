import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';
import { TEST_HARNESS_ENABLED, registerTrapPresets } from '../testHarness';
import { tChrome } from '../i18n';
import {
  DEFAULT_TRAPPED,
  TRAPPED_VALUES,
  coerceField,
  freshPreset,
  isTrappedValue,
  orderedAssignments,
  rangeProblem,
  uncoveredPages,
  type TrapAssignment,
  type TrapFields,
  type TrapVocabulary,
  type TrappedValue,
} from '../lib/trap-presets';

export function TrapPresetsPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const { performOperation } = useOperations();

  const [vocabulary, setVocabulary] = useState<TrapVocabulary | null>(null);
  const [assignments, setAssignments] = useState<TrapAssignment[]>([]);
  const [trapped, setTrapped] = useState<TrappedValue>(DEFAULT_TRAPPED);
  const [unusedInks, setUnusedInks] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [first, setFirst] = useState(1);
  const [last, setLast] = useState(1);
  const [fields, setFields] = useState<TrapFields>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const workingPath = activeFile?.workingPath ?? null;
  const filePath = activeFile?.path ?? null;
  const buffer = activeFile?.buffer ?? null;
  const pageCount = activeFile?.pageCount ?? 0;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('trap_preset_defaults', {});
        if (cancelled) return;
        const vocab = res as unknown as TrapVocabulary;
        setVocabulary(vocab);
        setFields(freshPreset(vocab));
      } catch (e: unknown) {
        if (!cancelled) {
          setStatus(tChrome('panel.common.error', {
            message: e instanceof Error ? e.message : String(e),
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [call]);

  useEffect(() => {
    if (!workingPath) {
      setAssignments([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('list_trap_presets', { file: workingPath });
        if (cancelled) return;
        const carried = res as unknown as {
          assignments: TrapAssignment[];
          trapped: string;
          unused_colorants: string[];
        };
        setAssignments(carried.assignments ?? []);
        setUnusedInks(carried.unused_colorants ?? []);
        if (isTrappedValue(carried.trapped)) setTrapped(carried.trapped);
      } catch (e: unknown) {
        if (!cancelled) {
          setStatus(tChrome('panel.common.error', {
            message: e instanceof Error ? e.message : String(e),
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workingPath, buffer, call]);

  const problem = rangeProblem(first, last, pageCount, assignments);

  const addAssignment = useCallback(() => {
    if (problem !== null) return;
    setAssignments((current) => orderedAssignments([
      ...current,
      { first, last, name, preset: { ...fields } },
    ]));
  }, [problem, first, last, name, fields]);

  const removeAssignment = useCallback((index: number) => {
    setAssignments((current) => current.filter((_, i) => i !== index));
  }, []);

  const applyAssignments = useCallback(async () => {
    if (!filePath) return;
    setBusy(true);
    setStatus(tChrome('panel.trapPresets.assigning'));
    try {
      const r = await performOperation(filePath, 'assign_trap_presets', {
        assignments,
        trapped,
      });
      if (r === EDIT_DECLINED) {
        setStatus('');
        return;
      }
      setStatus(tChrome('panel.trapPresets.assigned', {
        count: assignments.length,
        trapped,
      }));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', {
        message: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusy(false);
    }
  }, [filePath, performOperation, assignments, trapped]);

  const writePostscript = useCallback(async (output: string) => {
    if (!workingPath) return null;
    setBusy(true);
    setStatus(tChrome('panel.trapPresets.exporting'));
    try {
      const res = await call('export_postscript', {
        file: workingPath,
        output,
        gs_path: await ensureGsPath(),
      });
      setStatus(tChrome('panel.trapPresets.exported', {
        pages: (res as unknown as { trapping_pages?: number }).trapping_pages ?? 0,
      }));
      return res;
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', {
        message: e instanceof Error ? e.message : String(e),
      }));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [workingPath, call]);

  const exportPostscript = useCallback(async () => {
    const output = await saveFile('output.ps');
    if (!output) return;
    try {
      await writePostscript(output);
    } catch {
      // The status line already carries the refusal.
    }
  }, [saveFile, writePostscript]);

  const harnessRef = useRef(writePostscript);
  harnessRef.current = writePostscript;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerTrapPresets({
      exportPostscript: (output) => harnessRef.current(output),
    });
    return () => registerTrapPresets(null);
  }, []);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.trapPresets.open')} />;
  }

  const uncovered = uncoveredPages(assignments, pageCount);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.trapPresets.blurb')}</p>
      <p className="text-xs text-neutral-500">{tChrome('panel.trapPresets.scope')}</p>

      <div className="flex flex-col gap-2" data-testid="trap-preset-editor">
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          {tChrome('panel.trapPresets.name')}
          <input
            type="text"
            data-testid="trap-preset-name"
            className="flex-1 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          {tChrome('panel.trapPresets.pages')}
          <input
            type="number"
            data-testid="trap-preset-first"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={1}
            value={first}
            onChange={(e) => setFirst(Number(e.target.value))}
          />
          <span>{tChrome('panel.trapPresets.pagesTo')}</span>
          <input
            type="number"
            data-testid="trap-preset-last"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={1}
            value={last}
            onChange={(e) => setLast(Number(e.target.value))}
          />
        </div>
        {problem !== null && (
          <div className="text-xs text-amber-400" data-testid="trap-preset-range-problem">
            {tChrome(`panel.trapPresets.range.${problem}` as 'panel.trapPresets.range.empty')}
          </div>
        )}

        <div className="flex flex-col gap-1 max-h-72 overflow-auto pe-1">
          {(vocabulary?.fields ?? [])
            .filter((spec) => spec.type !== 'colorants')
            .map((spec) => (
              <label
                key={spec.name}
                className="flex items-center justify-between gap-2 text-xs text-neutral-400"
                data-testid={`trap-field-${spec.name}`}
              >
                {/* A trapping parameter name is a wire vocabulary a RIP reads,
                    not prose — it is never translated. */}
                <span className="font-mono">{spec.name}</span>
                {spec.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={Boolean(fields[spec.name])}
                    onChange={(e) => setFields((current) => ({
                      ...current, [spec.name]: e.target.checked,
                    }))}
                  />
                ) : spec.type === 'choice' ? (
                  <select
                    className="px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
                    value={String(fields[spec.name] ?? '')}
                    onChange={(e) => setFields((current) => ({
                      ...current, [spec.name]: e.target.value,
                    }))}
                  >
                    {(spec.choices ?? []).map((choice) => (
                      <option key={choice} value={choice}>{choice}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'}
                    className="w-28 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
                    step={spec.type === 'integer' ? 1 : 0.1}
                    min={spec.min}
                    max={spec.max}
                    value={String(fields[spec.name] ?? '')}
                    onChange={(e) => setFields((current) => ({
                      ...current, [spec.name]: coerceField(spec, e.target.value),
                    }))}
                  />
                )}
              </label>
            ))}
        </div>

        <button
          data-testid="trap-preset-add"
          disabled={problem !== null}
          onClick={addAssignment}
          className="self-start px-3 py-1.5 text-sm bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.trapPresets.add')}
        </button>
      </div>

      <div className="flex flex-col gap-1" data-testid="trap-preset-list">
        {assignments.length === 0 && (
          <div className="text-xs text-neutral-500" data-testid="trap-preset-empty">
            {tChrome('panel.trapPresets.empty')}
          </div>
        )}
        {assignments.map((entry, index) => (
          <div
            key={`${entry.first}-${entry.last}-${entry.name}`}
            className="flex items-center justify-between gap-2 text-xs text-neutral-300"
            data-testid={`trap-assignment-${index}`}
          >
            <span>
              {tChrome('panel.trapPresets.row', {
                name: entry.name, first: entry.first, last: entry.last,
              })}
            </span>
            <button
              className="px-2 py-0.5 bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700"
              data-testid={`trap-assignment-remove-${index}`}
              onClick={() => removeAssignment(index)}
            >
              {tChrome('panel.trapPresets.remove')}
            </button>
          </div>
        ))}
        {uncovered.length > 0 && (
          <div className="text-xs text-neutral-500" data-testid="trap-preset-uncovered">
            {tChrome('panel.trapPresets.uncovered', { pages: uncovered.join(', ') })}
          </div>
        )}
        {unusedInks.length > 0 && (
          <div className="text-xs text-amber-400" data-testid="trap-preset-unused-inks">
            {tChrome('panel.trapPresets.unusedInks', { inks: unusedInks.join(', ') })}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-500">
        {tChrome('panel.trapPresets.trapped')}
        <select
          data-testid="trap-preset-trapped"
          className="px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
          value={trapped}
          onChange={(e) => {
            if (isTrappedValue(e.target.value)) setTrapped(e.target.value);
          }}
        >
          {TRAPPED_VALUES.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </label>
      <p className="text-xs text-neutral-500" data-testid="trap-preset-trapped-note">
        {tChrome('panel.trapPresets.trappedNote')}
      </p>

      <div className="flex items-center gap-2">
        <button
          data-testid="trap-preset-apply"
          disabled={busy}
          onClick={() => void applyAssignments()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
        >
          {tChrome('panel.trapPresets.apply')}
        </button>
        <button
          data-testid="trap-preset-export"
          disabled={busy}
          onClick={() => void exportPostscript()}
          className="px-3 py-1.5 text-sm bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.trapPresets.export')}
        </button>
      </div>

      <StatusBar message={status} busy={busy} />
    </div>
  );
}
