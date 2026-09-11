import { describe, expect, it, vi } from 'vitest';
import { createPropertiesDrafts, propertyDirty, parsePropertyMetadata } from '../src/renderer/lib/properties-drafts';
import { DEFAULT_INITIAL_VIEW } from '../src/renderer/lib/initial-view';
import { DEFAULT_ADVANCED } from '../src/renderer/lib/doc-advanced';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';
import type { EngineCall } from '../src/renderer/lib/engine-call';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const view = () => ({ ...DEFAULT_INITIAL_VIEW, pages: 2 });
const advanced = () => ({ ...DEFAULT_ADVANCED, version: '1.7', pages: 2, bytes: 50,
  page_sizes: [{ width: 300, height: 400, count: 2 }] });
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', name: 'A.pdf', buffer: new Uint8Array([1]),
    pageCount: 2, dirty: false, undoStack: [], redoStack: [] };
  const b = { ...a, path: 'B', workingPath: 'work-B', name: 'B.pdf', buffer: new Uint8Array([2]) };
  let state: AppState = { ...initialState, activeFileId: 'A', files: new Map([['A', a], ['B', b]]), pageDirtyPaths: [] };
  const sameFile = vi.fn(async (a: string, b: string) => a === b);
  const drafts = createPropertiesDrafts(() => state, sameFile), d = drafts.get(a)!, other = drafts.get(b)!;
  let engineView = view(), engineAdvanced = advanced();
  const call = vi.fn<EngineCall>(async (method, _params, options) => {
    options?.assertCurrent?.();
    if (method === 'get_initial_view') return engineView;
    if (method === 'get_advanced_properties') return engineAdvanced;
    if (method === 'get_metadata') return { title: 'Original', author: '', subject: '', keywords: '' };
    return { output: _params?.output };
  });
  const commit = vi.fn(async () => {});
  const changeState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
  const publish = () => {
    const publication = { ...state.files.get('A')!, buffer: new Uint8Array([8]) };
    changeState({ files: new Map(state.files).set('A', publication) });
    return { publication, output: publication.workingPath } as WorkspaceOperationResult;
  };
  const operation = vi.fn<PerformOperation>(async (_path, method, params) => {
    if (method === 'set_initial_view') engineView = { ...engineView, ...params };
    else engineAdvanced = { ...engineAdvanced, ...params };
    return publish();
  });
  await drafts.load(d, call, commit); await drafts.load(other, call, commit);
  const editView = (page_mode: typeof engineView.page_mode) => drafts.change(d, d.view, { ...d.view.draft, page_mode });
  const editAdvanced = (base_url: string) => drafts.change(d, d.advanced, { ...d.advanced.draft, base_url });
  return { a, b, drafts, d, other, call, commit, operation, publish, editView, editAdvanced, changeState, sameFile, state: () => state };
}

