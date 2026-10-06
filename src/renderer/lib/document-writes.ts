import { tChrome } from '../i18n';

// Writes of a working copy that are in progress, recorded from the start of
// the gesture that asks for them (before its own gate, its consent prompt and
// its write chain), and documents that are leaving this window. A document
// leaves only once no write of it is recorded, so the window it moves to
// receives every result. While it leaves, a write that continues a gesture
// recorded before the move is admitted and waited for; a gesture that starts
// during the move refuses before its first await and cancels the move, unless
// the move has already handed the document over.
const inFlight = new Map<string, Set<Promise<void>>>();
/** Per leaving path: the moves under way, and whether a gesture refused
 * because of them since they began. */
const leaving = new Map<string, { moves: number; refused: boolean }>();

/** Records a write of every path in `paths` until the returned function runs.
 * Throws the move refusal, synchronously and recording nothing, when one of
 * them is leaving and has no write recorded. */
export function beginDocumentWrites(paths: readonly string[]): () => void {
  const refused = paths.filter(path => leaving.has(path) && !inFlight.get(path)?.size);
  if (refused.length) {
    for (const path of refused) leaving.get(path)!.refused = true;
    throw new Error(tChrome('app.window.moveRefusedAction'));
  }
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const unique = Array.from(new Set(paths));
  for (const path of unique) {
    let writes = inFlight.get(path);
    if (!writes) {
      writes = new Set();
      inFlight.set(path, writes);
    }
    writes.add(done);
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    for (const path of unique) {
      const current = inFlight.get(path);
      current?.delete(done);
      if (current && !current.size) inFlight.delete(path);
    }
    finish();
  };
}

export function beginDocumentWrite(workingPath: string): () => void {
  return beginDocumentWrites([workingPath]);
}

/** Runs `run` recorded as a write of `paths` from this call until it settles;
 * a refusal is returned as a rejected promise. */
export function withDocumentWrite<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
  let ended: () => void;
  try {
    ended = beginDocumentWrites(paths);
  } catch (error) {
    return Promise.reject(error);
  }
  let result: Promise<T>;
  try {
    result = run();
  } catch (error) {
    ended();
    return Promise.reject(error);
  }
  return result.finally(ended);
}

/**
 * Runs `leave` once no write of `workingPath` is recorded, whatever the
 * outcome of each. From this call until `leave` settles, a write that starts
 * a new gesture on the path refuses at once; `leave` reads `cancelled()`
 * before it hands the document over, and stays when a gesture was refused,
 * and reads it again after the hand-over to report a gesture refused then.
 * Holds no lock: a write never waits for a document to leave.
 */
export async function whileDocumentLeaves<T>(workingPath: string,
  leave: (cancelled: () => boolean) => Promise<T>): Promise<T> {
  const entry = leaving.get(workingPath) ?? { moves: 0, refused: false };
  entry.moves++;
  leaving.set(workingPath, entry);
  try {
    for (let writes = inFlight.get(workingPath); writes?.size; writes = inFlight.get(workingPath)) {
      await Promise.all(Array.from(writes));
    }
    return await leave(() => entry.refused);
  } finally {
    entry.moves--;
    if (!entry.moves) leaving.delete(workingPath);
  }
}

/** Test seam: how many paths have a write in progress. */
export function __documentWriteCount(): number {
  return inFlight.size;
}
