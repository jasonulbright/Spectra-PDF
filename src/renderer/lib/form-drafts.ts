import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { FillFormValues } from '../hooks/useOperations';
import type { EngineCall } from './engine-call';
import { readFormFields, type FormFieldValue, type FormReadResult } from './forms';
import { resolveFillTargets } from './form-overlay';
import { EDIT_DECLINED } from './edit-text';
import { tChrome, tChromeCount } from '../i18n';

type Values = Record<string, FormFieldValue>;
export interface FormDraft {
  path: string; workingPath: string; buffer: PdfBuffer | null;
  form: FormReadResult | null;
  values: Values; pending: Values; options: { flatten: boolean };
  needsRead: boolean; loading: object | null; busy: boolean; blocked: boolean;
  error: string; status: string;
}
export function sameFormValue(a: FormFieldValue | undefined, b: FormFieldValue | undefined): boolean {
  return Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
}
const empty = (): Values => Object.create(null);
const seed = (form: FormReadResult): Values => Object.assign(empty(),
  Object.fromEntries(form.fields.map(f => [f.name, structuredClone(f.value)])));

/** Filling sessions outlive the panel, not their open working document. An
 * arbitrary new revision never inherits name-only input. Only an exact Apply
 * receipt advances pending input, which is then fingerprinted against its read. */
