import { describe, expect, it, vi } from 'vitest';
import { createPageLabelDrafts, parseLabelRead, previewLabel, compactLabelSpecs, expandLabelRanges, type LabelRange } from '../src/renderer/lib/page-label-drafts';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile, OpenDocument } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';

const rows = (prefix = 'Original'): LabelRange[] => [{ start: 1, style: 'D', prefix, startAt: 5 }];
const reply = (ranges = rows(), total = 3) => ({ complete: true, count: ranges.length,
  ranges: ranges.map(r => ({ start: r.start - 1, style: r.style, prefix: r.prefix, start_at: r.startAt })),
  labels: Array.from({ length: total }, (_, i) => previewLabel(ranges, i + 1)) });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', buffer: new Uint8Array([1]), pageCount: 3, name: 'A', dirty: false, undoStack: [], redoStack: [] };
  const b = { ...a, path: 'B', workingPath: 'work-B', buffer: new Uint8Array([2]) };
  let state: AppState = { ...initialState, pageDirtyPaths: [], files: new Map([['A', a], ['B', b]]), activeFileId: 'A',
    workspace: { documents: [{ ...a, id: 'doc-A', pages: [0, 1, 2].map(i => ({ id: `id-${i}`, sourceDocId: 'A', sourcePageIndex: i })) } as OpenDocument] } };
  const drafts = createPageLabelDrafts(() => state), d = drafts.get(a)!, other = drafts.get(b)!;
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; drafts.reconcile(); };
  const call = vi.fn(async () => reply()); await drafts.load(d, call); await drafts.load(other, call);
  const edit = (prefix: string) => drafts.change(d, d.buffer, () => rows(prefix));
  const operation = vi.fn<PerformOperation>(async path => {
    const publication = { ...state.files.get(path)!, buffer: new Uint8Array([8]) };
    change({ files: new Map(state.files).set(path, publication) });
    return { output: publication.workingPath, publication } as WorkspaceOperationResult;
  });
  const commit = vi.fn(async () => {});
  const apply = () => drafts.apply(d, operation, call, commit);
  const edge = (ids: string[], sourceBuffer = a.buffer) => {
    const buffer = new Uint8Array([5]);
    change({ files: new Map(state.files).set('A', { ...a, buffer, pageCount: ids.length,
      authoredIdentity: { sourceBuffer, buffer, pages: ids, documents: [] } }), pageDirtyPaths: [] });
  };
  return { a, b, d, other, drafts, call, operation, commit, apply, edge, edit, change, state: () => state };
}

