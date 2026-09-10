import { describe, expect, it, vi } from 'vitest';
import { createFormDrafts } from '../src/renderer/lib/form-drafts';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { FillFormValues } from '../src/renderer/hooks/useOperations';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const readResult = (value = 'Original', name = 'name') => ({ fields: [{ name, type: 'text', value,
  read_only: false, required: false, widgets: [{ page: 0, rect: [0, 0, 100, 20] }] }],
  count: 1, has_xfa: false, xfa: 'none', xfa_calculations: false, calculation_order: [] });
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', name: 'A', buffer: new Uint8Array([1]),
    pageCount: 2, dirty: false, undoStack: [], redoStack: [] };
  const b = { ...a, path: 'B', workingPath: 'work-B', buffer: new Uint8Array([2]) };
  let state: AppState = { ...initialState, files: new Map([['A', a], ['B', b]]), activeFileId: 'A' };
  const drafts = createFormDrafts(() => state), da = drafts.get(a)!, db = drafts.get(b)!;
  const read = vi.fn(async () => readResult()); await drafts.load(da, read); await drafts.load(db, read);
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; drafts.reconcile(); };
  const type = (value: string, d = da) => drafts.setValue(d, d.buffer, 'name', value);
  const published = { ...a, buffer: new Uint8Array([3]), dirty: true };
  const fill = vi.fn<FillFormValues>(async () => {
    change({ files: new Map([['A', published], ['B', b]]) }); return { completed: true, publication: published };
  });
  return { a, b, da, db, drafts, read, change, type, published, fill, state: () => state };
}
describe('Forms-panel filling sessions', () => {
  it('A-B-A retains independent values and Flatten choice; Apply never pairs A input with B', async () => {
    const f = await fixture(); f.type('Only A'); f.drafts.setFlatten(f.da, f.a.buffer, true);
    f.change({ activeFileId: 'B' }); expect(f.db.values.name).toBe('Original');
    await f.drafts.save(f.db, f.fill); expect(f.fill).not.toHaveBeenCalled(); f.type('Only B', f.db);
    f.change({ activeFileId: 'A' }); expect(f.drafts.get(f.a)).toBe(f.da); expect(f.da.values.name).toBe('Only A');
    expect(f.da.options.flatten).toBe(true); expect(f.db.options.flatten).toBe(false);
    await f.drafts.save(f.da, f.fill);
    expect(f.fill).toHaveBeenCalledWith('A', { name: 'Only A' }, { flatten: true, expectedWorkingPath: 'work-A', expectedBuffer: f.a.buffer });
    expect(f.da.pending).toEqual({}); expect(f.db.pending).toEqual({ name: 'Only B' });
  });
  it('panel unmount cancels a read, not the document draft', async () => {
    const f = await fixture(); f.type('Keep'); f.drafts.cancelLoad(f.da);
    expect(f.drafts.get(f.a)?.values.name).toBe('Keep');
  });
  it.each(['load', 'save'])('late %s cannot modify a closed/reopened session even with a reused working path', async action => {
    const f = await fixture(), answer = deferred<ReturnType<typeof readResult> | Awaited<ReturnType<FillFormValues>>>(); let pending: Promise<void>;
    if (action === 'load') { f.da.needsRead = true; pending = f.drafts.load(f.da, () => answer.promise); }
    else { f.type('Old'); pending = f.drafts.save(f.da, () => answer.promise as ReturnType<FillFormValues>); }
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const fresh = f.drafts.get(f.a)!; await f.drafts.load(fresh, f.read); f.type('Fresh', fresh);
    answer.resolve(action === 'load' ? readResult('Old read') : { completed: true, publication: f.published }); await pending;
    expect(fresh.values.name).toBe('Fresh'); expect(fresh.busy).toBe(false);
  });
  it('cancelled read and error cannot replace remounted input/status', async () => {
    const f = await fixture(), answer = deferred<unknown>(); f.da.needsRead = true;
    const load = f.drafts.load(f.da, () => answer.promise); f.drafts.cancelLoad(f.da);
    await f.drafts.load(f.da, f.read); f.type('New'); answer.reject(Error('old error')); await load;
    expect(f.da.values.name).toBe('New'); expect(f.da.error).toBe('');
  });
  it.each([null, {}, { fields: [] }, { count: 9 }, { fields: [{ name: 'partial' }] }])('malformed read is not an editable empty form: %j', async bad => {
    const f = await fixture(); await f.drafts.reload(f.da, async () => {});
    await f.drafts.load(f.da, async () => bad === null ? null : { ...readResult(), ...bad });
    // An empty object overlay above is otherwise a faithful read: make the
    // actual empty reply explicit to exercise the missing-field boundary.
    if (bad && !Object.keys(bad).length) {
      await f.drafts.reload(f.da, async () => {}); await f.drafts.load(f.da, async () => ({}));
    }
    expect(f.drafts.editable(f.da)).toBe(false); expect(f.da.error).not.toBe('');
    f.type('Not authorized'); await f.drafts.save(f.da, f.fill); expect(f.fill).not.toHaveBeenCalled();
  });
  it.each(['revision', 'pending'])('%s change retains input but refuses old field identity', async kind => {
    const f = await fixture(); f.type('Keep');
    if (kind === 'revision') f.change({ files: new Map([['A', f.published], ['B', f.b]]) });
    else f.change({ pageDirtyPaths: ['A'] });
    await f.drafts.load(f.da, f.read); await f.drafts.save(f.da, f.fill); f.type('Stale event');
    expect(f.da.values.name).toBe('Keep'); expect(f.drafts.conflict(f.da)).toBe(true); expect(f.fill).not.toHaveBeenCalled();
  });
  it('another document page edit does not invalidate A', async () => {
    const f = await fixture(); f.type('A'); f.change({ pageDirtyPaths: ['B'] });
    await f.drafts.save(f.da, f.fill); expect(f.fill).toHaveBeenCalledTimes(1);
  });
  it('a clean form rereads after an external revision instead of remaining frozen', async () => {
    const f = await fixture(); f.change({ files: new Map([['A', f.published], ['B', f.b]]) });
    await f.drafts.load(f.da, async () => readResult('New baseline'));
    expect(f.da.values.name).toBe('New baseline'); expect(f.drafts.editable(f.da)).toBe(true);
    f.drafts.setValue(f.da, f.a.buffer, 'name', 'Old event'); expect(f.da.values.name).toBe('New baseline');
  });
  it.each(['Later', 'Original'])('newer typing %s during Apply survives on the exact receipt, even a return to the old baseline', async later => {
    const f = await fixture(), answer = deferred<Awaited<ReturnType<FillFormValues>>>(); f.type('Submitted');
    f.fill.mockImplementation(() => answer.promise); const save = f.drafts.save(f.da, f.fill);
    f.type(later); await f.drafts.save(f.da, f.fill); expect(f.fill).toHaveBeenCalledTimes(1);
    f.change({ activeFileId: 'B', files: new Map([['A', f.published], ['B', f.b]]) });
    answer.resolve({ completed: true, publication: f.published }); await save;
    expect(f.da.pending).toEqual({ name: later }); expect(f.da.buffer).toBe(f.published.buffer);
    await f.drafts.load(f.da, async () => readResult('Submitted')); expect(f.da.values.name).toBe(later);
    expect(f.da.pending).toEqual({ name: later }); expect(f.db.pending).toEqual({});
  });
  it('changing the Flatten choice while Apply awaits does not get retired', async () => {
    const f = await fixture(), answer = deferred<Awaited<ReturnType<FillFormValues>>>(); f.type('A');
    const save = f.drafts.save(f.da, () => answer.promise); f.drafts.setFlatten(f.da, f.da.buffer, true);
    f.change({ files: new Map([['A', f.published], ['B', f.b]]) }); answer.resolve({ completed: true, publication: f.published }); await save;
    expect(f.da.options.flatten).toBe(true);
  });
  it('later input whose field was flattened is retained visibly, not pruned as success', async () => {
    const f = await fixture(), answer = deferred<Awaited<ReturnType<FillFormValues>>>();
    f.type('Submitted'); f.drafts.setFlatten(f.da, f.da.buffer, true);
    const save = f.drafts.save(f.da, () => answer.promise); f.type('Later');
    f.change({ files: new Map([['A', f.published], ['B', f.b]]) }); answer.resolve({ completed: true, publication: f.published }); await save;
    await f.drafts.load(f.da, async () => ({ ...readResult(), fields: [], count: 0 }));
    expect(f.da.values.name).toBe('Later'); expect(f.da.pending).toEqual({ name: 'Later' });
    expect(f.drafts.conflict(f.da)).toBe(true); expect(f.drafts.editable(f.da)).toBe(false);
  });
  it.each(['renamed', 'retyped', 'ambiguous'])('post-Apply read resolves or refuses the %s field by fingerprint', async kind => {
    const f = await fixture(), answer = deferred<Awaited<ReturnType<FillFormValues>>>(); f.type('Submitted');
    const save = f.drafts.save(f.da, () => answer.promise); f.type('Later');
    f.change({ files: new Map([['A', f.published], ['B', f.b]]) }); answer.resolve({ completed: true, publication: f.published }); await save;
    const response = readResult('Submitted', kind === 'renamed' ? 'name+1' : 'name');
    if (kind === 'retyped') response.fields[0].type = 'button';
    if (kind === 'ambiguous') { response.fields.push({ ...response.fields[0], name: 'name+1' }); response.count++; }
    await f.drafts.load(f.da, async () => response);
    if (kind === 'renamed') { expect(f.da.values['name+1']).toBe('Later'); expect(f.drafts.editable(f.da)).toBe(true); }
    else { expect(f.da.values.name).toBe('Later'); expect(f.drafts.conflict(f.da)).toBe(true); }
  });
  it.each(['declined', 'error', 'empty receipt'])('%s preserves all input for retry', async outcome => {
    const f = await fixture(); f.type('Keep'); f.drafts.setFlatten(f.da, f.da.buffer, true);
    await f.drafts.save(f.da, (async () => {
      if (outcome === 'error') throw Error('refused'); return outcome === 'declined' ? EDIT_DECLINED : undefined;
    }) as FillFormValues);
    expect(f.da.values.name).toBe('Keep'); expect(f.da.pending).toEqual({ name: 'Keep' });
    expect(f.da.options.flatten).toBe(true); expect(f.da.busy).toBe(false);
  });
  it('a later external revision during acknowledgement does not get blessed by the receipt', async () => {
    const f = await fixture(); f.type('Submitted');
    await f.drafts.save(f.da, async () => {
      f.type('Later'); f.change({ files: new Map([['A', { ...f.published, buffer: new Uint8Array([4]) }], ['B', f.b]]) });
      return { completed: true, publication: f.published };
    });
    expect(f.da.pending).toEqual({ name: 'Later' }); expect(f.drafts.conflict(f.da)).toBe(true);
  });
  it('failed reload and edits during its await retain the draft; explicit successful reload clears it', async () => {
    const f = await fixture(); f.type('Keep'); await f.drafts.reload(f.da, async () => { throw Error('gate refused'); });
    expect(f.da.values.name).toBe('Keep'); const gate = deferred<void>(); const reload = f.drafts.reload(f.da, () => gate.promise);
    f.type('New'); gate.resolve(); await reload; expect(f.da.values.name).toBe('New');
    await f.drafts.reload(f.da, async () => {}); await f.drafts.load(f.da, f.read); expect(f.da.values.name).toBe('Original');
  });
});
