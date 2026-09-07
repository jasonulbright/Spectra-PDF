// The engine's idle lane: WHO GOES FIRST.
//
// The invariant under test is that a user-requested operation never waits
// behind a background sweep. The fake engine below is the real one's only
// relevant property — one serial FIFO — so "who goes first" is exactly the
// order in which requests are handed to it.
import { describe, it, expect, beforeEach } from 'vitest';
import {
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
