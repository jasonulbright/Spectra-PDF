import { describe, expect, it, vi } from 'vitest';
import { createOwnedDocumentRuns } from '../src/renderer/lib/owned-document-run';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';

function fixture() {
  const file: OpenFile = { path: 'A', name: 'A.pdf', workingPath: 'work-A', buffer: new Uint8Array([1]),
    pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
  let state: AppState = { ...initialState, activeFileId: 'A', files: new Map([['A', file]]), pageDirtyPaths: [] };
  const runs = createOwnedDocumentRuns(() => state);
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
  const replace = (next: OpenFile) => change({ files: new Map([['A', next]]) });
  return { file, runs, change, replace };
}

describe('conversion gesture owns the source before any await', () => {
  it('reserves before the picker and releases exactly its own run', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    expect(f.runs.begin(f.file)).toBeNull();
    await run.prepare(async () => {}); expect(run.isCurrent()).toBe(true);
    run.finish(); const next = f.runs.begin(f.file)!; run.finish();
    expect(f.runs.begin(f.file)).toBeNull(); next.finish(); expect(f.runs.begin(f.file)).not.toBeNull();
  });
  it('accepts its proven authored commit before freezing the operation revision', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    f.change({ pageDirtyPaths: ['A'] });
    const buffer = new Uint8Array([2]);
    const next = { ...f.file, buffer, authoredIdentity: { sourceBuffer: f.file.buffer!, buffer, pages: ['p'], documents: [] } };
    await run.prepare(async () => { f.replace(next); f.change({ pageDirtyPaths: [] }); run.synchronize(); });
    expect(run.source).toBe(next); expect(run.isCurrent()).toBe(true);
  });
  it('refuses a non-authored replacement during the gate', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!;
    await expect(run.prepare(async () => f.replace({ ...f.file, buffer: new Uint8Array([2]) }))).rejects.toThrow();
  });
  it.each(['path', 'session', 'revision', 'pending edits'] as const)('refuses a changed %s before dispatch', async variant => {
    const f = fixture(), run = f.runs.begin(f.file)!; await run.prepare(async () => {});
    if (variant === 'path') f.change({ activeFileId: 'B' });
    if (variant === 'session') f.replace({ ...f.file, workingPath: 'work-A-reopened' });
    if (variant === 'revision') f.replace({ ...f.file, buffer: new Uint8Array([2]) });
    if (variant === 'pending edits') f.change({ pageDirtyPaths: ['A'] });
    expect(run.isCurrent()).toBe(false); expect(() => run.assertCurrent()).toThrow();
  });
  it('does not revive a gesture after A-B-A', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!; await run.prepare(async () => {});
    f.change({ activeFileId: 'B' }); run.synchronize(); f.change({ activeFileId: 'A' });
    expect(run.isCurrent()).toBe(false);
  });
  it('does not revive a gesture across StrictMode cleanup/setup', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!; await run.prepare(async () => {});
    f.runs.deactivate(); f.runs.activate(); expect(run.isCurrent()).toBe(false);
    // The prior native operation may still be running; overlap remains held
    // until that caller releases its own reservation in finally.
    expect(f.runs.begin(f.file)).toBeNull(); run.finish(); expect(f.runs.begin(f.file)).not.toBeNull();
  });
  it('does not call the gate for a stale-at-entry gesture', async () => {
    const f = fixture(), run = f.runs.begin(f.file)!, gate = vi.fn(async () => {});
    f.replace({ ...f.file, buffer: new Uint8Array([2]) });
    await expect(run.prepare(gate)).rejects.toThrow(); expect(gate).not.toHaveBeenCalled();
  });
});
