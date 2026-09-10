import type { AppAction, AppState, OpenFile, PdfBuffer } from '../state/types';
import { tChrome } from '../i18n';
import { withFileLock } from './engine-lock';
import { serializeWorkspacePublication } from './workspace-publication';
import { hasPendingPageCommit, publishPageCommit, recoverPendingPageCommit, type PageCommitIo } from './page-commit-transaction';

export interface WorkspaceRewriteIo {
  confirm: (path: string, workingPath: string) => Promise<boolean>;
  commit: () => Promise<void>;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  read: (path: string) => Promise<Uint8Array>;
  remove: (path: string) => Promise<void>;
  countPages: (bytes: Uint8Array) => Promise<number>;
  transaction: PageCommitIo;
}
function copy(value: PdfBuffer): Uint8Array<ArrayBuffer> {
  return value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value);
}
async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
function changed(): Error { return new Error(tChrome('app.history.changed')); }
function sameRevision(now: AppState, expected: AppState, path: string): boolean {
  return now.files.get(path) === expected.files.get(path)
    && now.pageDirtyPaths === expected.pageDirtyPaths
    && now.pageUndoStack === expected.pageUndoStack && now.pageRedoStack === expected.pageRedoStack;
}

/** Stage the entire rewrite before replacing any working bytes. The commit
 * gate is outside the locks; builders operate only on their unique stage and
 * must not re-enter a gated engine transport. */
export async function rewriteWorkspaceFile<T>(path: string, getState: () => AppState,
  dispatch: (action: AppAction) => void, io: WorkspaceRewriteIo,
  build: (stage: string, original: Uint8Array, requireCurrent: () => void) => Promise<T>,
  options: { kind: 'forms' | 'operation'; preservePageCount?: boolean; unverified: () => Error;
    track?: (run: () => Promise<T>) => Promise<T> },
): Promise<{ completed: true; value: T; publication: OpenFile } | { completed: false }> {
  const before = getState();
  const initial = before.files.get(path);
  if (!initial || initial.importOnly) throw new Error(tChrome('refusal.file.noLongerOpen'));
  if (!await io.confirm(path, initial.workingPath)) return { completed: false };
  if (!sameRevision(getState(), before, path)) throw changed();
  await io.commit();
  const expected = getState();
  const current = expected.files.get(path);
  if (!current?.buffer || current.importOnly || current.workingPath !== initial.workingPath
      || expected.pageDirtyPaths.length) throw changed();
  let publication: OpenFile | undefined;
  const publish = () => serializeWorkspacePublication(() => withFileLock([current.workingPath], async () => {
    await recoverPendingPageCommit();
    const requireCurrent = () => { if (!sameRevision(getState(), expected, path)) throw changed(); };
    requireCurrent();
    const original = copy(current.buffer!);
    const expectedWorkingSha256 = await digest(original);
    const stage = `${current.workingPath}.${options.kind}-${crypto.randomUUID()}.pdf`;
    const cleanup = async () => { await io.remove(stage).catch(() => {}); };
    try {
      const value = await build(stage, original, requireCurrent);
      const buffer = (await io.read(stage)).slice();
      const pageCount = await io.countPages(buffer.slice());
      if (!Number.isSafeInteger(pageCount) || pageCount < 1
          || options.preservePageCount && pageCount !== current.pageCount) throw options.unverified();
      const expectedStagedSha256 = await digest(buffer);
      requireCurrent();
      await publishPageCommit(io.transaction,
        [{ workingPath: current.workingPath, stagedPath: stage, expectedWorkingSha256, expectedStagedSha256 }],
        snapshots => {
          requireCurrent();
          dispatch({ type: 'UPDATE_FILE', path, buffer, pageCount, snapshotPath: snapshots[0] });
          if (getState().files.get(path)?.buffer !== buffer) throw changed();
          publication = getState().files.get(path)!;
        }, cleanup);
      return value;
    } finally {
      if (!hasPendingPageCommit()) await cleanup();
    }
  }));
  // Refresh consent before tracking a write, rather than recording a declined
  // prompt as a completed operation. The locked revision check still fences drift.
  if (current.buffer !== initial.buffer && !await io.confirm(path, current.workingPath)) return { completed: false };
  if (!sameRevision(getState(), expected, path)) throw changed();
  const value = await (options.track ? options.track(publish) : publish());
  // Captured at dispatch, not by re-reading after an acknowledgement await:
  // another publication may already be current by then.
  return { completed: true, value, publication: publication! };
}
