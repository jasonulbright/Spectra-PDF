import { describe, expect, it, vi } from 'vitest';
import { createOwnedOperationRuns } from '../src/renderer/lib/owned-operation-run';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';
import { assertOperationGateResult } from '../src/renderer/lib/operation-intent';
import type { OpenDocument, PageRef } from '../src/renderer/state/types';

function fixture() {
  const file: OpenFile = { path: 'source', workingPath: 'work', name: 'source', buffer: new Uint8Array([1]),
    pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
  let state: AppState = { ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) };
  const runs = createOwnedOperationRuns(() => state);
  return { file, runs, read: () => state, update: (patch: Partial<AppState>) => { state = { ...state, ...patch }; } };
}
describe('owned workspace mutation gesture', () => {
  it('captures every pending partition and requires that exact page count after the gate', async () => {
    const f = fixture();
    const page = (index: number): PageRef => ({ id: `opaque-${index}`, sourceDocId: f.file.path,
      sourcePageIndex: 0, rotation: 0, width: 612, height: 792 });
    const documents: OpenDocument[] = [
      { ...f.file, id: 'first', pages: [page(0), page(1)] },
      { ...f.file, path: 'unrelated', id: 'other', pages: [page(2)] },
      { ...f.file, id: 'last', pages: [page(3), page(4)] },
    ];
    f.update({ workspace: { documents }, pageDirtyPaths: [f.file.path] });
    const run = f.runs.begin(f.file)!;
    expect(run.pageCount).toBe(4); expect(f.file.pageCount).toBe(1);
    const buffer = new Uint8Array([2]);
    const operation: PerformOperation = async (_path, _method, _params, options) => {
      const publication = { ...f.file, buffer, pageCount: 4,
        authoredIdentity: { sourceBuffer: f.file.buffer!, buffer, pages: [], documents: [] } };
      expect(() => assertOperationGateResult({ ...publication, pageCount: 2 }, options!.intent!)).toThrow();
      expect(() => assertOperationGateResult(publication, options!.intent!)).not.toThrow();
      f.update({ files: new Map([[f.file.path, publication]]), pageDirtyPaths: [] });
      return { output: f.file.workingPath, publication } as unknown as WorkspaceOperationResult;
    };
    await run.perform(operation, 'rotate', { pages: [4] });
    expect(run.visible()).toBe(true);
  });
  it('a read-only preview consumes the ticket and cannot turn into a write', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    await run.prepareRead(async () => {});
    expect(() => run.assertReadCurrent()).not.toThrow();
    const operation = vi.fn<PerformOperation>();
    await expect(run.perform(operation, 'rotate', {})).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    f.update({ files: new Map([['source', { ...f.file, buffer: new Uint8Array([2]) }]]) });
    expect(() => run.assertReadCurrent()).toThrow(); expect(run.visible()).toBe(false);
  });
  it('a read preview accepts an authored gate result, not an arbitrary replacement', async () => {
    for (const authored of [false, true]) {
      const f = fixture(), run = f.runs.begin(f.file)!;
      const buffer = new Uint8Array([2]);
      const prepare = run.prepareRead(async () => f.update({ files: new Map([['source', { ...f.file, buffer,
        ...(authored ? { authoredIdentity: { sourceBuffer: f.file.buffer!, buffer, pages: [], documents: [] } } : {}) }]]) }));
      if (authored) { await prepare; expect(() => run.assertReadCurrent()).not.toThrow(); }
      else await expect(prepare).rejects.toThrow();
    }
  });
  it.each(['session', 'revision', 'pending'])('never dispatches after pre-await %s drift', async kind => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    if (kind === 'session') f.update({ files: new Map([['source', { ...f.file, workingPath: 'new-work' }]]) });
    if (kind === 'revision') f.update({ files: new Map([['source', { ...f.file, buffer: new Uint8Array([2]) }]]) });
    if (kind === 'pending') f.update({ pageUndoStack: [] });
    const operation = vi.fn<PerformOperation>();
    await expect(run.perform(operation, 'rotate', {})).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
  it('reserves once and releases after cancellation or failure', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    expect(f.runs.begin(f.file)).toBeNull();
    run.finish(); expect(f.runs.begin(f.file)).not.toBeNull();
  });
  it('A-B-A and unmount/remount cannot restore an abandoned ticket', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    f.update({ activeFileId: 'other' }); run.synchronize(); f.update({ activeFileId: 'source' });
    expect(run.visible()).toBe(false);
    f.runs.deactivate(); f.runs.activate();
    const fresh = f.runs.begin(f.file);
    expect(fresh).not.toBeNull();
    run.finish();
    expect(f.runs.begin(f.file)).toBeNull();
    await expect(run.perform(vi.fn<PerformOperation>(), 'rotate', {})).rejects.toThrow();
  });
  it('its own publication survives synchronization, but a later revision cannot inherit success', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    const publication = { ...f.file, buffer: new Uint8Array([2]) };
    const operation: PerformOperation = async (_path, _method, _params, options) => {
      options!.assertActive!(); f.update({ files: new Map([['source', publication]]) }); run.synchronize();
      return { output: 'work', publication } as WorkspaceOperationResult;
    };
    await run.perform(operation, 'rotate', {});
    expect(run.visible()).toBe(true);
    f.update({ files: new Map([['source', { ...publication, buffer: new Uint8Array([3]) }]]) });
    expect(run.visible()).toBe(false);
  });
  it('an acknowledgement delayed behind another publication cannot report that later edit as its own', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    const publication = { ...f.file, buffer: new Uint8Array([2]) };
    const operation: PerformOperation = async () => {
      f.update({ files: new Map([['source', { ...publication, buffer: new Uint8Array([3]) }]]) });
      return { output: 'work', publication } as WorkspaceOperationResult;
    };
    await run.perform(operation, 'rotate', {}); expect(run.visible()).toBe(false);
  });
});
