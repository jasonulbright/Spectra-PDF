// The workspace is SETTLED when every document was indexed from the buffer
// its file holds now. Documents that were not would be superseded: their page
// indexes and rotations describe the previous bytes, while every reader of
// `files` already sees the new ones. A commit planned from superseded
// documents writes the wrong page for a moved index, applies a baked rotation
// a second time, and authors a baked annotation again beside itself — so a
// commit plans only once settled. Every byte replacement places, in the same
// step, documents that describe its bytes — read from them (an operation, a
// disk undo or redo) or composed for them (a page-tier commit) — or none (an
// open, which the indexer reads). A page-tier commit's composed documents
// (provisional) carry no fingerprint of what it wrote, so they wait for the
// read-back.
//
// DOM-free and pdf.js-free, so the rule tests in Node.
import type { AppState, OpenDocument, OpenFile, PageRef, PdfBuffer } from '../state/types';
import { tChrome } from '../i18n';

type WorkspaceState = Pick<AppState, 'files' | 'workspace'>;

/** What a publication reads from the bytes it is about to place: their page
 * count, and the documents they hold. No documents leaves the path to the
 * workspace indexer. */
export interface PublishedBytes {
  pageCount: number;
  documents: OpenDocument[];
}

/** Reads the bytes a publication is about to place, as documents of `file`. */
export type ReadPublishedBytes = (file: OpenFile, buffer: PdfBuffer) => Promise<PublishedBytes>;

/**
 * The document and page a drawing lands on, or null.
 *
 * `seen` is the page as the gesture's render showed it: its document, the
 * bytes that document described, and the page's rotation. A drawing is
 * display-normalized in that frame and bound to that page id, so it lands
 * only while the workspace holds the page in that document, over the same
 * bytes, which are still its file's bytes, turned the same way.
 */
export function drawingTarget(
  state: WorkspaceState,
  seen: { docId: string; pageId: string; buffer: PdfBuffer | null; rotation: number },
): { doc: OpenDocument; page: PageRef } | null {
  const doc = state.workspace.documents.find((d) => d.id === seen.docId);
  const page = doc?.pages.find((p) => p.id === seen.pageId);
  if (!doc || !page) return null;
  if (doc.buffer !== seen.buffer || state.files.get(doc.path)?.buffer !== doc.buffer) return null;
  return page.rotation === seen.rotation ? { doc, page } : null;
}

/** Whether `doc` was read from the bytes its file holds now. */
function readFromCurrentBytes(state: WorkspaceState, doc: OpenDocument): boolean {
  return !doc.provisional && state.files.get(doc.path)?.buffer === doc.buffer;
}

export function workspaceSettled(state: WorkspaceState): boolean {
  return state.workspace.documents.every((d) => readFromCurrentBytes(state, d));
}

/** Whether `path` waits for an index of the bytes it holds now: it has no
 * document yet, or its documents were not read from those bytes. */
export function needsIndex(state: WorkspaceState, path: string): boolean {
  const current = state.workspace.documents.find((d) => d.path === path);
  return !current || !readFromCurrentBytes(state, current);
}

/** Whether every document of `path` describes the bytes `path` holds now,
 * read from them or composed for them. Positional page addresses of the
 * current bytes resolve only against such documents. */
export function pathDescribesCurrentBytes(state: WorkspaceState, path: string): boolean {
  const buffer = state.files.get(path)?.buffer;
  const own = state.workspace.documents.filter((d) => d.path === path);
  return !!buffer && own.length > 0 && own.every((d) => d.buffer === buffer);
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

/** Whether a document not read from its file's current bytes waits on a
 * buffer whose index failed. */
function awaitsFailedIndex(state: WorkspaceState): boolean {
  return state.workspace.documents.some((d) => {
    const current = state.files.get(d.path)?.buffer;
    return !!current && !readFromCurrentBytes(state, d) && failed.has(current);
  });
}

/**
 * Resolve once the workspace is settled. Reject when a document not read from
 * its file's current bytes waits on a buffer whose index failed: no landing is
 * coming, and waiting on would hold the commit forever.
 */
export function awaitSettledWorkspace(
  getState: () => WorkspaceState,
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
