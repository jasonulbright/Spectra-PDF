// The BACKGROUND lane.
//
// INVARIANT: at most one background health run is outstanding at a time, and a
// run that stops being wanted is dropped at its next step boundary.
//
// That is the whole guarantee, stated exactly, and it is deliberately smaller
// than the one this lane used to carry. Health inspection no longer shares a
// process with the user's work: it runs in its own killable worker sidecar
// (`src-tauri/src/health_engine.rs`), reached through its own Tauri command,
// so an inspection cannot be ahead of a user operation in the interactive
// engine's FIFO no matter how long it takes. There is therefore nothing here
// to hold back FROM, and a lane that waited for interactive idleness would
// only be delaying work that costs the user nothing.
//
// Two things are still enforced, and they are not the same thing:
//
//   * ONE RUN AT A TIME — the worker is itself one serial process, so several
//     documents opening at once would otherwise interleave their steps and
//     each would finish later than the last.
//   * SUPERSESSION AT EVERY STEP, not once per run — the document can change,
//     or a re-check can supersede this run, between two steps of it.
//
// A step already handed to the worker cannot be recalled; what a superseded
// run stops is the NEXT one. `null` therefore means "abandoned before the next
// step", and a caller that gets it must record no evidence rather than a
// failure.

/** The lane's tail: each submission chains onto the previous one. */
let tail: Promise<unknown> = Promise.resolve();

// Outstanding INTERACTIVE requests. The lane publishes this count and no
// longer gates on it: since health moved to its own worker there is nothing
// here for a user operation to be held behind. It is the renderer-side answer
// to "is the user waiting on the engine right now", the local counterpart of
// the cross-window count `engine.rs` `publish_activity` emits.
let interactive = 0;

/**
 * Count one interactive request from NOW until the returned release is called.
 *
 * Called at the top of the interactive path — before the commit gate, before
 * the file lock — because the question is "has a user asked for something",
 * not "has a request reached the engine".
 */
export function beginInteractive(): () => void {
  interactive += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    interactive -= 1;
  };
}

/** Count one interactive request for as long as `run` is outstanding. */
export function trackInteractive<T>(run: () => Promise<T>): Promise<T> {
  const release = beginInteractive();
  return run().finally(release);
}

/** Interactive requests outstanding right now. */
export function interactiveInFlight(): number {
  return interactive;
}

/** Thrown out of `gate` when the run was superseded while it waited. Private:
 * `submitIdle` translates it to `null` and it never reaches a caller. */
const SUPERSEDED = Symbol('idle-lane-superseded');

/**
 * Submits ONE bounded worker request of a background run.
 *
 * Every request a run makes goes through here: it re-asks whether the run is
 * still wanted, and only then hands the request over.
 */
export type IdleGate = <R>(send: () => Promise<R>) => Promise<R>;

/**
 * Run background work in the lane.
 *
 * `run` receives the gate it must submit each of its requests through.
 * Resolves to `null` when `isCurrent` answers false — before the run started,
 * or at any step boundary within it, in which case the run was abandoned
 * part-way and whatever it had collected is not evidence.
 */
export function submitIdle<T>(
  run: (gate: IdleGate) => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | null> {
  const gate: IdleGate = async (send) => {
    // Asked at EVERY step, not once per run: the document can change, or a
    // re-check can supersede this run, between two steps of it.
    if (!isCurrent()) throw SUPERSEDED;
    return send();
  };
  const queued = tail.then(async (): Promise<T | null> => {
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

/** Drops the lane's state. The tail is module-scoped, so a caller that needs a
 * known starting point states it rather than inheriting one. */
export function resetEngineIdleLane(): void {
  tail = Promise.resolve();
  interactive = 0;
}
