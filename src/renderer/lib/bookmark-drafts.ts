import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import type { EngineCall } from './engine-call';
import type { OutlineNode } from './outline-reorder';
import { EDIT_DECLINED } from './edit-text';
import { tChrome } from '../i18n';

type Preview = { tagged: boolean; headings: number; existing: number; skipped: number };
export interface BookmarkDraft {
  path: string; workingPath: string; buffer: PdfBuffer | null;
  nodes: OutlineNode[]; baseline: OutlineNode[]; loaded: boolean; dirty: boolean;
  loading: object | null; busy: boolean; blocked: boolean; readOnly: boolean; error: string; status: string;
  queue: OutlineNode[][]; running: Promise<void> | null; saveRefused: boolean;
  preview: Preview | null; previewToken: object | null; mode: 'replace' | 'append'; deriving: boolean;
}
const changed = () => new Error(tChrome('nav.bookmarks.sourceChanged'));
const invalid = () => new Error(tChrome('app.operation.unverified'));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([, v]) => v !== undefined).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const sameBookmarkTree = (a: OutlineNode[], b: OutlineNode[]) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function parseBookmarkRead(reply: unknown, pages: number): { nodes: OutlineNode[]; readOnly: boolean } {
  const r = reply as { outline?: unknown; count?: unknown; truncated?: unknown } | null;
  if (!r || !Array.isArray(r.outline) || !Number.isSafeInteger(r.count) || typeof r.truncated !== 'boolean') throw invalid();
  let count = 0, lossy = false;
  const walk = (rows: unknown[], depth: number): OutlineNode[] => {
    if (depth > 64) throw invalid();
    return rows.map(row => {
      const n = row as OutlineNode | null;
      if (++count > 10000 || !n || typeof n !== 'object' || typeof n.title !== 'string' || !Array.isArray(n.children)
          || n.page !== null && (!Number.isSafeInteger(n.page) || n.page < 1 || n.page > pages)) throw invalid();
      if (n.action_lossy) lossy = true;
      return { ...structuredClone(n), children: walk(n.children, depth + 1) };
    });
  };
  const nodes = walk(r.outline, 0);
  if (count !== r.count) throw invalid();
  return { nodes, readOnly: r.truncated || lossy };
}

/** The full replacement tree is owned by an open session, not a mounted pane.
 * Its queue advances only on exact publication receipts. A page commit can
 * advance it only along a proven source-buffer edge, with the unedited outline
 * independently read back and matched before any draft is allowed to replace it. */
