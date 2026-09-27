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
): Promise<boolean> {
  const confirmed = new Map<string, DirtyPromptSnapshot>();
  while (true) {
    const pending = unconfirmedDirtySnapshots(confirmed, current());
    if (pending.length === 0) return true;
    const choice = await decide(pending);
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await save(pending))) return false;
    for (const snapshot of pending) confirmed.set(snapshot.path, snapshot);
  }
}
