import { describe, it, expect, vi } from 'vitest';
import { createBookmarkDrafts, parseBookmarkRead, sameBookmarkTree } from '../src/renderer/lib/bookmark-drafts';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile, OpenDocument } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';
import type { OutlineNode } from '../src/renderer/lib/outline-reorder';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';
import { withFileLock } from '../src/renderer/lib/engine-lock';
import { registerFileSaveBarrier, withFileSave } from '../src/renderer/lib/file-save-barrier';

const tree = (title = 'Original', page = 2): OutlineNode[] => [{ title, page, children: [] }];
const reply = (nodes = tree()) => ({ outline: nodes, count: nodes.length, truncated: false });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', buffer: new Uint8Array([1]), pageCount: 3, name: 'A', dirty: false, undoStack: [], redoStack: [] };
  const b = { ...a, path: 'B', workingPath: 'work-B', buffer: new Uint8Array([2]) };
  let state: AppState = { ...initialState, pageDirtyPaths: [], files: new Map([['A', a], ['B', b]]), activeFileId: 'A',
    workspace: { documents: [{ ...a, id: 'doc-A', pages: [0, 1, 2].map(i => ({ id: `id-${i}`, sourceDocId: 'A', sourcePageIndex: i })) } as OpenDocument] } };
  const drafts = createBookmarkDrafts(() => state), d = drafts.get(a)!, other = drafts.get(b)!;
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; drafts.reconcile(); };
  const call = vi.fn(async () => reply()); await drafts.load(d, call); await drafts.load(other, call);
  const edit = (title: string) => drafts.change(d, d.buffer, nodes => [{ ...nodes[0], title }]);
  const operation = vi.fn<PerformOperation>(async (path) => {
    const publication = { ...state.files.get(path)!, buffer: new Uint8Array([state.files.get(path)!.buffer!.toString().length + 3]) };
    change({ files: new Map(state.files).set(path, publication) }); return { output: publication.workingPath, publication } as WorkspaceOperationResult;
  });
  const commit = vi.fn(async () => {});
  const flush = () => drafts.flush(d, operation, call, commit);
  return { a, b, drafts, d, other, call, edit, operation, commit, flush, change, state: () => state };
}

