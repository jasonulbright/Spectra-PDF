// insertAnchor (M6.3, § 9.3): where Document ▸ Insert Pages puts new pages,
// and whose size a blank page copies. A state question, answered in
// selectors.ts beside the other active-file questions.
import { describe, expect, it } from 'vitest';
import { insertAnchor } from '../src/renderer/state/selectors';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageRef } from '../src/renderer/state/types';

function page(id: string, width = 612, height = 792): PageRef {
  return { id, sourceDocId: 'C:\\a.pdf', sourcePageIndex: 0, rotation: 0, width, height };
}

function fileEntry(path: string, importOnly = false): OpenFile {
  return {
    path,
    workingPath: path,
    name: path.split('\\').pop() ?? path,
    pageCount: 1,
    buffer: null,
    dirty: false,
    undoStack: [],
    redoStack: [],
    ...(importOnly ? { importOnly: true } : {}),
  } as OpenFile;
}

function doc(id: string, path: string, pages: PageRef[]): OpenDocument {
  return { ...fileEntry(path), id, pages };
}

function stateWith(opts: {
  active?: string | null;
  files?: [string, OpenFile][];
  docs?: OpenDocument[];
  currentPageId?: string | null;
}): AppState {
  return {
    ...initialState,
    activeFileId: opts.active ?? null,
    files: new Map(opts.files ?? []),
    workspace: { documents: opts.docs ?? [] },
    ui: { ...initialState.ui, currentPageId: opts.currentPageId ?? null },
  };
}

const A = 'C:\\a.pdf';
const B = 'C:\\b.pdf';

describe('insertAnchor', () => {
  it('lands AFTER the page being read, with that page as the neighbor', () => {
    const pages = [page('p1', 500, 500), page('p2', 200, 300), page('p3')];
    const s = stateWith({
      active: A,
      files: [[A, fileEntry(A)]],
      docs: [doc('d1', A, pages)],
      currentPageId: 'p2',
    });
    expect(insertAnchor(s)).toEqual({ docId: 'd1', index: 2, neighbor: pages[1] });
  });

  it('appends to the active file’s LAST document when nothing is being read', () => {
    const first = doc('d1', A, [page('p1')]);
    const last = doc('d2', A, [page('p2'), page('p3', 100, 100)]);
    const s = stateWith({
      active: A,
      files: [[A, fileEntry(A)]],
      docs: [first, last],
    });
    expect(insertAnchor(s)).toEqual({ docId: 'd2', index: 2, neighbor: last.pages[1] });
  });

  it('ignores a current page that belongs to ANOTHER file', () => {
    // Reading doc B, then focusing A's tab: currentPageId still names B's
    // page. Inserting into B because of it would put the page in a document
    // the user isn't looking at.
    const s = stateWith({
      active: A,
      files: [[A, fileEntry(A)], [B, fileEntry(B)]],
      docs: [doc('da', A, [page('a1')]), doc('db', B, [page('b1')])],
      currentPageId: 'b1',
    });
    expect(insertAnchor(s)).toEqual({
      docId: 'da',
      index: 1,
      neighbor: expect.objectContaining({ id: 'a1' }),
    });
  });

  it('refuses a ghost (import-only) active file', () => {
    const s = stateWith({
      active: A,
      files: [[A, fileEntry(A, true)]],
      docs: [doc('d1', A, [page('p1')])],
    });
    expect(insertAnchor(s)).toBeNull();
  });

  it('is null with no active file or no indexed documents', () => {
    expect(insertAnchor(stateWith({}))).toBeNull();
    // Active but the async indexer hasn't produced documents yet.
    expect(
      insertAnchor(stateWith({ active: A, files: [[A, fileEntry(A)]] })),
    ).toBeNull();
  });
});
