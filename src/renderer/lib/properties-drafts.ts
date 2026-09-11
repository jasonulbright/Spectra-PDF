import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import type { EngineCall } from './engine-call';
import { EDIT_DECLINED } from './edit-text';
import { tChrome } from '../i18n';
import { batch } from './tauri-bridge';
import { localizeEngineMessage } from './engine-messages';
import { DEFAULT_INITIAL_VIEW, initialViewChanges, VIEWER_ONLY_OPTIONS, type InitialView } from './initial-view';
import { DEFAULT_ADVANCED, advancedChanges, type AdvancedProperties } from './doc-advanced';
import { parseAdvancedReply, parseInitialViewReply, PropertiesReplyError } from './properties-reply-parsers';

export interface PropertyMetadata { title: string; author: string; subject: string; keywords: string }
export interface PropertyGroup<T extends object> {
  draft: T; baseline: T | null; fresh: boolean; error: string; keys: readonly (keyof T)[];
}
const metadataKeys = ['title', 'author', 'subject', 'keywords'] as const;
const viewKeys = ['page_layout', 'page_mode', 'open_page', 'zoom', 'zoom_percent', 'direction', ...VIEWER_ONLY_OPTIONS] as const;
const advancedKeys = ['trapped', 'base_url'] as const;
const group = <T extends object>(draft: T, keys: readonly (keyof T)[]): PropertyGroup<T> =>
  ({ draft, baseline: null, fresh: false, error: '', keys });
export const propertyDirty = <T extends object>(g: PropertyGroup<T>) =>
  g.baseline !== null && g.keys.some(key => g.draft[key] !== g.baseline![key]);
