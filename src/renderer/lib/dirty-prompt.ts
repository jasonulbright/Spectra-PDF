import type { AppState } from '../state/types';

/** Snapshot of the unsaved state named by a close or exit confirmation. */
export interface DirtyPromptSnapshot {
  path: string;
  /** User-visible edits, excluding an indexer's read-back of committed bytes. */
  editRevision: number;
  /** Byte identity also catches a reopen or replacement at the same path. */
  bufferRevision: object | null;
}

export function dirtyPromptSnapshots(state: AppState, paths: readonly string[]): DirtyPromptSnapshot[] {
  return paths.flatMap((path) => {
    const file = state.files.get(path);
    if (!file || !(file.dirty || state.pageDirtyPaths.includes(path))) return [];
    return [{ path, editRevision: file.editRevision ?? 0, bufferRevision: file.buffer }];
  });
}

export type DirtyPromptChoice = 'save' | 'discard' | 'cancel';

export function sameDirtyPromptSnapshot(
  left: DirtyPromptSnapshot,
  right: DirtyPromptSnapshot,
): boolean {
  return (
    left.path === right.path &&
    left.editRevision === right.editRevision &&
    left.bufferRevision === right.bufferRevision
  );
}

/** Dirty state that was not represented by an unchanged, already-answered prompt. */
export function unconfirmedDirtySnapshots(
  confirmed: ReadonlyMap<string, DirtyPromptSnapshot>,
  current: readonly DirtyPromptSnapshot[],
): DirtyPromptSnapshot[] {
  return current.filter((snapshot) => {
    const prior = confirmed.get(snapshot.path);
    return !prior || !sameDirtyPromptSnapshot(prior, snapshot);
  });
}

/** Repeat the prompt when new dirty state arrives while a dialog or save is
 * outstanding. Each answer covers only the revisions that the prompt named. */
export async function confirmDirtySnapshots(
  current: () => readonly DirtyPromptSnapshot[],
  decide: (pending: readonly DirtyPromptSnapshot[]) => Promise<DirtyPromptChoice>,
  save: (pending: readonly DirtyPromptSnapshot[]) => Promise<boolean>,
  previouslyConfirmed: readonly DirtyPromptSnapshot[] = [],
): Promise<boolean> {
  const confirmed = new Map(previouslyConfirmed.map((snapshot) => [snapshot.path, snapshot]));
  while (true) {
    const pending = unconfirmedDirtySnapshots(confirmed, current());
    if (pending.length === 0) return true;
    const choice = await decide(pending);
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await save(pending))) return false;
    for (const snapshot of pending) confirmed.set(snapshot.path, snapshot);
  }
}

/**
 * Write one file in place and report whether it may be marked saved: only when
 * its dirty snapshot is unchanged across the write, so edits made while the
 * write was in flight stay unsaved. `false` from `write` means the write was
 * refused and nothing is marked.
 */
export async function saveKeepingLaterEdits(
  readState: () => AppState,
  path: string,
  write: () => Promise<boolean>,
): Promise<{ written: boolean; markSaved: boolean }> {
  const before = dirtyPromptSnapshots(readState(), [path])[0];
  if (!(await write())) return { written: false, markSaved: false };
  const after = dirtyPromptSnapshots(readState(), [path])[0];
  return { written: true, markSaved: !!before && !!after && sameDirtyPromptSnapshot(before, after) };
}