describe('page label sessions and publication', () => {
  it('keeps independent unapplied drafts across A-B-A and remount', async () => {
    const f = await fixture(); f.edit('A draft'); f.change({ activeFileId: 'B' });
    f.drafts.change(f.other, f.b.buffer, () => rows('B draft')); f.drafts.cancelLoad(f.d); f.change({ activeFileId: 'A' });
    expect(f.drafts.get(f.a)).toBe(f.d); await f.drafts.load(f.d, f.call); expect(f.d.ranges).toEqual(rows('A draft'));
    await f.apply(); expect(f.operation.mock.calls[0][0]).toBe('A'); expect(f.other.ranges).toEqual(rows('B draft'));
    expect(f.operation.mock.calls[0][3]).toEqual({ expectedWorkingPath: 'work-A', expectedBuffer: f.a.buffer });
  });
  it.each(['new input', 'return to original'])('retires only submitted input: %s during Apply', async variant => {
    const f = await fixture(), pending = deferred<Awaited<ReturnType<PerformOperation>>>();
    const publish = f.operation.getMockImplementation()!; f.operation.mockImplementationOnce(() => pending.promise);
    f.edit('Submitted'); const run = f.apply(); await vi.waitFor(() => expect(f.operation).toHaveBeenCalledTimes(1));
    f.edit(variant === 'new input' ? 'Newer' : 'Original'); await f.apply();
    pending.resolve(await publish('A', 'set_page_labels', {})); await run;
    expect(f.d.dirty).toBe(true); expect(f.d.baseline).toEqual(rows('Submitted'));
    expect(f.d.ranges).toEqual(rows(variant === 'new input' ? 'Newer' : 'Original')); expect(f.operation).toHaveBeenCalledTimes(1);
    await f.apply(); expect(f.d.dirty).toBe(false); expect(f.operation).toHaveBeenCalledTimes(2);
  });
  it.each([EDIT_DECLINED, null, 'failure'] as const)('keeps a declined/failed draft for explicit retry: %s', async result => {
    const f = await fixture(); f.edit('Kept');
    if (result === 'failure') f.operation.mockRejectedValueOnce(new Error('fault'));
    else f.operation.mockResolvedValueOnce(result);
    await f.apply(); expect(f.d.ranges).toEqual(rows('Kept')); expect(f.d.dirty).toBe(true); expect(f.d.busy).toBe(false);
    await f.apply(); expect(f.d.dirty).toBe(false);
  });
  it('maps each surviving page value, not only a range start, across deletion/reorder', async () => {
    const f = await fixture(); f.edit('Edited'); f.change({ pageDirtyPaths: ['A'] });
    f.commit.mockImplementation(async () => f.edge(['id-2', 'id-0']));
    f.call.mockImplementation(async () => reply([{ ...rows()[0], startAt: 7 }, { ...rows()[0], start: 2 }], 2));
    await f.apply(); expect(f.d.error).toBe('');
    expect(f.operation.mock.calls[0][2].ranges).toEqual([
      { start: 0, style: 'D', prefix: 'Edited', start_at: 7 }, { start: 1, style: 'D', prefix: 'Edited', start_at: 5 }]);
  });
  it('rotation control accepts an identity-preserving authored edge', async () => {
    const f = await fixture(); f.edit('Rotated'); f.commit.mockImplementation(async () => f.edge(['id-0', 'id-1', 'id-2']));
    await f.apply(); expect(f.operation).toHaveBeenCalledTimes(1); expect(f.d.dirty).toBe(false);
  });
  it('explicit removal remains removal after a page commit', async () => {
    const f = await fixture(); f.drafts.change(f.d, f.d.buffer, () => []);
    f.commit.mockImplementation(async () => f.edge(['id-1', 'id-2']));
    f.call.mockImplementation(async () => reply([{ ...rows()[0], startAt: 6 }], 2));
    await f.apply(); expect(f.operation.mock.calls[0][2].ranges).toEqual([]);
  });
  it.each(['wrong edge', 'donor', 'duplicate', 'changed labels', 'incomplete read', 'new dirty pages'])('retains stale input on %s', async variant => {
    const f = await fixture(); f.edit('Kept');
    f.commit.mockImplementation(async () => f.edge(variant === 'donor' ? ['id-1', 'new-id'] : variant === 'duplicate' ? ['id-1', 'id-1'] : ['id-1', 'id-2'],
      variant === 'wrong edge' ? new Uint8Array([9]) : f.a.buffer));
    f.call.mockImplementation(async () => {
      if (variant === 'new dirty pages') f.change({ pageDirtyPaths: ['A'] });
      return { ...reply([{ ...rows(variant === 'changed labels' ? 'External' : 'Original')[0], startAt: 6 }], 2), complete: variant !== 'incomplete read' };
    });
    await f.apply(); expect(f.operation).not.toHaveBeenCalled(); expect(f.d.ranges).toEqual(rows('Kept'));
    expect(f.d.error).not.toBe(''); expect(f.drafts.conflict(f.d)).toBe(true);
  });
  it('a second foreign revision after publication cannot license another Apply', async () => {
    const f = await fixture(); f.edit('Submitted'); const publish = f.operation.getMockImplementation()!;
    f.operation.mockImplementationOnce(async (...args) => { f.edit('Retained'); const r = await publish(...args);
      f.change({ files: new Map(f.state().files).set('A', { ...f.a, buffer: new Uint8Array([77]) }) }); return r; });
    await f.apply(); await f.apply(); expect(f.operation).toHaveBeenCalledTimes(1); expect(f.drafts.conflict(f.d)).toBe(true);
  });
  it.each(['success', 'error'])('closed/reopened reused paths fence late Apply %s', async mode => {
    const f = await fixture(), wait = deferred<Awaited<ReturnType<PerformOperation>>>();
    f.operation.mockImplementation(() => wait.promise); f.edit('Old'); const run = f.apply();
    await vi.waitFor(() => expect(f.operation).toHaveBeenCalled());
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const reopened = f.drafts.get(f.a)!; await f.drafts.load(reopened, f.call);
    if (mode === 'error') wait.reject(new Error('old error')); else wait.resolve({ publication: f.a } as WorkspaceOperationResult);
    await run; expect(reopened).not.toBe(f.d); expect(reopened.ranges).toEqual(rows()); expect(reopened.error).toBe('');
  });
  it('reload does not discard input typed while its commit awaits', async () => {
    const f = await fixture(), wait = deferred<void>(); f.edit('Old'); const run = f.drafts.reload(f.d, () => wait.promise);
    f.edit('New'); wait.resolve(); await run; expect(f.d.ranges).toEqual(rows('New')); expect(f.d.dirty).toBe(true);
  });
  it('failed reload retains the whole draft; explicit successful reload retires it', async () => {
    const f = await fixture(); f.edit('Kept'); await f.drafts.reload(f.d, async () => { throw new Error('gate failed'); });
    expect(f.d.ranges).toEqual(rows('Kept')); await f.drafts.reload(f.d, f.commit); await f.drafts.load(f.d, f.call);
    expect(f.d.ranges).toEqual(rows()); expect(f.d.dirty).toBe(false);
  });
  it('an old read cannot populate a newly opened session with the same paths', async () => {
    const f = await fixture(), wait = deferred<ReturnType<typeof reply>>(); await f.drafts.reload(f.d, f.commit);
    const run = f.drafts.load(f.d, () => wait.promise); f.change({ files: new Map() });
    f.change({ files: new Map([['A', f.a]]) }); const reopened = f.drafts.get(f.a)!; await f.drafts.load(reopened, f.call);
    wait.resolve(reply(rows('Obsolete'))); await run; expect(reopened.ranges).toEqual(rows());
  });
  it.each([NaN, Infinity, 0, 1.5])('invalid starting number %s cannot reach publication or hang preview', async startAt => {
    const f = await fixture(); f.drafts.change(f.d, f.d.buffer, () => [{ ...rows()[0], startAt }]);
    await f.apply(); expect(f.operation).not.toHaveBeenCalled(); expect(f.d.error).not.toBe('');
    expect(previewLabel(f.d.ranges, 1)).toBe('—');
  });
  it('oversized Roman/alphabetic previews refuse before allocating', () => {
    for (const style of ['A', 'a', 'R', 'r']) expect(previewLabel([{ ...rows()[0], style, startAt: 2147483647 }], 1)).toBe('—');
  });
});

