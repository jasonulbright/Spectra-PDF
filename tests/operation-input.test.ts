import { describe, expect, it, vi } from 'vitest';
import { inspectOperationInput, type OperationInputIo } from '../src/renderer/lib/operation-input';
import { createOwnedOperationRuns } from '../src/renderer/lib/owned-operation-run';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';

describe('owned immutable edit inspection', () => {
  it.each(['control', 'pending', 'allocate', 'write', 'read', 'failure'])('owns and cleans the input across %s', async phase => {
    const original = new Uint8Array([9, 1, 2, 9]);
    const file: OpenFile = { path: 'A', workingPath: 'work', name: 'A', buffer: original.subarray(1, 3),
      pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
    let state: AppState = { ...initialState, activeFileId: 'A', files: new Map([['A', file]]) };
    const owners = createOwnedOperationRuns(() => state), run = owners.begin(file)!;
    const expire = () => { state = { ...state, files: new Map([['A', { ...file, buffer: new Uint8Array([3]) }]]) }; };
    const io: OperationInputIo = {
      allocate: vi.fn(async () => { if (phase === 'allocate') expire(); return 'private'; }),
      write: vi.fn(async (path, bytes) => { expect(path).toBe('private'); expect([...bytes]).toEqual([1, 2]); if (phase === 'write') expire(); }),
      remove: vi.fn(async () => {}),
    };
    const inspect = vi.fn(async path => {
      expect(path).toBe('private'); if (phase === 'read') expire();
      if (phase === 'failure') throw new Error('read failed'); return 'answer';
    });
    if (phase === 'pending') state = { ...state, pageDirtyPaths: ['A'] };
    const result = inspectOperationInput(run, io, inspect);
    if (phase === 'control') await expect(result).resolves.toBe('answer');
    else await expect(result).rejects.toThrow();
    expect(io.remove).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1);
    expect(inspect).toHaveBeenCalledTimes(['control', 'read', 'failure'].includes(phase) ? 1 : 0);
    expect([...original]).toEqual([9, 1, 2, 9]); run.finish();
  });
});
