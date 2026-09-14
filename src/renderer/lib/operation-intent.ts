import type { AppState, OpenFile } from '../state/types';
import { tChrome } from '../i18n';

/** Captured synchronously by the user gesture, before any prerequisite await.
 * Immutable reducer references include the pending page tier, not just disk. */
export interface OperationIntent {
  readonly source: OpenFile;
  readonly pageCount: number;
  readonly pageDirtyPaths: AppState['pageDirtyPaths'];
  readonly pageUndoStack: AppState['pageUndoStack'];
  readonly pageRedoStack: AppState['pageRedoStack'];
}

function changed(): Error { return new Error(tChrome('app.history.changed')); }

export function captureOperationIntent(state: AppState, source: OpenFile): OperationIntent {
  if (!source.buffer || source.importOnly || state.activeFileId !== source.path
      || state.files.get(source.path) !== source) throw changed();
  // The pending page tier, including every partition, is what the gesture
  // names. The stored OpenFile count describes the older on-disk revision.
  const pageCount = state.pageDirtyPaths.includes(source.path)
    ? state.workspace.documents.filter(doc => doc.path === source.path).reduce((n, doc) => n + doc.pages.length, 0)
    : source.pageCount;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw changed();
  return { source, pageCount, pageDirtyPaths: state.pageDirtyPaths,
    pageUndoStack: state.pageUndoStack, pageRedoStack: state.pageRedoStack };
}

export function assertOperationIntent(state: AppState, intent: OperationIntent): void {
  if (state.files.get(intent.source.path) !== intent.source
      || state.pageDirtyPaths !== intent.pageDirtyPaths
      || state.pageUndoStack !== intent.pageUndoStack
      || state.pageRedoStack !== intent.pageRedoStack) throw changed();
}

/** A commit may adopt exactly its authored source -> result mapping. A fresh
 * buffer at the same working path is not itself evidence that the gate made it. */
export function assertOperationGateResult(current: OpenFile, intent: OperationIntent): void {
  const before = intent.source;
  if (current.path !== before.path || current.workingPath !== before.workingPath || current.pageCount !== intent.pageCount
      || current.buffer !== before.buffer && (current.authoredIdentity?.sourceBuffer !== before.buffer
        || current.authoredIdentity.buffer !== current.buffer)) throw changed();
}
