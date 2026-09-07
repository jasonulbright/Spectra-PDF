// The engine's IDLE lane.
//
// INVARIANT: a user-requested engine operation never waits behind a background
// sweep for longer than ONE bounded step.
//
// That bound is the whole guarantee, stated exactly. The Python engine is one
// process reading one request at a time and it has no cancel, so anything
// already handed to it runs to completion — the operation queue and the commit
// gate sit above that FIFO and do not reorder it. A background sweep is
// therefore never handed over WHOLE. It is submitted here as a sequence of
// bounded requests, and every one of them passes through `gate`, which waits
// for the engine to be idle first. A user request arriving mid-sweep is
// dispatched immediately by the interactive path and reaches the engine ahead
// of the sweep's next step; what it waits for is the step already in flight,
// and nothing more.
//
// What is NOT guaranteed: preemption. A step already handed over finishes.
// The engine's own step bound (`document_health.py` `_STEP_PAGES`) is the
// other half of this promise — a lane that gated unbounded steps would gate
// nothing.
//
// Three things are enforced, and they are not the same thing:
//
//   * ONE RUN AT A TIME — several documents opening at once would otherwise
//     interleave their steps and each would finish later than the last.
//   * EVERY STEP SUBMITTED WHILE IDLE — not just the first. Checking idleness
//     once, before a whole sweep, is the defect this shape exists to remove.
//   * INTERACTIVE FROM THE REQUEST, NOT FROM THE DISPATCH — `beginInteractive`
//     is called before the commit gate runs, so the window in which a user
//     operation is gating-and-locking but not yet counted (during which the
//     lane would read the engine as idle and submit another step) does not
//     exist.
//
// A run already handed to the engine cannot be recalled. `null` therefore
// means "abandoned before the next step", and a caller that gets it must
// record no evidence rather than a failure.

/** Interactive engine requests currently outstanding. */
let interactive = 0;
let waiting: (() => void)[] = [];
/** The lane's tail: each submission chains onto the previous one. */
let tail: Promise<unknown> = Promise.resolve();

/** Thrown out of `gate` when the run was superseded while it waited. Private:
 * `submitIdle` translates it to `null` and it never reaches a caller. */
const SUPERSEDED = Symbol('idle-lane-superseded');

/**
 * Count one interactive request from NOW until the returned release is called.
 *
 * Called at the top of the interactive path — before the commit gate, before
 * the file lock — because the lane's question is "has a user asked for
 * something", not "has a request reached the engine".
 */
export function beginInteractive(): () => void {
  interactive += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    interactive -= 1;
    if (interactive === 0) {
      const woken = waiting;
      waiting = [];
      for (const resolve of woken) resolve();
    }
  };
}

/** Count one interactive request for as long as `run` is outstanding. */
export function trackInteractive<T>(run: () => Promise<T>): Promise<T> {
  const release = beginInteractive();
  return run().finally(release);
}

/** Resolves once no interactive engine request is outstanding. */
export function whenEngineIdle(): Promise<void> {
  if (interactive === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
  }).then(() => whenEngineIdle());
}

/**
 * Submits ONE bounded engine request of a background run.
 *
 * Every engine request a run makes goes through here: it waits for the engine
 * to be idle, re-asks whether the run is still wanted, and only then hands the
 * request over.
 */
export type IdleGate = <R>(send: () => Promise<R>) => Promise<R>;

/**
 * Run background engine work in the idle lane.
 *
 * `run` receives the gate it must submit each of its engine requests through.
 * Resolves to `null` when `isCurrent` answers false — before the run started,
 * or at any step boundary within it, in which case the run was abandoned
 * part-way and whatever it had collected is not evidence.
 */
export function submitIdle<T>(
  run: (gate: IdleGate) => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | null> {
  const gate: IdleGate = async (send) => {
    await whenEngineIdle();
    // Asked at EVERY step, not once per run: the document can change, or a
    // re-check can supersede this run, between two steps of it.
    if (!isCurrent()) throw SUPERSEDED;
    return send();
  };
  const queued = tail.then(async (): Promise<T | null> => {
    if (!isCurrent()) return null;
    await whenEngineIdle();
    if (!isCurrent()) return null;
    try {
      return await run(gate);
    } catch (err) {
      if (err === SUPERSEDED) return null;
      throw err;
    }
  });
  // The lane must survive a failing run: chaining the tail on the caller's
  // promise would leave every later submission rejected.
  tail = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

/** Drops the lane's state. The counters are module-scoped, so a caller that
 * needs a known starting point states it rather than inheriting one. */
export function resetEngineIdleLane(): void {
  interactive = 0;
  waiting = [];
  tail = Promise.resolve();
}

/** Interactive requests outstanding right now. */
export function interactiveInFlight(): number {
  return interactive;
}