describe('bookmark replacement ownership', () => {
  it.each([false, true])('export ordering: whole queue barrier=%s (file lock alone overtakes the second gesture)', async barrier => {
    const f = await fixture(), hold = deferred<void>();
    const publish = f.operation.getMockImplementation()!;
    let disk = 'Original', copied = '', count = 0;
    f.operation.mockImplementation((...args) => withFileLock(['work-A'], async () => {
      if (++count === 1) await hold.promise;
      disk = (args[2].outline as OutlineNode[])[0].title;
      return publish(...args);
    }));
    const off = registerFileSaveBarrier(f.drafts.beforeSave);
    try {
      f.edit('First'); const run = f.flush(); await vi.waitFor(() => expect(count).toBe(1));
      f.edit('Second'); f.flush();
      const save = (barrier ? withFileSave : (source: string, dest: string, body: () => Promise<void>) => withFileLock([source, dest], body))(
        'work-A', 'export', async () => { copied = disk; });
      hold.resolve(); await Promise.all([run, save]);
      expect(disk).toBe('Second'); expect(copied).toBe(barrier ? 'Second' : 'First');
    } finally { off(); hold.resolve(); }
  });
  it.each(['throw', 'decline', 'null'])('export refuses a %s in the queue, even after it settled, until explicit retry', async mode => {
    const f = await fixture(), hold = deferred<void>(); const publish = f.operation.getMockImplementation()!;
    f.operation.mockImplementationOnce(async () => { await hold.promise;
      if (mode === 'throw') throw Error('disk refused'); return mode === 'null' ? null : EDIT_DECLINED;
    });
    f.edit('Retained'); const run = f.flush();
    const wait = f.drafts.beforeSave('work-A'); const refuses = expect(wait).rejects.toThrow();
    await expect(f.drafts.beforeSave('work-B')).resolves.toBeUndefined();
    hold.resolve(); await run; await refuses;
    await expect(f.drafts.beforeSave('work-A')).rejects.toThrow();
    f.operation.mockImplementation(publish); await f.flush();
    await expect(f.drafts.beforeSave('work-A')).resolves.toBeUndefined();
  });
  it('saving does not submit unfinished input, and a closed source cannot release a waiting export', async () => {
    const f = await fixture(); f.edit('Unfinished'); await f.drafts.beforeSave('work-A');
    expect(f.operation).not.toHaveBeenCalled();
    const hold = deferred<Awaited<ReturnType<PerformOperation>>>(); f.operation.mockImplementationOnce(() => hold.promise);
    const run = f.flush(); const refuses = expect(f.drafts.beforeSave('work-A')).rejects.toThrow();
    f.change({ files: new Map([['B', f.b]]) }); hold.resolve(null); await run; await refuses;
    await expect(f.drafts.beforeSave('work-A')).resolves.toBeUndefined();
  });
  it('a failed gesture reverted to the unchanged baseline does not poison later saves', async () => {
    const f = await fixture(); f.edit('Refused'); f.operation.mockRejectedValueOnce(Error('disk refused'));
    await f.flush(); f.edit('Original');
    expect(f.d.dirty).toBe(false); await expect(f.drafts.beforeSave('work-A')).resolves.toBeUndefined();
  });
  it('holds separate drafts, options and errors across tabs and pane unmount', async () => {
    const f = await fixture(); f.edit('A edit'); f.drafts.setMode(f.d, 'append'); f.change({ activeFileId: 'B' });
    f.drafts.change(f.other, f.b.buffer, () => tree('B edit')); f.drafts.cancelLoad(f.d);
    expect(f.drafts.get(f.a)).toBe(f.d); expect(f.d.nodes).toEqual(tree('A edit')); expect(f.other.mode).toBe('replace');
    await f.flush(); expect(f.operation.mock.calls[0][0]).toBe('A'); expect(f.other.dirty).toBe(true);
  });
  it('queues two finished gestures on exact preceding receipts and does not auto-save newer unblurred input', async () => {
    const f = await fixture(), first = deferred<Awaited<ReturnType<PerformOperation>>>();
    const publish = f.operation.getMockImplementation()!; f.operation.mockImplementationOnce(() => first.promise);
    f.edit('First'); const run = f.flush(); await vi.waitFor(() => expect(f.operation).toHaveBeenCalledTimes(1));
    f.edit('Second'); expect(f.flush()).toBe(run); f.edit('Still typing');
    const result = await publish('A', 'set_outline', {}); first.resolve(result); await run;
    expect(f.operation).toHaveBeenCalledTimes(2);
    expect(f.operation.mock.calls[1][2].outline).toEqual(tree('Second'));
    expect(f.operation.mock.calls[1][3]?.expectedBuffer).toBe(result && result !== EDIT_DECLINED ? result.publication.buffer : undefined);
    expect(f.d.nodes).toEqual(tree('Still typing')); expect(f.d.dirty).toBe(true);
  });
  it.each(['throw', 'decline'])('%s keeps the full draft and allows retry, not a destructive reload', async mode => {
    const f = await fixture(); const publish = f.operation.getMockImplementation()!; f.edit('Retained');
    f.operation.mockImplementationOnce(async () => { if (mode === 'throw') throw Error('disk refused'); return EDIT_DECLINED; });
    await f.flush(); await f.drafts.load(f.d, f.call); expect(f.d.nodes).toEqual(tree('Retained')); expect(f.d.dirty).toBe(true);
    f.operation.mockImplementation(publish); await f.flush(); expect(f.d.dirty).toBe(false);
  });
  it('returning to the original tree during a save queues the reversal instead of dropping it as clean', async () => {
    const f = await fixture(), first = deferred<Awaited<ReturnType<PerformOperation>>>();
    const publish = f.operation.getMockImplementation()!; f.operation.mockImplementationOnce(() => first.promise);
    f.edit('First'); const run = f.flush(); await vi.waitFor(() => expect(f.operation).toHaveBeenCalledOnce());
    f.edit('Original'); f.flush(); first.resolve(await publish('A', 'set_outline', {})); await run;
    expect(f.operation.mock.calls.map(c => c[2].outline)).toEqual([tree('First'), tree('Original')]);
    expect(f.d.dirty).toBe(false); expect(f.d.nodes).toEqual(tree('Original'));
  });
  it('a failed first queued save never dispatches its dependent successors', async () => {
    const f = await fixture(), failure = deferred<Awaited<ReturnType<PerformOperation>>>(); f.operation.mockImplementation(() => failure.promise);
    f.edit('First'); const run = f.flush(); await vi.waitFor(() => expect(f.operation).toHaveBeenCalledOnce());
    f.edit('Second'); f.flush(); failure.reject(Error('failed')); await run;
    expect(f.operation).toHaveBeenCalledOnce(); expect(f.d.nodes).toEqual(tree('Second')); expect(f.d.dirty).toBe(true);
  });
  it.each(['load', 'save', 'preview'])('late %s is inert after close/reopen even with reused paths', async mode => {
    const f = await fixture(), answer = deferred<unknown>(); let run: Promise<void>;
    if (mode === 'load') { f.d.loaded = false; run = f.drafts.load(f.d, () => answer.promise); }
    else if (mode === 'preview') run = f.drafts.preview(f.d, () => answer.promise, f.commit);
    else { f.edit('Old'); run = f.drafts.flush(f.d, () => answer.promise as ReturnType<PerformOperation>, f.call, f.commit); }
    await Promise.resolve(); await Promise.resolve();
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const fresh = f.drafts.get(f.a)!; await f.drafts.load(fresh, f.call); f.drafts.change(fresh, fresh.buffer, () => tree('New'));
    answer.reject(Error('old error')); await run; expect(fresh.error).toBe(''); expect(fresh.nodes).toEqual(tree('New'));
  });
  it.each(['buffer', 'pages'])('an intervening %s change cannot be blessed by an in-flight save', async kind => {
    const f = await fixture(), answer = deferred<Awaited<ReturnType<PerformOperation>>>();
    f.operation.mockImplementationOnce(() => answer.promise); f.edit('First'); const run = f.flush();
    await vi.waitFor(() => expect(f.operation).toHaveBeenCalledOnce()); f.edit('Second'); f.flush();
    const publication = { ...f.a, buffer: new Uint8Array([3]) };
    f.change({ files: new Map([['A', kind === 'buffer' ? { ...publication, buffer: new Uint8Array([4]) } : publication], ['B', f.b]]),
      pageDirtyPaths: kind === 'pages' ? ['A'] : [] });
    if (kind === 'pages') f.commit.mockImplementation(async () => { throw Error('gate failed'); });
    answer.resolve({ output: 'work-A', publication } as WorkspaceOperationResult); await run;
    expect(f.operation).toHaveBeenCalledOnce(); expect(f.d.dirty).toBe(true); expect(f.d.nodes).toEqual(tree('Second'));
  });
  for (const variant of ['faithful', 'wrong edge', 'deleted', 'duplicate', 'changed outline', 'opaque action']) {
    it(`page mapping: ${variant}`, async () => {
      const f = await fixture(); f.edit('Renamed'); f.change({ pageDirtyPaths: ['A'] });
      f.commit.mockImplementation(async () => {
        if (!f.state().pageDirtyPaths.length) return;
        const buffer = new Uint8Array([3]), pages = variant === 'deleted' ? ['id-0', 'id-2'] : variant === 'duplicate' ? ['id-1', 'id-1'] : ['id-1', 'id-2'];
        f.change({ files: new Map([['A', { ...f.a, pageCount: 2, buffer, authoredIdentity: {
          sourceBuffer: variant === 'wrong edge' ? new Uint8Array([9]) : f.a.buffer, buffer, pages, documents: [] } }], ['B', f.b]]), pageDirtyPaths: [] });
      });
      f.call.mockImplementation(async () => reply(variant === 'changed outline' ? tree('External', 1)
        : variant === 'opaque action' ? [{ ...tree('Original', 1)[0], action: { X: 'changed' } }] : tree('Original', 1)));
      await f.flush();
      if (variant === 'faithful') {
        expect(f.operation.mock.calls[0][2].outline).toEqual(tree('Renamed', 1)); expect(f.d.nodes).toEqual(tree('Renamed', 1));
      } else { expect(f.operation).not.toHaveBeenCalled(); expect(f.d.nodes).toEqual(tree('Renamed')); expect(f.d.dirty).toBe(true); expect(f.d.error).not.toBe(''); }
    });
  }
  it.each([null, {}, { outline: [] }, { outline: [], count: 1, truncated: false }, reply([{ title: 'bad', page: 9, children: [] }])])('malformed reads refuse: %j', bad => {
    expect(() => parseBookmarkRead(bad, 3)).toThrow();
  });
  it('truncated or lossy reads display but never authorize replacement', async () => {
    const f = await fixture(); f.d.loaded = false;
    await f.drafts.load(f.d, async () => ({ ...reply(), truncated: true }));
    f.edit('Not accepted'); await f.flush(); expect(f.operation).not.toHaveBeenCalled(); expect(f.d.nodes).toEqual(tree());
    expect(parseBookmarkRead(reply([{ ...tree()[0], action_lossy: true }]), 3).readOnly).toBe(true);
    expect(sameBookmarkTree(tree(), [{ ...tree()[0], action: { URI: 'different' } }])).toBe(false);
  });
  it('derived preview and mode belong to the source revision; dirty or changed sources cannot build', async () => {
    const f = await fixture(); const call = vi.fn(async () => ({ tagged: true, headings: 3, existing: 1, skipped: [] }));
    await f.drafts.preview(f.d, call, f.commit); f.drafts.setMode(f.d, 'append'); f.change({ activeFileId: 'B' });
    expect(f.other.preview).toBe(null); await f.drafts.derive(f.d, f.operation);
    expect(f.operation.mock.calls[0].slice(0, 3)).toEqual(['A', 'outline_from_structure', { mode: 'append', tag_if_untagged: false }]);
    await f.drafts.load(f.d, f.call); await f.drafts.preview(f.d, call, f.commit); f.edit('Dirty');
    await f.drafts.derive(f.d, f.operation); expect(f.operation).toHaveBeenCalledTimes(1);
  });
  it('failed reload or newer typing during reload retains the draft', async () => {
    const f = await fixture(); f.edit('Keep'); await f.drafts.reload(f.d, async () => { throw Error('failure'); });
    expect(f.d.nodes).toEqual(tree('Keep')); const gate = deferred<void>(); const run = f.drafts.reload(f.d, () => gate.promise);
    f.edit('New'); gate.resolve(); await run; expect(f.d.nodes).toEqual(tree('New'));
  });
  it.each(['pending', 'buffer'])('a %s change after preview refuses visibly instead of building from stale evidence', async kind => {
    const f = await fixture();
    await f.drafts.preview(f.d, async () => ({ tagged: true, headings: 3, existing: 1, skipped: [] }), f.commit);
    if (kind === 'pending') f.change({ pageDirtyPaths: ['A'] });
    else f.change({ files: new Map([['A', { ...f.a, buffer: new Uint8Array([5]) }], ['B', f.b]]) });
    await f.drafts.derive(f.d, f.operation); expect(f.operation).not.toHaveBeenCalled(); expect(f.d.error).not.toBe('');
  });
});
