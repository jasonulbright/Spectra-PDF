import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { restoreHistory, type HistoryIo } from '../src/renderer/lib/disk-history';
import { recoverPendingPageCommit, hasPendingPageCommit, type PageCommitEntry } from '../src/renderer/lib/page-commit-transaction';
import { serializeWorkspacePublication } from '../src/renderer/lib/workspace-publication';
import { withFileLock } from '../src/renderer/lib/engine-lock';
import { createAppStore } from '../src/renderer/state/store';
import { initialState, appReducer } from '../src/renderer/state/reducer';
import type { AppAction, AppState, OpenFile } from '../src/renderer/state/types';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const disk = new Map<string, Uint8Array>([
    ['work', new Uint8Array([2])], ['s1', new Uint8Array([0])], ['s2', new Uint8Array([1])],
  ]);
  const file: OpenFile = { path: 'source', workingPath: 'work', name: 'source', pageCount: 3,
    buffer: disk.get('work')!.slice(), dirty: true, undoStack: ['s1', 's2'], redoStack: [] };
  const store = createAppStore({ ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) });
  const events: string[] = [];
  const retained = new Map<string, { prior: Uint8Array; snapshot: string; entry: PageCommitEntry }>();
  const io: HistoryIo = {
    read: async path => { events.push('read'); return disk.get(path)!.slice(); },
    countPages: async data => { events.push('validate'); return data[0] + 1; },
    write: async (path, bytes) => { events.push('stage'); disk.set(path, bytes.slice()); },
    remove: async path => { events.push('cleanup'); disk.delete(path); },
    transaction: {
      publish: async (id, entries) => {
        const [entry] = entries;
        events.push('publish');
        if (hash(disk.get(entry.workingPath)!) !== entry.expectedWorkingSha256
            || hash(disk.get(entry.stagedPath)!) !== entry.expectedStagedSha256) throw new Error('revision mismatch');
        const snapshot = `backup-${id}`;
        const prior = disk.get(entry.workingPath)!.slice();
        disk.set(snapshot, prior.slice());
        retained.set(id, { prior, snapshot, entry });
        disk.set(entry.workingPath, disk.get(entry.stagedPath)!.slice());
        disk.delete(entry.stagedPath);
        return { status: 'committed', snapshots: [snapshot], detail: '' };
      },
      abort: async id => {
        events.push('abort');
        const tx = retained.get(id);
        if (tx) disk.set(tx.entry.workingPath, tx.prior.slice());
        return { status: 'rolledBack', snapshots: [], detail: '' };
      },
      acknowledge: async () => { events.push('ack'); },
    },
  };
  const actions: AppAction[] = [];
  const dispatch = (action: AppAction) => { actions.push(action); store.dispatch(action); };
  const run = (direction: 'undo' | 'redo' = 'undo') => restoreHistory(direction, store.getState, dispatch, io);
  return { disk, store, io, events, actions, run, file };
}

