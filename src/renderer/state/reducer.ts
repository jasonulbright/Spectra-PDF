import { AppState, AppAction, OpenDocument, OpenFile, PageAnnotation, PdfBuffer } from './types';
import { carriesManifest } from '../lib/doc-names';

// Re-project a display-normalized annotation rect when its page's display
// rotates by `delta` quarter-turns clockwise: annotation coords always live
// in the page's CURRENT display space (that's what the overlay renders and
// what the commit builder maps through the final rotation), so they must
// turn with the page to keep covering the same content.
// Re-project a single display-normalized point through the same quarter-turn
// (derived from, and consistent with, the bbox corner mapping below: applying
// this to a rect's two corners and re-deriving min/max reproduces it exactly).
function rotatePoint(u: number, v: number, d: number): [number, number] {
  if (d === 90) return [1 - v, u];
  if (d === 180) return [1 - u, 1 - v];
  if (d === 270) return [v, 1 - u];
  return [u, v];
}

export function rotateAnnotationRect(a: PageAnnotation, delta: number): PageAnnotation {
  const d = ((delta % 360) + 360) % 360;
  if (d === 0) return a;
  let points: number[] | undefined;
  if (a.points) {
    points = [];
    for (let i = 0; i < a.points.length; i += 2) {
      const [px, py] = rotatePoint(a.points[i], a.points[i + 1], d);
      points.push(px, py);
    }
  }
  if (d === 90) return { ...a, x: 1 - (a.y + a.h), y: a.x, w: a.h, h: a.w, ...(points ? { points } : {}) };
  if (d === 180) return { ...a, x: 1 - (a.x + a.w), y: 1 - (a.y + a.h), ...(points ? { points } : {}) };
  return { ...a, x: a.y, y: 1 - (a.x + a.w), w: a.h, h: a.w, ...(points ? { points } : {}) }; // 270
}

export const initialState: AppState = {
  files: new Map(),
  activeFileId: null,
  workspace: { documents: [] },
  pageUndoStack: [],
  pageRedoStack: [],
  pageDirtyPaths: [],
};

function mapDocument(
  documents: OpenDocument[],
  docId: string,
  update: (doc: OpenDocument) => OpenDocument,
): OpenDocument[] {
  return documents.map((d) => (d.id === docId ? update(d) : d));
}

// Every in-memory page mutation goes through here: push the previous state
// onto the page-edit undo tier, clear redo, and mark the touched files dirty
// for the commit bridge. Callers return the current documents array unchanged
// (by reference) to signal a rejected/no-op edit.
function applyPageEdit(state: AppState, documents: OpenDocument[], touchedPaths: string[]): AppState {
  if (documents === state.workspace.documents) return state;
  const pageDirtyPaths = [
    ...state.pageDirtyPaths,
    ...touchedPaths.filter((p) => !state.pageDirtyPaths.includes(p)),
  ];
  return {
    ...state,
    workspace: { documents },
    pageUndoStack: [
      ...state.pageUndoStack,
      { documents: state.workspace.documents, dirtyPaths: state.pageDirtyPaths },
    ],
    pageRedoStack: [],
    pageDirtyPaths,
  };
}

// Total pages an open file would have across all its workspace documents —
// used to reject edits that would materialize a 0-page (invalid) PDF.
function pagesForPath(documents: OpenDocument[], path: string): number {
  return documents.filter((d) => d.path === path).reduce((sum, d) => sum + d.pages.length, 0);
}

// After a cross-doc move, drop documents left with no pages (matching PDFx),
// but never a path's last document — file-level lifecycle stays with CLOSE_FILE.
function pruneEmptyDocs(documents: OpenDocument[]): OpenDocument[] {
  const pruned = documents.filter(
    (d) => d.pages.length > 0 || documents.filter((o) => o.path === d.path).length === 1,
  );
  return pruned.length === documents.length ? documents : pruned;
}

