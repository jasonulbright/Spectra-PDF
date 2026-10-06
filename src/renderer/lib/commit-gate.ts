import { hasWorkspacePublication, workspacePublicationsSettled } from './workspace-publication';

// Commit gate: lets low-level call paths (engine operations, undo snapshots)
// flush pending in-memory page edits to disk before they read or replace file
// bytes, without every one of the 16 operation panels having to know the page
// tier exists. AppContent registers its page commit here; tauri-bridge's
// file.snapshot and useEngine's mutating calls await it.
type Gate = () => Promise<void>;

let gate: Gate | null = null;
let inflight: Promise<void> | null = null;
/** Gates waiting for publications, each with the paths it names (`null`:
 * every path). Read by the end-to-end harness, which must see a gated call
 * blocked in its gate before it lets the publication it waits for go on. */
const waitingGates = new Set<{ paths: readonly string[] | null }>();

/** Registers the page commit. It commits every dirty file (cross-file moves
 * entangle them) and resolves at once when nothing is dirty, no page commit is
 * pending and the workspace is settled. */
export function setCommitGate(fn: Gate | null): void {
  gate = fn;
}

// Concurrent callers share one run. Errors propagate so a blocked operation
// aborts instead of running against stale bytes. The commit implementation
// itself must use the raw (ungated) bridge functions or this would deadlock.
// A joining caller runs the gate again once the shared run settles: that run
// planned before the caller arrived, so edits made in between stay pending.
function commitShared(): Promise<void> {
  if (!gate) return Promise.resolve();
  if (inflight) return inflight.then(() => commitShared());
  const current = gate;
  inflight = (async () => {
    try {
      await current();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Commits every dirty file through the shared run, and waits for no
 * publication. For a holder of a write chain: the commit takes no chain, so it
 * cannot wait for the holder, while a publication it would wait for (a disk
 * undo announced from its chain claim) can.
 */
export function commitPendingPageEdits(): Promise<void> {
  return commitShared();
}

/**
 * Flushes pending page edits, then waits for every outstanding publication
 * that may replace one of `paths` (working paths), then flushes again: what a
 * publication lands is indexed, and edits made while it ran are committed.
 * Without `paths` it waits for every outstanding publication.
 *
 * The caller holds no lock and no write chain. A publication never waits for
 * a gate, so waiting for one here cannot close a cycle; a caller holding the
 * write chain of a path would wait for a disk undo of that path, which is
 * announced while it waits for the chain. Only the publications outstanding when the
 * wait begins are awaited; the shared run is never extended by one caller's
 * wait, so a call on another document does not wait for it.
 */
export async function runCommitGate(paths?: readonly string[], before = Infinity): Promise<void> {
  await commitShared();
  if (!hasWorkspacePublication(paths, before)) return;
  const waiting = { paths: paths ?? null };
  waitingGates.add(waiting);
  try {
    await workspacePublicationsSettled(paths, before);
  } finally {
    waitingGates.delete(waiting);
  }
  await commitShared();
}

/** How many gates naming `path` (or every path) wait for a publication now. */
export function gatesWaitingFor(path: string): number {
  let count = 0;
  for (const gate of waitingGates) if (!gate.paths || gate.paths.includes(path)) count++;
  return count;
}
