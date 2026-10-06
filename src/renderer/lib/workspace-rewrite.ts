import type { AppAction, AppState, OpenFile, PdfBuffer } from '../state/types';
import { tChrome } from '../i18n';
import { withFileLock, withWriteChain } from './engine-lock';
import { announceWorkspacePublication, serializeWorkspacePublication } from './workspace-publication';
import { commitPendingPageEdits } from './commit-gate';
import { beginDocumentWrite } from './document-writes';
import { hasPendingPageCommit, publishPageCommit, recoverPendingPageCommit, type PageCommitIo } from './page-commit-transaction';
import type { ReadPublishedBytes } from './workspace-settle';
import { releaseStageCredential, shareStageCredential } from './stage-credentials';

export interface WorkspaceRewriteIo {
  confirm: (path: string, workingPath: string) => Promise<boolean>;
  /** The commit gate for the working paths the rewrite acts on; it waits only
   * for publications announced before `before`. */
  commit: (paths: readonly string[], before?: number) => Promise<void>;
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
function sameRevision(now: AppState, expected: AppState, path: string): boolean {
  return now.files.get(path) === expected.files.get(path) && now.pageDirtyPaths === expected.pageDirtyPaths
    && now.pageUndoStack === expected.pageUndoStack && now.pageRedoStack === expected.pageRedoStack;
}

/** Rounds of "commit the pending page edits, then check" before a refusal. */
export const REWRITE_COMMIT_ATTEMPTS = 3;

const DECLINED = Symbol('declined');
const RETRY = Symbol('retry');

/**
 * Holds every rewrite at the start of its engine steps (phase 2, under the
 * shared lock) until `release` runs. An end-to-end spec decides with it what
 * happens while a rewrite is in its engine step, without a timer. Reached
 * only from the harness, which exists only in a `VITE_E2E` build.
 */
let engineStepHold: { held: Promise<void>; waiting: number } | null = null;
export function holdRewriteEngineSteps(): { release: () => void; waiting: () => number } {
  let release!: () => void;
  const hold = { held: new Promise<void>(resolve => { release = resolve; }), waiting: 0 };
  engineStepHold = hold;
  return {
    release: () => { if (engineStepHold === hold) engineStepHold = null; release(); },
    waiting: () => hold.waiting,
  };
}

/**
 * Stage the entire rewrite before replacing any working bytes.
 *
 * Order: the commit gate, holding nothing; the write chain of the working
 * path, announced as a publication of that path from the claim until the
 * publication ends, so a commit gate that names the path waits for this
 * rewrite. Under the chain: pending page edits are committed and the revision
 * is captured again, so a write asked for while an earlier write of the path
 * ran applies to that write's result, with consent asked again for the new
 * bytes. Phase 1, in the publication lane: recover a pending page commit.
 * Phase 2, under a SHARED lock on the working path and outside the lane: the
 * stage, the engine steps, the read-back and the index; readers that run no
 * gate read the bytes the user still sees. Then, holding the chain only,
 * every pending page edit is committed. Phase 3: the exclusive lock, then the
 * lane, then the fence and the publication.
 *
 * Fence: the file is the captured one, no page edit is pending anywhere, and
 * the page history is the one at phase 1 or empty. Replacing a file's bytes
 * resets a live page tier (`withNewBytes` in the reducer), so a pending edit
 * of another document is committed before phase 3, never published over, and
 * page history recorded during the rewrite refuses it. A page edit of the
 * rewritten file itself voids the work in progress.
 *
 * The commit run while the chain is held is the page commit alone, never a
 * gate: a gate waits for announced publications, and a disk undo of this path
 * is announced while it waits for this chain.
 *
 * Builders operate only on their unique stage and must not re-enter a gated
 * engine transport. `io.confirm` may run while the chain is held, so it must
 * not run a commit gate either.
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
  const working = initial.workingPath;
  const ended = beginDocumentWrite(working);
  // Announced from the request on: a gate that names the path waits for this
  // rewrite, also while its own consent prompt and its own gate run. Its own
  // gate waits only for older announcements, so two rewrites of one path
  // never wait for each other.
  const announced = announceWorkspacePublication([working]);
  try {
    if (!await io.confirm(path, working)) return { completed: false };
    options.assertActive?.();
    if (!sameRevision(getState(), before, path)) throw changed();
    // The gate commits through the lane and the dirty paths' locks; it runs
    // holding nothing, before the chain, never inside phase 1.
    await io.commit([working], announced.order);
    options.assertActive?.();
    const open = (): OpenFile => {
      const file = getState().files.get(path);
      if (!file?.buffer || file.importOnly || file.workingPath !== working) throw changed();
      return file;
    };
    let current = open();
    // Refresh consent before tracking a write, rather than recording a declined
    // prompt as a completed operation.
    if (current.buffer !== initial.buffer && !await io.confirm(path, working)) return { completed: false };
    options.assertActive?.();
    current = open();

    const requireCurrent = () => {
      options.assertActive?.();
      const now = getState();
      if (now.files.get(path) !== current || now.pageDirtyPaths.includes(path)) throw changed();
    };
    /** Commits pending page edits until none is left; refuses when the file
     * changes, unless `consent` accepts the new bytes. */
    const settle = async (consent: boolean): Promise<boolean> => {
      for (let attempt = 0; attempt < REWRITE_COMMIT_ATTEMPTS; attempt++) {
        options.assertActive?.();
        if (getState().pageDirtyPaths.length) {
          await commitPendingPageEdits();
          continue;
        }
        const file = open();
        if (file !== current) {
          if (!consent) throw changed();
          if (!await io.confirm(path, working)) return false;
          current = file;
          continue;
        }
        return true;
      }
      throw changed();
    };

