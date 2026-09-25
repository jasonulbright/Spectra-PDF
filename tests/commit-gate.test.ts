import { describe, it, expect, afterEach } from 'vitest';
import { setCommitGate, runCommitGate } from '../src/renderer/lib/commit-gate';

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
