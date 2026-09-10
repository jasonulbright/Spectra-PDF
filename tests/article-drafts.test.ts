import { describe, expect, it, vi } from 'vitest';
import { createArticleDrafts } from '../src/renderer/lib/article-drafts';
import { emptyArticle } from '../src/renderer/lib/article-beads';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', buffer: new Uint8Array([1]), name: 'A',
    pageCount: 2, dirty: false, undoStack: [], redoStack: [] };
  const b: OpenFile = { ...a, path: 'B', workingPath: 'work-B', buffer: new Uint8Array([2]) };
  let state: AppState = { ...initialState, files: new Map([['A', a], ['B', b]]), activeFileId: 'A' };
  const drafts = createArticleDrafts(() => state);
  const da = drafts.get(a)!; const db = drafts.get(b)!;
  const list = vi.fn(async () => ({ threads: [] }));
  await drafts.load(da, list); await drafts.load(db, list);
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; drafts.reconcile(); };
  const authored = (title: string) => ({ ...emptyArticle(title), beads: [{ page: 1, rect: [0, 0, 10, 10] as [number, number, number, number] }] });
  const published = { ...a, buffer: new Uint8Array([3]), dirty: true };
  const operation = vi.fn<PerformOperation>(async () => ({ publication: published } as Awaited<ReturnType<PerformOperation>>));
  return { a, b, da, db, drafts, list, change, authored, operation, published, state: () => state };
}

