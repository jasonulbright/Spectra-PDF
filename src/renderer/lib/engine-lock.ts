/**
 * Per-file serialization for engine operations — 9-§I.5 P17.
 *
 * The commit gate guarantees the engine reads bytes matching what the user
 * sees; it does NOT guarantee that two independent whole-file operations
 * targeting the SAME file cannot run at once. `useOperationQueue`'s `track`
 * is a visible-progress list, not a lock. In practice the UI is modal enough
 * that it is hard to trigger, and every op writes a temp then renames — but
 * "hard to trigger" and "each write is atomic" are not the same as "two
 * writes to one file cannot interleave", and the losing write silently wins
 * on whichever rename lands last.
 *
 * So: an operation takes a lock on every file path it names, and releases it
 * when it settles. Rules that make this safe rather than a new deadlock
 * surface:
 *
 *   - ALL of an operation's paths are claimed in ONE synchronous step,
 *     before any await. JavaScript is single-threaded, so nothing can
 *     interleave between the claims — which means two operations can never
 *     hold a partial, opposing subset of each other's paths. There is no
 *     cycle to deadlock on.
 *   - The lock is released in a `finally`. A rejected operation must not
 *     wedge the file it failed on.
 *   - Waiting uses `allSettled`, never `all`: a PREVIOUS operation's failure
 *     is its caller's business, and must not reject the next one in line.
 *   - The commit gate runs OUTSIDE the lock, by construction — the gate
 *     itself writes files, so gating from inside would have an operation
 *     wait on a commit that is waiting on the operation.
 */

/** Keys the engine's own signatures use for a file path. */
const PATH_KEYS = ['file', 'output', 'source', 'dest', 'path', 'output_path'] as const;
/** …and for a LIST of file paths (merge, portfolio, batch inputs). */
const PATH_LIST_KEYS = ['files', 'inputs', 'sources'] as const;

/** path → the promise the current holder settles. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Every file path an engine call names. Paths are compared as raw strings,
 * the M7 identity rule: producers canonicalize at the Rust boundary, so two
 * spellings of one file are already one string by the time they get here —
 * and "normalizing" locally with string tricks is the thing M7 forbids.
 */
export function lockKeysFor(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const v = params[key];
    if (typeof v === 'string' && v) out.push(v);
  }
  for (const key of PATH_LIST_KEYS) {
    const v = params[key];
    if (!Array.isArray(v)) continue;
    for (const item of v) if (typeof item === 'string' && item) out.push(item);
  }
  return Array.from(new Set(out)).sort();
}

/**
 * Run `body` with exclusive access to `keys`. With no keys it runs straight
 * through — a call that names no file cannot conflict with one that does.
 */
export async function withFileLock<T>(keys: string[], body: () => Promise<T>): Promise<T> {
  if (!keys.length) return body();
  const prior = keys.map((k) => chains.get(k)).filter(Boolean) as Promise<unknown>[];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Claim first, THEN wait: claiming before the first await is what makes
  // acquisition atomic, so a later caller sees this holder and queues behind
  // it instead of racing past.
  for (const k of keys) chains.set(k, held);
  if (prior.length) await Promise.allSettled(prior);
  try {
    return await body();
  } finally {
    release();
    // Only clear entries still pointing at THIS holder — a later operation
    // may already have claimed the key behind us.
    for (const k of keys) if (chains.get(k) === held) chains.delete(k);
  }
}

/** Test seam: whether any file is currently locked. */
export function __lockedCount(): number {
  return chains.size;
}
