import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commitPageEdits } from '../src/renderer/lib/workspace-commit';
import {
  hasPendingPageCommit, recoverPendingPageCommit, publishPageCommit,
  type PageCommitEntry, type PageCommitIo,
} from '../src/renderer/lib/page-commit-transaction';

const entries: PageCommitEntry[] = [
  { workingPath: 'a.pdf', stagedPath: 'a.stage' },
  { workingPath: 'b.pdf', stagedPath: 'b.stage' },
];
const committed = { status: 'committed', snapshots: ['a.snap', 'b.snap'], detail: '' };
const restored = { status: 'rolledBack', snapshots: [], detail: '' };

function fixture() {
  const original = new Map([['a.pdf', 'old A'], ['b.pdf', 'old B']]);
  const disk = new Map(original);
  const events: string[] = [];
  const ids: string[] = [];
  const io: PageCommitIo = {
    publish: async id => {
      ids.push(id);
      events.push('publish');
      disk.set('a.pdf', 'new A');
      disk.set('b.pdf', 'new B');
      return committed;
    },
    abort: async id => {
      expect(ids).toContain(id);
      events.push('abort');
      for (const [path, bytes] of original) disk.set(path, bytes);
      return restored;
    },
    acknowledge: async id => { expect(ids).toContain(id); events.push('ack'); },
  };
  return { io, original, disk, events, ids,
    publishState: () => { events.push('state'); },
    cleanup: async () => { events.push('cleanup'); } };
}

describe('page commit acknowledgement and recovery', () => {
  it('publishes state only after a complete receipt and acknowledges afterwards', async () => {
    const f = fixture();
    await publishPageCommit(f.io, entries, snapshots => {
      expect(snapshots).toEqual(['a.snap', 'b.snap']);
      expect([...f.disk.values()]).toEqual(['new A', 'new B']);
      f.publishState();
    }, f.cleanup);
    expect(f.events).toEqual(['publish', 'state', 'ack', 'cleanup']);
    expect(hasPendingPageCommit()).toBe(false);
  });

  it('aborts the exact id after a success reply was lost; nothing publishes in the renderer', async () => {
    const f = fixture();
    const publish = f.io.publish;
    f.io.publish = async (id, batch) => { await publish(id, batch); throw new Error('reply lost'); };
    await expect(publishPageCommit(f.io, entries, f.publishState, f.cleanup)).rejects.toThrow('reply lost');
    expect(f.disk).toEqual(f.original);
    expect(f.events).toEqual(['publish', 'abort', 'cleanup', 'ack']);
    expect(hasPendingPageCommit()).toBe(false);
  });

  it.each([
    null, {}, false,
    { ...committed, status: 'COMMITTED' },
    { ...committed, snapshots: [] },
    { ...committed, snapshots: ['a.snap'] },
    { ...committed, snapshots: ['a.snap', 'a.snap'] },
    { ...committed, snapshots: ['a.snap', 'b.snap', 'c.snap'] },
    { ...committed, snapshots: ['a.pdf', 'b.snap'] },
    { ...committed, snapshots: ['a.snap', 'b.stage'] },
    { ...committed, snapshots: ['a.snap', null] },
    { ...committed, detail: 42 },
  ])('a malformed receipt cannot publish state: %j', async receipt => {
    const f = fixture();
    const publish = f.io.publish;
    f.io.publish = async (id, batch) => { await publish(id, batch); return receipt; };
    await expect(publishPageCommit(f.io, entries, f.publishState, f.cleanup)).rejects.toThrow();
    expect(f.disk).toEqual(f.original);
    expect(f.events).not.toContain('state');
    expect(hasPendingPageCommit()).toBe(false);
  });

  it.each(['lost', 'malformed', 'required'])('unconfirmed rollback remains gated until retry: %s', async mode => {
    const f = fixture();
    const publish = f.io.publish;
    const abort = f.io.abort;
    f.io.publish = async (id, batch) => { await publish(id, batch); throw new Error('publish failed'); };
    f.io.abort = async () => {
      if (mode === 'lost') throw new Error('abort reply lost');
      return mode === 'malformed' ? { status: 'rolledBack' } : { ...restored, status: 'recoveryRequired' };
    };
    try {
      await expect(publishPageCommit(f.io, entries, f.publishState, f.cleanup)).rejects.toThrow('needs recovery');
      expect(hasPendingPageCommit()).toBe(true);
      expect(f.events).not.toContain('cleanup');
      expect(f.events).not.toContain('state');
      const other = fixture();
      await expect(publishPageCommit(other.io, entries, other.publishState, other.cleanup)).rejects.toThrow('needs recovery');
      expect(other.events).toEqual([]);
      // Exercise the actual empty-plan boundary, not only its App spelling.
      await expect(commitPageEdits({
        workspace: { documents: [] }, files: new Map(), dirtyPaths: [],
        transaction: other.io,
        dispatch: () => { throw new Error('empty plan bypassed recovery'); },
        writeBuffer: async () => { throw new Error('unexpected write'); },
        remove: async () => { throw new Error('unexpected cleanup'); },
      })).rejects.toThrow('needs recovery');
      expect(other.events).toEqual([]);
    } finally {
      f.io.abort = abort;
      await recoverPendingPageCommit();
    }
    expect(f.disk).toEqual(f.original);
    expect(hasPendingPageCommit()).toBe(false);
    const retry = fixture();
    await publishPageCommit(retry.io, entries, retry.publishState, retry.cleanup);
    expect(retry.ids[0]).not.toBe(f.ids[0]);
  });

  it('an acknowledgement failure never rolls back a published renderer update', async () => {
    const f = fixture();
    const ack = f.io.acknowledge;
    f.io.acknowledge = async () => { throw new Error('ack reply lost'); };
    try {
      await publishPageCommit(f.io, entries, f.publishState, f.cleanup);
      expect(f.events).toEqual(['publish', 'state', 'cleanup']);
      expect(hasPendingPageCommit()).toBe(true);
    } finally {
      f.io.acknowledge = ack;
      await recoverPendingPageCommit();
    }
    expect(f.events).toEqual(['publish', 'state', 'cleanup', 'ack']);
    expect([...f.disk.values()]).toEqual(['new A', 'new B']);
    expect(hasPendingPageCommit()).toBe(false);
  });

  it('a dispatch that rejects before publication rolls back the native files', async () => {
    const f = fixture();
    await expect(publishPageCommit(f.io, entries, () => { throw new Error('dispatch failed'); }, f.cleanup))
      .rejects.toThrow('dispatch failed');
    expect(f.disk).toEqual(f.original);
    expect(hasPendingPageCommit()).toBe(false);
  });

  it('App cannot bypass recovery via an empty dirty set or disk undo/redo', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('readState().pageDirtyPaths.length === 0 && !hasPendingPageCommit() && !hasWorkspacePublication()');
    expect(app).toContain('restoreHistory(direction, readState, dispatch,');
    const history = readFileSync(new URL('../src/renderer/lib/disk-history.ts', import.meta.url), 'utf8');
    expect(history.indexOf('await recoverPendingPageCommit()')).toBeLessThan(history.indexOf('await io.read('));
    expect(history).toContain('serializeWorkspacePublication(async () =>');
    const commit = readFileSync(new URL('../src/renderer/lib/workspace-commit.ts', import.meta.url), 'utf8');
    expect(commit).not.toContain('await rename(');
    expect(commit).not.toContain('await snapshot(');
    expect(app).toContain('transaction: pageCommit');
  });
});
