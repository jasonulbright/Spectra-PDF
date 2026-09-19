// Document ownership across windows.
//
// A path is live in at most one window. The arbiter is process-wide managed
// state on the Rust side, not a map in this module: a second window is a
// second module scope, so a JavaScript map would start empty and grant
// everything. The claim is taken at the open funnel, BEFORE any bytes are
// read, so a refusal costs nothing and leaks no working copy.
//
// What exclusivity buys is that no "whose document is this" question needs a
// merge policy. Two windows can never hold the same file, so their dirty sets
// cannot intersect, their page tiers cannot address the same bytes, and the
// per-window commit guard, file lock and generation counter each stay correct
// unchanged. The alternative — two independent edit sessions on two private
// working copies of one file — is reconciled by whichever save lands last,
// and the loser's whole session disappears with no error anywhere.

import { claims } from './tauri-bridge';

export type ClaimMode = 'write' | 'read';

export interface ClaimOutcome {
  granted: boolean;
  /** The window holding the path when `granted` is false. */
  owner: string;
}

/** A path that could not be claimed, with the window that holds it. */
export interface ClaimRefusal {
  path: string;
  owner: string;
}

export interface ClaimPartition {
  granted: string[];
  refused: ClaimRefusal[];
}

// The arbiter's claim is idempotent per window and its release drops the
// window's claim whatever preceded it, so the ORDER in which one window's
// calls on a path are processed decides who holds the path afterwards. Both
// are async commands, and arrival order does not fix processing order: a
// close's release still in flight when a reopen claims the same path can be
// processed second and leave the reopened document with no claim. Each call
// on a path is therefore sent only after the previous call on that path from
// this window has answered, whatever its outcome.
const lastCallOnPath = new Map<string, Promise<void>>();

function inPathOrder<T>(path: string, call: () => Promise<T>): Promise<T> {
  const previous = lastCallOnPath.get(path) ?? Promise.resolve();
  const current = previous.then(call);
  const settled = current.then(
    () => {},
    () => {},
  );
  lastCallOnPath.set(path, settled);
  void settled.then(() => {
    if (lastCallOnPath.get(path) === settled) lastCallOnPath.delete(path);
  });
  return current;
}

/**
 * Claim every path, keeping what was granted and reporting what was not.
 *
 * Partial success is the right shape: a multi-file open whose second file
 * belongs to another window still opens the first, and the refusal names only
 * what it stopped. Claims are taken one at a time because the arbiter is
 * per-path and a batch that failed atomically would refuse an entire drop over
 * one file.
 */
export async function claimPaths(
  paths: readonly string[],
  mode: ClaimMode,
): Promise<ClaimPartition> {
  const granted: string[] = [];
  const refused: ClaimRefusal[] = [];
  for (const path of paths) {
    const outcome = await inPathOrder(path, () => claims.claim(path, mode));
    if (outcome.granted) granted.push(path);
    else refused.push({ path, owner: outcome.owner });
  }
  return { granted, refused };
}

/**
 * The single window a refusal set points at, or null when it points at more
 * than one. Only a single owner can be offered as somewhere to go.
 */
export function soleOwner(refused: readonly ClaimRefusal[]): string | null {
  if (refused.length === 0) return null;
  const first = refused[0].owner;
  return refused.every((r) => r.owner === first) ? first : null;
}

/** Release each path this window no longer holds. Failures are ignored: the
 * window's own destruction releases everything it held. */
export async function releasePaths(paths: readonly string[]): Promise<void> {
  // Every release takes its place in its path's order now, not after the
  // releases before it answer: a claim made meanwhile must queue behind it.
  await Promise.all(
    paths.map((path) =>
      inPathOrder(path, () => claims.release(path)).catch(() => {
        // The claim outlives only this window; a failed release is not a
        // state the user can be asked to do anything about.
      }),
    ),
  );
}