describe('atomic disk history', () => {
  it.each(['read', 'validate', 'stage'] as const)('%s failure leaves disk, buffer and history untouched', async where => {
    const f = fixture();
    const before = f.store.getState();
    const fail = async () => { throw new Error(`injected ${where}`); };
    if (where === 'read') f.io.read = fail;
    else if (where === 'validate') f.io.countPages = fail;
    else f.io.write = async (path) => { f.disk.set(path, new Uint8Array([99])); return fail(); };
    await expect(f.run()).rejects.toThrow(`injected ${where}`);
    expect(f.store.getState()).toBe(before);
    expect(f.disk.get('work')).toEqual(f.file.buffer);
    expect(f.events).not.toContain('publish');
    expect([...f.disk.keys()].some(p => p.includes('.history-'))).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, 1.5, undefined, '2'])('invalid page count %s refuses before mutation', async count => {
    const f = fixture();
    f.io.countPages = async () => count as number;
    await expect(f.run()).rejects.toThrow('non-empty PDF');
    expect(f.disk.get('work')).toEqual(f.file.buffer);
    expect(f.actions).toEqual([]);
  });
  it('uses one state publication and never reads the working file after restore', async () => {
    const f = fixture();
    await f.run();
    const after = f.store.getState().files.get('source')!;
    expect(after.buffer).toEqual(f.disk.get('work'));
    expect(after.pageCount).toBe(2);
    expect(after.undoStack).toEqual(['s1']);
    expect(f.actions.map(a => a.type)).toEqual(['RESTORE_HISTORY']);
    expect(f.events.slice(0, 5)).toEqual(['read', 'validate', 'stage', 'publish', 'ack']);
  });
  it('queues repeated undo/redo against current state, without needing a render', async () => {
    const f = fixture();
    await Promise.all([f.run(), f.run(), f.run('redo'), f.run('redo')]);
    const after = f.store.getState().files.get('source')!;
    expect(after.buffer).toEqual(new Uint8Array([2]));
    expect(after.buffer).toEqual(f.disk.get('work'));
    expect(after.undoStack).toHaveLength(2);
    expect(after.redoStack).toEqual([]);
    expect(f.actions).toHaveLength(4);
  });
  it.each(['lost', 'malformed', 'state-refused'])('aborts confirmed native writes on %s before state publication', async mode => {
    const f = fixture();
    const original = f.io.transaction.publish;
    f.io.transaction.publish = async (id, entries) => {
      const result = await original(id, entries);
      if (mode === 'lost') throw new Error('lost reply');
      if (mode === 'state-refused') f.store.dispatch({ type: 'MARK_SAVED', path: 'source' });
      return mode === 'malformed' ? { status: 'committed' } : result;
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.disk.get('work')).toEqual(f.file.buffer);
    expect(f.store.getState().files.get('source')!.buffer).toEqual(f.file.buffer);
    expect(f.events).toContain('abort');
    expect(f.actions).toEqual([]);
    expect(hasPendingPageCommit()).toBe(false);
  });
  it('retains unconfirmed restoration and blocks the next history until recovery succeeds', async () => {
    const f = fixture();
    const publish = f.io.transaction.publish;
    const abort = f.io.transaction.abort;
    f.io.transaction.publish = async (id, entries) => { await publish(id, entries); throw new Error('lost'); };
    f.io.transaction.abort = async () => { throw new Error('abort lost'); };
    try {
      await expect(f.run()).rejects.toThrow('needs recovery');
      const attempts = f.events.filter(e => e === 'publish').length;
      await expect(f.run()).rejects.toThrow('needs recovery');
      expect(f.events.filter(e => e === 'publish')).toHaveLength(attempts);
      expect(f.store.getState().files.get('source')).toBe(f.file);
    } finally {
      f.io.transaction.abort = abort;
      await recoverPendingPageCommit();
    }
    expect(f.disk.get('work')).toEqual(f.file.buffer);
  });
  it('acknowledgement loss never rolls back the published history', async () => {
    const f = fixture();
    f.io.transaction.acknowledge = async () => { throw new Error('ack lost'); };
    try {
      await f.run();
      expect(f.store.getState().files.get('source')!.buffer).toEqual(f.disk.get('work'));
      expect(f.actions).toHaveLength(1);
      expect(f.events).not.toContain('abort');
    } finally {
      f.io.transaction.acknowledge = async () => {};
      await recoverPendingPageCommit();
    }
  });
  it('an earlier page commit and later history share the same publication lane', async () => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const commit = serializeWorkspacePublication(async () => {
      await waiting;
      f.disk.set('work', new Uint8Array([3]));
      f.disk.set('s3', new Uint8Array([2]));
      f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', buffer: new Uint8Array([3]), pageCount: 4, snapshotPath: 's3' });
    });
    const undo = f.run();
    expect(f.events).toEqual([]);
    release();
    await Promise.all([commit, undo]);
    expect(f.disk.get('work')).toEqual(new Uint8Array([2]));
    expect(f.store.getState().files.get('source')!.undoStack).toEqual(['s1', 's2']);
  });
  it('source history and validation inputs cannot alter the bytes eventually published', async () => {
    const f = fixture();
    f.io.countPages = async data => { data.fill(99); f.disk.set('s2', new Uint8Array([88])); return 2; };
    await f.run();
    expect(f.disk.get('work')).toEqual(new Uint8Array([1]));
    expect(f.store.getState().files.get('source')!.buffer).toEqual(new Uint8Array([1]));
  });
  it('a file change during validation refuses before native publication', async () => {
    const f = fixture();
    f.io.countPages = async () => { f.store.dispatch({ type: 'MARK_SAVED', path: 'source' }); return 2; };
    await expect(f.run()).rejects.toThrow('changed');
    expect(f.events).not.toContain('publish');
    expect(f.disk.get('work')).toEqual(f.file.buffer);
    expect(f.store.getState().files.get('source')!.undoStack).toEqual([]);
  });
  it('a silently refused state dispatch aborts the completed native write', async () => {
    const f = fixture();
    await expect(restoreHistory('undo', f.store.getState, () => {}, f.io)).rejects.toThrow('changed');
    expect(f.events).toContain('abort');
    expect(f.disk.get('work')).toEqual(f.file.buffer);
    expect(f.store.getState().files.get('source')).toBe(f.file);
  });
  it('history waits for an existing engine file lock and captures the resulting revision', async () => {
    const f = fixture();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const engine = withFileLock(['work'], async () => {
      await wait;
      f.disk.set('work', new Uint8Array([3]));
      f.disk.set('s3', new Uint8Array([2]));
      f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', pageCount: 4, buffer: new Uint8Array([3]), snapshotPath: 's3' });
    });
    const undo = f.run();
    expect(f.events).toEqual([]);
    release();
    await Promise.all([engine, undo]);
    expect(f.disk.get('work')).toEqual(new Uint8Array([2]));
    expect(f.store.getState().files.get('source')!.undoStack).toEqual(['s1', 's2']);
  });
  it('the reducer refuses stale expected history without any partial buffer/stack update', () => {
    const f = fixture();
    const expected = f.store.getState();
    f.store.dispatch({ type: 'MARK_SAVED', path: 'source' });
    const changed = f.store.getState();
    const next = appReducer(changed, { type: 'RESTORE_HISTORY', direction: 'undo', path: 'source',
      expected, snapshotPath: 's2', counterpart: 'opposite', buffer: [9], pageCount: 1 });
    expect(next).toBe(changed);
  });
  it('current queued actions are visible before subscriber rendering', () => {
    const f = fixture();
    let latest: AppState | undefined;
    const off = f.store.subscribe(() => { latest = f.store.getState(); });
    f.store.dispatch({ type: 'MARK_SAVED', path: 'source' });
    expect(latest).toBe(f.store.getState());
    expect(latest!.files.get('source')!.undoStack).toEqual([]);
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('setCommandStateSource(() => ({ state: readState(), dispatch }))');
    off();
  });
});
