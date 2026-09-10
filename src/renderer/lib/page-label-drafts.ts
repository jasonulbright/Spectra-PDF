import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import type { EngineCall } from './engine-call';
import { EDIT_DECLINED } from './edit-text';
import { tChrome, tChromeCount } from '../i18n';

export interface LabelRange { start: number; style: string; prefix: string; startAt: number }
type Spec = { style: string; prefix: string; value: number };
const styles = ['D', 'r', 'R', 'a', 'A', 'none'];
const invalid = () => new Error(tChrome('panel.pageLabels.incomplete'));
const changed = () => new Error(tChrome('panel.pageLabels.sourceChanged'));
export function validLabelRanges(rows: LabelRange[], total: number): boolean {
  return Array.isArray(rows) && new Set(rows.map(r => r?.start)).size === rows.length && rows.every(r => r
    && Number.isSafeInteger(r.start) && r.start >= 1 && r.start <= total && styles.includes(r.style)
    && typeof r.prefix === 'string' && r.prefix.length <= 10000 && Number.isSafeInteger(r.startAt) && r.startAt >= 1
    && Number.isSafeInteger(r.startAt + total)
    && (!['r', 'R', 'a', 'A'].includes(r.style) || r.startAt + total <= (['r', 'R'].includes(r.style) ? 9968000 : 259974)));
}
export function parseLabelRead(reply: unknown, total: number): LabelRange[] {
  const r = reply as { complete?: unknown; ranges?: unknown; count?: unknown; labels?: unknown } | null;
  if (!r || r.complete !== true || !Array.isArray(r.ranges) || r.count !== r.ranges.length
      || !Array.isArray(r.labels) || r.labels.length !== total || r.labels.some(v => typeof v !== 'string')) throw invalid();
  const rows = r.ranges.map(n => ({ start: typeof n?.start === 'number' ? n.start + 1 : NaN,
    style: n?.style, prefix: n?.prefix, startAt: n?.start_at }));
  if (!validLabelRanges(rows, total) || rows.some((v, i) => i > 0 && v.start <= rows[i - 1].start)
      || rows.length > 0 && rows[0].start !== 1) throw invalid();
  return rows;
}
export const sameLabelRanges = (a: LabelRange[], b: LabelRange[]) => JSON.stringify(a) === JSON.stringify(b);
export function expandLabelRanges(rows: LabelRange[], total: number): Spec[] {
  if (!validLabelRanges(rows, total)) throw invalid();
  const sorted = [...rows].sort((a, b) => a.start - b.start); let index = -1;
  return Array.from({ length: total }, (_, i) => {
    while (index + 1 < sorted.length && sorted[index + 1].start <= i + 1) index++;
    const r = sorted[index];
    return r ? { style: r.style, prefix: r.prefix, value: r.style === 'none' ? 1 : r.startAt + i + 1 - r.start }
      : { style: 'D', prefix: '', value: i + 1 };
  });
}
export function compactLabelSpecs(specs: Spec[]): LabelRange[] {
  const rows: LabelRange[] = [];
  specs.forEach((s, i) => {
    const prev = specs[i - 1];
    if (!prev || s.style !== prev.style || s.prefix !== prev.prefix || s.style !== 'none' && s.value !== prev.value + 1)
      rows.push({ start: i + 1, style: s.style, prefix: s.prefix, startAt: s.value });
  });
  return rows;
}
/** Bounded preview: invalid and oversized input cannot hang the UI. */
export function previewLabel(rows: LabelRange[], page: number): string {
  const r = [...rows].sort((a, b) => a.start - b.start).filter(v => v.start <= page).at(-1);
  if (!r) return String(page);
  let n = r.startAt + page - r.start;
  if (!Number.isSafeInteger(n) || n < 1 || r.prefix.length > 10000) return '—';
  let value = '';
  if (r.style === 'D') value = String(n);
  if (r.style === 'a' || r.style === 'A') {
    if (n > 259974) return '—';
    value = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
  }
  if (r.style === 'r' || r.style === 'R') {
    if (n > 9968000) return '—';
    for (const [v, s] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
      [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const) {
      const count = Math.floor(n / v); value += s.repeat(count); n %= v;
    }
  }
  return r.prefix + (r.style === 'R' || r.style === 'A' ? value.toUpperCase() : value);
}
export interface PageLabelDraft {
  path: string; workingPath: string; buffer: PdfBuffer | null; pages: number;
  ranges: LabelRange[]; baseline: LabelRange[]; loaded: boolean; dirty: boolean; busy: boolean;
  loading: object | null; error: string; status: string;
}
export function createPageLabelDrafts(readState: () => AppState) {
  const entries = new Map<string, PageLabelDraft>(), listeners = new Set<() => void>(); let version = 0;
  const notify = () => { version++; for (const fn of listeners) fn(); };
  const live = (d: PageLabelDraft) => entries.get(d.workingPath) === d && readState().files.get(d.path)?.workingPath === d.workingPath;
  const at = (d: PageLabelDraft, buffer = d.buffer) => live(d) && !!buffer && readState().files.get(d.path)?.buffer === buffer;
  const editable = (d: PageLabelDraft) => d.loaded && at(d);
  const conflict = (d: PageLabelDraft) => d.dirty && !at(d);
  const reconcile = () => { let removed = false;
    for (const [key, d] of entries) if (!live(d)) { entries.delete(key); removed = true; }
    if (removed) notify();
  };
  const get = (file: OpenFile | null) => {
    if (!file?.buffer || file.importOnly || readState().files.get(file.path)?.workingPath !== file.workingPath) return null;
    let d = entries.get(file.workingPath);
    if (!d || d.path !== file.path) { d = { path: file.path, workingPath: file.workingPath, buffer: null, pages: file.pageCount,
      ranges: [], baseline: [], loaded: false, dirty: false, busy: false, loading: null, error: '', status: '' }; entries.set(file.workingPath, d); }
    return d;
  };
  const load = async (d: PageLabelDraft, call: EngineCall) => {
    if (!live(d) || d.dirty || d.busy || d.loading || d.error || d.loaded && at(d)) return;
    const file = readState().files.get(d.path)!; if (!file.buffer) return;
    const token = {}; d.loading = token; notify();
    const accepts = () => at(d, file.buffer) && d.loading === token && !d.dirty && !readState().pageDirtyPaths.includes(d.path);
    try { const reply = await call('get_page_labels', { file: d.workingPath }); if (!accepts()) return;
      d.ranges = parseLabelRead(reply, file.pageCount); d.baseline = d.ranges; d.pages = file.pageCount; d.buffer = file.buffer; d.loaded = true;
    } catch (e) { if (accepts()) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d) && d.loading === token) { d.loading = null; notify(); } }
  };
  const cancelLoad = (d: PageLabelDraft) => { if (live(d) && d.loading) { d.loading = null; notify(); } };
  const change = (d: PageLabelDraft, buffer: PdfBuffer | null, edit: (r: LabelRange[]) => LabelRange[]) => {
    if (!editable(d) || d.buffer !== buffer) return;
    d.ranges = edit(d.ranges); d.dirty = !sameLabelRanges(d.ranges, d.baseline); d.error = ''; d.status = ''; notify();
  };
  const prepare = async (d: PageLabelDraft, submitted: LabelRange[], call: EngineCall, commit: () => Promise<void>) => {
    if (!at(d)) throw changed();
    const buffer = d.buffer, before = readState(), pageById = new Map<string, number>();
    for (const doc of before.workspace.documents) if (doc.buffer === buffer) for (const p of doc.pages) if (p.sourceDocId === d.path) {
      if (pageById.has(p.id)) throw changed(); pageById.set(p.id, p.sourcePageIndex);
    }
    await commit();
    if (!live(d) || readState().pageDirtyPaths.includes(d.path)) throw changed();
    const file = readState().files.get(d.path)!;
    if (file.buffer === buffer) return submitted;
    const edge = file.authoredIdentity;
    if (!edge || edge.sourceBuffer !== buffer || edge.buffer !== file.buffer || edge.pages.length !== file.pageCount
        || new Set(edge.pages).size !== edge.pages.length || edge.pages.some(id => !pageById.has(id))) throw changed();
    const map = (rows: LabelRange[]) => {
      if (!rows.length) return [];
      const specs = expandLabelRanges(rows, d.pages);
      const mapped = edge.pages.map(id => specs[pageById.get(id)!]); if (mapped.some(s => !s)) throw changed();
      return compactLabelSpecs(mapped);
    };
    const expected = expandLabelRanges(map(d.baseline), file.pageCount);
    const reply = await call('get_page_labels', { file: d.workingPath });
    if (!at(d, file.buffer) || readState().pageDirtyPaths.includes(d.path)) throw changed();
    const baseline = parseLabelRead(reply, file.pageCount);
    if (JSON.stringify(expected) !== JSON.stringify(expandLabelRanges(baseline, file.pageCount))) throw changed();
    const next = map(submitted), current = map(d.ranges);
    d.ranges = current; d.baseline = baseline; d.pages = file.pageCount; d.buffer = file.buffer;
    d.dirty = !sameLabelRanges(current, baseline); notify(); return next;
  };
  const apply = async (d: PageLabelDraft, operation: PerformOperation, call: EngineCall, commit: () => Promise<void>) => {
    if (!editable(d) || !d.dirty || d.busy) return;
    if (new Set(d.ranges.map(r => r.start)).size !== d.ranges.length) { d.error = tChrome('panel.pageLabels.duplicateStart'); notify(); return; }
    if (!validLabelRanges(d.ranges, d.pages)) { d.error = tChrome('panel.pageLabels.invalid'); notify(); return; }
    const original = d.ranges; d.busy = true; d.error = ''; d.status = tChrome('panel.pageLabels.applying'); notify();
    try { const submitted = await prepare(d, original, call, commit);
      const result = await operation(d.path, 'set_page_labels', {
        ranges: submitted.map(r => ({ start: r.start - 1, style: r.style, prefix: r.prefix, start_at: r.startAt })),
      }, { expectedWorkingPath: d.workingPath, expectedBuffer: d.buffer! });
      if (!live(d) || result === EDIT_DECLINED || result === null) return;
      if (!result.publication?.buffer || result.publication.path !== d.path || result.publication.workingPath !== d.workingPath) throw invalid();
      d.buffer = result.publication.buffer; d.baseline = submitted; d.dirty = !sameLabelRanges(d.ranges, submitted);
      d.status = submitted.length ? tChromeCount('panel.pageLabels.applied', submitted.length) : tChrome('panel.pageLabels.removed');
    } catch (e) { if (live(d)) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; if (d.error || d.dirty) d.status = ''; notify(); } }
  };
  const reload = async (d: PageLabelDraft, commit: () => Promise<void>) => {
    if (!live(d) || d.busy) return;
    const rows = d.ranges; d.busy = true; notify();
    try { await commit(); if (!live(d) || d.ranges !== rows) return;
      d.loaded = false; d.buffer = null; d.ranges = []; d.baseline = []; d.dirty = false; d.loading = null; d.error = ''; d.status = '';
    } catch (e) { if (live(d)) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; notify(); } }
  };
  return { get, reconcile, editable, conflict, load, cancelLoad, change, apply, reload,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => version };
}
export type PageLabelDrafts = ReturnType<typeof createPageLabelDrafts>;