// After stripping a closed file's pages out of other documents, a still-open
// path can be left with zero total pages — an uncommittable composition.
// Dropping its documents (and its dirty mark) lets the indexer restore that
// file's pristine composition from its unchanged buffer.
function resetEmptiedPaths(
  documents: OpenDocument[],
  dirtyPaths: string[],
): { documents: OpenDocument[]; dirtyPaths: string[] } {
  const emptied = new Set(
    documents.map((d) => d.path).filter((path) => pagesForPath(documents, path) === 0),
  );
  if (emptied.size === 0) return { documents, dirtyPaths };
  return {
    documents: documents.filter((d) => !emptied.has(d.path)),
    dirtyPaths: dirtyPaths.filter((p) => !emptied.has(p)),
  };
}

function applyFileUpdate(
  files: Map<string, OpenFile>,
  update: { path: string; pageCount: number; buffer: PdfBuffer; snapshotPath: string },
): Map<string, OpenFile> {
  const existing = files.get(update.path);
  if (!existing) return files;
  const next = new Map(files);
  next.set(update.path, {
    ...existing,
    pageCount: update.pageCount,
    buffer: update.buffer,
    dirty: true,
    undoStack: [...existing.undoStack, update.snapshotPath],
    redoStack: [], // new action clears redo
  });
  return next;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'OPEN_FILE': {
      const files = new Map(state.files);
      files.set(action.path, {
        path: action.path,
        workingPath: action.workingPath,
        name: action.name,
        pageCount: action.pageCount,
        buffer: action.buffer,
        dirty: false,
        undoStack: [],
        redoStack: [],
      });
      return {
        ...state,
        files,
        activeFileId: action.path,
        // Page-edit history recorded before this file existed (or before its
        // buffer was refreshed) can't be replayed against the new workspace —
        // undoing it would drop the file's strip. Pending dirt stays valid:
        // an open file invalidates no other file's composition.
        pageUndoStack: [],
        pageRedoStack: [],
      };
    }
    case 'CLOSE_FILE': {
      const files = new Map(state.files);
      files.delete(action.path);
      const activeFileId = state.activeFileId === action.path
        ? (files.size > 0 ? files.keys().next().value ?? null : null)
        : state.activeFileId;
      // Drop the file's documents, and strip its pages out of every other
      // document — pending cross-file moves referencing it could never be
      // committed once the source bytes are gone. Page-edit history may
      // reference those pages too, so the tier resets. Paths stripped all the
      // way to zero pages are reset to their on-disk composition instead of
      // keeping an uncommittable empty strip.
      const stripped = pruneEmptyDocs(
        state.workspace.documents
          .filter((d) => d.path !== action.path)
          .map((d) =>
            d.pages.some((p) => p.sourceDocId === action.path)
              ? { ...d, pages: d.pages.filter((p) => p.sourceDocId !== action.path) }
              : d,
          ),
      );
      const { documents, dirtyPaths } = resetEmptiedPaths(
        stripped,
        state.pageDirtyPaths.filter((p) => p !== action.path),
      );
      return {
        ...state,
        files,
        activeFileId,
        workspace: { documents },
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: dirtyPaths,
      };
    }
    case 'SET_ACTIVE_FILE':
      return { ...state, activeFileId: action.path };
    case 'UPDATE_FILE': {
      const files = applyFileUpdate(state.files, action);
      if (files === state.files) return state;
      const tierEmpty =
        state.pageUndoStack.length === 0 &&
        state.pageRedoStack.length === 0 &&
        state.pageDirtyPaths.length === 0;
      if (tierEmpty) return { ...state, files };
      // Defense-in-depth: the file's bytes were replaced while page edits
      // were pending — a caller bypassed the commit gate. In-memory history
      // and dirty compositions now reference stale buffers (cross-file moves
      // entangle every dirty path with each other), so the whole tier resets
      // and the dirty paths' documents are dropped for the indexer to
      // re-derive from the current buffers.
      const invalidated = new Set([...state.pageDirtyPaths, action.path]);
      return {
        ...state,
        files,
        workspace: {
          documents: state.workspace.documents.filter((d) => !invalidated.has(d.path)),
        },
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: [],
      };
    }
    case 'COMMIT_PAGE_EDITS': {
      // The commit bridge's atomic landing: every rebuilt file joins the
      // snapshot undo chain and the page-edit tier resets in one step. The
      // workspace is left alone — the indexer re-derives each updated path
      // from its new buffer.
      let files = state.files;
      for (const update of action.updates) {
        files = applyFileUpdate(files, update);
      }
      return {
        ...state,
        files,
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: [],
      };
    }
    case 'UNDO': {
      const files = new Map(state.files);
      const existing = files.get(action.path);
      if (!existing || existing.undoStack.length === 0) return state;
      files.set(action.path, {
        ...existing,
        undoStack: existing.undoStack.slice(0, -1), // caller restored this snapshot
        redoStack: [...existing.redoStack, action.redoSnapshot],
        dirty: existing.undoStack.length > 1,
      });
      return { ...state, files };
    }
    case 'REDO': {
      const files = new Map(state.files);
      const existing = files.get(action.path);
      if (!existing || existing.redoStack.length === 0) return state;
      files.set(action.path, {
        ...existing,
        redoStack: existing.redoStack.slice(0, -1), // caller restored this snapshot
        undoStack: [...existing.undoStack, action.undoSnapshot],
        dirty: true,
      });
      return { ...state, files };
    }
    case 'REFRESH_BUFFER': {
      // Buffer/pageCount swap that leaves undo/redo history alone — used
      // after an undo/redo restore. Callers drain the page tier first, but if
      // one ever doesn't, invalidate it like UPDATE_FILE does.
      const existing = state.files.get(action.path);
      if (!existing) return state;
      const files = new Map(state.files);
      files.set(action.path, { ...existing, pageCount: action.pageCount, buffer: action.buffer });
      const tierEmpty =
        state.pageUndoStack.length === 0 &&
        state.pageRedoStack.length === 0 &&
        state.pageDirtyPaths.length === 0;
      if (tierEmpty) return { ...state, files };
      const invalidated = new Set([...state.pageDirtyPaths, action.path]);
      return {
        ...state,
        files,
        workspace: {
          documents: state.workspace.documents.filter((d) => !invalidated.has(d.path)),
        },
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: [],
      };
    }
    case 'MARK_SAVED': {
      const files = new Map(state.files);
      const existing = files.get(action.path);
      if (!existing) return state;
      files.set(action.path, { ...existing, dirty: false, undoStack: [], redoStack: [] });
      return { ...state, files };
    }
    case 'SET_WORKSPACE_DOCUMENTS': {
      // Indexing is async — the file may have been closed while it ran.
      if (!state.files.has(action.path)) return state;
      const prev = state.workspace.documents;
      const firstIndex = prev.findIndex((d) => d.path === action.path);
      const kept = prev.filter((d) => d.path !== action.path);
      // Replace this file's documents in place; new files append at the end.
      const insertAt = firstIndex === -1
        ? kept.length
        : prev.slice(0, firstIndex).filter((d) => d.path !== action.path).length;
      const documents = [...kept.slice(0, insertAt), ...action.documents, ...kept.slice(insertAt)];
      return { ...state, workspace: { documents } };
    }
    case 'REORDER_PAGES': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      if (!doc) return state;
      const byId = new Map(doc.pages.map((p) => [p.id, p]));
      const valid =
        action.order.length === doc.pages.length &&
        action.order.every((id) => byId.has(id)) &&
        action.order.some((id, i) => doc.pages[i].id !== id);
      if (!valid) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: action.order.map((id) => byId.get(id)!),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'MOVE_PAGE': {
      const from = state.workspace.documents.find((d) => d.id === action.fromDocId);
      const to = state.workspace.documents.find((d) => d.id === action.toDocId);
      const page = from?.pages.find((p) => p.id === action.pageId);
      if (!from || !to || !page) return state;
      let documents = state.workspace.documents.map((d) => {
        if (d.id !== from.id && d.id !== to.id) return d;
        // Remove from source, then insert at the target index (a same-document
        // move hits both branches, so toIndex counts positions after removal).
        let pages = d.id === from.id ? d.pages.filter((p) => p.id !== page.id) : d.pages;
        if (d.id === to.id) {
          const at = Math.max(0, Math.min(action.toIndex, pages.length));
          pages = [...pages.slice(0, at), page, ...pages.slice(at)];
        }
        return { ...d, pages, pageCount: pages.length };
      });
      if (from.id === to.id && documents.every((d, i) => {
        const prev = state.workspace.documents[i];
        return d.pages.length === prev.pages.length && d.pages.every((p, j) => p === prev.pages[j]);
      })) {
        return state; // same-document move that landed where it started
      }
      if (pagesForPath(documents, from.path) === 0) return state; // would empty the file
      documents = pruneEmptyDocs(documents);
      return applyPageEdit(state, documents, from.path === to.path ? [from.path] : [from.path, to.path]);
    }
    case 'MOVE_PAGE_TO_NEW_DOC': {
      const sourceIndex = state.workspace.documents.findIndex((d) => d.id === action.fromDocId);
      const source = sourceIndex === -1 ? undefined : state.workspace.documents[sourceIndex];
      const page = source?.pages.find((p) => p.id === action.pageId);
      if (!source || !page) return state;
      // The new document is a new partition of the page's source file — it
      // keeps that file's path/buffer (the file never loses pages here), and
      // the commit bridge rebuilds the same file with one more manifest entry.
      const withoutPage = mapDocument(state.workspace.documents, source.id, (d) => {
        const pages = d.pages.filter((p) => p.id !== page.id);
        return { ...d, pages, pageCount: pages.length };
      });
      // An emptied source doc is always pruned here — the new document carries
      // the same path, so the file keeps at least one document.
      const emptied = source.pages.length === 1;
      let next = emptied ? withoutPage.filter((d) => d.id !== source.id) : withoutPage;
      let insertAt = action.docIndex;
      if (emptied && sourceIndex < action.docIndex) insertAt -= 1;
      insertAt = Math.max(0, Math.min(next.length, insertAt));
      const newDoc: OpenDocument = {
        ...source,
        id: action.newDocId,
        name: action.newName,
        pages: [page],
        pageCount: 1,
      };
      next = [...next.slice(0, insertAt), newDoc, ...next.slice(insertAt)];
      return applyPageEdit(state, next, [source.path]);
    }
    case 'DELETE_PAGE_REF': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      if (!doc || !page) return state;
      // Deleting the file's last remaining page would materialize a 0-page
      // PDF at commit — closing the file is the right gesture for that.
      if (pagesForPath(state.workspace.documents, doc.path) <= 1) return state;
      const documents = pruneEmptyDocs(
        mapDocument(state.workspace.documents, action.docId, (d) => {
          const pages = d.pages.filter((p) => p.id !== action.pageId);
          return { ...d, pages, pageCount: pages.length };
        }),
      );
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'SPLIT_DOC': {
      const index = state.workspace.documents.findIndex((d) => d.id === action.docId);
      const doc = index === -1 ? undefined : state.workspace.documents[index];
      if (!doc || action.atIndex <= 0 || action.atIndex >= doc.pages.length) return state;
      const head = doc.pages.slice(0, action.atIndex);
      const tail = doc.pages.slice(action.atIndex);
      const documents = [...state.workspace.documents];
      documents.splice(
        index,
        1,
        { ...doc, pages: head, pageCount: head.length },
        { ...doc, id: action.newDocId, name: action.newName, pages: tail, pageCount: tail.length },
      );
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'ADD_ANNOTATION': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      if (!doc || !page) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? { ...p, annotations: [...(p.annotations ?? []), action.annotation] }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'UPDATE_ANNOTATION': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      const existing = page?.annotations?.find((a) => a.id === action.annotationId);
      if (!doc || !existing || existing.note === action.note) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? {
                ...p,
                annotations: p.annotations!.map((a) =>
                  a.id === action.annotationId ? { ...a, note: action.note } : a,
                ),
              }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'REMOVE_ANNOTATION': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      if (!doc || !page?.annotations?.some((a) => a.id === action.annotationId)) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? { ...p, annotations: p.annotations!.filter((a) => a.id !== action.annotationId) }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'ROTATE_PAGE_REF': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      if (!doc || !page || page.rotation === action.rotation) return state;
      const delta = (action.rotation - page.rotation + 360) % 360;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? {
                ...p,
                rotation: action.rotation,
                annotations: p.annotations?.map((a) => rotateAnnotationRect(a, delta)),
              }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'REORDER_DOCS': {
      const index = state.workspace.documents.findIndex((d) => d.id === action.docId);
      const target = index + action.direction;
      if (index === -1 || target < 0 || target >= state.workspace.documents.length) return state;
      const documents = [...state.workspace.documents];
      [documents[index], documents[target]] = [documents[target], documents[index]];
      // Cross-file strip order is view-only; swapping two partitions of the
      // same file changes that file's page order and must be committed.
      const samePath = documents[index].path === documents[target].path;
      return applyPageEdit(state, documents, samePath ? [documents[index].path] : []);
    }
    case 'RENAME_DOC': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const name = action.name.trim();
      if (!doc || !name || name === doc.name) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        name,
      }));
      // Persisted via the manifest only when the file commits with one —
      // same file-anchored predicate the commit planner uses, so a rename
      // never dirties a file that would then commit without a manifest (or
      // vice versa). Otherwise display-only until reindex.
      const partitionCount = state.workspace.documents.filter((d) => d.path === doc.path).length;
      const fileName = state.files.get(doc.path)?.name ?? doc.name;
      const persists = carriesManifest(fileName, partitionCount);
      return applyPageEdit(state, documents, persists ? [doc.path] : []);
    }
    case 'REMOVE_DOC': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      if (!doc) return state;
      const siblings = state.workspace.documents.filter((d) => d.path === doc.path);
      if (siblings.length === 1) return state; // last document of a file — close the file instead
      const documents = state.workspace.documents.filter((d) => d.id !== action.docId);
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'UNDO_PAGE_OP': {
      const last = state.pageUndoStack[state.pageUndoStack.length - 1];
      if (!last) return state;
      return {
        ...state,
        workspace: { documents: last.documents },
        pageDirtyPaths: last.dirtyPaths,
        pageUndoStack: state.pageUndoStack.slice(0, -1),
        pageRedoStack: [
          ...state.pageRedoStack,
          { documents: state.workspace.documents, dirtyPaths: state.pageDirtyPaths },
        ],
      };
    }
    case 'REDO_PAGE_OP': {
      const next = state.pageRedoStack[state.pageRedoStack.length - 1];
      if (!next) return state;
      return {
        ...state,
        workspace: { documents: next.documents },
        pageDirtyPaths: next.dirtyPaths,
        pageRedoStack: state.pageRedoStack.slice(0, -1),
        pageUndoStack: [
          ...state.pageUndoStack,
          { documents: state.workspace.documents, dirtyPaths: state.pageDirtyPaths },
        ],
      };
    }
    case 'CLEAR_PAGE_EDITS':
      // The commit bridge just materialized the edits to disk; the workspace
      // itself is left alone — the indexer re-derives it from the new buffers.
      return { ...state, pageUndoStack: [], pageRedoStack: [], pageDirtyPaths: [] };
    default:
      return state;
  }
}
