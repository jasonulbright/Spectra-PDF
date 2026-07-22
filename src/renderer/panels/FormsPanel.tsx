import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, app } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { readFormFields } from '../lib/forms';
import type { FormField, FormFieldValue } from '../lib/forms';

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
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  // The values as first read — Apply sends only the fields the user CHANGED
  // (a diff), never the full current-state snapshot: the engine validates every
  // edit as authoritative, so resending an untouched read-only/button/unselected
  // field would abort the whole fill (gauntlet CRITICAL). pdf-lib's per-field
  // no-op tolerated the full snapshot; the engine does not.
  const initialValues = useRef<Record<string, FormFieldValue>>({});
  const [fields, setFields] = useState<FormField[]>([]);
  const [hasXFA, setHasXFA] = useState(false);
  const [values, setValues] = useState<Record<string, FormFieldValue>>({});
  const [flatten, setFlatten] = useState(false);
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;

  // Read fields whenever the file's bytes change identity — the same signal
  // the canvas indexer keys on, so this auto-refreshes after an apply
  // (UPDATE_FILE swaps the buffer), after any whole-file op, and after undo.
  useEffect(() => {
    let cancelled = false;
    if (!buffer) {
      setFields([]);
      setHasXFA(false);
      setValues({});
      return;
    }
    setReading(true);
    readFormFields(buffer)
      .then((result) => {
        if (cancelled) return;
        setFields(result.fields);
        setHasXFA(result.hasXFA);
        const seed: Record<string, FormFieldValue> = {};
        for (const f of result.fields) seed[f.name] = f.value;
        setValues(seed);
        initialValues.current = seed;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFields([]);
        setHasXFA(false);
        setStatus(`Error reading fields: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buffer]);

  const setValue = useCallback((name: string, value: FormFieldValue) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const editableCount = fields.filter((f) => f.editable).length;

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
      setStatus('No changes to apply');
      return;
    }
    setBusy(true);
    setStatus(flatten ? 'Filling and flattening…' : 'Filling form…');
    try {
      // FC4 (§I.0 S1/S3): snapshot (runs the commit gate) → fill through the
      // ENGINE (Unicode-capable + multi-select optionlist) → reload → UPDATE_
      // FILE (undoable via the snapshot). `call` is commit-gated (never
      // callRaw). Page count is unchanged by a fill/flatten.
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('fill_form_fields', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        edits,
        flatten,
        font_dir: await app.getEditFontPath(),
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      dispatch({
        type: 'UPDATE_FILE',
        path: activeFile.path,
        pageCount: activeFile.pageCount,
        buffer,
        snapshotPath,
      });
      setStatus(
        flatten
          ? 'Form filled and flattened (fields locked)'
          : `Filled ${changedCount} field${changedCount === 1 ? '' : 's'}`,
      );
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, fields, values, flatten, dispatch, call]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to fill its form fields" />;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="text-sm text-neutral-400 shrink-0">
        Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)
      </div>

      {hasXFA && (
        <div
          data-testid="forms-xfa-warning"
          className="shrink-0 px-3 py-2 bg-amber-500/15 border border-amber-500/40 rounded text-xs text-amber-200"
        >
          This form uses XFA (dynamic forms), which isn't supported. Only its standard AcroForm
          fields are shown below; filling will save a plain AcroForm copy.
        </div>
      )}

      {reading ? (
        <div className="text-sm text-neutral-500">Reading form fields…</div>
      ) : fields.length === 0 ? (
        <div className="text-sm text-neutral-500">This PDF has no form fields.</div>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
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
              Flatten (lock fields after filling)
            </label>
            <button
              data-testid="forms-apply"
              onClick={handleApply}
              disabled={busy || editableCount === 0}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
            >
              {busy ? 'Applying…' : flatten ? 'Fill & Flatten' : 'Fill Form'}
            </button>
          </div>
        </>
      )}
      <StatusBar message={status} busy={busy} />
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
      {field.required && <span className="text-[10px] text-amber-400 uppercase">required</span>}
      {field.readOnly && <span className="text-[10px] text-neutral-500 uppercase">read-only</span>}
      {(field.type === 'button' || field.type === 'signature') && (
        <span className="text-[10px] text-neutral-500 uppercase">{field.type}</span>
      )}
    </div>
  );

  // Non-fillable kinds render a disabled placeholder so the field is still
  // visible in the list.
  if (!field.editable) {
    return (
      <div>
        {label}
        <input
          type="text"
          disabled
          value={typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : ''}
          className="w-full px-3 py-1.5 bg-neutral-800/50 border border-neutral-800 rounded text-sm text-neutral-500"
        />
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
        {field.required && <span className="text-[10px] text-amber-400 uppercase">required</span>}
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
          <option value="">— none —</option>
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
