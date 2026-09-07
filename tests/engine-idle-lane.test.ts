// The background lane: WHAT IT STILL PROMISES.
//
// It used to hold background work back until the interactive engine was idle,
// because both shared one serial process. They no longer do: health inspection
// runs in its own killable worker sidecar, so nothing a background run submits
// can be ahead of a user's operation in the interactive FIFO.
//
// What is left, and what this file gates, is smaller and still load-bearing:
// one run at a time, and supersession asked at EVERY step rather than once per
// run. The fake below is the worker's only relevant property — one serial
// process — so "who goes first" is exactly the order requests are handed to it.
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

describe('the background lane', () => {
  beforeEach(() => resetEngineIdleLane());

  it('runs one background run at a time', async () => {
    // Several documents opening at once would otherwise interleave their steps
    // in the worker, and each would finish later than the last.
    const engine = fakeEngine();
    const first = submitIdle(() => engine.send('sweep-1'), () => true);
    const second = submitIdle(() => engine.send('sweep-2'), () => true);
    await settle();
    expect(engine.dispatched).toEqual(['sweep-1']);

    engine.finish('sweep-1');
    expect(await first).toBe('sweep-1');
    await settle();
    expect(engine.dispatched).toEqual(['sweep-1', 'sweep-2']);
    engine.finish('sweep-2');
    expect(await second).toBe('sweep-2');
  });

  it('does NOT wait for the interactive engine to be idle', async () => {
    // The invariant this file used to gate, now deliberately gone: health has
    // its own process, so delaying a background step while a user operation is
    // outstanding would postpone work that costs the user nothing.
    const engine = fakeEngine();
    const user = trackInteractive(() => engine.send('user'));
    const sweep = submitIdle(() => engine.send('sweep'), () => true);
    await settle();
    expect(engine.dispatched).toEqual(['user', 'sweep']);

    engine.finish('user');
    engine.finish('sweep');
    await user;
    expect(await sweep).toBe('sweep');
  });

  it('never submits a run superseded while it waited in the queue', async () => {
    const engine = fakeEngine();
    let wanted = true;
    const blocking = submitIdle(() => engine.send('sweep-1'), () => true);
    const queued = submitIdle(() => engine.send('sweep-2'), () => wanted);
    await settle();

    wanted = false;
    engine.finish('sweep-1');
    await blocking;
    await settle();
    expect(engine.dispatched).toEqual(['sweep-1']);
    expect(await queued).toBeNull();
  });

  it('abandons a run at the next step boundary once it is superseded', async () => {
    // Supersession is asked at EVERY step, not once per run: the document can
    // change, or a re-check can supersede this run, between two steps of it.
    const engine = fakeEngine();
    let wanted = true;
    const run = submitIdle(async (gate) => {
      await gate(() => engine.send('step-1'));
      await gate(() => engine.send('step-2'));
      return 'finished';
    }, () => wanted);
    await settle();
    expect(engine.dispatched).toEqual(['step-1']);

    wanted = false;
    engine.finish('step-1');
    expect(await run).toBeNull();
    await settle();
    // The step already handed over cannot be recalled; what supersession stops
    // is the NEXT one.
    expect(engine.dispatched).toEqual(['step-1']);
  });

  it('does not submit a run superseded before it started', async () => {
    const engine = fakeEngine();
    expect(await submitIdle(() => engine.send('sweep'), () => false)).toBeNull();
    expect(engine.dispatched).toEqual([]);
  });

  it('a failing run does not wedge the lane', async () => {
    // Chaining the tail on the caller's promise would leave every later
    // submission rejected.
    const engine = fakeEngine();
    await expect(submitIdle(() => engine.fail('boom'), () => true)).rejects.toThrow('boom');
    const next = submitIdle(() => engine.send('after'), () => true);
    await settle();
    engine.finish('after');
    expect(await next).toBe('after');
  });
});

describe('the interactive count the lane publishes', () => {
  beforeEach(() => resetEngineIdleLane());

  it('counts a request only while it is outstanding', async () => {
    const engine = fakeEngine();
    const user = trackInteractive(() => engine.send('user'));
    expect(interactiveInFlight()).toBe(1);
    engine.finish('user');
    await user;
    expect(interactiveInFlight()).toBe(0);
  });

  it('counts from the request, not from the dispatch', () => {
    // `beginInteractive` is called before the commit gate and the file lock,
    // because the question is "has a user asked for something", not "has a
    // request reached the engine".
    const release = beginInteractive();
    expect(interactiveInFlight()).toBe(1);
    release();
    expect(interactiveInFlight()).toBe(0);
  });

  it('releases once even when the release is called twice', () => {
    const release = beginInteractive();
    release();
    release();
    expect(interactiveInFlight()).toBe(0);
  });
});
