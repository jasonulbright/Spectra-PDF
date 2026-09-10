import type { AppState, OpenFile, PdfBuffer } from '../state/types';
import type { PerformOperation } from '../hooks/useOperations';
import type { OperationOptions, WorkspaceOperationResult } from './operation-transaction';
import type { OpMethod } from './op-edit-class';
import { EDIT_DECLINED } from './edit-text';
import { tChrome } from '../i18n';
import { pagesParam } from './page-scope';
import { emptyTarget, defaultAppearance, isAuthored, targetPayload, appearancePayload,
  targetProblem, appearanceProblem, type DrawnLink, type PickedLink, type LinkRecord,
  type NamedDestination, type LinkTarget, type LinkAppearance } from './links';

type Read = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface LinkDraft {
  id: object;
  kind: 'create' | 'edit';
  buffer: PdfBuffer;
  page: number;
  index: number;
  rect: [number, number, number, number] | null;
  target: LinkTarget;
  appearance: LinkAppearance;
}
export interface LinkSession {
  identity: object;
  path: string; workingPath: string;
  buffer: PdfBuffer | null;
  links: LinkRecord[]; names: NamedDestination[];
  draft: LinkDraft | null; picked: PickedLink | null;
  generation: number; loading: object | null; busy: boolean;
  error: string; status: string;
  query: { pages: string; emails: boolean };
  found: { count: number; already: number; buffer: PdfBuffer; query: LinkSession['query'] } | null;
}
const invalid = () => new Error(tChrome('app.operation.unverified'));
const rectOk = (r: unknown): boolean => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite);

/** Reads are one revision-bound snapshot, never independently merged responses.
 * Contiguous per-page indices are the engine's _links_on enumeration; add_links
 * appends to it. This correspondence also pins the new editor after Create. */
function parseLists(listed: unknown, named: unknown): { links: LinkRecord[]; names: NamedDestination[] } {
  const links = (listed as { links?: LinkRecord[] } | null)?.links;
  const names = (named as { destinations?: NamedDestination[] } | null)?.destinations;
  if (!Array.isArray(links) || !Array.isArray(names)) throw invalid();
  const counts = new Map<number, number>();
  for (const l of links) {
    if (!l || !Number.isSafeInteger(l.page) || l.page < 1 || l.index !== (counts.get(l.page) ?? 0)
        || typeof l.kind !== 'string' || typeof l.target !== 'string' || !l.target_spec
        || typeof l.target_spec.kind !== 'string' || !l.appearance || !Number.isFinite(l.appearance.width)
        || l.rect !== null && !rectOk(l.rect)) throw invalid();
    counts.set(l.page, l.index + 1);
  }
  if (names.some(n => !n || typeof n.name !== 'string'
    || n.page !== null && (!Number.isSafeInteger(n.page) || n.page < 1))) throw invalid();
  return structuredClone({ links, names });
}

/** One store per workspace window, alive even when the Links panel is hidden.
 * Session identity fences close/reopen; source identity fences page addresses;
 * immutable draft/query identities fence late completions and picker results. */
