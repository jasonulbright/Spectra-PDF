import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import type { Article, DrawnBead } from './article-beads';
import { EDIT_DECLINED } from './edit-text';
import { tChrome } from '../i18n';

export interface ArticleDraft {
  readonly path: string;
  readonly workingPath: string;
  buffer: PdfBuffer | null;
  articles: Article[];
  selected: number;
  bead: number;
  loaded: boolean;
  dirty: boolean;
  busy: boolean;
  loading: object | null;
  error: string;
}

/** Session-owned, not panel-owned: hiding the pane or visiting another document
 * cannot discard a draft. Close retires it synchronously, fencing late replies. */
export function createArticleDrafts(readState: () => AppState) {
  const entries = new Map<string, ArticleDraft>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => { version++; for (const listener of listeners) listener(); };
  const live = (d: ArticleDraft) => entries.get(d.workingPath) === d
    && readState().files.get(d.path)?.workingPath === d.workingPath;
  const current = (d: ArticleDraft) => live(d)
    && readState().files.get(d.path)?.buffer === d.buffer
    && !readState().pageDirtyPaths.includes(d.path);
  const editable = (d: ArticleDraft) => d.loaded && current(d);
  const reconcile = () => {
    let removed = false;
    for (const [key, d] of entries) if (!live(d)) { entries.delete(key); removed = true; }
    if (removed) notify();
  };
  const get = (file: OpenFile | null): ArticleDraft | null => {
    if (!file?.buffer || file.importOnly || readState().files.get(file.path)?.workingPath !== file.workingPath) return null;
    let d = entries.get(file.workingPath);
    if (!d || d.path !== file.path) {
      d = { path: file.path, workingPath: file.workingPath, buffer: null,
        articles: [], selected: 0, bead: 0, loaded: false, dirty: false, busy: false, loading: null, error: '' };
      entries.set(file.workingPath, d);
    }
    return d;
  };
  const load = async (d: ArticleDraft, call: (method: string, params: Record<string, unknown>) => Promise<unknown>) => {
    if (!live(d) || d.dirty || d.busy || d.loading || d.error || d.loaded && current(d)) return;
    const buffer = readState().files.get(d.path)?.buffer;
    if (!buffer) return;
    const token = {}; d.loading = token; notify();
    const accepts = () => live(d) && d.loading === token && !d.dirty
      && readState().files.get(d.path)?.buffer === buffer && !readState().pageDirtyPaths.includes(d.path);
    try {
      const reply = await call('list_threads', { file: d.workingPath });
      if (!accepts()) return;
      const rows = (reply as { threads?: unknown } | null)?.threads;
      if (!Array.isArray(rows)) throw new Error(tChrome('app.operation.unverified'));
      const articles = rows.map((row: Article) => {
        if (!row || !['title', 'author', 'subject', 'keywords'].every(key => typeof row[key as keyof Article] === 'string')
            || !Array.isArray(row.beads) || row.beads.some(b => !b || !Number.isSafeInteger(b.page) || b.page < 1
              || !Array.isArray(b.rect) || b.rect.length !== 4 || !b.rect.every(Number.isFinite))) {
          throw new Error(tChrome('app.operation.unverified'));
        }
        return structuredClone(row);
      });
      d.articles = articles; d.buffer = buffer; d.loaded = true; d.selected = 0; d.bead = 0;
    } catch (e) {
      if (live(d) && d.loading === token && readState().files.get(d.path)?.buffer === buffer)
        d.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (live(d) && d.loading === token) { d.loading = null; notify(); }
    }
  };
  const cancelLoad = (d: ArticleDraft) => { if (d.loading) { d.loading = null; notify(); } };
  const clampSelection = (d: ArticleDraft) => {
    d.selected = Math.max(0, Math.min(d.selected, d.articles.length - 1));
    d.bead = Math.max(0, Math.min(d.bead, (d.articles[d.selected]?.beads.length ?? 0) - 1));
  };
  const change = (d: ArticleDraft, edit: (articles: Article[]) => Article[]) => {
    if (!editable(d)) return;
    d.articles = edit(d.articles); clampSelection(d); d.dirty = true; d.error = ''; notify();
  };
  const select = (d: ArticleDraft, selected: number, bead: number) => {
    if (!live(d)) return;
    d.selected = selected; d.bead = bead; clampSelection(d); notify();
  };
  const append = (d: ArticleDraft, drawn: DrawnBead, untitled: () => Article) => {
    if (drawn.path !== d.path || drawn.workingPath !== d.workingPath || drawn.buffer !== d.buffer) return;
    change(d, prev => {
      const list = prev.length ? prev : [untitled()];
      const index = Math.min(d.selected, list.length - 1);
      return list.map((a, i) => i === index ? { ...a, beads: [...a.beads, { page: drawn.page, rect: [...drawn.rect] as [number, number, number, number] }] } : a);
    });
  };
  const reset = (d: ArticleDraft) => {
    if (!live(d) || d.busy) return;
    entries.delete(d.workingPath); notify(); // explicit user discard/reload only
  };
  const save = async (d: ArticleDraft, performOperation: PerformOperation) => {
    if (!editable(d) || !d.dirty || d.busy || !d.buffer) return;
    const submitted = d.articles;
    const buffer = d.buffer;
    d.busy = true; d.error = ''; notify();
    try {
      const result = await performOperation(d.path, 'set_threads', { threads: submitted },
        { expectedWorkingPath: d.workingPath, expectedBuffer: buffer });
      if (!live(d) || result === EDIT_DECLINED || result === null) return;
      d.buffer = result.publication.buffer;
      d.dirty = d.articles !== submitted;
    } catch (e) {
      if (live(d)) d.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (live(d)) { d.busy = false; notify(); }
    }
  };
  return { get, reconcile, current, editable, load, cancelLoad, change, select, append, reset, save,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => version };
}
export type ArticleDrafts = ReturnType<typeof createArticleDrafts>;
