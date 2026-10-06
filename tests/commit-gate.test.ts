import { describe, it, expect, afterEach } from 'vitest';
import { setCommitGate, runCommitGate } from '../src/renderer/lib/commit-gate';
import { commitLockKeys, runPageCommit, PAGE_COMMIT_ATTEMPTS } from '../src/renderer/lib/page-commit-run';
import { withFileLock, __lockedCount } from '../src/renderer/lib/engine-lock';
import { hasWorkspacePublication, serializeWorkspacePublication } from '../src/renderer/lib/workspace-publication';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';

// A gate run commits the edits pending when it planned; edits made while it
// writes stay pending, as in the page-tier commit.
function pageTier() {
  let pending: string[] = [];
  const committed: string[] = [];
  const writes: Array<() => void> = [];
  let runs = 0;
  setCommitGate(async () => {
    runs++;
    if (!pending.length) return;
    const planned = pending.slice();
    await new Promise<void>(r => writes.push(r));
    committed.push(...planned);
    pending = pending.filter(e => !planned.includes(e));
  });
  return {
    edit: (e: string) => { pending.push(e); },
    completeWrites: async () => {
      for (let i = 0; i < 50; i++) {
        const w = writes.shift();
        if (w) w();
        await Promise.resolve();
      }
    },
    committed,
    runs: () => runs,
  };
}

afterEach(() => setCommitGate(null));

describe('runCommitGate', () => {
  it('commits the pending edit before resolving', async () => {
    const tier = pageTier();
    tier.edit('E1');
    const call = runCommitGate();
    await tier.completeWrites();
    await call;
    expect(tier.committed).toEqual(['E1']);
  });

  it('a caller joining a run also commits an edit made after that run planned', async () => {
    const tier = pageTier();
    tier.edit('E1');
    const first = runCommitGate();
    await Promise.resolve();
    tier.edit('E2');
    const second = runCommitGate();
    await tier.completeWrites();
    await first;
    await second;
    expect(tier.committed).toEqual(['E1', 'E2']);
  });

  it('a joining caller with nothing new pending runs one empty gate pass', async () => {
    const tier = pageTier();
    tier.edit('E1');
    const first = runCommitGate();
    const second = runCommitGate();
    await tier.completeWrites();
    await Promise.all([first, second]);
    expect(tier.committed).toEqual(['E1']);
    expect(tier.runs()).toBe(2);
  });

  it('a failed shared run rejects the joining caller', async () => {
    setCommitGate(() => Promise.reject(new Error('blocked')));
    const first = runCommitGate();
    const second = runCommitGate();
    await expect(first).rejects.toThrow('blocked');
    await expect(second).rejects.toThrow('blocked');
  });
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function file(path: string): OpenFile {
  return { path, workingPath: `work-${path}`, name: path, pageCount: 1, buffer: new Uint8Array([1]),
    dirty: false, undoStack: [], redoStack: [] };
}
function stateOf(paths: string[], dirty: string[]): AppState {
  return { ...initialState, files: new Map(paths.map(p => [p, file(p)])), pageDirtyPaths: dirty };
}
/** A page commit over `current`, recording what it saw. */
function commitRun(current: { state: AppState }, events: string[], settle: () => Promise<void> = async () => {}) {
  return runPageCommit<string>({
    read: () => current.state,
    recover: async () => { events.push('recover'); },
    settle,
    clean: 'clean',
    commit: async state => {
      events.push(`commit ${state.pageDirtyPaths.join(',')} locked=${__lockedCount()}`);
      return 'committed';
    },
  });
}

describe('page commit locks', () => {
  it('locks the working path of each dirty file, sorted, and no other', () => {
    expect(commitLockKeys(stateOf(['B', 'A', 'C'], ['C', 'A']))).toEqual(['work-A', 'work-C']);
    expect(commitLockKeys(stateOf(['A'], []))).toEqual([]);
    expect(commitLockKeys(stateOf(['A'], ['A', 'A', 'gone']))).toEqual(['work-A']);
  });

  it('does not wait for a reader of a clean document', async () => {
    const reading = deferred();
    const reader = withFileLock([{ key: 'work-B', mode: 'shared' }], () => reading.promise);
    const events: string[] = [];
    await expect(commitRun({ state: stateOf(['A', 'B'], ['A']) }, events)).resolves.toEqual({ value: 'committed' });
    expect(events).toEqual(['recover', 'commit A locked=2']);
    reading.resolve();
    await reader;
    expect(__lockedCount()).toBe(0);
  });

  it('waits for a reader of a dirty document without holding the publication lane', async () => {
    const reading = deferred();
    const reader = withFileLock([{ key: 'work-A', mode: 'shared' }], () => reading.promise);
    const events: string[] = [];
    const commit = commitRun({ state: stateOf(['A', 'B'], ['A']) }, events);
    await flush();
    expect(events).toEqual([]);
    expect(hasWorkspacePublication()).toBe(false);
    // Another document publishes while the commit waits.
    await serializeWorkspacePublication(async () => { events.push('publish B'); });
    expect(events).toEqual(['publish B']);
    reading.resolve();
    await expect(commit).resolves.toEqual({ value: 'committed' });
    expect(events).toEqual(['publish B', 'recover', 'commit A locked=1']);
    await reader;
  });

  it('a dirty set that grows while settling is locked again before it commits', async () => {
    const current = { state: stateOf(['A', 'B'], ['A']) };
    const events: string[] = [];
    let rounds = 0;
    const result = await commitRun(current, events, async () => {
      if (rounds++ === 0) current.state = stateOf(['A', 'B'], ['A', 'B']);
    });
    expect(result).toEqual({ value: 'committed' });
    expect(events).toEqual(['recover', 'recover', 'commit A,B locked=2']);
  });

  it('a dirty set that shrinks while settling commits with the locks it holds', async () => {
    const current = { state: stateOf(['A', 'B'], ['A', 'B']) };
    const events: string[] = [];
    const result = await commitRun(current, events, async () => { current.state = stateOf(['A', 'B'], ['B']); });
    expect(result).toEqual({ value: 'committed' });
    expect(events).toEqual(['recover', 'commit B locked=2']);
  });

  it(`refuses after ${PAGE_COMMIT_ATTEMPTS} rounds that each find an unlocked dirty path`, async () => {
    let n = 0;
    const current = { state: stateOf(['f0'], ['f0']) };
    const events: string[] = [];
    const result = await commitRun(current, events, async () => {
      n++;
      current.state = stateOf([`f${n}`], [`f${n}`]);
    });
    expect(result).toBeNull();
    expect(events).toEqual(['recover', 'recover', 'recover']);
    expect(__lockedCount()).toBe(0);
  });

  it('a settled state with no dirty page returns the clean outcome without committing', async () => {
    const events: string[] = [];
    await expect(commitRun({ state: stateOf(['A'], []) }, events)).resolves.toEqual({ value: 'clean' });
    expect(events).toEqual(['recover']);
  });
});
