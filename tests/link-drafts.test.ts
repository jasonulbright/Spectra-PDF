import { describe, expect, it, vi } from 'vitest';
import { createLinkDrafts } from '../src/renderer/lib/link-drafts';
import { defaultAppearance, type LinkRecord } from '../src/renderer/lib/links';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const link = (index = 0): LinkRecord => ({ page: 1, index, kind: 'uri', target: 'https://old.example/',
  target_spec: { kind: 'uri', url: 'https://old.example/' }, rect: [0, 0, 50, 50], appearance: defaultAppearance() });
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', name: 'A', buffer: new Uint8Array([1]),
    pageCount: 2, dirty: false, undoStack: [], redoStack: [] };
  const b: OpenFile = { ...a, path: 'B', workingPath: 'work-B', buffer: new Uint8Array([2]) };
  let state: AppState = { ...initialState, files: new Map([['A', a], ['B', b]]), activeFileId: 'A' };
  const drafts = createLinkDrafts(() => state), da = drafts.get(a)!, db = drafts.get(b)!;
  const read = vi.fn(async (method: string) => method === 'list_links' ? { links: [link()] } : { destinations: [] });
  await drafts.load(da, read); await drafts.load(db, read);
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; drafts.reconcile(); };
  const draw = (file = a) => {
    const request = drafts.startDraw(file)!;
    drafts.receiveDraw({ ...request, page: 1, rect: [10, 10, 100, 100] });
    return request;
  };
  const type = (url: string, s = da) => drafts.patchDraft(s, s.draft!, { target: { kind: 'uri', url } });
  const published = { ...a, buffer: new Uint8Array([3]), dirty: true };
  const operation = vi.fn<PerformOperation>(async () => {
    change({ files: new Map([['A', published], ['B', b]]) });
    return { publication: published } as Awaited<ReturnType<PerformOperation>>;
  });
  return { a, b, da, db, drafts, read, change, draw, type, published, operation, state: () => state };
}