    let publication: OpenFile | undefined;
    const publish = (): Promise<T | typeof DECLINED> =>
      withWriteChain([working], async () => {
        if (!await settle(true)) return DECLINED;
        // The page history as the rewrite starts. Publishing resets a live page
        // tier, so history recorded since (a page undo of another document)
        // refuses the rewrite rather than being dropped.
        const history = await serializeWorkspacePublication(async () => {
          await recoverPendingPageCommit();
          requireCurrent();
          const { pageUndoStack, pageRedoStack } = getState();
          return { pageUndoStack, pageRedoStack };
        }, [working]);
        const historyKept = () => {
          const now = getState();
          return (now.pageUndoStack === history.pageUndoStack && now.pageRedoStack === history.pageRedoStack)
            || (!now.pageUndoStack.length && !now.pageRedoStack.length);
        };
        const stage = `${working}.${options.kind}-${crypto.randomUUID()}.pdf`;
        let shared = false;
        const cleanup = async () => {
          await io.remove(stage).catch(() => {});
          if (shared) await releaseStageCredential(stage);
        };
        let published = false;
        try {
          // Shared: a builder may read the working path itself (a sealed
          // document's plaintext), and no writer may replace it meanwhile.
          const file = current;
          const staged = await withFileLock([{ key: working, mode: 'shared' }], async () => {
            requireCurrent();
            const original = copy(file.buffer!);
            const expectedWorkingSha256 = await digest(original);
            shared = await shareStageCredential(file, stage);
            const hold = engineStepHold;
            if (hold) {
              hold.waiting++;
              try { await hold.held; } finally { hold.waiting--; }
              requireCurrent();
            }
            const value = await build(stage, original, requireCurrent);
            const buffer = (await io.read(stage)).slice();
            // The reading runs on a copy; the documents describe the object dispatched.
            const { pageCount, documents: read } = await io.index(file, buffer.slice());
            if (!Number.isSafeInteger(pageCount) || pageCount < 1
                || options.preservePageCount && pageCount !== file.pageCount) throw options.unverified();
            const documents = read.map(d => ({ ...d, buffer }));
            return { value, buffer, pageCount, documents, expectedWorkingSha256, expectedStagedSha256: await digest(buffer) };
          });
          const requireFence = () => {
            requireCurrent();
            if (getState().pageDirtyPaths.length || !historyKept()) throw changed();
          };
          for (let attempt = 0; ; attempt++) {
            if (attempt === REWRITE_COMMIT_ATTEMPTS) throw changed();
            requireCurrent();
            await settle(false);
            const outcome = await withFileLock([working], () => serializeWorkspacePublication(async () => {
              requireCurrent();
              // A page edit made since the commit above: commit it outside
              // the lane and the exclusive lock, then try again.
              if (getState().pageDirtyPaths.length) return RETRY;
              requireFence();
              published = true;
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
            }, [working]));
            if (outcome !== RETRY) return outcome as T;
          }
        } finally {
          // An unconfirmed abort of this publication fences its stage before
          // cleanup; a rewrite that never published owns its stage alone.
          if (!published || !hasPendingPageCommit()) await cleanup();
        }
      });
    const value = await (options.track ? options.track(publish as () => Promise<T>) : publish());
    if (value === DECLINED) return { completed: false };
    // Captured at dispatch, not by re-reading after an acknowledgement await:
    // another publication may already be current by then.
    return { completed: true, value: value as T, publication: publication! };
  } finally {
    announced();
    ended();
  }
}
