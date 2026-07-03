// Commit gate: lets low-level call paths (engine operations, undo snapshots)
// flush pending in-memory page edits to disk before they read or replace file
// bytes, without every one of the 16 operation panels having to know the page
// tier exists. AppContent registers its commitIfNeeded here; tauri-bridge's
// file.snapshot and useEngine's mutating calls await it.
type Gate = () => Promise<void>;

let gate: Gate | null = null;
let inflight: Promise<void> | null = null;

export function setCommitGate(fn: Gate | null): void {
  gate = fn;
}

// Concurrent callers share one run. Errors propagate so a blocked operation
// aborts instead of running against stale bytes. The commit implementation
// itself must use the raw (ungated) bridge functions or this would deadlock.
export function runCommitGate(): Promise<void> {
  if (!gate) return Promise.resolve();
  if (inflight) return inflight;
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
