import type { AppState } from '../state/types';
import { withFileLock } from './engine-lock';
import { serializeWorkspacePublication } from './workspace-publication';

type CommitState = Pick<AppState, 'files' | 'pageDirtyPaths'>;

/**
 * The working paths a page-tier commit locks: one per dirty file, sorted.
 * The commit writes and reads back only dirty files; a page it copies from a
 * clean file comes from that file's in-memory buffer, and a clean file cannot
 * publish during the commit because every publisher holds the publication
 * lane. A dirty path with no open file has no working copy to lock.
 */
export function commitLockKeys(state: CommitState): string[] {
  const out = new Set<string>();
  for (const path of state.pageDirtyPaths) {
    const file = state.files.get(path);
    if (file) out.add(file.workingPath);
  }
  return Array.from(out).sort();
}

export interface PageCommitRunIo<T> {
  read: () => AppState;
  /** Recovers an unconfirmed earlier publication; takes no renderer lock. */
  recover: () => Promise<void>;
  /** Resolves once every document was indexed from its file's current bytes. */
  settle: () => Promise<void>;
  /** Writes the dirty files of `state`; runs only with every one of them locked. */
  commit: (state: AppState) => Promise<T>;
  /** The outcome of a run that finds no dirty page once settled. */
  clean: T;
}

/** At most this many lock-then-check rounds before the caller refuses. */
export const PAGE_COMMIT_ATTEMPTS = 3;

/**
 * One page-tier commit: exclusive locks on the dirty working paths, then the
 * publication lane, then the settled re-check, then the write. The dirty set
 * is read holding nothing; the lane is entered only once every lock is held,
 * so the commit never holds the lane while it waits for a reader. When the
 * settled dirty set names a working path the round did not lock, the round
 * releases the lane and its locks and starts again. Resolves to `null` when
 * every round found such a path.
 */
export async function runPageCommit<T>(io: PageCommitRunIo<T>): Promise<{ value: T } | null> {
  for (let attempt = 0; attempt < PAGE_COMMIT_ATTEMPTS; attempt++) {
    const locked = commitLockKeys(io.read());
    const outcome = await withFileLock(locked, () => serializeWorkspacePublication(async () => {
      await io.recover();
      await io.settle();
      const state = io.read();
      if (!commitLockKeys(state).every((key) => locked.includes(key))) return null;
      if (!state.pageDirtyPaths.length) return { value: io.clean };
      return { value: await io.commit(state) };
    }));
    if (outcome) return outcome;
  }
  return null;
}
