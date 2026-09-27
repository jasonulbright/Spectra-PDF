/** Snapshot of the unsaved state named by a close or exit confirmation. */
export interface DirtyPromptSnapshot {
  path: string;
  /** The current OpenFile object; a replacement means the user is seeing new bytes. */
  fileRevision: object;
  /** Workspace documents for this path; page edits replace their objects. */
  pageRevisions: readonly object[];
}

export type DirtyPromptChoice = 'save' | 'discard' | 'cancel';

export function sameDirtyPromptSnapshot(
  left: DirtyPromptSnapshot,
  right: DirtyPromptSnapshot,
): boolean {
  return (
    left.path === right.path &&
    left.fileRevision === right.fileRevision &&
    left.pageRevisions.length === right.pageRevisions.length &&
    left.pageRevisions.every((page, index) => page === right.pageRevisions[index])
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
