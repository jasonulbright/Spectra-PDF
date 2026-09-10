import { describe, expect, it, vi } from 'vitest';
import { createDocumentJsDrafts, parseDocumentJsRead, type DocScript } from '../src/renderer/lib/document-js-drafts';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';
const rows = (js = 'Original'): DocScript[] => [{ name: 'Script', js }];
const reply = (scripts = rows()) => ({ scripts, count: scripts.length, complete: true });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', buffer: new Uint8Array([1]), pageCount: 1, name: 'A', dirty: false, undoStack: [], redoStack: [] };
  const b = { ...a, path: 'B', workingPath: 'work-B', buffer: new Uint8Array([2]) };
  let state: AppState = { ...initialState, pageDirtyPaths: [], files: new Map([['A', a], ['B', b]]), activeFileId: 'A' };
  const drafts = createDocumentJsDrafts(() => state), d = drafts.get(a)!, other = drafts.get(b)!;
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; drafts.reconcile(); };
  const call = vi.fn(async () => reply()); await drafts.load(d, call); await drafts.load(other, call);
  const edit = (js: string) => drafts.change(d, d.buffer, () => rows(js));
  const operation = vi.fn<PerformOperation>(async path => {
    const publication = { ...state.files.get(path)!, buffer: new Uint8Array([8]) };
    change({ files: new Map(state.files).set(path, publication) });
    return { output: publication.workingPath, publication } as WorkspaceOperationResult;
  });
  return { a, b, d, other, drafts, call, edit, operation, change, state: () => state,
    save: () => drafts.save(d, operation) };
}
describe('document JavaScript draft ownership', () => {
  it('retains independent text, selection and owner across A-B-A and pane remount', async () => {
    const f = await fixture(); f.drafts.change(f.d, f.a.buffer, () => [...rows('A draft'), { name: 'Second', js: '' }]);
    f.drafts.select(f.d, 1); f.change({ activeFileId: 'B' }); f.drafts.change(f.other, f.b.buffer, () => rows('B draft'));
    f.drafts.cancelLoad(f.d); f.change({ activeFileId: 'A' }); await f.drafts.load(f.d, f.call);
    expect(f.drafts.get(f.a)).toBe(f.d); expect(f.d.selected).toBe(1); expect(f.d.scripts[0].js).toBe('A draft');
    await f.save(); expect(f.operation.mock.calls[0][0]).toBe('A'); expect(f.other.scripts).toEqual(rows('B draft'));
    expect(f.operation.mock.calls[0][3]).toEqual({ expectedWorkingPath: 'work-A', expectedBuffer: f.a.buffer });
  });
  it.each(['Newer', 'Original'])('new typing during Save survives even when reverting: %s', async text => {
    const f = await fixture(), pending = deferred<Awaited<ReturnType<PerformOperation>>>(), publish = f.operation.getMockImplementation()!;
    f.operation.mockImplementationOnce(() => pending.promise); f.edit('Submitted'); const run = f.save();
    f.edit(text); await f.save(); pending.resolve(await publish('A', 'set_document_js', {})); await run;
    expect(f.d.scripts).toEqual(rows(text)); expect(f.d.baseline).toEqual(rows('Submitted')); expect(f.d.dirty).toBe(true);
    expect(f.operation).toHaveBeenCalledTimes(1); await f.save(); expect(f.d.dirty).toBe(false);
  });
  it.each([EDIT_DECLINED, null, 'error'] as const)('keeps refused input and permits retry: %s', async mode => {
    const f = await fixture(); f.edit('Kept');
    if (mode === 'error') f.operation.mockRejectedValueOnce(new Error('fault')); else f.operation.mockResolvedValueOnce(mode);
    await f.save(); expect(f.d.scripts).toEqual(rows('Kept')); expect(f.d.dirty).toBe(true); expect(f.d.busy).toBe(false);
    await f.save(); expect(f.d.dirty).toBe(false);
  });
  it.each(['buffer', 'pending pages'])('retains and refuses a source changed by %s', async mode => {
    const f = await fixture(); f.edit('Kept');
    if (mode === 'buffer') f.change({ files: new Map(f.state().files).set('A', { ...f.a, buffer: new Uint8Array([4]) }) });
    else f.change({ pageDirtyPaths: ['A'] });
    await f.save(); await f.drafts.load(f.d, f.call); expect(f.operation).not.toHaveBeenCalled();
    expect(f.d.scripts).toEqual(rows('Kept')); expect(f.drafts.conflict(f.d)).toBe(true);
  });
  it('an exact receipt cannot authorize a later foreign revision', async () => {
    const f = await fixture(), publish = f.operation.getMockImplementation()!; f.edit('Submitted');
    f.operation.mockImplementationOnce(async (...args) => { f.edit('Newer'); const result = await publish(...args);
      f.change({ files: new Map(f.state().files).set('A', { ...f.a, buffer: new Uint8Array([9]) }) }); return result; });
    await f.save(); await f.save(); expect(f.operation).toHaveBeenCalledTimes(1); expect(f.drafts.conflict(f.d)).toBe(true);
  });
  it.each(['read', 'save', 'error'])('closed/reopened reused paths fence late %s', async mode => {
    const f = await fixture(), pending = deferred<unknown>();
    let run: Promise<void>;
    if (mode === 'read') { f.d.loaded = false; run = f.drafts.load(f.d, () => pending.promise); }
    else { f.operation.mockImplementation(() => pending.promise as ReturnType<PerformOperation>); f.edit('Old'); run = f.save(); }
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const reopened = f.drafts.get(f.a)!; await f.drafts.load(reopened, f.call);
    if (mode === 'error') pending.reject(new Error('late')); else pending.resolve(mode === 'read' ? reply(rows('late')) : { publication: f.a });
    await run; expect(reopened.scripts).toEqual(rows()); expect(reopened.error).toBe(''); expect(reopened).not.toBe(f.d);
  });
  it('late cancelled reads cannot replace a newer load or another document', async () => {
    const f = await fixture(), pending = deferred<unknown>(); f.d.loaded = false;
    const old = f.drafts.load(f.d, () => pending.promise); f.drafts.cancelLoad(f.d);
    await f.drafts.load(f.d, async () => reply(rows('Fresh'))); f.edit('Newer');
    pending.resolve(reply(rows('Old'))); await old; expect(f.d.scripts).toEqual(rows('Newer')); expect(f.other.scripts).toEqual(rows());
  });
  it('reload is explicit, gated, and cannot discard typing during its await', async () => {
    const f = await fixture(), gate = deferred<void>(); f.edit('First'); const run = f.drafts.reload(f.d, () => gate.promise);
    f.edit('Newer'); gate.resolve(); await run; expect(f.d.scripts).toEqual(rows('Newer'));
    await f.drafts.reload(f.d, async () => { throw new Error('gate'); }); expect(f.d.scripts).toEqual(rows('Newer'));
    await f.drafts.reload(f.d, async () => {}); await f.drafts.load(f.d, f.call); expect(f.d.dirty).toBe(false); expect(f.d.scripts).toEqual(rows());
  });
  it('whitespace in an existing name is identity, not permission to rename it', async () => {
    const f = await fixture(); f.drafts.change(f.d, f.a.buffer, () => [{ name: ' Script ', js: 'Edited' }]); await f.save();
    expect(f.operation.mock.calls[0][2].scripts).toEqual([{ name: ' Script ', js: 'Edited' }]); expect(f.d.dirty).toBe(false);
  });
  it.each([{ value: [{ name: '', js: '' }] }, { value: [{ name: 'x', js: '' }, { name: 'x', js: 'a' }] }])('refuses invalid names before publication', async ({ value }) => {
    const f = await fixture(); f.drafts.change(f.d, f.a.buffer, () => value); await f.save();
    expect(f.operation).not.toHaveBeenCalled(); expect(f.d.error).not.toBe(''); expect(f.d.dirty).toBe(true);
  });
  it('clamps selection when a selected script is deleted', async () => {
    const f = await fixture(); f.drafts.change(f.d, f.a.buffer, () => [...rows(), { name: 'Second', js: '' }]); f.drafts.select(f.d, 1);
    f.drafts.change(f.d, f.a.buffer, prev => prev.slice(0, 1)); expect(f.d.selected).toBe(0);
  });
  it.each([null, {}, { scripts: [] }, { complete: false, scripts: [], count: 0 },
    { complete: true, scripts: [], count: 1 }, reply([{ name: 3, js: '' }] as unknown as DocScript[]),
    reply([{ name: 'x', js: null }] as unknown as DocScript[]), reply([{ name: 'x', js: '' }, { name: 'x', js: '' }])])('incomplete/malformed reply cannot seed replacement: %j', value => {
    expect(() => parseDocumentJsRead(value)).toThrow();
  });
  it('a failed strict read leaves editing disabled, complete empty remains valid', async () => {
    const f = await fixture(); f.d.loaded = false; f.d.buffer = null;
    await f.drafts.load(f.d, async () => ({ complete: false, scripts: [], count: 0 })); expect(f.drafts.editable(f.d)).toBe(false);
    expect(parseDocumentJsRead(reply([]))).toEqual([]); expect(f.d.error).not.toBe('');
  });
});
