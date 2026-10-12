import { tChrome, type UiKey } from '../i18n';

// Writes of a working copy that are in progress, recorded from the start of
// the gesture that asks for them (before its own gate, its consent prompt and
// its write chain), and documents that are leaving this window: moving to
// another one or closing. A document leaves only once no write of it is
// recorded, so the window it moves to, or the save prompt of its close,
// receives every result. While it leaves, a write that continues a gesture
// recorded before the leave began is admitted and waited for; a gesture that
// starts during the leave refuses before its first await and calls the leave
// off, unless the document has already been handed over.
const inFlight = new Map<string, Set<Promise<void>>>();

/** Why a document is leaving this window. */
export type LeaveKind = 'move' | 'close';

/** One leave of one or more paths: why it began, and whether a gesture
 * refused because of it since it began. */
interface LeaveScope { kind: LeaveKind; refused: boolean }
/** Per leaving path, its leaves under way in the order they began. Two leaves
 * of one path (an Exit's close and a move) keep their own records, so a
 * refusal before a leave began never calls that leave off. */
const leaving = new Map<string, Set<LeaveScope>>();
const listeners = new Set<() => void>();

const REFUSAL: Record<LeaveKind, UiKey> = {
  move: 'app.window.moveRefusedAction',
  close: 'app.close.refusedAction',
};

function changed(): void {
  for (const listener of listeners) {
    try { listener(); } catch (error) { queueMicrotask(() => { throw error; }); }
  }
}

/** Records a write of every path in `paths` until the returned function runs.
 * Throws the refusal of the leave, synchronously and recording nothing, when
 * one of them is leaving and has no write recorded. */
export function beginDocumentWrites(paths: readonly string[]): () => void {
  const refused = paths.filter(path => leaving.has(path) && !inFlight.get(path)?.size);
  if (refused.length) {
    for (const path of refused) for (const scope of leaving.get(path)!) scope.refused = true;
    const [oldest] = leaving.get(refused[0])!;
    throw new Error(tChrome(REFUSAL[oldest.kind]));
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
  if (unique.length) changed();
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
    if (unique.length) changed();
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

/** How many distinct writes of `paths` are recorded now. */
export function documentWritesOf(paths: readonly string[]): number {
  const writes = new Set<Promise<void>>();
  for (const path of paths) for (const write of inFlight.get(path) ?? []) writes.add(write);
  return writes.size;
}

/** Calls `listener` each time a write of any path is recorded or ends. */
export function onDocumentWritesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Resolves once no write of `paths` is recorded, whatever the outcome of
 * each, including writes recorded while it waits. */
export async function documentWritesDrained(paths: readonly string[]): Promise<void> {
  for (;;) {
    const writes = new Set<Promise<void>>();
    for (const path of paths) for (const write of inFlight.get(path) ?? []) writes.add(write);
    if (!writes.size) return;
    await Promise.all(writes);
  }
}

/**
 * Runs `leave` with `paths` marked as leaving for `kind`. From this call until
 * `leave` settles, a write that starts a new gesture on a path with no write
 * recorded refuses at once, with the refusal of the oldest leave of that
 * path. `leave` reads `cancelled()` before the documents go and stays when a
 * gesture was refused during this leave. `leave` decides how to wait for the
 * writes already recorded
 * (`documentWritesDrained`, or a wait the user can end). Holds no lock: a
 * write never waits for a document to leave.
 */
export async function whileDocumentsLeave<T>(paths: readonly string[], kind: LeaveKind,
  leave: (cancelled: () => boolean) => Promise<T>): Promise<T> {
  const unique = Array.from(new Set(paths));
  const scope: LeaveScope = { kind, refused: false };
  for (const path of unique) {
    let scopes = leaving.get(path);
    if (!scopes) {
      scopes = new Set();
      leaving.set(path, scopes);
    }
    scopes.add(scope);
  }
  try {
    return await leave(() => scope.refused);
  } finally {
    for (const path of unique) {
      const scopes = leaving.get(path);
      scopes?.delete(scope);
      if (scopes && !scopes.size) leaving.delete(path);
    }
  }
}

/**
 * Runs `leave` once no write of `workingPath` is recorded, whatever the
 * outcome of each: the move of one document to another window. `leave` reads
 * `cancelled()` before it hands the document over, and stays when a gesture
 * was refused, and reads it again after the hand-over to report a gesture
 * refused then.
 */
export function whileDocumentLeaves<T>(workingPath: string,
  leave: (cancelled: () => boolean) => Promise<T>): Promise<T> {
  return whileDocumentsLeave([workingPath], 'move', async (cancelled) => {
    await documentWritesDrained([workingPath]);
    return leave(cancelled);
  });
}

/** Test seam: how many paths have a write in progress. */
export function __documentWriteCount(): number {
  return inFlight.size;
}
