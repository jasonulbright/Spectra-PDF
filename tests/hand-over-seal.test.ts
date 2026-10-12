// A document handed to another window is read from its file on disk. From the
// moment that file is final until the tab closes, the store refuses a page
// edit, undo or redo that would change it, with the reason `moving`.
import { describe, expect, it } from 'vitest';
import { createAppStore, changesSealedPageTier } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState, OpenDocument, OpenFile, PageRef, PdfBuffer } from '../src/renderer/state/types';

function file(path: string): OpenFile {
  const buffer: PdfBuffer = new Uint8Array([path.length]);
  return { path, workingPath: `${path}.w`, name: path, pageCount: 1, buffer, dirty: false, undoStack: [], redoStack: [] };
}

function page(path: string): PageRef {
  return { id: `${path}#p0`, sourceDocId: path, sourcePageIndex: 0, rotation: 0, width: 300, height: 400 };
}

function documentFor(source: OpenFile): OpenDocument {
  return { ...source, id: `${source.path}#0`, pages: [page(source.path)] };
}

function storeWith(...paths: string[]) {
  const files = paths.map(file);
  const state: AppState = {
    ...initialState,
    activeFileId: paths[0],
    files: new Map(files.map((f) => [f.path, f])),
    workspace: { documents: files.map(documentFor) },
  };
  return createAppStore(state);
}

const rotate = (path: string): AppAction => ({ type: 'ROTATE_PAGE_REFS', pageIds: [`${path}#p0`], delta: 90 });
const rotation = (store: ReturnType<typeof storeWith>, path: string) =>
  store.getState().workspace.documents.find((d) => d.path === path)!.pages[0].rotation;

describe('hand-over seal', () => {
  it('refuses a page edit of a sealed path with the reason moving', () => {
    const store = storeWith('a.pdf');
    store.dispatch({ type: 'SEAL_PAGE_TIER', path: 'a.pdf' });
    const before = store.getState();
    store.dispatch(rotate('a.pdf'));
    const after = store.getState();
    expect(rotation(store, 'a.pdf')).toBe(0);
    expect(after.files.get('a.pdf')!.editRevision).toBe(before.files.get('a.pdf')!.editRevision);
    expect(after.pageUndoStack).toBe(before.pageUndoStack);
    expect(after.pageDirtyPaths).toEqual([]);
    expect(after.pageEditRefusals).toBe(before.pageEditRefusals + 1);
    expect(after.pageEditRefusalReason).toBe('moving');
  });

  it('refuses an undo and a redo that would change a sealed path', () => {
    const store = storeWith('a.pdf');
    store.dispatch(rotate('a.pdf'));
    store.dispatch(rotate('a.pdf'));
    store.dispatch({ type: 'UNDO_PAGE_OP' });
    expect(rotation(store, 'a.pdf')).toBe(90);
    store.dispatch({ type: 'SEAL_PAGE_TIER', path: 'a.pdf' });

    const refusals = store.getState().pageEditRefusals;
    store.dispatch({ type: 'UNDO_PAGE_OP' });
    expect(rotation(store, 'a.pdf')).toBe(90);
    store.dispatch({ type: 'REDO_PAGE_OP' });
    expect(rotation(store, 'a.pdf')).toBe(90);
    expect(store.getState().pageEditRefusals).toBe(refusals + 2);
    expect(store.getState().pageUndoStack).toHaveLength(1);
    expect(store.getState().pageRedoStack).toHaveLength(1);
  });

  it('never affects another path', () => {
    const store = storeWith('a.pdf', 'b.pdf');
    store.dispatch({ type: 'SEAL_PAGE_TIER', path: 'a.pdf' });
    store.dispatch(rotate('b.pdf'));
    expect(rotation(store, 'b.pdf')).toBe(90);
    store.dispatch({ type: 'UNDO_PAGE_OP' });
    expect(rotation(store, 'b.pdf')).toBe(0);
    store.dispatch({ type: 'REDO_PAGE_OP' });
    expect(rotation(store, 'b.pdf')).toBe(90);
    expect(store.getState().pageEditRefusals).toBe(0);
  });

  it('refuses an edit that names a sealed path and another path as a whole', () => {
    const store = storeWith('a.pdf', 'b.pdf');
    store.dispatch({ type: 'SEAL_PAGE_TIER', path: 'a.pdf' });
    store.dispatch({ type: 'ROTATE_PAGE_REFS', pageIds: ['a.pdf#p0', 'b.pdf#p0'], delta: 90 });
    expect(rotation(store, 'a.pdf')).toBe(0);
    expect(rotation(store, 'b.pdf')).toBe(0);
    expect(store.getState().pageEditRefusalReason).toBe('moving');
  });

  it('lifts when the sealed path closes', () => {
    const store = storeWith('a.pdf', 'b.pdf');
    store.dispatch({ type: 'SEAL_PAGE_TIER', path: 'a.pdf' });
    store.dispatch({ type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(store.getState().files.has('a.pdf')).toBe(false);

    // The same path opened again is not sealed.
    const reopened = file('a.pdf');
    store.dispatch({ type: 'OPEN_FILE', path: 'a.pdf', workingPath: reopened.workingPath, name: 'a.pdf',
      pageCount: 1, buffer: reopened.buffer! });
    store.dispatch({ type: 'SET_WORKSPACE_DOCUMENTS', path: 'a.pdf', documents: [documentFor(reopened)] });
    const refusals = store.getState().pageEditRefusals;
    store.dispatch(rotate('a.pdf'));
    expect(rotation(store, 'a.pdf')).toBe(90);
    expect(store.getState().pageEditRefusals).toBe(refusals);
  });

  it('lifts on unseal, after a hand-off that failed or stopped', () => {
    const store = storeWith('a.pdf');
    store.dispatch({ type: 'SEAL_PAGE_TIER', path: 'a.pdf' });
    store.dispatch(rotate('a.pdf'));
    expect(rotation(store, 'a.pdf')).toBe(0);
    store.dispatch({ type: 'UNSEAL_PAGE_TIER', path: 'a.pdf' });
    store.dispatch(rotate('a.pdf'));
    expect(rotation(store, 'a.pdf')).toBe(90);
    expect(store.getState().pageEditRefusals).toBe(1);
  });

  it('a seal or unseal changes no state and notifies nobody', () => {
    const store = storeWith('a.pdf');
    let notified = 0;
    store.subscribe(() => { notified++; });
    const before = store.getState();
    store.dispatch({ type: 'SEAL_PAGE_TIER', path: 'a.pdf' });
    store.dispatch({ type: 'UNSEAL_PAGE_TIER', path: 'a.pdf' });
    expect(store.getState()).toBe(before);
    expect(notified).toBe(0);
  });

  it('a byte change that is not a page-tier action passes the seal', () => {
    const before = storeWith('a.pdf').getState();
    const existing = before.files.get('a.pdf')!;
    const after: AppState = {
      ...before,
      files: new Map([['a.pdf', { ...existing, editRevision: 1 }]]),
    };
    const sealed = new Set(['a.pdf']);
    expect(changesSealedPageTier(before, after, { type: 'MARK_SAVED', path: 'a.pdf' }, sealed)).toBe(false);
    expect(changesSealedPageTier(before, after, { type: 'UNDO_PAGE_OP' }, sealed)).toBe(true);
    expect(changesSealedPageTier(before, after, { type: 'UNDO_PAGE_OP' }, new Set())).toBe(false);
  });
});
