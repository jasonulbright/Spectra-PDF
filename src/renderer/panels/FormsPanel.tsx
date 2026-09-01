import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { file, app } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { readFormFields } from '../lib/forms';
import { fillClosure, formCalculation } from '../lib/form-overlay';
import { mergeUntouched } from '../lib/late-read';
import { classifyFillResult } from '../lib/fill-result';
import type { FormField, FormFieldValue, XFAKind } from '../lib/forms';
import {
  ACTION_KIND_LABEL,
  ACTION_TRIGGERS,
  ACTION_TRIGGER_LABEL,
  isRunnable,
} from '../lib/field-actions';
import { useFieldScriptsAllowed } from '../hooks/useFieldScriptsAllowed';
import { scriptInventory } from '../lib/field-js-policy';
import type { JsTrigger, ScriptRunReport } from '../lib/field-js-policy';
import { scriptReportsFor, subscribeScriptReports } from '../lib/field-js-reports';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

/** The four value triggers, in the order a commit runs them — the same order
 * `engine/forms.py` declares, so a refusal list reads the way the document
 * would have executed. */
const SCRIPT_TRIGGERS = ['K', 'V', 'C', 'F'] as const;

const SCRIPT_TRIGGER_LABEL = {
  K: 'panel.forms.scriptTrigger.K',
  V: 'panel.forms.scriptTrigger.V',
  C: 'panel.forms.scriptTrigger.C',
  F: 'panel.forms.scriptTrigger.F',
  Fo: 'panel.forms.scriptTrigger.Fo',
  Bl: 'panel.forms.scriptTrigger.Bl',
} as const satisfies Record<JsTrigger, string>;

/** What a report says, in the reader's language. The report itself carries
 * facts (capability names, engine text, a millisecond budget); the wording is
 * decided here so control flow never matches on a localized string. */
function reportText(report: ScriptRunReport): string {
  if (report.kind === 'refused') {
    return tChrome('panel.forms.scriptRefused', { capabilities: report.detail });
  }
  if (report.kind === 'timeout') {
    return tChrome('panel.forms.scriptTimedOut', { ms: report.detail });
  }
  return tChrome('panel.forms.scriptErrored', { message: report.detail });
}

/** The live report set for one document. */
function useScriptReports(path: string | null): readonly ScriptRunReport[] {
  const [reports, setReports] = useState<readonly ScriptRunReport[]>(() =>
    path ? scriptReportsFor(path) : [],
  );
  useEffect(() => {
    if (!path) {
      setReports([]);
      return;
    }
    setReports(scriptReportsFor(path));
    return subscribeScriptReports(() => setReports(scriptReportsFor(path)));
  }, [path]);
  return reports;
}

/** Value equality across the FormFieldValue union (arrays compared element-wise). */
function valueEquals(a: FormFieldValue | undefined, b: FormFieldValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    return aa.length === bb.length && aa.every((x, i) => x === bb[i]);
  }
  return a === b;
}