describe('article draft session and revision ownership', () => {
  it('selection remains on a real article/bead after removing the selected last row', async () => {
    const f = await fixture(); f.drafts.change(f.da, () => [f.authored('One'), f.authored('Two')]);
    f.drafts.select(f.da, 1, 0); f.drafts.change(f.da, rows => rows.slice(0, 1));
    expect(f.da.selected).toBe(0); expect(f.da.bead).toBe(0);
    f.drafts.change(f.da, () => []); expect(f.da.selected).toBe(0);
  });
  it('A to B to A preserves independent lists, selections and dirty state', async () => {
    const f = await fixture(); f.drafts.change(f.da, () => [f.authored('Only A')]);
    f.change({ activeFileId: 'B' }); f.drafts.change(f.db, () => [f.authored('Only B'), f.authored('Second B')]);
    f.drafts.select(f.db, 1, 0); f.change({ activeFileId: 'A' });
    expect(f.drafts.get(f.a)).toBe(f.da); expect(f.da.articles[0].title).toBe('Only A');
    expect(f.db.selected).toBe(1); expect(f.da.dirty && f.db.dirty).toBe(true);
    await f.drafts.save(f.da, f.operation);
    expect(f.operation).toHaveBeenCalledWith('A', 'set_threads', { threads: [f.authored('Only A')] },
      { expectedWorkingPath: 'work-A', expectedBuffer: f.a.buffer });
    expect(f.db.dirty).toBe(true);
  });
  it('an untouched B cannot publish A, even with programmatic Save', async () => {
    const f = await fixture(); f.drafts.change(f.da, () => [f.authored('A')]);
    await f.drafts.save(f.db, f.operation); expect(f.operation).not.toHaveBeenCalled();
  });
  it('late read cannot overwrite a new read or new input after cancel/remount', async () => {
    const f = await fixture(); f.drafts.reset(f.da); const d = f.drafts.get(f.a)!;
    const old = deferred<unknown>(); const pending = f.drafts.load(d, () => old.promise);
    f.drafts.cancelLoad(d); await f.drafts.load(d, f.list);
    f.drafts.change(d, () => [f.authored('New input')]);
    old.resolve({ threads: [f.authored('Old read')] }); await pending;
    expect(d.articles[0].title).toBe('New input'); expect(d.dirty).toBe(true);
  });
  it('stale read errors cannot overwrite the replacement draft status', async () => {
    const f = await fixture(); f.drafts.reset(f.da); const d = f.drafts.get(f.a)!;
    const old = deferred<unknown>(); const pending = f.drafts.load(d, () => old.promise);
    f.drafts.cancelLoad(d); await f.drafts.load(d, f.list);
    old.reject(new Error('old read')); await pending; expect(d.error).toBe('');
  });
  it.each([null, {}, { threads: null }, { threads: [null] }, { threads: [{ title: 'partial' }] }])(
    'failed read is not an editable empty document: %j', async answer => {
      const f = await fixture(); f.drafts.reset(f.da); const d = f.drafts.get(f.a)!;
      await f.drafts.load(d, async () => answer);
      expect(d.loaded).toBe(false); expect(d.error).not.toBe('');
      f.drafts.change(d, () => [f.authored('Overwrite')]); expect(d.dirty).toBe(false);
      await f.drafts.save(d, f.operation); expect(f.operation).not.toHaveBeenCalled();
      f.drafts.reset(d); const retry = f.drafts.get(f.a)!; await f.drafts.load(retry, f.list);
      expect(f.drafts.editable(retry)).toBe(true);
    });
  it.each(['pending pages', 'new buffer'])('%s fences stale addresses without discarding input', async mode => {
    const f = await fixture(); f.drafts.change(f.da, () => [f.authored('Keep')]);
    if (mode === 'pending pages') f.change({ pageDirtyPaths: ['A'] });
    else f.change({ files: new Map([['A', f.published], ['B', f.b]]) });
    expect(f.drafts.editable(f.da)).toBe(false);
    await f.drafts.load(f.da, f.list); await f.drafts.save(f.da, f.operation);
    f.drafts.change(f.da, () => []);
    expect(f.da.articles[0].title).toBe('Keep'); expect(f.da.dirty).toBe(true);
    expect(f.operation).not.toHaveBeenCalled(); expect(f.list).toHaveBeenCalledTimes(2);
  });
  it('an unrelated document page edit does not invalidate the draft', async () => {
    const f = await fixture(); f.drafts.change(f.da, () => [f.authored('Keep')]); f.change({ pageDirtyPaths: ['B'] });
    expect(f.drafts.editable(f.da)).toBe(true); await f.drafts.save(f.da, f.operation);
    expect(f.operation).toHaveBeenCalledTimes(1);
  });
  it('dirty draft survives hiding/remounting; closing retires even a reused working path', async () => {
    const f = await fixture(); f.drafts.change(f.da, () => [f.authored('Keep')]); f.drafts.cancelLoad(f.da);
    expect(f.drafts.get(f.a)).toBe(f.da);
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const reopened = f.drafts.get(f.a)!;
    expect(reopened).not.toBe(f.da); expect(reopened.articles).toEqual([]);
    await f.drafts.save(f.da, f.operation); expect(f.operation).not.toHaveBeenCalled();
  });
  it('newer edits remain dirty and advance to the exact saved revision', async () => {
    const f = await fixture(); const reply = deferred<Awaited<ReturnType<PerformOperation>>>();
    f.drafts.change(f.da, () => [f.authored('Submitted')]); f.operation.mockImplementation(() => reply.promise);
    const save = f.drafts.save(f.da, f.operation);
    f.drafts.change(f.da, () => [f.authored('Later')]);
    f.change({ activeFileId: 'B', files: new Map([['A', f.published], ['B', f.b]]) });
    reply.resolve({ publication: f.published } as Awaited<ReturnType<PerformOperation>>); await save;
    expect(f.da.articles[0].title).toBe('Later'); expect(f.da.dirty).toBe(true);
    expect(f.da.buffer).toBe(f.published.buffer); expect(f.drafts.editable(f.da)).toBe(true);
    expect(f.db.articles).toEqual([]); expect(f.db.busy).toBe(false);
    expect((f.operation.mock.calls[0][2].threads as { title: string }[])[0].title).toBe('Submitted');
  });
  it('busy is per draft and prevents duplicate Save/reset', async () => {
    const f = await fixture(); const reply = deferred<Awaited<ReturnType<PerformOperation>>>();
    f.operation.mockImplementation(() => reply.promise); f.drafts.change(f.da, () => [f.authored('A')]);
    const save = f.drafts.save(f.da, f.operation); await f.drafts.save(f.da, f.operation); f.drafts.reset(f.da);
    expect(f.drafts.get(f.a)).toBe(f.da); expect(f.operation).toHaveBeenCalledTimes(1);
    expect(f.db.busy).toBe(false); reply.resolve(EDIT_DECLINED); await save;
    expect(f.da.busy).toBe(false); expect(f.da.dirty).toBe(true);
  });
  it.each(['save', 'read'])('late %s cannot update a closed and reopened entry', async kind => {
    const f = await fixture(); const reply = deferred<unknown>();
    let pending: Promise<void>;
    if (kind === 'save') {
      f.drafts.change(f.da, () => [f.authored('A')]);
      pending = f.drafts.save(f.da, (() => reply.promise) as PerformOperation);
    } else { f.da.loaded = false; pending = f.drafts.load(f.da, () => reply.promise); }
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const fresh = f.drafts.get(f.a)!; await f.drafts.load(fresh, f.list);
    reply.resolve(kind === 'save' ? { publication: f.published } : { threads: [f.authored('Late')] }); await pending;
    expect(fresh.articles).toEqual([]); expect(fresh.buffer).toBe(f.a.buffer); expect(fresh.busy).toBe(false);
  });
  it.each(['path', 'session', 'revision', 'pending'])('a stale %s drawn bead is rejected', async kind => {
    const f = await fixture();
    const bead = { page: 1, rect: [0, 0, 10, 10] as [number, number, number, number], path: f.a.path,
      workingPath: f.a.workingPath, buffer: f.a.buffer! };
    if (kind === 'path') bead.path = 'B';
    if (kind === 'session') bead.workingPath = 'old-A';
    if (kind === 'revision') bead.buffer = new Uint8Array([1]);
    if (kind === 'pending') f.change({ pageDirtyPaths: ['A'] });
    f.drafts.append(f.da, bead, () => f.authored('A')); expect(f.da.articles).toEqual([]);
  });
  it('a current drawn bead appends once to its owning article', async () => {
    const f = await fixture(); f.drafts.append(f.da, { page: 1, rect: [0, 0, 10, 10], path: 'A',
      workingPath: 'work-A', buffer: f.a.buffer! }, () => emptyArticle('A'));
    expect(f.da.articles[0].beads).toHaveLength(1); expect(f.da.dirty).toBe(true);
  });
});
