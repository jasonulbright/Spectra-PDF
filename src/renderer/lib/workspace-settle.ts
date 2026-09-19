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

// Buffers whose last index run failed, with the error it failed with. The
// indexer retries on its next pass and clears the mark when it does, so the
// mark means "no index is coming".
const failed = new WeakMap<object, unknown>();
// The same verdicts, kept through a retry until a run reads the buffer: a
// retry that fails again must not take the notice away while it runs.
const unreadable = new WeakSet<object>();
const failureListeners = new Set<() => void>();

/** The index verdicts as of the last change. A new object for each change,
 * so a subscriber can tell that one happened. */
export interface IndexVerdicts {
  unreadable(buffer: PdfBuffer): boolean;
}

function verdictSnapshot(): IndexVerdicts {
  return { unreadable: (buffer) => unreadable.has(buffer) };
}

let verdicts = verdictSnapshot();

function notify(verdictChanged: boolean): void {
  if (verdictChanged) verdicts = verdictSnapshot();
  for (const listener of [...failureListeners]) listener();
}

export function recordIndexFailure(buffer: PdfBuffer, error: unknown): void {
  failed.set(buffer, error);
  const known = unreadable.has(buffer);
  unreadable.add(buffer);
  notify(!known);
}

export function clearIndexFailure(buffer: PdfBuffer): void {
  failed.delete(buffer);
}

/** A run read `buffer`: its pages are readable. */
export function recordIndexSuccess(buffer: PdfBuffer): void {
  if (unreadable.delete(buffer)) notify(true);
}

/** Subscribe to index verdicts, read with `indexVerdicts`. */
export function subscribeIndexVerdicts(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

export function indexVerdicts(): IndexVerdicts {
  return verdicts;
}

/**
 * Whether `file` shows no pages because pdf.js could not read the pages of
 * the bytes it holds: it has no documents of those bytes, and their index
 * failed. pdf.js may load such bytes and still fail on a page.
 */
export function pagesUnreadable(state: WorkspaceState, file: OpenFile, known: IndexVerdicts): boolean {
  return !!file.buffer && known.unreadable(file.buffer) && needsIndex(state, file.path);
}

/** The failed index a document not read from its file's current bytes waits
 * on, or null. */
function awaitedFailure(state: WorkspaceState): { error: unknown } | null {
  for (const d of state.workspace.documents) {
    const current = state.files.get(d.path)?.buffer;
    if (current && !readFromCurrentBytes(state, d) && failed.has(current)) {
      return { error: failed.get(current) };
    }
  }
  return null;
}

/**
 * Resolve once the workspace is settled. Reject when a document not read from
 * its file's current bytes waits on a buffer whose index failed: no landing is
 * coming, and waiting on would hold the commit forever. The refusal carries
 * the index's own error as its `cause`.
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
        return;
      }
      const failure = awaitedFailure(state);
      if (failure) {
        finish();
        reject(new Error(tChrome('app.history.changed'), { cause: failure.error }));
      }
    }
    unsubscribe = subscribe(check);
    failureListeners.add(check);
    check();
  });
}

/** The error the awaited index failed with: the cause of an
 * `awaitSettledWorkspace` refusal, else the refusal itself. */
export function indexError(refusal: unknown): Error {
  const cause = refusal instanceof Error && refusal.cause !== undefined ? refusal.cause : refusal;
  return cause instanceof Error ? cause : new Error(String(cause));
}
