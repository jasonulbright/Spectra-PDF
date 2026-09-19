import type { AppAction, AppState, PdfBuffer } from '../state/types';
import { tChrome } from '../i18n';
import { withFileLock } from './engine-lock';
import { serializeWorkspacePublication } from './workspace-publication';
import { hasPendingPageCommit, publishPageCommit, recoverPendingPageCommit, type PageCommitIo } from './page-commit-transaction';
import type { ReadPublishedBytes } from './workspace-settle';

export interface HistoryIo {
  read: (path: string) => Promise<Uint8Array>;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  remove: (path: string) => Promise<void>;
  /** The page count and the documents of the restored bytes, placed with them. */
  index: ReadPublishedBytes;
  transaction: PageCommitIo;
}

function bytes(value: PdfBuffer): Uint8Array<ArrayBuffer> {
  return value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value);
}
async function digest(value: PdfBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes(value));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
function changed(): Error { return new Error(tChrome('app.history.changed')); }

export function restoreHistory(direction: 'undo' | 'redo', getState: () => AppState,
  dispatch: (action: AppAction) => void, io: HistoryIo): Promise<void> {
  // Queue BEFORE the first await. Repeated keypresses read the newest history
  // when their own turn begins, including dispatches React has not rendered.
  return serializeWorkspacePublication(async () => {
    await recoverPendingPageCommit();
    const selected = getState();
    const pageHistory = direction === 'undo' ? selected.pageUndoStack : selected.pageRedoStack;
    if (pageHistory.length) {
      dispatch({ type: direction === 'undo' ? 'UNDO_PAGE_OP' : 'REDO_PAGE_OP' });
      return;
    }
    const path = selected.activeFileId;
    const working = path && selected.files.get(path)?.workingPath;
    if (!path || !working) return;
    await withFileLock([working], async () => {
      const expected = getState();
      if (expected.activeFileId !== path) throw changed();
      const latestPageHistory = direction === 'undo' ? expected.pageUndoStack : expected.pageRedoStack;
      if (latestPageHistory.length) {
        dispatch({ type: direction === 'undo' ? 'UNDO_PAGE_OP' : 'REDO_PAGE_OP' });
        return;
      }
      const current = expected.files.get(path);
      if (!current || current.importOnly || current.workingPath !== working) throw changed();
      const snapshotPath = (direction === 'undo' ? current.undoStack : current.redoStack).at(-1);
      if (!snapshotPath) return;
      if (!current.buffer) throw changed();
      const isCurrent = () => {
        const now = getState();
        return now.files.get(path) === current && now.pageUndoStack === expected.pageUndoStack
          && now.pageRedoStack === expected.pageRedoStack && now.pageDirtyPaths === expected.pageDirtyPaths;
      };
      // Read and validate the exact retained bytes BEFORE touching the working
      // file. Count them, not a later read of the mutable working path. The
      // reading runs on a copy; the documents describe the object dispatched.
      const buffer = (await io.read(snapshotPath)).slice();
      const { pageCount, documents: read } = await io.index(current, buffer.slice());
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error(tChrome('app.history.invalid'));
      const documents = read.map(d => ({ ...d, buffer }));
      const expectedWorkingSha256 = await digest(current.buffer);
      const expectedStagedSha256 = await digest(buffer);
      if (!isCurrent()) throw changed();
      const stagedPath = `${working}.history-${crypto.randomUUID()}.pdf`;
      const cleanup = async () => { await io.remove(stagedPath).catch(() => {}); };
      try {
        await io.write(stagedPath, buffer);
        if (!isCurrent()) throw changed();
        await publishPageCommit(io.transaction,
          [{ workingPath: working, stagedPath, expectedWorkingSha256, expectedStagedSha256 }],
          snapshots => {
            if (!isCurrent()) throw changed();
            dispatch({ type: 'RESTORE_HISTORY', direction, expected, path, snapshotPath,
              counterpart: snapshots[0], buffer, pageCount, documents });
            // A refused reducer update must abort native publication, not
            // acknowledge a changed file with old history still displayed.
            if (getState().files.get(path)?.buffer !== buffer) throw changed();
          }, cleanup);
      } finally {
        // An unconfirmed abort fences this stage before cleanup or later work.
        if (!hasPendingPageCommit()) await cleanup();
      }
    });
  });
}
