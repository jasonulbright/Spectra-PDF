import { tChrome } from '../i18n';

// Writes of a working copy that are in progress, from the moment the write is
// asked for (before its consent prompt, its commit gate and its write chain),
// and documents that are leaving this window. A document leaves only after
// every write already asked for has finished, so the window it moves to
// receives the write's result; a write asked for while the document leaves
// refuses before its first await, while the gesture that asked for it is
// still the one on screen.
const inFlight = new Map<string, Set<Promise<void>>>();
const leaving = new Map<string, number>();

/** Records a write of every path in `paths` until the returned function runs.
 * Throws the changed refusal, synchronously and recording nothing, while one
 * of them is leaving. */
export function beginDocumentWrites(paths: readonly string[]): () => void {
  if (paths.some(path => leaving.has(path))) throw new Error(tChrome('app.history.changed'));
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

/**
 * Runs `leave` once every write of `workingPath` asked for so far has
 * finished, whatever its outcome. From this call until `leave` settles, a new
 * write of the path refuses at once. Holds no lock: a write never waits for a
 * document to leave.
 */
export async function whileDocumentLeaves<T>(workingPath: string, leave: () => Promise<T>): Promise<T> {
  leaving.set(workingPath, (leaving.get(workingPath) ?? 0) + 1);
  try {
    await Promise.all(Array.from(inFlight.get(workingPath) ?? []));
    return await leave();
  } finally {
    const left = (leaving.get(workingPath) ?? 1) - 1;
    if (left > 0) leaving.set(workingPath, left);
    else leaving.delete(workingPath);
  }
}

/** Test seam: how many paths have a write in progress. */
export function __documentWriteCount(): number {
  return inFlight.size;
}
