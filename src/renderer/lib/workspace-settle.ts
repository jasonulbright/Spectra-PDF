// The workspace is SETTLED when every document was indexed from the buffer
// its file holds now. Between a buffer change and the landing of its reindex
// the documents are superseded: their page indexes and rotations describe the
// previous bytes, while every reader of `files` already sees the new ones. A
// commit planned from superseded documents writes the wrong page for a moved
// index, applies a baked rotation a second time, and authors a baked
// annotation again beside itself — so a commit plans only once settled.
//
// DOM-free and pdf.js-free, so the rule tests in Node.
import type { AppState, PdfBuffer } from '../state/types';
import { tChrome } from '../i18n';

export function workspaceSettled(state: Pick<AppState, 'files' | 'workspace'>): boolean {
  return state.workspace.documents.every((d) => state.files.get(d.path)?.buffer === d.buffer);
}

// Buffers whose last index run failed. The indexer retries on its next pass
// and clears the mark when it does, so the mark means "no index is coming".
const failed = new WeakSet<object>();
const failureListeners = new Set<() => void>();

export function recordIndexFailure(buffer: PdfBuffer): void {
  failed.add(buffer);
  for (const listener of [...failureListeners]) listener();
}

export function clearIndexFailure(buffer: PdfBuffer): void {
  failed.delete(buffer);
}

/** Whether a superseded document waits on a buffer whose index failed. */
function awaitsFailedIndex(state: Pick<AppState, 'files' | 'workspace'>): boolean {
  return state.workspace.documents.some((d) => {
    const current = state.files.get(d.path)?.buffer;
    return !!current && current !== d.buffer && failed.has(current);
  });
}

/**
 * Resolve once the workspace is settled. Reject when a superseded document
 * waits on a buffer whose index failed: no landing is coming, and waiting on
 * would hold the commit forever.
 */
export function awaitSettledWorkspace(
  getState: () => Pick<AppState, 'files' | 'workspace'>,
  subscribe: (listener: () => void) => () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = (): void => {
      done = true;
      unsubscribe();
      failureListeners.delete(check);
    };
    function check(): void {
      if (done) return;
      const state = getState();
      if (workspaceSettled(state)) {
        finish();
        resolve();
      } else if (awaitsFailedIndex(state)) {
        finish();
        reject(new Error(tChrome('app.history.changed')));
      }
    }
    unsubscribe = subscribe(check);
    failureListeners.add(check);
    check();
  });
}
