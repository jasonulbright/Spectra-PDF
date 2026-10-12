import { appReducer } from './reducer';
import type { AppAction, AppState } from './types';

/** Whether `action` took `before` to `after` as a page-tier edit, undo or
 * redo that changed the `editRevision` of a path in `sealed`. */
export function changesSealedPageTier(
  before: AppState,
  after: AppState,
  action: AppAction,
  sealed: ReadonlySet<string>,
): boolean {
  if (!sealed.size) return false;
  const pageTier = action.type === 'UNDO_PAGE_OP' || action.type === 'REDO_PAGE_OP'
    || after.pageUndoStack.length > before.pageUndoStack.length;
  if (!pageTier) return false;
  for (const path of sealed) {
    if (after.files.get(path)?.editRevision !== before.files.get(path)?.editRevision) return true;
  }
  return false;
}

/** Dispatch settles the authoritative state synchronously, independently of
 * React's render batching. Transaction receipts must not inspect a stale render.
 *
 * A sealed path is one whose bytes are being handed to another window: its
 * file on disk is final, so a page edit, undo or redo that would change it
 * is refused here, whatever surface asked for it. */
export function createAppStore(initial: AppState) {
  let state = initial;
  const sealed = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch: (action: AppAction) => {
      if (action.type === 'SEAL_PAGE_TIER') {
        sealed.add(action.path);
        return;
      }
      if (action.type === 'UNSEAL_PAGE_TIER') {
        sealed.delete(action.path);
        return;
      }
      let next = appReducer(state, action);
      if (next === state) return;
      if (changesSealedPageTier(state, next, action, sealed)) {
        next = {
          ...state,
          pageEditRefusals: state.pageEditRefusals + 1,
          pageEditRefusalReason: 'moving',
        };
      } else if (action.type === 'CLOSE_FILE' && !next.files.has(action.path)) {
        sealed.delete(action.path);
      }
      state = next;
      for (const listener of listeners) {
        // Notification failure cannot turn an already published state into a
        // rejected transaction and cause native rollback underneath that state.
        try { listener(); } catch (error) { queueMicrotask(() => { throw error; }); }
      }
    },
  };
}
