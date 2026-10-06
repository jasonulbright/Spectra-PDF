import type { AppAction, AppState, OpenFile, PdfBuffer } from '../state/types';
import { tChrome } from '../i18n';
import { withFileLock, withWriteChain } from './engine-lock';
import { announceWorkspacePublication, serializeWorkspacePublication } from './workspace-publication';
import { hasPendingPageCommit, publishPageCommit, recoverPendingPageCommit, type PageCommitIo } from './page-commit-transaction';
import type { ReadPublishedBytes } from './workspace-settle';
import { releaseStageCredential, shareStageCredential } from './stage-credentials';

export interface WorkspaceRewriteIo {
  confirm: (path: string, workingPath: string) => Promise<boolean>;
  /** The commit gate for the working paths the rewrite acts on. */
  commit: (paths: readonly string[]) => Promise<void>;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  read: (path: string) => Promise<Uint8Array>;
  remove: (path: string) => Promise<void>;
  /** The page count and the documents of the staged bytes, placed with them. */
  index: ReadPublishedBytes;
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
function sameTier(now: AppState, expected: AppState): boolean {
  return now.pageDirtyPaths === expected.pageDirtyPaths
    && now.pageUndoStack === expected.pageUndoStack && now.pageRedoStack === expected.pageRedoStack;
}
function sameRevision(now: AppState, expected: AppState, path: string): boolean {
  return now.files.get(path) === expected.files.get(path) && sameTier(now, expected);
}
function emptyTier(state: AppState): boolean {
  return !state.pageDirtyPaths.length && !state.pageUndoStack.length && !state.pageRedoStack.length;
}

/**
 * Stage the entire rewrite before replacing any working bytes.
 *
 * Order: the commit gate holding nothing; the write chain of the working
 * path; then three phases. Phase 1, in the publication lane: recover a
 * pending page commit and capture the revision. Phase 2, under a SHARED lock
 * on the working path and outside the lane: the stage, the engine steps, the
 * read-back and the index. Phase 3: the exclusive lock, then the lane, then
 * the fence and the publication. Until phase 3 publishes, readers of the
 * working path read the bytes the user still sees, and other documents
 * publish freely; a save, a disk undo or another write of the path waits for
 * the chain, in issue order.
 *
 * The fence is per path: the file is still the captured one and none of its
 * pages is dirty. The rest of the page tier must be the captured one or
 * empty: replacing a file's bytes resets a live page tier (`withNewBytes` in
 * the reducer), so a page edit of another document still pending at the
 * publication refuses the rewrite, while one committed meanwhile does not.
 *
 * Builders operate only on their unique stage and must not re-enter a gated
 * engine transport.
 */
export async function rewriteWorkspaceFile<T>(path: string, getState: () => AppState,
  dispatch: (action: AppAction) => void, io: WorkspaceRewriteIo,
  build: (stage: string, original: Uint8Array, requireCurrent: () => void) => Promise<T>,
  options: { kind: 'forms' | 'operation'; preservePageCount?: boolean; unverified: () => Error;
    assertActive?: () => void;
    track?: (run: () => Promise<T>) => Promise<T> },
): Promise<{ completed: true; value: T; publication: OpenFile } | { completed: false }> {
  const before = getState();
  options.assertActive?.();
  const initial = before.files.get(path);
  if (!initial || initial.importOnly) throw new Error(tChrome('refusal.file.noLongerOpen'));
  if (!await io.confirm(path, initial.workingPath)) return { completed: false };
  options.assertActive?.();
  if (!sameRevision(getState(), before, path)) throw changed();
  // The gate commits through the lane and the dirty paths' locks; it runs
  // holding nothing, before the chain, never inside phase 1.
  await io.commit([initial.workingPath]);
  options.assertActive?.();
  const gated = getState();
  const current = gated.files.get(path);
  if (!current?.buffer || current.importOnly || current.workingPath !== initial.workingPath
      || gated.pageDirtyPaths.length) throw changed();
  const working = current.workingPath;
  const requireGated = () => {
    options.assertActive?.();
    const now = getState();
    if (now.files.get(path) !== current || now.pageDirtyPaths.length) throw changed();
  };
  let publication: OpenFile | undefined;
  const publish = () => withWriteChain([working], async () => {
    // A save, a disk undo or a write of this path that held the chain first
    // may have published.
    requireGated();
    const expected = await serializeWorkspacePublication(async () => {
      await recoverPendingPageCommit();
      requireGated();
      return getState();
    }, [working]);
    // Phase 2 check: only a change to this file, or a page edit on it, voids
    // the work in progress.
    const requireCurrent = () => {
      options.assertActive?.();
      const now = getState();
      if (now.files.get(path) !== current || now.pageDirtyPaths.includes(path)) throw changed();
    };
    const requireFence = () => {
      requireCurrent();
      const now = getState();
      if (!sameTier(now, expected) && !emptyTier(now)) throw changed();
    };
    const stage = `${working}.${options.kind}-${crypto.randomUUID()}.pdf`;
    let shared = false;
    const cleanup = async () => {
      await io.remove(stage).catch(() => {});
      if (shared) await releaseStageCredential(stage);
    };
    // Shared: a builder may read the working path itself (a sealed document's
    // plaintext), and no writer may replace it meanwhile.
    const staged = await withFileLock([{ key: working, mode: 'shared' }], async () => {
      requireCurrent();
      const original = copy(current.buffer!);
      const expectedWorkingSha256 = await digest(original);
      shared = await shareStageCredential(current, stage);
      const value = await build(stage, original, requireCurrent);
      const buffer = (await io.read(stage)).slice();
      // The reading runs on a copy; the documents describe the object dispatched.
      const { pageCount, documents: read } = await io.index(current, buffer.slice());
      if (!Number.isSafeInteger(pageCount) || pageCount < 1
          || options.preservePageCount && pageCount !== current.pageCount) throw options.unverified();
      const documents = read.map(d => ({ ...d, buffer }));
      return { value, buffer, pageCount, documents, expectedWorkingSha256, expectedStagedSha256: await digest(buffer) };
    }).catch(async (error: unknown) => {
      await cleanup();
      throw error;
    });
    // Announced from the claim on: a gate that names this path waits for the
    // publication while it still waits for the lock.
    const done = announceWorkspacePublication([working]);
    try {
      return await withFileLock([working], () => serializeWorkspacePublication(async () => {
        try {
          requireFence();
          await publishPageCommit(io.transaction,
            [{ workingPath: working, stagedPath: stage,
              expectedWorkingSha256: staged.expectedWorkingSha256, expectedStagedSha256: staged.expectedStagedSha256 }],
            snapshots => {
              requireFence();
              dispatch({ type: 'UPDATE_FILE', path, buffer: staged.buffer, pageCount: staged.pageCount,
                snapshotPath: snapshots[0], documents: staged.documents });
              if (getState().files.get(path)?.buffer !== staged.buffer) throw changed();
              publication = getState().files.get(path)!;
            }, cleanup);
          return staged.value;
        } finally {
          // An unconfirmed abort fences this stage before cleanup or later work.
          if (!hasPendingPageCommit()) await cleanup();
        }
      }, [working]));
    } finally {
      done();
    }
  });
  // Refresh consent before tracking a write, rather than recording a declined
  // prompt as a completed operation. The locked revision check still fences drift.
  if (current.buffer !== initial.buffer && !await io.confirm(path, working)) return { completed: false };
  options.assertActive?.();
  if (!sameRevision(getState(), gated, path)) throw changed();
  const value = await (options.track ? options.track(publish) : publish());
  // Captured at dispatch, not by re-reading after an acknowledgement await:
  // another publication may already be current by then.
  return { completed: true, value, publication: publication! };
}
