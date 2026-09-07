// The engine's idle lane: WHO GOES FIRST.
//
// The invariant under test is that a user-requested operation never waits
// behind a background sweep. The fake engine below is the real one's only
// relevant property — one serial FIFO — so "who goes first" is exactly the
// order in which requests are handed to it.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginInteractive,
  interactiveInFlight,
  resetEngineIdleLane,
  submitIdle,
  trackInteractive,
} from '../src/renderer/lib/engine-idle-lane';

/** Records the order requests are handed over in, and lets each be finished
 * by name so a test decides what is outstanding when. */
function fakeEngine() {
  const dispatched: string[] = [];
  const open = new Map<string, (value: string) => void>();
  return {
    dispatched,
    send(name: string): Promise<string> {
      dispatched.push(name);
      return new Promise<string>((resolve) => open.set(name, resolve));
    },
    fail(name: string): Promise<string> {
      dispatched.push(name);
      return Promise.reject(new Error(name));
    },
    finish(name: string) {
      const resolve = open.get(name);
      open.delete(name);
      resolve?.(name);
    },
  };
}

/** Lets every already-resolved promise chain settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('engine idle lane', () => {
  beforeEach(() => resetEngineIdleLane());

  it('holds background work back while an interactive request is outstanding', async () => {
    const engine = fakeEngine();
    const user = trackInteractive(() => engine.send('user'));
    const sweep = submitIdle(() => engine.send('sweep'), () => true);
    await settle();
    expect(engine.dispatched).toEqual(['user']);

    engine.finish('user');
    await user;
    await settle();
    expect(engine.dispatched).toEqual(['user', 'sweep']);
    engine.finish('sweep');
    expect(await sweep).toBe('sweep');
    expect(interactiveInFlight()).toBe(0);
  });

  it('lets an interactive request jump ahead of a queued sweep', async () => {
    const engine = fakeEngine();
    const first = trackInteractive(() => engine.send('user-1'));
    const sweep = submitIdle(() => engine.send('sweep'), () => true);
    await settle();
    // The second user operation arrives while the sweep is still waiting.
    const second = trackInteractive(() => engine.send('user-2'));
    engine.finish('user-1');
    await first;
    await settle();
    expect(engine.dispatched).toEqual(['user-1', 'user-2']);

    engine.finish('user-2');
    await second;
    await settle();
    expect(engine.dispatched).toEqual(['user-1', 'user-2', 'sweep']);
    engine.finish('sweep');
    await sweep;
  });

  it('runs one sweep at a time, so several opens cannot stack up in the FIFO', async () => {
    const engine = fakeEngine();
    const a = submitIdle(() => engine.send('sweep-a'), () => true);
    const b = submitIdle(() => engine.send('sweep-b'), () => true);
    await settle();
    expect(engine.dispatched).toEqual(['sweep-a']);

    engine.finish('sweep-a');
    await a;
    await settle();
    expect(engine.dispatched).toEqual(['sweep-a', 'sweep-b']);
    engine.finish('sweep-b');
    await b;
  });

  it('never submits a run superseded while it waited', async () => {
    const engine = fakeEngine();
    const user = trackInteractive(() => engine.send('user'));
    let current = true;
    const sweep = submitIdle(() => engine.send('sweep'), () => current);
    await settle();
    current = false; // the document changed, or a re-check superseded this run
    engine.finish('user');
    await user;
    expect(await sweep).toBeNull();
    expect(engine.dispatched).toEqual(['user']);
  });

  it('a failing sweep does not wedge the lane', async () => {
    const engine = fakeEngine();
    const bad = submitIdle(() => engine.fail('sweep-bad'), () => true);
    await expect(bad).rejects.toThrow('sweep-bad');
    const good = submitIdle(() => engine.send('sweep-good'), () => true);
    await settle();
    expect(engine.dispatched).toEqual(['sweep-bad', 'sweep-good']);
    engine.finish('sweep-good');
    await good;
  });

  it('counts an interactive request only while it is outstanding', async () => {
    const engine = fakeEngine();
    const user = trackInteractive(() => engine.send('user'));
    expect(interactiveInFlight()).toBe(1);
    engine.finish('user');
    await user;
    expect(interactiveInFlight()).toBe(0);
  });
});


// The bound the lane actually promises: ONE STEP.
//
// The earlier shape checked idleness once, before handing over a whole sweep,
// and a sweep is one unbounded traversal of one document. A user request
// arriving a moment later waited for all of it. What is pinned below is the
// replacement promise, stated as an order of handover: the user request goes
// over ahead of the sweep's NEXT step, and the only thing it waits for is the
// step already in flight.
describe('a user request arriving mid-sweep', () => {
  beforeEach(() => resetEngineIdleLane());

  /** A sweep of `count` bounded steps, each submitted through the gate. */
  function steppedSweep(engine: ReturnType<typeof fakeEngine>, count: number) {
    return submitIdle(async (gate) => {
      for (let i = 0; i < count; i += 1) await gate(() => engine.send(`step-${i}`));
      return 'swept';
    }, () => true);
  }

  it('reaches the engine before any further health work', async () => {
    const engine = fakeEngine();
    const sweep = steppedSweep(engine, 3);
    await settle();
    expect(engine.dispatched).toEqual(['step-0']);

    // The user acts while the first step is still in the engine.
    const user = trackInteractive(() => engine.send('user'));
    expect(engine.dispatched).toEqual(['step-0', 'user']);

    engine.finish('step-0');
    await settle();
    // The step that was in flight finished; the next one did NOT go over,
    // because the user request is still outstanding.
    expect(engine.dispatched).toEqual(['step-0', 'user']);

    engine.finish('user');
    await user;
    await settle();
    expect(engine.dispatched).toEqual(['step-0', 'user', 'step-1']);
    engine.finish('step-1');
    await settle();
    engine.finish('step-2');
    expect(await sweep).toBe('swept');
  });

  it('waits for at most the one step already in flight', async () => {
    const engine = fakeEngine();
    const sweep = steppedSweep(engine, 8);
    await settle();
    const user = trackInteractive(() => engine.send('user'));
    engine.finish('step-0');
    await settle();
    // Not step-1..step-7: the sweep is not queued ahead of the user at all.
    expect(engine.dispatched).toEqual(['step-0', 'user']);
    engine.finish('user');
    await user;
    await settle();
    expect(engine.dispatched).toEqual(['step-0', 'user', 'step-1']);
    engine.finish('step-1');
    await settle();
    for (let i = 2; i < 8; i += 1) {
      engine.finish(`step-${i}`);
      await settle();
    }
    expect(await sweep).toBe('swept');
  });

  it('abandons the run at the next step boundary once it is superseded', async () => {
    const engine = fakeEngine();
    let current = true;
    const sweep = submitIdle(async (gate) => {
      await gate(() => engine.send('step-0'));
      await gate(() => engine.send('step-1'));
      return 'swept';
    }, () => current);
    await settle();
    expect(engine.dispatched).toEqual(['step-0']);
    current = false; // the document changed, or a re-check superseded this run
    engine.finish('step-0');
    // `null`, never a failure: nothing was determined about the current bytes.
    expect(await sweep).toBeNull();
    expect(engine.dispatched).toEqual(['step-0']);
  });
});

// The window between a user asking for something and the engine hearing about
// it. `call` runs the commit gate and takes a file lock first, and both can
// take arbitrarily long; a lane that only counted a request once it reached
// the engine read the engine as idle for that whole window.
describe('interactive is counted from the request, not the dispatch', () => {
  beforeEach(() => resetEngineIdleLane());

  it('holds background work back while an operation is still gating', async () => {
    const engine = fakeEngine();
    const release = beginInteractive(); // gate and lock run here
    expect(interactiveInFlight()).toBe(1);
    const sweep = submitIdle((gate) => gate(() => engine.send('sweep')), () => true);
    await settle();
    expect(engine.dispatched).toEqual([]);

    release();
    await settle();
    expect(engine.dispatched).toEqual(['sweep']);
    engine.finish('sweep');
    expect(await sweep).toBe('sweep');
    expect(interactiveInFlight()).toBe(0);
  });

  it('releases once even when the release is called twice', () => {
    const release = beginInteractive();
    release();
    release();
    expect(interactiveInFlight()).toBe(0);
  });
});