describe('Properties draft ownership', () => {
  it('displays an ordered author sequence without submitting it on a title edit', async () => {
    const f = await fixture(); f.drafts.reload(f.d);
    f.call.mockImplementationOnce(async () => ({ title: 'Original', author: ['A', 'B'], subject: '', keywords: '' }));
    await f.drafts.load(f.d, f.call, f.commit);
    expect(f.d.metadata.draft.author).toBe('A; B');
    f.drafts.change(f.d, f.d.metadata, { ...f.d.metadata.draft, title: 'Changed' });
    f.call.mockClear(); await f.drafts.exportMetadata(f.d, false, async () => 'copy.pdf', f.call);
    expect(f.call.mock.calls[0][1]).toEqual({ file: 'work-A', output: 'copy.pdf', title: 'Changed' });
    expect(() => parsePropertyMetadata({ title: '', author: ['A', 7], subject: '', keywords: '' })).toThrow();
  });
  it.each([{}, null, { output: 'wrong.pdf' }])('does not call an incomplete export reply saved: %s', async reply => {
    const f = await fixture(); f.call.mockResolvedValueOnce(reply);
    await f.drafts.exportMetadata(f.d, false, async () => 'copy.pdf', f.call);
    expect(f.d.status).not.toBe('Saved.'); expect(f.d.status).toMatch(/unknown/i);
  });
  it.each(['A', 'work-A', 'B', 'work-B'])('refuses copy export onto an open path or its alias: %s', async target => {
    const f = await fixture(); f.call.mockClear();
    f.sameFile.mockImplementation(async (a, b) => a === 'alias.pdf' && b === target);
    await f.drafts.exportMetadata(f.d, false, async () => 'alias.pdf', f.call);
    expect(f.call).not.toHaveBeenCalled(); expect(f.d.status).toMatch(/different file/);
  });
  it('does not create edit baselines from failed or partial reads', async () => {
    const f = await fixture(); f.drafts.reload(f.d);
    f.call.mockImplementation(async method => method === 'get_metadata'
      ? { title: '', author: '', subject: '', keywords: '' } : {});
    await f.drafts.load(f.d, f.call, f.commit);
    expect(f.d.view.baseline).toBeNull(); expect(f.d.advanced.baseline).toBeNull();
    expect(f.d.view.error).not.toBe(''); expect(f.d.advanced.error).not.toBe('');
    await f.drafts.apply(f.d, 'view', f.operation, f.call); expect(f.operation).not.toHaveBeenCalled();
  });
  it('retains independent input across A-B-A', async () => {
    const f = await fixture(); f.editView('thumbnails'); f.changeState({ activeFileId: 'B' });
    f.drafts.change(f.other, f.other.metadata, { ...f.other.metadata.draft, title: 'B draft' });
    f.changeState({ activeFileId: 'A' }); await f.drafts.load(f.d, f.call, f.commit);
    expect(f.drafts.get(f.a)).toBe(f.d); expect(f.d.view.draft.page_mode).toBe('thumbnails');
    expect(f.other.metadata.draft.title).toBe('B draft');
  });
  it('applying Advanced retains an unsaved Initial View and metadata draft', async () => {
    const f = await fixture(); f.editView('thumbnails'); f.editAdvanced('https://new.invalid/');
    f.drafts.change(f.d, f.d.metadata, { ...f.d.metadata.draft, title: 'Unsubmitted' });
    await f.drafts.apply(f.d, 'advanced', f.operation, f.call);
    expect(f.d.view.draft.page_mode).toBe('thumbnails'); expect(propertyDirty(f.d.view)).toBe(true);
    expect(f.d.metadata.draft.title).toBe('Unsubmitted');
    expect(propertyDirty(f.d.advanced)).toBe(false);
    expect(f.operation.mock.calls[0][3]).toEqual({ expectedWorkingPath: 'work-A', expectedBuffer: f.a.buffer });
  });
  it.each(['outlines', 'default'] as const)('retains newer typing during Apply, including reverting old input: %s', async mode => {
    const f = await fixture(), wait = deferred<Awaited<ReturnType<PerformOperation>>>();
    const perform = f.operation.getMockImplementation()!;
    f.operation.mockImplementationOnce(() => wait.promise); f.editView('thumbnails');
    const run = f.drafts.apply(f.d, 'view', f.operation, f.call);
    await vi.waitFor(() => expect(f.operation).toHaveBeenCalledOnce()); f.editView(mode);
    wait.resolve(await perform('A', 'set_initial_view', { page_mode: 'thumbnails' })); await run;
    expect(f.d.view.draft.page_mode).toBe(mode); expect(f.d.view.baseline!.page_mode).toBe('thumbnails');
    expect(propertyDirty(f.d.view)).toBe(true);
  });
  it.each([EDIT_DECLINED, null])('does not mark an unperformed operation saved', async answer => {
    const f = await fixture(); f.editView('outlines'); f.operation.mockResolvedValueOnce(answer);
    await f.drafts.apply(f.d, 'view', f.operation, f.call);
    expect(f.d.view.baseline!.page_mode).toBe('default'); expect(propertyDirty(f.d.view)).toBe(true);
    expect(f.d.status).toBe('');
  });
  it('keeps late publication and readback out of the other document', async () => {
    const f = await fixture(), wait = deferred<Awaited<ReturnType<PerformOperation>>>();
    f.editView('outlines'); f.operation.mockImplementationOnce(() => wait.promise);
    const run = f.drafts.apply(f.d, 'view', f.operation, f.call);
    f.changeState({ activeFileId: 'B' }); wait.resolve(f.publish()); await run;
    expect(f.other.view.draft.page_mode).toBe('default'); expect(f.other.status).toBe('');
    expect(f.other.buffer).toBe(f.b.buffer);
  });
  it('retains dirty input as a conflict after unrelated replacement', async () => {
    const f = await fixture(); f.editView('outlines'); f.publish(); f.call.mockClear();
    await f.drafts.load(f.d, f.call, f.commit);
    expect(f.drafts.conflict(f.d)).toBe(true); expect(f.d.view.draft.page_mode).toBe('outlines');
    expect(f.call).not.toHaveBeenCalled();
    await f.drafts.apply(f.d, 'view', f.operation, f.call); expect(f.operation).not.toHaveBeenCalled();
  });
  it('does not install a read from a superseded revision', async () => {
    const f = await fixture(), wait = deferred<unknown>(); f.drafts.reload(f.d);
    f.call.mockImplementationOnce(() => wait.promise);
    const run = f.drafts.load(f.d, f.call, f.commit);
    await vi.waitFor(() => expect(f.d.loading).not.toBeNull());
    f.publish(); wait.resolve({ title: 'Late', author: '', subject: '', keywords: '' }); await run;
    expect(f.d.metadata.baseline).toBeNull();
  });
  it('reserves busy before the picker and never clears open metadata after strip-to-copy', async () => {
    const f = await fixture(), wait = deferred<string | null>();
    const picker = vi.fn(() => wait.promise); f.call.mockClear();
    const run = f.drafts.exportMetadata(f.d, true, picker, f.call);
    await f.drafts.exportMetadata(f.d, true, picker, f.call); expect(picker).toHaveBeenCalledOnce();
    wait.resolve('copy.pdf'); await run;
    expect(f.d.metadata.draft.title).toBe('Original'); expect(f.call).toHaveBeenCalledOnce();
  });
  it.each(['switch', 'revision', 'unmount'] as const)('a picker cannot submit after %s', async variant => {
    const f = await fixture(), wait = deferred<string | null>(); f.call.mockClear();
    const run = f.drafts.exportMetadata(f.d, false, () => wait.promise, f.call);
    if (variant === 'switch') f.changeState({ activeFileId: 'B' });
    if (variant === 'revision') f.publish();
    if (variant === 'unmount') { f.drafts.deactivate(); f.drafts.activate(); }
    wait.resolve('copy.pdf'); await run; expect(f.call).not.toHaveBeenCalled();
    expect(f.d.busy).toBe(false);
  });
  it('rechecks ownership at the engine lock boundary', async () => {
    const f = await fixture(); f.call.mockImplementationOnce(async (_method, _params, options) => {
      f.publish(); options!.assertCurrent!(); throw new Error('must not dispatch');
    });
    await f.drafts.exportMetadata(f.d, false, async () => 'copy.pdf', f.call);
    expect(f.d.status).not.toContain('must not dispatch'); expect(f.d.status).not.toBe('');
  });
});
