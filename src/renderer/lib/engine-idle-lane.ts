// The engine's IDLE lane.
//
// INVARIANT: a user-requested engine operation never waits behind a background
// sweep. The Python engine is one process reading one request at a time, so
// anything already handed to it is ahead of everything submitted later — the
// operation queue and the commit gate sit above that FIFO and do not reorder
// it. Work that no user asked for is therefore submitted HERE instead: one run
// at a time, and only while nothing interactive is outstanding.
//
// Two things are enforced, and they are not the same thing:
//
//   * ONE AT A TIME — several documents opening at once would otherwise hand
//     the FIFO one full traversal per document, and the next interactive
//     request would queue behind all of them.
//   * SUBMITTED WHILE IDLE — a run is handed over only when no interactive
//     request is in flight, and its currency is re-asked at that moment, so a
//     run whose document changed (or whose re-check superseded it) is dropped
//     before it costs the engine anything.
//
// A run already handed to the engine cannot be recalled: the engine has no
// cancel. `null` therefore means "never submitted", and a caller that gets it
// must record no evidence rather than a failure.

/** Interactive engine requests currently outstanding. */
let interactive = 0;
let waiting: (() => void)[] = [];
/** The lane's tail: each submission chains onto the previous one. */
let tail: Promise<unknown> = Promise.resolve();

/** Count one interactive request for as long as `run` is outstanding. */
export function trackInteractive<T>(run: () => Promise<T>): Promise<T> {
  interactive += 1;
  return run().finally(() => {
    interactive -= 1;
    if (interactive === 0) {
      const woken = waiting;
      waiting = [];
      for (const resolve of woken) resolve();
    }
  });
}

/** Resolves once no interactive engine request is outstanding. */
export function whenEngineIdle(): Promise<void> {
  if (interactive === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
  }).then(() => whenEngineIdle());
}

/**
 * Run background engine work in the idle lane.
 *
 * Resolves to `null` when `isCurrent` answers false at submission time — the
 * run was superseded while it waited, and was never sent.
 */
export function submitIdle<T>(
  run: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | null> {
  const queued = tail.then(async (): Promise<T | null> => {
    if (!isCurrent()) return null;
    await whenEngineIdle();
    // Asked AGAIN after the wait: the document can have changed, or a
    // re-check can have superseded this run, during it.
    if (!isCurrent()) return null;
    return run();
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