export function createFormDrafts(readState: () => AppState) {
  const entries = new Map<string, FormDraft>();
  const listeners = new Set<() => void>(); let version = 0;
  const notify = () => { version++; for (const fn of listeners) fn(); };
  const live = (d: FormDraft) => entries.get(d.workingPath) === d
    && readState().files.get(d.path)?.workingPath === d.workingPath;
  const at = (d: FormDraft, buffer: PdfBuffer | null) => !!buffer && live(d)
    && readState().files.get(d.path)?.buffer === buffer && !readState().pageDirtyPaths.includes(d.path);
  const dirty = (d: FormDraft) => Object.keys(d.pending).length > 0 || d.options.flatten;
  const conflict = (d: FormDraft) => d.blocked || dirty(d) && !!d.buffer && !at(d, d.buffer);
  const editable = (d: FormDraft) => !!d.form && !d.needsRead && !d.blocked && at(d, d.buffer);
  const reconcile = () => {
    let changed = false;
    for (const [key, d] of entries) if (!live(d)) { entries.delete(key); changed = true; }
    if (changed) notify();
  };
  const get = (file: OpenFile | null): FormDraft | null => {
    if (!file?.buffer || file.importOnly || readState().files.get(file.path)?.workingPath !== file.workingPath) return null;
    let d = entries.get(file.workingPath);
    if (!d || d.path !== file.path) {
      d = { path: file.path, workingPath: file.workingPath, buffer: null, form: null, values: empty(), pending: empty(),
        options: { flatten: false }, needsRead: true, loading: null, busy: false, blocked: false, error: '', status: '' };
      entries.set(file.workingPath, d);
    }
    return d;
  };
  const load = async (d: FormDraft, call: EngineCall) => {
    if (!live(d) || d.busy || d.loading || d.error || conflict(d) || editable(d)
        || readState().pageDirtyPaths.includes(d.path)) return;
    const buffer = readState().files.get(d.path)?.buffer; if (!buffer) return;
    const token = {}; d.loading = token; notify();
    const accepts = () => live(d) && d.loading === token && at(d, buffer);
    try {
      const form = await readFormFields(call, d.workingPath, true);
      if (!accepts()) return;
      let pending = d.pending;
      if (Object.keys(pending).length) {
        // This path is only for typing newer than our own successful Apply.
        // Missing/ambiguous/retyped fields (including flatten) retain the old
        // editor visibly, never reduce the pending set to an empty success.
        if (!d.form || Object.keys(pending).some(n => !d.form!.fields.some(f => f.name === n))) throw Error(tChrome('panel.forms.fillUnverified'));
        const mapped = resolveFillTargets(d.form.fields, form.fields, pending);
        if (mapped.skipped.length) { d.blocked = true; throw Error(tChrome('panel.forms.sourceChanged')); }
        pending = mapped.resolved;
      }
      d.form = form; d.buffer = buffer; d.needsRead = false;
      d.values = Object.assign(seed(form), structuredClone(pending)); d.pending = empty();
      for (const [name, value] of Object.entries(pending)) {
        if (!sameFormValue(value, form.fields.find(f => f.name === name)?.value)) d.pending[name] = value;
      }
    } catch (e) { if (accepts()) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d) && d.loading === token) { d.loading = null; notify(); } }
  };
  const cancelLoad = (d: FormDraft) => { if (live(d) && d.loading) { d.loading = null; notify(); } };
  const setValue = (d: FormDraft, buffer: PdfBuffer | null, name: string, value: FormFieldValue) => {
    if (!editable(d) || buffer !== d.buffer) return;
    const field = d.form!.fields.find(f => f.name === name); if (!field?.editable) return;
    d.values = Object.assign(empty(), d.values, { [name]: structuredClone(value) });
    d.pending = Object.assign(empty(), d.pending);
    if (sameFormValue(field.value, value)) delete d.pending[name]; else d.pending[name] = structuredClone(value);
    d.error = ''; d.status = ''; notify();
  };
  const setFlatten = (d: FormDraft, buffer: PdfBuffer | null, flatten: boolean) => {
    if (!editable(d) || buffer !== d.buffer) return;
    d.options = { flatten }; d.error = ''; d.status = ''; notify();
  };
  const reload = async (d: FormDraft, commit: () => Promise<void>) => {
    if (!live(d) || d.busy) return;
    const values = d.values, options = d.options; d.busy = true; notify();
    try {
      await commit();
      if (!live(d) || d.values !== values || d.options !== options) return;
      d.form = null; d.buffer = null; d.needsRead = true; d.pending = empty(); d.values = empty();
      d.options = { flatten: false }; d.loading = null; d.blocked = false; d.error = ''; d.status = '';
    } catch (e) { if (live(d)) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; notify(); } }
  };
  const save = async (d: FormDraft, fill: FillFormValues) => {
    if (!editable(d) || d.busy) return;
    if (!dirty(d)) { d.status = tChrome('panel.forms.noChanges'); notify(); return; }
    const values = d.values, pending = d.pending, options = d.options;
    d.busy = true; d.error = ''; d.loading = null;
    d.status = tChrome(options.flatten ? 'panel.forms.fillingFlattening' : 'panel.forms.filling'); notify();
    try {
      const result = await fill(d.path, structuredClone(pending), { flatten: options.flatten,
        expectedWorkingPath: d.workingPath, expectedBuffer: d.buffer! });
      if (!live(d)) return;
      if (result === EDIT_DECLINED) { d.status = ''; return; }
      if (!result?.completed || !result.publication.buffer || result.publication.workingPath !== d.workingPath
          || result.publication.path !== d.path) throw Error(tChrome('panel.forms.fillUnverified'));
      d.pending = empty();
      for (const [name, value] of Object.entries(d.values)) {
        if (!sameFormValue(value, values[name])) d.pending[name] = structuredClone(value);
      }
      if (d.options === options) d.options = { flatten: false };
      d.buffer = result.publication.buffer; d.needsRead = true;
      d.status = options.flatten ? tChrome('panel.forms.filledFlattened') : tChromeCount('panel.forms.filled', Object.keys(pending).length);
    } catch (e) { if (live(d)) { d.error = e instanceof Error ? e.message : String(e); d.status = ''; } }
    finally { if (live(d)) { d.busy = false; notify(); } }
  };
  return { get, reconcile, dirty, conflict, editable, load, cancelLoad, setValue, setFlatten, reload, save,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => version };
}
export type FormDrafts = ReturnType<typeof createFormDrafts>;