function accept<T extends object>(g: PropertyGroup<T>, value: T): void {
  const merged = { ...value };
  // Only a proven own publication may rebase dirty input onto newer bytes.
  // Preserve every field changed since the previous accepted baseline,
  // including typing that happened while the read was outstanding.
  if (g.baseline) for (const key of g.keys) {
    if (g.draft[key] !== g.baseline[key]) merged[key] = g.draft[key];
  }
  g.draft = merged; g.baseline = value; g.fresh = true; g.error = '';
}
const changed = () => new Error(tChrome('app.history.changed'));
const incomplete = () => new Error(tChrome('dialog.props.unknown'));
export function parsePropertyMetadata(raw: unknown): PropertyMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw incomplete();
  const value = raw as Record<string, unknown>;
  const parsed = { ...value };
  // dc:creator is an ordered XMP sequence. Display all authors, but never
  // collapse that sequence merely because another metadata field changed.
  if (Array.isArray(parsed.author) && parsed.author.every(v => typeof v === 'string')) parsed.author = parsed.author.join('; ');
  if (metadataKeys.some(k => !Object.prototype.hasOwnProperty.call(parsed, k) || typeof parsed[k] !== 'string')) throw incomplete();
  return Object.fromEntries(metadataKeys.map(k => [k, parsed[k]])) as unknown as PropertyMetadata;
}
export interface PropertiesDraft {
  path: string; workingPath: string; buffer: PdfBuffer | null;
  metadata: PropertyGroup<PropertyMetadata>; view: PropertyGroup<InitialView>;
  advanced: PropertyGroup<AdvancedProperties>; busy: boolean; loading: object | null; status: string;
}
export function createPropertiesDrafts(readState: () => AppState,
  sameFile: (a: string, b: string) => Promise<boolean> = batch.pathsSameFile) {
  const entries = new Map<string, PropertiesDraft>(), listeners = new Set<() => void>();
  let version = 0;
  let lifetime = 0, mounted = true;
  const notify = () => { version++; for (const fn of listeners) fn(); };
  const live = (d: PropertiesDraft) => entries.get(d.workingPath) === d
    && readState().files.get(d.path)?.workingPath === d.workingPath;
  const at = (d: PropertiesDraft, buffer = d.buffer) => live(d) && buffer !== null
    && readState().files.get(d.path)?.buffer === buffer;
  const dirty = (d: PropertiesDraft) => propertyDirty(d.metadata) || propertyDirty(d.view) || propertyDirty(d.advanced);
  const conflict = (d: PropertiesDraft) => dirty(d) && !at(d);
  const editable = <T extends object>(d: PropertiesDraft, g: PropertyGroup<T>) =>
    at(d) && g.fresh && g.baseline !== null && !readState().pageDirtyPaths.includes(d.path);
  const assertCurrent = (d: PropertiesDraft, buffer: PdfBuffer, active = false) => {
    if (!at(d, buffer) || readState().pageDirtyPaths.includes(d.path)
        || active && readState().activeFileId !== d.path) throw changed();
  };
  const get = (file: OpenFile | null) => {
    if (!file?.buffer || file.importOnly) return null;
    let d = entries.get(file.workingPath);
    if (!d || d.path !== file.path) {
      d = { path: file.path, workingPath: file.workingPath, buffer: file.buffer,
        metadata: group({ title: '', author: '', subject: '', keywords: '' }, metadataKeys),
        view: group({ ...DEFAULT_INITIAL_VIEW }, viewKeys), advanced: group({ ...DEFAULT_ADVANCED }, advancedKeys),
        busy: false, loading: null, status: '' };
      entries.set(file.workingPath, d);
    }
    return d;
  };
  const invalidateFacts = (d: PropertiesDraft) => {
    d.metadata.fresh = false; d.view.fresh = false; d.advanced.fresh = false;
    d.metadata.error = ''; d.view.error = ''; d.advanced.error = '';
  };
  const load = async (d: PropertiesDraft, call: EngineCall, commit: () => Promise<void>) => {
    if (!live(d) || d.busy || d.loading || conflict(d)) return;
    if (at(d) && [d.metadata, d.view, d.advanced].every(g => g.fresh || g.error)) return;
    const token = {}; d.loading = token; notify();
    try {
      await commit();
      if (!live(d) || d.loading !== token) return;
      const file = readState().files.get(d.path)!;
      if (!file.buffer || readState().pageDirtyPaths.includes(d.path)) throw changed();
      if (!at(d)) {
        if (dirty(d)) throw changed();
        d.buffer = file.buffer; invalidateFacts(d);
      }
      const buffer = file.buffer;
      const owns = () => d.loading === token && at(d, buffer) && !readState().pageDirtyPaths.includes(d.path);
      const read = async <T extends object>(g: PropertyGroup<T>, method: string, parse: (r: unknown) => T) => {
        if (!owns() || g.fresh || g.error) return;
        try {
          const raw = await call(method, { file: d.workingPath }, { assertCurrent: () => assertCurrent(d, buffer) });
          if (owns()) accept(g, parse(raw));
        } catch (e) { if (owns()) {
          g.fresh = false;
          g.error = e instanceof PropertiesReplyError ? incomplete().message : e instanceof Error ? e.message : String(e);
        } }
        if (owns()) notify();
      };
      await read(d.metadata, 'get_metadata', parsePropertyMetadata);
      await read(d.view, 'get_initial_view', parseInitialViewReply);
      await read(d.advanced, 'get_advanced_properties', parseAdvancedReply);
    } catch (e) { if (live(d) && d.loading === token) d.status = e instanceof Error ? e.message : String(e); }
    finally { if (live(d) && d.loading === token) { d.loading = null; notify(); } }
  };
  const cancelLoad = (d: PropertiesDraft) => { if (live(d) && d.loading) { d.loading = null; notify(); } };
  const change = <T extends object>(d: PropertiesDraft, g: PropertyGroup<T>, next: T) => {
    if (!editable(d, g)) return;
    g.draft = next; d.status = ''; notify();
  };
  const apply = async (d: PropertiesDraft, kind: 'view' | 'advanced', operation: PerformOperation, call: EngineCall) => {
    const g = d[kind];
    if (d.busy || !at(d) || !g.fresh || !g.baseline || readState().pageDirtyPaths.includes(d.path)) return;
    const params = kind === 'view' ? initialViewChanges(d.view.baseline!, d.view.draft)
      : advancedChanges(d.advanced.baseline!, d.advanced.draft);
    if (!params) return;
    const submitted = { ...g.draft }, buffer = d.buffer!;
    d.busy = true; d.loading = null;
    d.status = tChrome(kind === 'view' ? 'dialog.props.savingView' : 'dialog.props.savingAdvanced'); notify();
    try {
      assertCurrent(d, buffer, true);
      const result = await operation(d.path, kind === 'view' ? 'set_initial_view' : 'set_advanced_properties', params,
        { expectedWorkingPath: d.workingPath, expectedBuffer: buffer });
      if (!live(d)) return;
      if (result === EDIT_DECLINED || result === null) { d.status = ''; return; }
      const published = result.publication;
      if (!published?.buffer || published.path !== d.path || published.workingPath !== d.workingPath) throw incomplete();
      // Retire exactly what was submitted, even if current typing returned to
      // the old baseline. Do not mark a later unrelated revision accepted.
      if (kind === 'view') d.view.baseline = submitted as InitialView;
      else d.advanced.baseline = submitted as AdvancedProperties;
      d.buffer = published.buffer; invalidateFacts(d);
      d.status = tChrome('dialog.props.saved');
    } catch (e) { if (live(d)) d.status = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; notify(); } }
    if (at(d)) await load(d, call, async () => {});
  };
  const exportMetadata = async (d: PropertiesDraft, strip: boolean, picker: () => Promise<string | null>, call: EngineCall) => {
    if (d.busy || !editable(d, d.metadata)) return;
    const buffer = d.buffer!, submitted = Object.fromEntries(metadataKeys
      .filter(k => d.metadata.draft[k] !== d.metadata.baseline![k]).map(k => [k, d.metadata.draft[k]])), owner = lifetime;
    const assertOwner = () => { if (!mounted || owner !== lifetime) throw changed(); assertCurrent(d, buffer, true); };
    d.busy = true; d.status = ''; notify();
    try {
      assertOwner();
      const output = await picker();
      if (!output) return;
      assertOwner();
      // A copy export has no workspace publication receipt. It must not write
      // an open source or working copy, including a hardlink/UNC alias, then
      // leave that document's displayed bytes and history stale.
      for (const file of readState().files.values()) {
        for (const path of [file.path, file.workingPath]) {
          if (output === path || await sameFile(output, path)) {
            throw new Error(localizeEngineMessage('output must be a different file from the input'));
          }
          assertOwner();
        }
      }
      const reply = await call(strip ? 'strip_metadata' : 'set_metadata', { file: d.workingPath, output, ...(strip ? {} : submitted) },
        { assertCurrent: assertOwner });
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)
          || (reply as { output?: unknown }).output !== output) throw incomplete();
      // This is a separate output, not an edit to the open document/draft.
      if (live(d)) d.status = tChrome(strip ? 'dialog.props.stripped' : 'dialog.props.saved');
    } catch (e) { if (live(d)) d.status = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; notify(); } }
  };
  const reload = (d: PropertiesDraft) => {
    if (!live(d) || d.busy) return;
    d.loading = null; d.buffer = readState().files.get(d.path)!.buffer;
    for (const g of [d.metadata, d.view, d.advanced]) g.baseline = null;
    invalidateFacts(d); d.status = ''; notify();
  };
  const activate = () => { mounted = true; lifetime++; };
  const deactivate = () => { mounted = false; lifetime++; for (const d of entries.values()) d.loading = null; };
  return { get, at, conflict, editable, change, load, cancelLoad, apply, exportMetadata, reload, activate, deactivate,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => version };
}
