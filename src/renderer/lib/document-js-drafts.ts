import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import type { EngineCall } from './engine-call';
import { EDIT_DECLINED } from './edit-text';
import { tChrome } from '../i18n';

export interface DocScript { name: string; js: string }
export interface DocumentJsDraft {
  path: string; workingPath: string; buffer: PdfBuffer | null;
  scripts: DocScript[]; baseline: DocScript[]; selected: number;
  loaded: boolean; dirty: boolean; busy: boolean; loading: object | null; error: string;
}
const same = (a: DocScript[], b: DocScript[]) => JSON.stringify(a) === JSON.stringify(b);
const incomplete = () => new Error(tChrome('panel.docjs.incomplete'));
export function validateScripts(value: unknown): DocScript[] {
  if (!Array.isArray(value) || value.some(s => !s || typeof s.name !== 'string' || typeof s.js !== 'string')) throw incomplete();
  const scripts: DocScript[] = value.map(s => ({ name: s.name, js: s.js }));
  if (scripts.some(s => !s.name.trim())) throw new Error(tChrome('panel.docjs.needsName'));
  if (new Set(scripts.map(s => s.name)).size !== scripts.length) throw new Error(tChrome('panel.docjs.duplicateName'));
  return scripts;
}
export function parseDocumentJsRead(value: unknown): DocScript[] {
  const r = value as { complete?: unknown; scripts?: unknown; count?: unknown } | null;
  if (!r || r.complete !== true || !Array.isArray(r.scripts) || r.count !== r.scripts.length) throw incomplete();
  return validateScripts(r.scripts);
}

/** One open working session owns its text and revision; panel lifetime does not. */
export function createDocumentJsDrafts(readState: () => AppState) {
  const entries = new Map<string, DocumentJsDraft>(), listeners = new Set<() => void>(); let version = 0;
  const notify = () => { version++; for (const fn of listeners) fn(); };
  const live = (d: DocumentJsDraft) => entries.get(d.workingPath) === d
    && readState().files.get(d.path)?.workingPath === d.workingPath;
  const current = (d: DocumentJsDraft, buffer = d.buffer) => live(d) && !!buffer
    && readState().files.get(d.path)?.buffer === buffer && !readState().pageDirtyPaths.includes(d.path);
  const editable = (d: DocumentJsDraft) => d.loaded && current(d);
  const conflict = (d: DocumentJsDraft) => d.dirty && !current(d);
  const reconcile = () => { let removed = false;
    for (const [key, d] of entries) if (!live(d)) { entries.delete(key); removed = true; }
    if (removed) notify();
  };
  const get = (file: OpenFile | null) => {
    if (!file?.buffer || file.importOnly || readState().files.get(file.path)?.workingPath !== file.workingPath) return null;
    let d = entries.get(file.workingPath);
    if (!d || d.path !== file.path) { d = { path: file.path, workingPath: file.workingPath, buffer: null,
      scripts: [], baseline: [], selected: 0, loaded: false, dirty: false, busy: false, loading: null, error: '' }; entries.set(file.workingPath, d); }
    return d;
  };
  const load = async (d: DocumentJsDraft, call: EngineCall) => {
    if (!live(d) || d.dirty || d.busy || d.loading || d.error || d.loaded && current(d)) return;
    const buffer = readState().files.get(d.path)?.buffer; if (!buffer) return;
    const token = {}; d.loading = token; notify();
    const accepts = () => current(d, buffer) && d.loading === token && !d.dirty;
    try { const reply = await call('list_document_js', { file: d.workingPath, for_edit: true });
      if (!accepts()) return;
      d.scripts = parseDocumentJsRead(reply); d.baseline = d.scripts; d.selected = 0; d.buffer = buffer; d.loaded = true;
    } catch (e) { if (accepts()) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d) && d.loading === token) { d.loading = null; notify(); } }
  };
  const cancelLoad = (d: DocumentJsDraft) => { if (live(d) && d.loading) { d.loading = null; notify(); } };
  const change = (d: DocumentJsDraft, buffer: PdfBuffer | null, edit: (s: DocScript[]) => DocScript[]) => {
    if (!editable(d) || d.buffer !== buffer) return;
    d.scripts = edit(d.scripts); d.selected = Math.max(0, Math.min(d.selected, d.scripts.length - 1));
    d.dirty = !same(d.scripts, d.baseline); d.error = ''; notify();
  };
  const select = (d: DocumentJsDraft, index: number) => {
    if (!live(d) || !Number.isInteger(index) || index < 0 || index >= d.scripts.length) return;
    d.selected = index; notify();
  };
  const save = async (d: DocumentJsDraft, operation: PerformOperation) => {
    if (!editable(d) || !d.dirty || d.busy) return;
    let submitted: DocScript[];
    try { submitted = validateScripts(d.scripts); }
    catch (e) { d.error = e instanceof Error ? e.message : String(e); notify(); return; }
    d.busy = true; d.error = ''; notify();
    try { const result = await operation(d.path, 'set_document_js', { scripts: submitted },
      { expectedWorkingPath: d.workingPath, expectedBuffer: d.buffer! });
      if (!live(d) || result === EDIT_DECLINED || result === null) return;
      if (!result.publication?.buffer || result.publication.path !== d.path || result.publication.workingPath !== d.workingPath) throw incomplete();
      d.buffer = result.publication.buffer; d.baseline = submitted; d.dirty = !same(d.scripts, submitted);
    } catch (e) { if (live(d)) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; notify(); } }
  };
  const reload = async (d: DocumentJsDraft, commit: () => Promise<void>) => {
    if (!live(d) || d.busy) return;
    const scripts = d.scripts; d.busy = true; notify();
    try { await commit(); if (!live(d) || d.scripts !== scripts) return;
      d.scripts = []; d.baseline = []; d.buffer = null; d.loaded = false; d.dirty = false; d.loading = null; d.error = ''; d.selected = 0;
    } catch (e) { if (live(d)) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; notify(); } }
  };
  return { get, reconcile, current, editable, conflict, load, cancelLoad, change, select, save, reload,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => version };
}
export type DocumentJsDrafts = ReturnType<typeof createDocumentJsDrafts>;