describe('complete page-label reads', () => {
  it.each([null, {}, { ...reply(), complete: false }, { ...reply(), count: 0 }, { ...reply(), labels: [] },
    { ...reply(), ranges: [{ ...reply().ranges[0], start: '0' }] }, { ...reply(), ranges: [{ ...reply().ranges[0], prefix: null }] },
    { ...reply(), ranges: [{ ...reply().ranges[0], start_at: 0 }] }, { ...reply(), ranges: [{ ...reply().ranges[0], start: 1 }] },
    { ...reply(), count: 2, ranges: [reply().ranges[0], reply().ranges[0]] }])('refuses incomplete/malformed replacement seed %#', async bad => {
    expect(() => parseLabelRead(bad, 3)).toThrow(); const f = await fixture(); await f.drafts.reload(f.d, f.commit);
    await f.drafts.load(f.d, async () => bad); expect(f.d.loaded).toBe(false); expect(f.d.error).not.toBe('');
    f.edit('New'); await f.apply(); expect(f.operation).not.toHaveBeenCalled();
  });
  it('accepts empty complete reads and preserves all style/value semantics when regrouped', () => {
    expect(parseLabelRead(reply([], 3), 3)).toEqual([]);
    for (const style of ['D', 'R', 'r', 'A', 'a', 'none']) {
      const expanded = expandLabelRanges([{ ...rows()[0], style }], 3);
      expect(expandLabelRanges(compactLabelSpecs(expanded), 3)).toEqual(expanded);
    }
  });
});