export function FormsPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const { confirmSignedEdit } = useOperations();
  const workingPath = activeFile?.workingPath ?? null;
  // The values as first read — Apply sends only the fields the user CHANGED
  // (a diff), never the full current-state snapshot: the engine validates every
  // edit as authoritative, so resending an untouched read-only/button/unselected
  // field would abort the whole fill (regression). pdf-lib's per-field
  // no-op tolerated the full snapshot; the engine does not.
  const initialValues = useRef<Record<string, FormFieldValue>>({});
  // Field names the user has typed into since the last read landed. The read
  // below re-runs on EVERY buffer change — an undo, a page-edit commit, any
  // other panel's op — so it lands mid-form routinely, and a bare
  // `setValues(seed)` silently reverted every field filled since the panel
  // opened. See `lib/late-read.ts` for the class and why merging (not skipping
  // the seed) is the correct shape.
  const touched = useRef<Set<string>>(new Set());
  const [fields, setFields] = useState<FormField[]>([]);
  const [xfaKind, setXfaKind] = useState<XFAKind>('none');
  const [xfaCalculations, setXfaCalculations] = useState(false);
  const [calculationOrder, setCalculationOrder] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, FormFieldValue>>({});
  const [flatten, setFlatten] = useState(false);
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;

  // A different document is a fresh filling session: a field name that happens
  // to exist in both must not carry the previous document's typing forward.
  useEffect(() => {
    touched.current.clear();
  }, [workingPath]);

  // Read fields whenever the file's bytes change identity — the same signal
  // the canvas indexer keys on, so this auto-refreshes after an apply
  // (UPDATE_FILE swaps the buffer), after any whole-file op, and after undo.
  useEffect(() => {
    let cancelled = false;
    if (!buffer || !workingPath) {
      setFields([]);
      setXfaKind('none');
      setXfaCalculations(false);
      setCalculationOrder([]);
      setValues({});
      touched.current.clear();
      return;
    }
    setReading(true);
    // Read through the engine. Keyed on `buffer` identity — the same
    // content-change signal as before — but read from the working copy on
    // disk, whose bytes equal `buffer` (page-tier edits touch neither until
    // commit). `call` never gates `read_form_fields` (it is INTERNAL).
    readFormFields(call, workingPath)
      .then((result) => {
        if (cancelled) return;
        setFields(result.fields);
        setXfaKind(result.xfa);
        setXfaCalculations(result.xfaCalculations);
        setCalculationOrder(result.calculationOrder);
        const seed: Record<string, FormFieldValue> = {};
        for (const f of result.fields) seed[f.name] = f.value;
        // The file is always the BASELINE — Apply diffs against it, so it must
        // be the truth even when a read lands mid-typing. Only the fields the
        // user actually touched survive on top of it.
        initialValues.current = seed;
        setValues((prev) => mergeUntouched(seed, prev, touched.current));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFields([]);
        setXfaKind('none');
        setXfaCalculations(false);
        setCalculationOrder([]);
        setStatus(tChrome('panel.forms.errorReading', { message: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buffer, workingPath, call]);

  const setValue = useCallback((name: string, value: FormFieldValue) => {
    touched.current.add(name);
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const editableCount = fields.filter((f) => f.editable).length;
  // Fields whose /JS this app does not run, and calculations the document
  // declared no order for. Both are reported rather than silently absent: a
  // Total that stays empty because nothing said when to compute it is exactly
  // the failure this row exists to end.
  const scriptsNotRunCount = fields.filter((f) => f.scriptsNotRun?.length).length;
  const unorderedCalcCount =
    calculationOrder.length === 0 ? fields.filter((f) => f.actions?.C).length : 0;
  // The refused scripts THEMSELVES, per field and per trigger, with the body
  // readable. A count alone states a position without evidencing it; a reader
  // who wants to know what this app declined to run can see it, and the bytes
  // are still in the document either way.
  const refusedScripts = fields.flatMap((f) =>
    (f.scriptsNotRun ?? [])
      .filter((t): t is (typeof SCRIPT_TRIGGERS)[number] =>
        (SCRIPT_TRIGGERS as readonly string[]).includes(t),
      )
      .map((trigger) => ({ field: f.name, trigger, js: f.actions?.[trigger] ?? '' })),
  );
  // With scripting on, the list stops being a refusal list: it names the
  // custom scripts that DID NOT run cleanly, and says why. A script that ran
  // is not listed, because there is nothing about it the reader needs.
  const scriptsAllowed = useFieldScriptsAllowed();
  const runReports = useScriptReports(activeFile?.path ?? null);
  const customScripts = scriptInventory(fields).custom;
  const reportedScripts = runReports.map((report) => ({
    field: report.field,
    trigger: report.trigger,
    js:
      customScripts.find((e) => e.field === report.field && e.trigger === report.trigger)?.js ?? '',
    note: reportText(report),
  }));

  const handleApply = useCallback(async () => {
    if (!activeFile) return;
    // Only the editable fields the user actually CHANGED — never read-only /
    // button / signature / untouched fields (the engine would reject them and
    // abort the whole fill). Flatten still runs on an empty diff (it bakes the
    // existing values), but a plain fill with no changes is a no-op.
    const edits: Record<string, FormFieldValue> = {};
    for (const f of fields) {
      if (f.editable && !valueEquals(values[f.name], initialValues.current[f.name])) {
        edits[f.name] = values[f.name];
      }
    }
    const changedCount = Object.keys(edits).length;
    if (changedCount === 0 && !flatten) {
      setStatus(tChrome('panel.forms.noChanges'));
      return;
    }
    setBusy(true);
    setStatus(flatten ? tChrome('panel.forms.fillingFlattening') : tChrome('panel.forms.filling'));
    try {
      // The signed-document decision, taken BEFORE the snapshot — `file.
      // snapshot` runs the commit gate, so asking after it would flush pending
      // page edits on the way to refusing this edit.
      //
      // Two classes, because the button does two things. A plain fill is
      // `form-fill` and is asked about the TRANSITIVE set: filling an unlocked
      // line item that recalculates a locked Total produces a document
      // reporting as altered, and a decision taken on the typed names alone
      // would never see it. Flatten BAKES the widgets away — the form stops
      // existing — so it is structural whatever a fill-only certification
      // permits.
      const typedNames = Object.keys(edits);
      const targets = fillClosure(formCalculation(fields, calculationOrder), typedNames);
      const allowed = flatten
        ? await confirmSignedEdit(activeFile.path, activeFile.workingPath, 'structural')
        : await confirmSignedEdit(
            activeFile.path,
            activeFile.workingPath,
            'form-fill',
            targets,
            typedNames,
          );
      if (!allowed) {
        setStatus('');
        return;
      }
      // Snapshot (runs the commit gate) → fill through the
      // ENGINE (Unicode-capable + multi-select optionlist) → reload → UPDATE_
      // FILE (undoable via the snapshot). `call` is commit-gated (never
      // callRaw). Page count is unchanged by a fill/flatten.
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const fillReport = await call('fill_form_fields', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        edits,
        flatten,
        font_dir: await app.getEditFontPath(),
      });
      // The engine refuses an inconsistent fill atomically, so a thrown error
      // is already an error here. What is left is the report on the success
      // path, which is the only evidence the write covered what was named —
      // announcing success without reading it is announcing the request.
      const outcome = classifyFillResult(fillReport, changedCount);
      // Written: these values ARE the file's now, so the re-read the dispatch
      // below triggers should reseed everything. (On the error path `touched`
      // deliberately stands — nothing was written, so the typing must survive.)
      // A report that does not add up is still a document that changed on
      // disk, so the reload runs either way — it IS the re-read the notice
      // tells the user to trust instead of the panel's own state.
      touched.current.clear();
      const buffer = await file.readBuffer(activeFile.workingPath);
      dispatch({
        type: 'UPDATE_FILE',
        path: activeFile.path,
        pageCount: activeFile.pageCount,
        buffer,
        snapshotPath,
      });
      if (outcome.kind === 'refused') {
        setStatus(
          tChrome('panel.common.error', {
            message:
              outcome.refusal.kind === 'incomplete'
                ? tChrome('panel.forms.fillIncomplete', {
                    named: outcome.refusal.requested,
                    written: outcome.refusal.filled,
                  })
                : tChrome('panel.forms.fillUnverified'),
          }),
        );
        return;
      }
      setStatus(
        flatten
          ? tChrome('panel.forms.filledFlattened')
          : tChromeCount('panel.forms.filled', changedCount),
      );
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, fields, values, flatten, calculationOrder, dispatch, call, confirmSignedEdit]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.forms.open')} />;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="text-sm text-neutral-400 shrink-0">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})
      </div>

      {/* ISO 32000-2 Annex K: a processor that supports XFA forms shall
          indicate clearly that the user is interacting with one. Static and
          dynamic are different interactions and say so separately. */}
      {xfaKind !== 'none' && (
        <div
          data-testid={xfaKind === 'dynamic' ? 'forms-xfa-dynamic' : 'forms-xfa-static'}
          className="shrink-0 px-3 py-2 bg-amber-500/15 border border-amber-500/40 rounded text-xs text-amber-200"
        >
          {tChrome(xfaKind === 'dynamic' ? 'panel.forms.xfaDynamic' : 'panel.forms.xfaStatic')}
        </div>
      )}

      {xfaCalculations && (
        <div
          data-testid="forms-xfa-calculations"
          className="shrink-0 px-3 py-2 bg-amber-500/15 border border-amber-500/40 rounded text-xs text-amber-200"
        >
          {tChrome('panel.forms.xfaCalculations')}
        </div>
      )}

      {unorderedCalcCount > 0 && (
        <div
          data-testid="forms-unordered-calculations"
          className="shrink-0 px-3 py-2 bg-amber-500/15 border border-amber-500/40 rounded text-xs text-amber-200"
        >
          {tChromeCount('panel.forms.noCalculationOrder', unorderedCalcCount)}
        </div>
      )}

      {!scriptsAllowed.enabled && scriptsNotRunCount > 0 && (
        <div
          data-testid="forms-scripts-not-run"
          className="shrink-0 px-3 py-2 bg-neutral-800/60 border border-neutral-700 rounded text-xs text-neutral-300 flex flex-col gap-2"
        >
          <div>{tChromeCount('panel.forms.scriptsNotRun', scriptsNotRunCount)}</div>
          <div className="text-neutral-200">{tChrome('panel.forms.scriptsTitle')}</div>
          <p className="text-[11px] text-neutral-400">
            {tChrome('panel.forms.scriptsPosition')}
          </p>
          {/* Nothing is worded while the machine key read is still in flight:
              naming a policy that has not been read yet claims an
              administrator lockout on every machine that has none. */}
          {scriptsAllowed.suppression !== 'unknown' && (
            <p data-testid="forms-scripts-switch" className="text-[11px] text-neutral-400">
              {tChrome(
                scriptsAllowed.suppression === 'policy'
                  ? 'panel.forms.scriptsPolicyHint'
                  : 'panel.forms.scriptsPreferenceHint',
              )}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            {refusedScripts.map((row) => (
              <RefusedScript key={`${row.field}:${row.trigger}`} {...row} />
            ))}
          </div>
        </div>
      )}

      {scriptsAllowed.enabled && customScripts.length > 0 && (
        <div
          data-testid="forms-scripts-running"
          className="shrink-0 px-3 py-2 bg-neutral-800/60 border border-neutral-700 rounded text-xs text-neutral-300 flex flex-col gap-2"
        >
          <div className="text-neutral-200">{tChrome('panel.forms.scriptsRunningTitle')}</div>
          <p className="text-[11px] text-neutral-400">
            {tChrome('panel.forms.scriptsRunningPosition')}
          </p>
          {reportedScripts.length === 0 ? (
            <p data-testid="forms-scripts-all-clean" className="text-[11px] text-neutral-400">
              {tChrome('panel.forms.scriptsAllClean')}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {reportedScripts.map((row) => (
                <RefusedScript key={`${row.field}:${row.trigger}`} {...row} />
              ))}
            </div>
          )}
        </div>
      )}

      {reading ? (
        <div className="text-sm text-neutral-500">{tChrome('panel.forms.reading')}</div>
      ) : fields.length === 0 ? (
        <div className="text-sm text-neutral-500">{tChrome('panel.forms.noFields')}</div>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pe-1" tabIndex={0} role="region" aria-label={tChrome('panel.forms.fieldsAria')}>
            {fields.map((f) => (
              <FieldRow
                key={f.name}
                field={f}
                value={values[f.name]}
                onChange={(v) => setValue(f.name, v)}
              />
            ))}
          </div>
          <div className="shrink-0 flex items-center gap-4 pt-2 border-t border-neutral-800">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-neutral-400">
              <input
                data-testid="forms-flatten"
                type="checkbox"
                checked={flatten}
                onChange={() => setFlatten((v) => !v)}
                className="rounded bg-neutral-800 border-neutral-700"
              />
              {tChrome('panel.forms.flatten')}
            </label>
            <button
              data-testid="forms-apply"
              onClick={handleApply}
              disabled={busy || editableCount === 0}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
            >
              {busy ? tChrome('panel.forms.applying') : flatten ? tChrome('panel.forms.fillFlatten') : tChrome('panel.forms.fillForm')}
            </button>
          </div>
        </>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}

/** One script this app declined to run: which field, which trigger, and the
 * body on request. The body is the document's own bytes and is shown verbatim
 * — never localized, never summarized, because a paraphrase of a script is not
 * the script. */
function RefusedScript({
  field,
  trigger,
  js,
  note,
}: {
  field: string;
  trigger: JsTrigger;
  js: string;
  /** Why this row is here, when scripting is on and the script ran. Absent in
   * the off state, where the heading already says why every row is listed. */
  note?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-neutral-700 bg-neutral-900/60 p-1.5">
      <div className="flex items-center gap-2">
        <span className="text-neutral-200 truncate">{field}</span>
        <span className="text-[11px] text-neutral-500 truncate">
          {tChrome(SCRIPT_TRIGGER_LABEL[trigger])}
        </span>
        {js !== '' && (
          <button
            type="button"
            data-testid={`forms-script-toggle-${field}-${trigger}`}
            className="ms-auto text-[11px] quiet-action shrink-0"
            onClick={() => setOpen((v) => !v)}
          >
            {tChrome(open ? 'panel.forms.scriptHide' : 'panel.forms.scriptShow')}
          </button>
        )}
      </div>
      {note !== undefined && (
        <p
          data-testid={`forms-script-note-${field}-${trigger}`}
          className="mt-1 text-[11px] text-amber-200/80"
        >
          {note}
        </p>
      )}
      {open && (
        <pre
          data-testid={`forms-script-body-${field}-${trigger}`}
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-950 p-1.5 text-[11px] text-neutral-300"
        >
          {js}
        </pre>
      )}
    </div>
  );
}

/** The data actions a field carries, named from the one kind table the canvas
 * and the properties editor also name them from. */
function DataActions({ field }: { field: FormField }): React.ReactElement | null {
  const rows = ACTION_TRIGGERS.flatMap((trigger) => {
    const action = field.fieldActions?.[trigger];
    return action ? [{ trigger, action }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div
      className="mt-1 flex flex-col gap-0.5"
      data-testid={`form-field-actions-${field.name}`}
    >
      {rows.map(({ trigger, action }) => (
        <span key={trigger} className="text-[11px] text-neutral-500">
          {/* An action this app reports rather than performs says so where it
              is listed, not only when it is used — as a whole sentence, so a
              translation can order the clause its own way. */}
          {tChrome(
            isRunnable(action)
              ? 'panel.forms.dataActionRow'
              : 'panel.forms.dataActionRowReported',
            {
              trigger: tChrome(ACTION_TRIGGER_LABEL[trigger]),
              action: tChrome(ACTION_KIND_LABEL[action.kind]),
            },
          )}
        </span>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: FormFieldValue | undefined;
  onChange: (v: FormFieldValue) => void;
}): React.ReactElement {
  const testId = `form-field-${field.name}`;
  const label = (
    <div className="flex items-center gap-2 mb-1">
      <span className="text-sm text-neutral-300">{field.name}</span>
      {field.required && <span className="text-[10px] text-amber-400 uppercase">{tChrome('panel.forms.required')}</span>}
      {field.readOnly && <span className="text-[10px] text-neutral-500 uppercase">{tChrome('panel.forms.readOnly')}</span>}
      {field.calculated && (
        <span data-testid={`form-calculated-${field.name}`} className="text-[10px] text-sky-400 uppercase">
          {tChrome('panel.forms.calculated')}
        </span>
      )}
      {field.valueFromXFA && (
        <span
          data-testid={`form-from-xfa-${field.name}`}
          title={tChrome('panel.forms.fromXfaTitle')}
          className="text-[10px] text-emerald-400 uppercase"
        >
          {tChrome('panel.forms.fromXfa')}
        </span>
      )}
      {(field.type === 'button' || field.type === 'signature') && (
        <span className="text-[10px] text-neutral-500 uppercase">{field.type}</span>
      )}
    </div>
  );

  // Non-fillable kinds render a disabled placeholder so the field is still
  // visible in the list. A pushbutton holds no value at all, so what it DOES
  // is the only thing there is to report about it.
  if (!field.editable) {
    return (
      <div>
        {label}
        {field.type !== 'button' && (
          <input
            data-testid={testId}
            type="text"
            disabled
            value={typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : ''}
            className="w-full px-3 py-1.5 bg-neutral-800/50 border border-neutral-800 rounded text-sm text-neutral-500"
          />
        )}
        <DataActions field={field} />
      </div>
    );
  }

  if (field.type === 'text') {
    const str = typeof value === 'string' ? value : '';
    return (
      <div>
        {label}
        {field.multiline ? (
          <textarea
            data-testid={testId}
            value={str}
            rows={3}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500 resize-y"
          />
        ) : (
          <input
            data-testid={testId}
            type="text"
            value={str}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        )}
      </div>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          data-testid={testId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded bg-neutral-800 border-neutral-700"
        />
        <span className="text-sm text-neutral-300">{field.name}</span>
        {field.required && <span className="text-[10px] text-amber-400 uppercase">{tChrome('panel.forms.required')}</span>}
      </label>
    );
  }

  if (field.type === 'radio' || field.type === 'dropdown') {
    const sel = typeof value === 'string' ? value : '';
    return (
      <div>
        {label}
        <select
          data-testid={testId}
          value={sel}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="">{tChrome('panel.forms.none')}</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // optionlist (multi-select)
  const selected = Array.isArray(value) ? value : [];
  return (
    <div>
      {label}
      <select
        data-testid={testId}
        multiple
        value={selected}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
        className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        size={Math.min(4, (field.options ?? []).length || 1)}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}