export function createLinkDrafts(readState: () => AppState) {
  const entries = new Map<string, LinkSession>();
  const listeners = new Set<() => void>(); let version = 0;
  const notify = () => { version++; for (const fn of listeners) fn(); };
  const live = (s: LinkSession) => entries.get(s.workingPath) === s
    && readState().files.get(s.path)?.workingPath === s.workingPath;
  const at = (s: LinkSession, buffer: PdfBuffer | null) => !!buffer && live(s)
    && readState().files.get(s.path)?.buffer === buffer && !readState().pageDirtyPaths.includes(s.path);
  const ready = (s: LinkSession) => at(s, s.buffer);
  const conflict = (s: LinkSession) => !!s.draft && !at(s, s.draft.buffer);
  const reconcile = () => {
    let changed = false;
    for (const [key, s] of entries) if (!live(s)) { entries.delete(key); changed = true; }
    if (changed) notify();
  };
  const get = (file: OpenFile | null): LinkSession | null => {
    if (!file?.buffer || file.importOnly || readState().files.get(file.path)?.workingPath !== file.workingPath) return null;
    let s = entries.get(file.workingPath);
    if (!s || s.path !== file.path) {
      s = { identity: {}, path: file.path, workingPath: file.workingPath, buffer: null, links: [], names: [], draft: null,
        picked: null, generation: 0, loading: null, busy: false, error: '', status: '',
        query: { pages: 'all', emails: true }, found: null };
      entries.set(file.workingPath, s);
    }
    return s;
  };
  const beginEdit = (s: LinkSession, link: LinkRecord) => {
    if (!ready(s) || s.busy || !s.links.includes(link)) return;
    s.generation++; s.picked = null;
    s.draft = { id: {}, kind: 'edit', buffer: s.buffer!, page: link.page, index: link.index, rect: link.rect,
      target: structuredClone(isAuthored(link.target_spec.kind) ? link.target_spec : emptyTarget('uri')),
      appearance: structuredClone(link.appearance) };
    s.error = ''; s.status = ''; notify();
  };
  const finishPick = (s: LinkSession) => {
    const p = s.picked;
    if (!p || !ready(s) || p.buffer !== s.buffer) return;
    s.picked = null;
    const link = s.links.find(l => l.page === p.page && l.index === p.index);
    if (link) beginEdit(s, link);
  };
  const load = async (s: LinkSession, read: Read) => {
    if (!live(s) || s.busy || s.loading || s.error || ready(s) || conflict(s)
        || readState().pageDirtyPaths.includes(s.path)) return;
    const buffer = readState().files.get(s.path)?.buffer; if (!buffer) return;
    const token = {}; s.loading = token; notify();
    const accepts = () => live(s) && s.loading === token && at(s, buffer);
    try {
      const listed = await read('list_links', { file: s.workingPath });
      if (!accepts()) return;
      const named = await read('list_named_destinations', { file: s.workingPath });
      if (!accepts()) return;
      const parsed = parseLists(listed, named);
      s.links = parsed.links; s.names = parsed.names; s.buffer = buffer; finishPick(s);
    } catch (e) {
      if (live(s) && s.loading === token && readState().files.get(s.path)?.buffer === buffer)
        s.error = e instanceof Error ? e.message : String(e);
    } finally { if (live(s) && s.loading === token) { s.loading = null; notify(); } }
  };
  const cancelLoad = (s: LinkSession) => { if (s.loading) { s.loading = null; notify(); } };
  const startDraw = (file: OpenFile) => {
    const s = get(file); if (!s || !at(s, file.buffer)) return null;
    s.generation++; s.picked = null;
    return { path: s.path, workingPath: s.workingPath, buffer: file.buffer!, generation: s.generation, session: s.identity };
  };
  const drawingSession = (drawn: Pick<DrawnLink, 'path' | 'workingPath' | 'buffer' | 'generation' | 'session'>) => {
    const s = entries.get(drawn.workingPath);
    if (!s || s.identity !== drawn.session || s.path !== drawn.path || !at(s, drawn.buffer)
        || drawn.generation !== s.generation) return null;
    return s;
  };
  const failDraw = (drawn: Parameters<typeof drawingSession>[0], error: unknown) => {
    const s = drawingSession(drawn); if (!s) return;
    s.generation++; s.error = error instanceof Error ? error.message : String(error); notify();
  };
  const receiveDraw = (drawn: DrawnLink) => {
    const s = drawingSession(drawn); if (!s) return;
    if (!Number.isSafeInteger(drawn.page) || drawn.page < 1 || !rectOk(drawn.rect)) return;
    s.generation++; // consume this geometry completion once
    s.draft = { id: {}, kind: 'create', buffer: drawn.buffer, page: drawn.page, index: -1,
      rect: [...drawn.rect], target: emptyTarget('uri'), appearance: defaultAppearance() };
    s.error = ''; s.status = ''; notify();
  };
  const receivePick = (p: PickedLink) => {
    const file = readState().files.get(p.path);
    if (!file || file.workingPath !== p.workingPath || file.buffer !== p.buffer) return;
    const s = get(file); if (!s || !at(s, p.buffer) || s.busy) return;
    s.generation++; s.picked = p; finishPick(s); notify();
  };
  const patchDraft = (s: LinkSession, expected: LinkDraft, patch: Partial<Pick<LinkDraft, 'target' | 'appearance'>>) => {
    // A delayed native picker must not overwrite a newer choice or draft.
    if (!live(s) || s.draft !== expected || !at(s, expected.buffer)) return;
    s.generation++; s.picked = null; s.draft = { ...expected, ...structuredClone(patch) }; s.error = ''; notify();
  };
  const discard = (s: LinkSession) => {
    if (!live(s) || s.busy) return;
    s.generation++; s.draft = null; s.picked = null; s.buffer = null;
    s.loading = null; s.error = ''; s.status = ''; notify();
  };
  const setQuery = (s: LinkSession, patch: Partial<LinkSession['query']>) => {
    if (!live(s)) return;
    s.query = { ...s.query, ...patch }; s.found = null; notify();
  };
  const reload = async (s: LinkSession, commit: () => Promise<void>) => {
    if (!live(s) || s.busy) return;
    const draft = s.draft; s.busy = true; notify();
    try {
      await commit();
      if (live(s) && s.draft === draft) { s.busy = false; discard(s); }
    } catch (e) { if (live(s)) s.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(s)) { s.busy = false; notify(); } }
  };
  const run = async (s: LinkSession, method: OpMethod, params: Record<string, unknown>,
    perform: PerformOperation, options: OperationOptions, done: string,
    accepted?: (result: WorkspaceOperationResult) => void) => {
    if (!live(s) || s.busy || !at(s, options.expectedBuffer ?? null)) return;
    s.busy = true; s.error = ''; s.status = tChrome('panel.common.working'); s.loading = null; notify();
    try {
      const result = await perform(s.path, method, params, { ...options, expectedWorkingPath: s.workingPath });
      if (!live(s)) return;
      if (result === null || result === EDIT_DECLINED) { s.status = ''; return; }
      accepted?.(result); s.buffer = null; s.found = null; s.status = done;
    } catch (e) {
      if (live(s)) { s.error = e instanceof Error ? e.message : String(e); s.status = ''; }
    } finally { if (live(s)) { s.busy = false; notify(); } }
  };
  const save = async (s: LinkSession, perform: PerformOperation) => {
    const d = s.draft;
    if (!d || !ready(s) || d.buffer !== s.buffer || conflict(s)) return;
    const problem = targetProblem(d.target, { pageCount: readState().files.get(s.path)!.pageCount, names: s.names.map(n => n.name) })
      ?? appearanceProblem(d.appearance);
    if (problem) return;
    const target = targetPayload(d.target), appearance = appearancePayload(d.appearance);
    const index = d.kind === 'create' ? s.links.filter(l => l.page === d.page).length : d.index;
    const accepted = (r: WorkspaceOperationResult) => {
      if (s.draft?.id !== d.id) return;
      if (s.draft === d) s.draft = null;
      else {
        // Creation already landed: later typing edits that new link, never
        // creates a duplicate on a second press. add_links appends per page.
        s.draft = { ...s.draft, kind: 'edit', index, buffer: r.publication.buffer! };
        if (d.kind === 'create') s.links = [...s.links, { page: d.page, index, rect: d.rect,
          kind: d.target.kind, target: '', target_spec: d.target, appearance: d.appearance }];
      }
    };
    if (d.kind === 'create') await run(s, 'add_links', { links: [{ page: d.page, rect: d.rect, target, appearance }] },
      perform, { expectedBuffer: d.buffer }, tChrome('panel.links.draw.created', { page: d.page }), accepted);
    else await run(s, 'set_link_target', { page: d.page, index, target }, perform,
      { expectedBuffer: d.buffer, following: [{ method: 'set_link_appearance', params: { page: d.page, index, appearance } }] },
      tChrome('panel.links.retargeted'), accepted);
  };
  const remove = async (s: LinkSession, link: LinkRecord, perform: PerformOperation) => {
    if (!ready(s) || !s.links.includes(link)) return;
    await run(s, 'delete_link', { page: link.page, index: link.index }, perform,
      { expectedBuffer: s.buffer! }, tChrome('panel.links.removed'));
  };
  const find = async (s: LinkSession, read: Read) => {
    const buffer = readState().files.get(s.path)?.buffer;
    if (!buffer || !at(s, buffer) || s.busy) return;
    const query = s.query; s.busy = true; s.error = ''; s.found = null; notify();
    try {
      const result = await read('find_url_links', { file: s.workingPath, pages: pagesParam(query.pages), emails: query.emails });
      if (!live(s) || s.query !== query || !at(s, buffer)) return;
      const p = result as { count: number; already_linked: number };
      if (!p || !Number.isSafeInteger(p.count) || p.count < 0 || !Number.isSafeInteger(p.already_linked)
          || p.already_linked < 0 || p.already_linked > p.count) throw invalid();
      s.found = { count: p.count, already: p.already_linked, buffer, query };
    } catch (e) { if (live(s) && s.query === query && at(s, buffer)) s.error = e instanceof Error ? e.message : String(e); }
    finally { if (live(s)) { s.busy = false; notify(); } }
  };
  const derive = async (s: LinkSession, perform: PerformOperation) => {
    const f = s.found;
    if (!f || f.query !== s.query || !at(s, f.buffer) || f.count <= f.already) return;
    await run(s, 'create_links_from_urls', { pages: pagesParam(f.query.pages), emails: f.query.emails, skip_existing: true },
      perform, { expectedBuffer: f.buffer }, tChrome('panel.links.derive.created'));
  };
  return { get, reconcile, ready, conflict, load, cancelLoad, startDraw, receiveDraw, failDraw, receivePick,
    beginEdit, patchDraft, discard, reload, setQuery, save, remove, find, derive,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, snapshot: () => version };
}
export type LinkDrafts = ReturnType<typeof createLinkDrafts>;
