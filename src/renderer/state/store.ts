import { annotationsMadeBy, appReducer } from './reducer';
import type { AppAction, AppState, PageAnnotation } from './types';
import { needsBundledFace, unreadFacesRefusal } from '../lib/text-box-edit';
import { awaitBundledFaces } from '../lib/text-box-engine';
import { bundledFacesKnown } from '../lib/text-box-faces';

/** What the store knows of the face files of the fonts folder. */
export interface FaceKnowledge {
  known: () => boolean;
  /** One bounded read; whether the files are known after it. */
  settle: () => Promise<boolean>;
}

const SESSION_FACES: FaceKnowledge = { known: bundledFacesKnown, settle: () => awaitBundledFaces() };

/** The first annotation a page edit took `before` to `after` by making or
 *  changing, whose text the commit draws in a bundled face. */
export function textNeedingFaces(
  before: AppState, after: AppState, action: AppAction,
): { annotation: PageAnnotation; page: number } | null {
  // A page edit pushes the undo tier; an undo or a redo restores a model
  // that was admitted when it was made.
  if (action.type === 'UNDO_PAGE_OP' || action.type === 'REDO_PAGE_OP') return null;
  if (after.pageUndoStack.length <= before.pageUndoStack.length) return null;
  for (const made of annotationsMadeBy(before.workspace.documents, after.workspace.documents)) {
    if (needsBundledFace(made.annotation)) return made;
  }
  return null;
}

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
 * is refused here, whatever surface asked for it.
 *
 * A page edit that makes a text the commit draws in a bundled face is
 * admitted only on the face files the fonts folder holds, never on the face
 * tables alone. While the files are not read, the edit is held for one
 * bounded read and applied to the state of that later time; when the read
 * gives no answer the edit is refused with the `faces` notice. A text the
 * standard font draws is never held by itself.
 *
 * The page tier keeps the order the edits were asked in: while an edit is
 * held, every later page edit, undo and redo waits behind it and is applied
 * after it, in order. An action that is no page-tier change is never
 * delayed. */
export function createAppStore(initial: AppState, faces: FaceKnowledge = SESSION_FACES) {
  let state = initial;
  const sealed = new Set<string>();
  const listeners = new Set<() => void>();
  // Page-tier actions asked for while an edit is held, oldest first.
  const behind: AppAction[] = [];
  let holding = false;
  const apply = (action: AppAction, facesSettled: boolean): void => {
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
    const pageTier = action.type === 'UNDO_PAGE_OP' || action.type === 'REDO_PAGE_OP'
      || next.pageUndoStack.length > state.pageUndoStack.length;
    if (holding && pageTier) {
      behind.push(action);
      return;
    }
    const waiting = faces.known() ? null : textNeedingFaces(state, next, action);
    if (changesSealedPageTier(state, next, action, sealed)) {
      next = {
        ...state,
        pageEditRefusals: state.pageEditRefusals + 1,
        pageEditRefusalReason: 'moving',
      };
    } else if (waiting && !facesSettled) {
      holding = true;
      // An action that throws leaves the ones behind it in their order.
      const run = (waited: AppAction, settled: boolean): void => {
        try { apply(waited, settled); } catch (error) { queueMicrotask(() => { throw error; }); }
      };
      const release = (): void => {
        holding = false;
        run(action, true);
        // An action that waited can be held in its turn: the rest then
        // waits behind it.
        while (!holding && behind.length > 0) run(behind.shift()!, false);
      };
      // A read that fails is a read with no answer.
      void faces.settle().then(release, release);
      return;
    } else if (waiting) {
      next = {
        ...state,
        pageEditRefusals: state.pageEditRefusals + 1,
        pageEditRefusalReason: { textBox: unreadFacesRefusal(waiting.annotation, waiting.page) },
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
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch: (action: AppAction): void => apply(action, false),
  };
}
