// One open per path in a window.
//
// The open funnel asks whether a path is open and then awaits its bytes (a
// working copy, a password prompt) before OPEN_FILE lands. A second open of
// the same path in that gap sees it unopened too: it prepares the file again,
// asks for the password again, and its OPEN_FILE replaces the first one's
// bytes and resets the page-edit history. So the first open of a path owns it
// until that open settles, and every other open of the path waits for it and
// takes its verdict.
//
// DOM-free and IPC-free, so the rule tests in Node.

export interface OpenFlights {
  /** Settles when the open of `path` in flight settles; undefined when none is. */
  pending(path: string): Promise<void> | undefined;
  /** Record an open of `path` in flight. The returned function settles it. */
  begin(path: string): () => void;
}

export function createOpenFlights(): OpenFlights {
  const flights = new Map<string, Promise<void>>();
  return {
    pending: (path) => flights.get(path),
    begin(path) {
      let settle: () => void = () => {};
      const flight = new Promise<void>((resolve) => {
        settle = resolve;
      });
      flights.set(path, flight);
      return () => {
        if (flights.get(path) === flight) flights.delete(path);
        settle();
      };
    },
  };
}

/** Serialize operations that read or replace the bytes behind a path within
 * one renderer. Open and import claims are exclusive across windows, but one
 * window may upgrade its own read claim to a write claim; this lock closes
 * the corresponding same-window race. Multiple paths are acquired in stable
 * order so concurrent batches cannot deadlock. */
export interface PathOperationLock {
  run<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T>;
}

export function createPathOperationLock(): PathOperationLock {
  const tails = new Map<string, Promise<void>>();

  const acquire = async (path: string): Promise<() => void> => {
    const previous = tails.get(path) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => owned);
    tails.set(path, tail);
    await previous;
    return () => {
      if (tails.get(path) === tail) tails.delete(path);
      release();
    };
  };

  return {
    async run<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
      const releases: (() => void)[] = [];
      try {
        for (const path of [...new Set(paths)].sort()) releases.push(await acquire(path));
        return await operation();
      } finally {
        for (let i = releases.length - 1; i >= 0; i--) releases[i]();
      }
    },
  };
}

/**
 * - `reactivated`: the path was open as a document and came forward.
 * - `opened`: this call read the bytes and landed OPEN_FILE.
 * - `refused`: this call read nothing it could open (a cancelled prompt, a
 *   file the engine refused); it said so itself.
 * - `deferred`: another open of the path was in flight and did not open it,
 *   and that open said why.
 */
export type OpenStep = 'reactivated' | 'opened' | 'refused' | 'deferred';

/** Open `path` once: wait for an open of it already in flight, then bring the
 * document forward, or open it while every later open of it waits. */
export async function openPathOnce(
  flights: OpenFlights,
  path: string,
  step: {
    /** Whether `path` is open as a document now. */
    isOpen: () => boolean;
    reactivate: () => Promise<void>;
    /** Read the bytes and land OPEN_FILE; false when nothing was opened. */
    open: () => Promise<boolean>;
  },
): Promise<OpenStep> {
  const inFlight = flights.pending(path);
  if (inFlight) await inFlight;
  if (step.isOpen()) {
    await step.reactivate();
    return 'reactivated';
  }
  if (inFlight) return 'deferred';
  const settle = flights.begin(path);
  try {
    return (await step.open()) ? 'opened' : 'refused';
  } finally {
    settle();
  }
}
