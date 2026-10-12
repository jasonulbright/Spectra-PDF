import { describe, expect, it } from 'vitest';
import { latestRun } from '../src/renderer/lib/latest-run';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('latestRun', () => {
  it('only the run begun last is current', () => {
    const runs = latestRun();
    const first = runs.begin();
    expect(first()).toBe(true);
    const second = runs.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('a run overtaken while it awaits applies nothing, and the later run owns busy', async () => {
    // The shape of the preflight run: a gate, then the read, then the report.
    const runs = latestRun();
    const applied: string[] = [];
    let busy = false;
    const run = async (name: string, gate: Promise<void>) => {
      const current = runs.begin();
      busy = true;
      try {
        await gate;
        if (!current()) return;
        applied.push(name);
      } finally {
        if (current()) busy = false;
      }
    };
    const firstGate = deferred();
    const secondGate = deferred();
    // The first run's gate commits, which starts the second run.
    const first = run('first', firstGate.promise);
    const second = run('second', secondGate.promise);
    firstGate.resolve();
    await first;
    expect(applied).toEqual([]);
    expect(busy).toBe(true);
    secondGate.resolve();
    await second;
    expect(applied).toEqual(['second']);
    expect(busy).toBe(false);
  });

  it('a run in flight when its document closes applies nothing', async () => {
    const runs = latestRun();
    const applied: string[] = [];
    const read = deferred();
    const run = (async () => {
      const current = runs.begin();
      await read.promise;
      if (current()) applied.push('closed document');
    })();
    // The document goes away: no run starts, the one in flight is overtaken.
    runs.begin();
    read.resolve();
    await run;
    expect(applied).toEqual([]);
  });

  it('two sequences are independent', () => {
    const a = latestRun();
    const b = latestRun();
    const first = a.begin();
    b.begin();
    expect(first()).toBe(true);
  });
});
