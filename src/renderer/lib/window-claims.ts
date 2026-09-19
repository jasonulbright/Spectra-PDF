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
import type { OpenFile } from '../state/types';

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
export type CallOrder = <T>(key: string, call: () => Promise<T>) => Promise<T>;

export function createCallOrder(): CallOrder {
  const lastCallOn = new Map<string, Promise<void>>();
  return <T>(key: string, call: () => Promise<T>): Promise<T> => {
    const previous = lastCallOn.get(key) ?? Promise.resolve();
    const current = previous.then(call);
    const settled = current.then(
      () => {},
      () => {},
    );
    lastCallOn.set(key, settled);
    void settled.then(() => {
      if (lastCallOn.get(key) === settled) lastCallOn.delete(key);
    });
    return current;
  };
}

const inPathOrder = createCallOrder();

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

/** The flows of this window that hold the claim on each path while they run
 * (an open, an import), counted. The arbiter keeps one claim per path and
 * window, so each of them holds that same claim. */
export interface ClaimHolds {
  hold(paths: readonly string[]): void;
  drop(paths: readonly string[]): void;
  held(path: string): boolean;
}

export function createClaimHolds(): ClaimHolds {
  const counts = new Map<string, number>();
  return {
    hold(paths) {
      for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
    },
    drop(paths) {
      for (const path of paths) {
        const left = (counts.get(path) ?? 0) - 1;
        if (left > 0) counts.set(path, left);
        else counts.delete(path);
      }
    },
    held: (path) => (counts.get(path) ?? 0) > 0,
  };
}

/**
 * The byte-only import sources `previous` held that `next` no longer holds.
 *
 * A source leaves `files` once no page references it, and nothing else
 * releases its read claim: another window could not open that file for
 * editing until this window closed.
 */
export function departedImportSources(
  previous: ReadonlyMap<string, OpenFile>,
  next: ReadonlyMap<string, OpenFile>,
): string[] {
  return [...previous.values()].filter((f) => f.importOnly && !next.has(f.path)).map((f) => f.path);
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
 * window's own destruction releases everything it held.
 *
 * `inUse` is asked when the release's turn comes, not when it is called. The
 * arbiter keeps one claim per path and window, so another open, import or
 * document of this window that took the path meanwhile holds that same claim,
 * and the release would drop it; a path still in use is kept. */
export async function releasePaths(
  paths: readonly string[],
  inUse: (path: string) => boolean = () => false,
): Promise<void> {
  // Every release takes its place in its path's order now, not after the
  // releases before it answer: a claim made meanwhile must queue behind it.
  await Promise.all(
    paths.map((path) =>
      inPathOrder(path, async () => {
        if (!inUse(path)) await claims.release(path);
      }).catch(() => {
        // The claim outlives only this window; a failed release is not a
        // state the user can be asked to do anything about.
      }),
    ),
  );
}