export function createBookmarkDrafts(readState: () => AppState) {
  const entries = new Map<string, BookmarkDraft>(), listeners = new Set<() => void>(); let version = 0;
  const notify = () => { version++; for (const fn of listeners) fn(); };
  const live = (d: BookmarkDraft) => entries.get(d.workingPath) === d && readState().files.get(d.path)?.workingPath === d.workingPath;
  const at = (d: BookmarkDraft, buffer = d.buffer) => live(d) && !!buffer && readState().files.get(d.path)?.buffer === buffer;
  const editable = (d: BookmarkDraft) => d.loaded && !d.readOnly && !d.blocked && !d.deriving && at(d);
  const conflict = (d: BookmarkDraft) => d.blocked || d.dirty && !at(d);
  const reconcile = () => { let removed = false;
    for (const [key, d] of entries) if (!live(d)) { entries.delete(key); removed = true; }
    if (removed) notify();
  };
  const get = (file: OpenFile | null): BookmarkDraft | null => {
    if (!file?.buffer || file.importOnly || readState().files.get(file.path)?.workingPath !== file.workingPath) return null;
    let d = entries.get(file.workingPath);
    if (!d || d.path !== file.path) {
      d = { path: file.path, workingPath: file.workingPath, buffer: null, nodes: [], baseline: [], loaded: false, dirty: false,
        loading: null, busy: false, blocked: false, readOnly: false, error: '', status: '', queue: [], running: null, saveRefused: false,
        preview: null, previewToken: null, mode: 'replace', deriving: false };
      entries.set(file.workingPath, d);
    }
    return d;
  };
  const load = async (d: BookmarkDraft, call: EngineCall) => {
    if (!live(d) || d.dirty || d.busy || d.loading || d.error || d.loaded && at(d)) return;
    const source = readState().files.get(d.path)!; if (!source.buffer) return;
    const token = {}; d.loading = token; notify();
    const accepts = () => live(d) && d.loading === token && at(d, source.buffer) && !d.dirty;
    try {
      const reply = await call('get_outline', { file: d.workingPath });
      if (!accepts() || readState().pageDirtyPaths.includes(d.path)) return;
      const parsed = parseBookmarkRead(reply, source.pageCount);
      d.nodes = parsed.nodes; d.baseline = parsed.nodes; d.readOnly = parsed.readOnly;
      d.buffer = source.buffer; d.loaded = true; d.preview = null; d.previewToken = null;
      if (d.readOnly) d.status = tChrome('nav.bookmarks.incomplete');
    } catch (e) { if (accepts()) d.error = String(e instanceof Error ? e.message : e); }
    finally { if (live(d) && d.loading === token) { d.loading = null; notify(); } }
  };
  const cancelLoad = (d: BookmarkDraft) => { if (live(d) && d.loading) { d.loading = null; notify(); } };
  const change = (d: BookmarkDraft, buffer: PdfBuffer | null, edit: (nodes: OutlineNode[]) => OutlineNode[]) => {
    if (!editable(d) || buffer !== d.buffer) return;
    d.nodes = edit(d.nodes); d.dirty = !sameBookmarkTree(d.nodes, d.baseline);
    d.preview = null; d.previewToken = null; d.error = ''; d.status = ''; notify();
  };
  const prepare = async (d: BookmarkDraft, call: EngineCall, commit: () => Promise<void>) => {
    if (!at(d)) throw changed();
    const before = readState(), buffer = d.buffer;
    const sourceIds = new Map<number, string[]>();
    // Only PageRefs indexed from these bytes may prove an old numeric address.
    for (const doc of before.workspace.documents) if (doc.buffer === buffer) for (const p of doc.pages) {
      if (p.sourceDocId === d.path) sourceIds.set(p.sourcePageIndex + 1, [...(sourceIds.get(p.sourcePageIndex + 1) ?? []), p.id]);
    }
    await commit();
    if (!live(d) || readState().pageDirtyPaths.includes(d.path)) throw changed();
    const current = readState().files.get(d.path)!;
    if (current.buffer === buffer) return;
    const record = current.authoredIdentity;
    if (!record || record.sourceBuffer !== buffer || record.buffer !== current.buffer || record.pages.length !== current.pageCount
        || new Set(record.pages).size !== record.pages.length) throw changed();
    const map = (nodes: OutlineNode[]): OutlineNode[] => nodes.map(n => {
      let page = n.page;
      if (page !== null) {
        const ids = sourceIds.get(page);
        if (ids?.length !== 1 || !record.pages.includes(ids[0])) throw changed();
        page = record.pages.indexOf(ids[0]) + 1;
      }
      return { ...n, page, children: map(n.children) };
    });
    const baseline = map(d.baseline);
    const reply = await call('get_outline', { file: d.workingPath });
    if (!at(d, current.buffer) || readState().pageDirtyPaths.includes(d.path)) throw changed();
    const post = parseBookmarkRead(reply, current.pageCount);
    // Import/recovery/other outline changes cannot be overwritten by an old
    // full replacement, even when some page identities still happen to match.
    if (post.readOnly || !sameBookmarkTree(baseline, post.nodes)) throw changed();
    const nodes = map(d.nodes), queue = d.queue.map(map);
    d.baseline = post.nodes; d.nodes = nodes; d.queue = queue; d.buffer = current.buffer;
    d.dirty = !sameBookmarkTree(nodes, post.nodes); d.preview = null; d.previewToken = null; notify();
  };
  const flush = (d: BookmarkDraft, operation: PerformOperation, call: EngineCall, commit: () => Promise<void>): Promise<void> => {
    // Returning to the pre-save baseline is still a new gesture when an older
    // replacement is in flight. Compare against the queued tail, not dirty.
    if (!editable(d) || !d.dirty && !d.busy) return d.running ?? Promise.resolve();
    if (!sameBookmarkTree(d.queue.at(-1) ?? d.baseline, d.nodes)) d.queue.push(d.nodes);
    if (d.running) return d.running;
    d.busy = true; d.loading = null; d.error = ''; d.saveRefused = false; d.status = tChrome('nav.bookmarks.saving'); notify();
    const run = async () => {
      try {
        while (d.queue.length) {
          await prepare(d, call, commit);
          const submitted = d.queue[0];
          const result = await operation(d.path, 'set_outline', { outline: submitted },
            { expectedWorkingPath: d.workingPath, expectedBuffer: d.buffer! });
          if (!live(d)) return;
          if (result === EDIT_DECLINED || result === null) { d.saveRefused = true; d.queue = []; return; }
          if (!result.publication?.buffer || result.publication.workingPath !== d.workingPath || result.publication.path !== d.path) throw invalid();
          d.buffer = result.publication.buffer; d.baseline = submitted; d.queue.shift();
          d.dirty = !sameBookmarkTree(d.nodes, submitted); notify();
        }
      } catch (e) { if (live(d)) { d.saveRefused = true; d.error = e instanceof Error ? e.message : String(e); d.blocked = !at(d); d.queue = []; } }
      finally { if (live(d)) { d.busy = false; d.running = null; d.status = ''; notify(); } }
    };
    // Set the owner promise before any await can run a competing flush.
    d.running = Promise.resolve().then(run); return d.running;
  };
  const reload = async (d: BookmarkDraft, commit: () => Promise<void>) => {
    if (!live(d) || d.busy || d.deriving) return;
    const nodes = d.nodes; d.busy = true; notify();
    try { await commit(); if (!live(d) || d.nodes !== nodes) return;
      d.loaded = false; d.buffer = null; d.nodes = []; d.baseline = []; d.dirty = false; d.blocked = false;
      d.readOnly = false; d.error = ''; d.saveRefused = false; d.status = ''; d.loading = null; d.preview = null; d.previewToken = null; d.queue = [];
    } catch (e) { if (live(d)) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.busy = false; notify(); } }
  };
  const preview = async (d: BookmarkDraft, call: EngineCall, commit: () => Promise<void>) => {
    if (!editable(d) || d.busy || d.dirty) return;
    d.deriving = true; d.error = ''; d.status = tChrome('nav.bookmarks.derive.reading'); const token = {}; d.previewToken = token; notify();
    try {
      await prepare(d, call, commit); if (!live(d)) return;
      d.previewToken = token; const buffer = d.buffer;
      const r = await call('preview_structure_outline', { file: d.workingPath }) as Record<string, unknown>;
      if (!at(d, buffer) || d.previewToken !== token || readState().pageDirtyPaths.includes(d.path)) throw changed();
      if (!r || typeof r.tagged !== 'boolean' || !['headings', 'existing'].every(k => Number.isSafeInteger(r[k]) && Number(r[k]) >= 0)
          || !Array.isArray(r.skipped)) throw invalid();
      d.preview = { tagged: r.tagged, headings: Number(r.headings), existing: Number(r.existing), skipped: r.skipped.length };
    } catch (e) { if (live(d) && d.previewToken === token) { d.preview = null; d.error = e instanceof Error ? e.message : String(e); } }
    finally { if (live(d)) { d.deriving = false; d.status = ''; notify(); } }
  };
  const cancelPreview = (d: BookmarkDraft) => { if (live(d)) { d.preview = null; d.previewToken = null; notify(); } };
  const setMode = (d: BookmarkDraft, mode: 'append' | 'replace') => { if (live(d) && !d.deriving) { d.mode = mode; notify(); } };
  const derive = async (d: BookmarkDraft, operation: PerformOperation) => {
    if (!live(d) || d.deriving || d.busy || d.dirty || !d.preview) return;
    if (!editable(d) || readState().pageDirtyPaths.includes(d.path)) { d.error = changed().message; notify(); return; }
    const preview = d.preview, token = d.previewToken; d.deriving = true; d.error = ''; d.status = tChrome('nav.bookmarks.derive.building'); notify();
    try {
      const result = await operation(d.path, 'outline_from_structure', { mode: d.mode, tag_if_untagged: !preview.tagged },
        { expectedWorkingPath: d.workingPath, expectedBuffer: d.buffer! });
      if (!live(d) || result === EDIT_DECLINED || result === null) return;
      d.loaded = false; d.buffer = result.publication.buffer; d.preview = null; d.previewToken = null;
      const report = result as unknown as { source: string; added: number };
      d.status = Number.isSafeInteger(report.added) && report.added >= 0
        ? tChrome(report.source === 'autotag' ? 'nav.bookmarks.derive.builtFromDetected' : 'nav.bookmarks.derive.builtFromTags', { count: report.added })
        : tChrome('app.operation.unverified');
    } catch (e) { if (live(d) && d.previewToken === token) d.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(d)) { d.deriving = false; if (d.preview) d.status = ''; notify(); } }
  };
  const beforeSave = async (workingPath: string): Promise<void> => {
    const d = entries.get(workingPath);
    if (!d) return;
    // Only wait for gestures the user already finished. Do not manufacture a
    // blur or submit newer, unfinished typing as a side effect of saving.
    while (d.running) {
      await d.running;
      if (!live(d)) throw changed();
    }
    if (!live(d)) throw changed();
    // flush retains refused input instead of rejecting its UI event promise.
    // That refusal must nevertheless stop Save/Save As, not certify old bytes.
    if ((d.saveRefused && d.dirty) || d.blocked) throw new Error(d.error || tChrome('app.operation.unverified'));
  };
  return { get, reconcile, editable, conflict, at, load, cancelLoad, change, flush, beforeSave, reload, preview, derive, cancelPreview, setMode,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => version };
}
export type BookmarkDrafts = ReturnType<typeof createBookmarkDrafts>;