describe('link draft ownership and asynchronous boundaries', () => {
  it('A-B-A restores independent rectangle, target, appearance and scan input', async () => {
    const f = await fixture(); f.draw(); f.type('https://a.example/');
    f.drafts.patchDraft(f.da, f.da.draft!, { appearance: { ...defaultAppearance(), width: 2 } });
    f.drafts.setQuery(f.da, { pages: '2', emails: false }); f.change({ activeFileId: 'B' });
    await f.drafts.save(f.db, f.operation); expect(f.operation).not.toHaveBeenCalled();
    f.draw(f.b); f.type('https://b.example/', f.db); f.change({ activeFileId: 'A' });
    expect(f.drafts.get(f.a)).toBe(f.da); expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://a.example/' });
    expect(f.da.draft?.appearance.width).toBe(2); expect(f.da.query).toEqual({ pages: '2', emails: false });
    await f.drafts.save(f.da, f.operation);
    expect(f.operation).toHaveBeenCalledWith('A', 'add_links', { links: [{ page: 1, rect: [10, 10, 100, 100],
      target: { kind: 'uri', url: 'https://a.example/' }, appearance: { width: 2, style: 'solid', highlight: 'invert' } }] },
    { expectedBuffer: f.a.buffer, expectedWorkingPath: 'work-A' });
    expect(f.da.draft).toBeNull(); expect(f.db.draft?.target).toEqual({ kind: 'uri', url: 'https://b.example/' });
  });
  it('delivery is consumed once and remount does not reset a changed draft', async () => {
    const f = await fixture(), ticket = f.draw(); f.type('https://kept.example/');
    f.drafts.cancelLoad(f.da); f.drafts.receiveDraw({ ...ticket, page: 1, rect: [0, 0, 50, 50] });
    expect(f.drafts.get(f.a)?.draft?.target).toEqual({ kind: 'uri', url: 'https://kept.example/' });
  });
  it.each(['newer draw', 'newer edit', 'discard', 'revision', 'pending pages', 'reopen'])('late geometry refuses after %s', async kind => {
    const f = await fixture(); f.draw(); f.type('https://keep.example/');
    const ticket = f.drafts.startDraw(f.a)!;
    if (kind === 'newer draw') f.draw();
    if (kind === 'newer edit') f.type('https://newer.example/');
    if (kind === 'discard') f.drafts.discard(f.da);
    if (kind === 'revision') f.change({ files: new Map([['A', f.published], ['B', f.b]]) });
    if (kind === 'pending pages') f.change({ pageDirtyPaths: ['A'] });
    if (kind === 'reopen') {
      f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
      f.drafts.startDraw(f.a); // identical path, bytes, and local generation: still a different session
    }
    const s = f.drafts.get(f.state().files.get('A')!)!, before = s.draft;
    f.drafts.receiveDraw({ ...ticket, page: 2, rect: [0, 0, 99, 99] }); expect(s.draft).toBe(before);
  });
  it('native picker completion cannot overwrite newer input or another edit', async () => {
    const f = await fixture(); f.draw(); const old = f.da.draft!;
    f.type('https://typed.example/'); f.drafts.patchDraft(f.da, old, { target: { kind: 'file', path: 'old.pdf' } });
    expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://typed.example/' });
    f.drafts.beginEdit(f.da, f.da.links[0]); const edit = f.da.draft;
    f.drafts.patchDraft(f.da, old, { target: { kind: 'file', path: 'old.pdf' } }); expect(f.da.draft).toBe(edit);
  });
  it('geometry errors belong to their current request, never a later draw or another document', async () => {
    const f = await fixture(), old = f.drafts.startDraw(f.a)!;
    f.draw(); f.drafts.failDraw(old, Error('stale error')); expect(f.da.error).toBe('');
    const current = f.drafts.startDraw(f.a)!; f.change({ activeFileId: 'B' });
    f.drafts.failDraw(current, Error('current A error')); expect(f.da.error).toBe('current A error'); expect(f.db.error).toBe('');
    f.drafts.failDraw(current, Error('replayed error')); expect(f.da.error).toBe('current A error');
  });
  it.each(['list', 'names'])('a late %s read cannot overwrite remount state or input', async phase => {
    const f = await fixture(); f.drafts.discard(f.da);
    const answer = deferred<unknown>();
    const old = f.drafts.load(f.da, method => method === (phase === 'list' ? 'list_links' : 'list_named_destinations')
      ? answer.promise : Promise.resolve({ links: [link()] }));
    await Promise.resolve(); f.drafts.cancelLoad(f.da); await f.drafts.load(f.da, f.read);
    f.draw(); f.type('https://new.example/');
    answer.resolve(phase === 'list' ? { links: [] } : { destinations: [{ name: 'Old', page: 2 }] }); await old;
    expect(f.da.links).toHaveLength(1); expect(f.da.names).toEqual([]); expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://new.example/' });
  });
  it('a revision changing between the two reads produces no mixed snapshot', async () => {
    const f = await fixture(); f.drafts.discard(f.da);
    const answer = deferred<unknown>(); const load = f.drafts.load(f.da, method => method === 'list_links'
      ? Promise.resolve({ links: [link()] }) : answer.promise);
    await Promise.resolve(); f.change({ files: new Map([['A', f.published], ['B', f.b]]) });
    answer.resolve({ destinations: [] }); await load; expect(f.drafts.ready(f.da)).toBe(false);
    await f.drafts.load(f.da, f.read); expect(f.da.buffer).toBe(f.published.buffer);
  });
  it.each([null, {}, { links: null }, { links: [null] }, { links: [link(3)] }])('bad list is not an empty successful read: %j', async bad => {
    const f = await fixture(); f.drafts.discard(f.da);
    await f.drafts.load(f.da, async method => method === 'list_links' ? bad : { destinations: [] });
    expect(f.drafts.ready(f.da)).toBe(false); expect(f.da.error).not.toBe('');
    f.draw(); f.type('https://not-written.example/'); await f.drafts.save(f.da, f.operation); expect(f.operation).not.toHaveBeenCalled();
    f.drafts.discard(f.da); await f.drafts.load(f.da, f.read); expect(f.drafts.ready(f.da)).toBe(true);
  });
  it.each(['pending pages', 'revision'])('%s fences Create, Edit, Delete without losing input', async kind => {
    const f = await fixture(); f.drafts.beginEdit(f.da, f.da.links[0]); f.type('https://keep.example/');
    if (kind === 'revision') f.change({ files: new Map([['A', f.published], ['B', f.b]]) });
    else f.change({ pageDirtyPaths: ['A'] });
    await f.drafts.save(f.da, f.operation); await f.drafts.remove(f.da, f.da.links[0], f.operation);
    expect(f.operation).not.toHaveBeenCalled(); expect(f.drafts.conflict(f.da)).toBe(true);
    expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://keep.example/' });
  });
  it('current Edit sends target and appearance as one pinned transaction', async () => {
    const f = await fixture(); f.drafts.beginEdit(f.da, f.da.links[0]); f.type('https://new.example/');
    f.change({ pageDirtyPaths: ['B'] }); await f.drafts.save(f.da, f.operation);
    expect(f.operation.mock.calls[0]).toEqual(['A', 'set_link_target', { page: 1, index: 0, target: { kind: 'uri', url: 'https://new.example/' } },
      { expectedBuffer: f.a.buffer, expectedWorkingPath: 'work-A', following: [{ method: 'set_link_appearance',
        params: { page: 1, index: 0, appearance: { width: 0, style: 'solid', highlight: 'invert' } } }] }]);
  });
  it.each(['create', 'edit'])('typing during %s stays unsaved on the exact published revision', async kind => {
    const f = await fixture(); if (kind === 'create') f.draw(); else f.drafts.beginEdit(f.da, f.da.links[0]);
    f.type('https://submitted.example/'); const result = deferred<Awaited<ReturnType<PerformOperation>>>();
    f.operation.mockImplementation(() => result.promise); const save = f.drafts.save(f.da, f.operation);
    f.type('https://later.example/'); await f.drafts.save(f.da, f.operation); expect(f.operation).toHaveBeenCalledTimes(1);
    f.change({ activeFileId: 'B', files: new Map([['A', f.published], ['B', f.b]]) });
    result.resolve({ publication: f.published } as Awaited<ReturnType<PerformOperation>>); await save;
    expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://later.example/' }); expect(f.da.draft?.kind).toBe('edit');
    expect(f.da.draft?.buffer).toBe(f.published.buffer); expect(f.da.draft?.index).toBe(kind === 'create' ? 1 : 0);
    expect(f.db.draft).toBeNull(); await f.drafts.load(f.da, async method => method === 'list_links'
      ? { links: kind === 'create' ? [link(), link(1)] : [link()] } : { destinations: [] });
    await f.drafts.save(f.da, f.operation);
    expect(f.operation.mock.calls[1][1]).toBe('set_link_target');
    expect(f.operation.mock.calls[1][2]).toMatchObject({ index: kind === 'create' ? 1 : 0, target: { url: 'https://later.example/' } });
  });
  it.each(['declined', 'null', 'error'])('%s publication retains the draft for retry', async kind => {
    const f = await fixture(); f.draw(); f.type('https://keep.example/'); const draft = f.da.draft;
    f.operation.mockImplementation(async () => { if (kind === 'error') throw Error('native refusal'); return kind === 'null' ? null : EDIT_DECLINED; });
    await f.drafts.save(f.da, f.operation); expect(f.da.draft).toBe(draft); expect(f.da.busy).toBe(false);
    expect(f.drafts.ready(f.da)).toBe(true);
  });
  it.each(['read', 'save', 'find'])('late %s completion cannot touch a closed/reopened session', async kind => {
    const f = await fixture(), answer = deferred<unknown>(); let pending: Promise<void>;
    if (kind === 'read') { f.drafts.discard(f.da); pending = f.drafts.load(f.da, () => answer.promise); }
    else if (kind === 'save') { f.draw(); f.type('https://a.example/'); pending = f.drafts.save(f.da, (() => answer.promise) as PerformOperation); }
    else pending = f.drafts.find(f.da, () => answer.promise);
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const fresh = f.drafts.get(f.a)!; await f.drafts.load(fresh, f.read); f.draw(); f.type('https://fresh.example/', fresh);
    answer.resolve({ publication: f.published, links: [], count: 2, already_linked: 0 }); await pending;
    expect(fresh.draft?.target).toEqual({ kind: 'uri', url: 'https://fresh.example/' }); expect(fresh.links).toHaveLength(1);
    expect(fresh.found).toBeNull(); expect(fresh.busy).toBe(false);
  });
  it('late picked-link read cannot replace a newer drawn/edited draft', async () => {
    const f = await fixture(); f.drafts.discard(f.da);
    f.drafts.receivePick({ path: 'A', workingPath: 'work-A', buffer: f.a.buffer!, page: 1, index: 0 });
    f.draw(); f.type('https://drawn.example/'); await f.drafts.load(f.da, f.read);
    expect(f.da.draft?.kind).toBe('create'); expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://drawn.example/' });
    f.drafts.receivePick({ path: 'A', workingPath: 'work-A', buffer: new Uint8Array([1]), page: 1, index: 0 });
    expect(f.da.draft?.kind).toBe('create');
    f.drafts.receivePick({ path: 'A', workingPath: 'work-A', buffer: f.a.buffer!, page: 1, index: 0 });
    expect(f.da.draft?.kind).toBe('edit');
  });
  it.each(['query', 'revision'])('a scan at an old %s cannot authorize Create', async kind => {
    const f = await fixture(), answer = deferred<unknown>(); const scan = f.drafts.find(f.da, () => answer.promise);
    if (kind === 'query') f.drafts.setQuery(f.da, { pages: '2' });
    else f.change({ files: new Map([['A', f.published], ['B', f.b]]) });
    answer.resolve({ count: 3, already_linked: 1 }); await scan;
    expect(f.da.found).toBeNull(); await f.drafts.derive(f.da, f.operation); expect(f.operation).not.toHaveBeenCalled();
  });
  it('a scan and Create remain owned by A while B is active', async () => {
    const f = await fixture(), answer = deferred<unknown>(); const scan = f.drafts.find(f.da, () => answer.promise);
    f.change({ activeFileId: 'B' }); answer.resolve({ count: 3, already_linked: 1 }); await scan;
    expect(f.db.found).toBeNull(); await f.drafts.derive(f.da, f.operation);
    expect(f.operation).toHaveBeenCalledWith('A', 'create_links_from_urls', { pages: 'all', emails: true, skip_existing: true },
      { expectedBuffer: f.a.buffer, expectedWorkingPath: 'work-A' });
  });
  it('Delete does not guess how to rebase another edited link index', async () => {
    const f = await fixture(); f.drafts.beginEdit(f.da, f.da.links[0]); f.type('https://keep.example/');
    await f.drafts.remove(f.da, f.da.links[0], f.operation);
    expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://keep.example/' }); expect(f.drafts.conflict(f.da)).toBe(true);
  });
  it('failed reload and typing during its await do not discard input', async () => {
    const f = await fixture(); f.draw(); f.type('https://keep.example/');
    await f.drafts.reload(f.da, async () => { throw Error('commit failed'); });
    expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://keep.example/' });
    const answer = deferred<void>(); const reload = f.drafts.reload(f.da, () => answer.promise);
    f.type('https://newer.example/'); answer.resolve(); await reload;
    expect(f.da.draft?.target).toEqual({ kind: 'uri', url: 'https://newer.example/' });
    await f.drafts.reload(f.da, async () => {}); expect(f.da.draft).toBeNull();
  });
});
