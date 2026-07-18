import { describe, expect, it } from 'vitest';
import { appReducer, initialState, rotateAnnotationRect } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageAnnotation, PageRef } from '../src/renderer/state/types';

function makeFile(path: string, pageCount: number, name?: string): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: name ?? (path.split('/').pop() ?? path),
    pageCount,
    buffer: [1, 2, 3],
    dirty: false,
    undoStack: [],
    redoStack: [],
  };
}

function makePages(path: string, count: number, offset = 0): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${path}#p${offset + i}`,
    sourceDocId: path,
    sourcePageIndex: offset + i,
    rotation: 0 as const,
    width: 300,
    height: 400,
  }));
}

function makeDoc(file: OpenFile, id: string, pages: PageRef[]): OpenDocument {
  return { ...file, id, pages, pageCount: pages.length };
}

function stateWith(files: OpenFile[], documents: OpenDocument[]): AppState {
  return {
    ...initialState,
    files: new Map(files.map((f) => [f.path, f])),
    workspace: { documents },
  };
}

const pageIds = (doc: OpenDocument): string[] => doc.pages.map((p) => p.id);

describe('SET_WORKSPACE_DOCUMENTS', () => {
  it('appends documents for a newly indexed file', () => {
    const a = makeFile('a.pdf', 2);
    const docA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const next = appReducer(stateWith([a], []), {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [docA],
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0']);
  });

  it('replaces a file\'s documents in place, preserving workspace order', () => {
    const a = makeFile('a.pdf', 5);
    const b = makeFile('b.pdf', 2);
    const docA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 5));
    const docB = makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2));
    // Re-index a.pdf as two manifest partitions
    const split = [
      makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3)),
      makeDoc(a, 'a.pdf#1', makePages('a.pdf', 2, 3)),
    ];
    const next = appReducer(stateWith([a, b], [docA, docB]), {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: split,
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0', 'a.pdf#1', 'b.pdf#0']);
  });

  it('is ignored when the file is no longer open', () => {
    const a = makeFile('a.pdf', 2);
    const docA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const next = appReducer(stateWith([], []), {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [docA],
    });
    expect(next.workspace.documents).toEqual([]);
  });
});

describe('CLOSE_FILE', () => {
  it('drops the closed file\'s workspace documents', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 1);
    const docs = [
      makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2)),
      makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1)),
    ];
    const next = appReducer(stateWith([a, b], docs), { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['b.pdf#0']);
  });
});

describe('REORDER_PAGES', () => {
  it('applies a full permutation of the document\'s pages', () => {
    const a = makeFile('a.pdf', 3);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'REORDER_PAGES',
      docId: 'a.pdf#0',
      order: ['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1'],
    });
    expect(pageIds(next.workspace.documents[0])).toEqual(['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1']);
  });

  it('rejects an order that is not a permutation', () => {
    const a = makeFile('a.pdf', 3);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const state = stateWith([a], [doc]);
    for (const order of [
      ['a.pdf#p0', 'a.pdf#p1'], // wrong length
      ['a.pdf#p0', 'a.pdf#p1', 'nope'], // unknown id
    ]) {
      const next = appReducer(state, { type: 'REORDER_PAGES', docId: 'a.pdf#0', order });
      expect(pageIds(next.workspace.documents[0])).toEqual(['a.pdf#p0', 'a.pdf#p1', 'a.pdf#p2']);
    }
  });
});

describe('MOVE_PAGE', () => {
  it('moves a page between documents and updates both page counts', () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 1);
    const docA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const docB = makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1));
    const next = appReducer(stateWith([a, b], [docA, docB]), {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'b.pdf#0',
      pageId: 'a.pdf#p1',
      toIndex: 0,
    });
    const [nextA, nextB] = next.workspace.documents;
    expect(pageIds(nextA)).toEqual(['a.pdf#p0', 'a.pdf#p2']);
    expect(nextA.pageCount).toBe(2);
    expect(pageIds(nextB)).toEqual(['a.pdf#p1', 'b.pdf#p0']);
    expect(nextB.pageCount).toBe(2);
    // The moved page still references its original source bytes
    expect(nextB.pages[0].sourceDocId).toBe('a.pdf');
    expect(nextB.pages[0].sourcePageIndex).toBe(1);
  });

  it('repositions within the same document', () => {
    const a = makeFile('a.pdf', 3);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      toIndex: 2,
    });
    expect(pageIds(next.workspace.documents[0])).toEqual(['a.pdf#p1', 'a.pdf#p2', 'a.pdf#p0']);
    expect(next.workspace.documents[0].pageCount).toBe(3);
  });

  it('is a no-op when the page is not in the source document', () => {
    const a = makeFile('a.pdf', 2);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const state = stateWith([a], [doc]);
    const next = appReducer(state, {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'a.pdf#0',
      pageId: 'missing',
      toIndex: 0,
    });
    expect(next).toBe(state);
  });
});

describe('SPLIT_DOC', () => {
  it('splits one document into two at the given index', () => {
    const a = makeFile('a.pdf', 4);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 4));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'SPLIT_DOC',
      docId: 'a.pdf#0',
      atIndex: 3,
      newDocId: 'a.pdf#0-split',
      newName: 'a (2)',
    });
    const [head, tail] = next.workspace.documents;
    expect(head.id).toBe('a.pdf#0');
    expect(pageIds(head)).toEqual(['a.pdf#p0', 'a.pdf#p1', 'a.pdf#p2']);
    expect(head.pageCount).toBe(3);
    expect(tail.id).toBe('a.pdf#0-split');
    expect(tail.name).toBe('a (2)');
    expect(pageIds(tail)).toEqual(['a.pdf#p3']);
    expect(tail.pageCount).toBe(1);
  });

  it('rejects splits at the document boundaries', () => {
    const a = makeFile('a.pdf', 2);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const state = stateWith([a], [doc]);
    for (const atIndex of [0, 2]) {
      const next = appReducer(state, {
        type: 'SPLIT_DOC',
        docId: 'a.pdf#0',
        atIndex,
        newDocId: 'x',
        newName: 'x',
      });
      expect(next).toBe(state);
    }
  });
});

describe('DELETE_PAGE_REF', () => {
  it('removes the page in memory and marks the file dirty', () => {
    const a = makeFile('a.pdf', 3);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'DELETE_PAGE_REF',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p1',
    });
    expect(pageIds(next.workspace.documents[0])).toEqual(['a.pdf#p0', 'a.pdf#p2']);
    expect(next.workspace.documents[0].pageCount).toBe(2);
    expect(next.pageDirtyPaths).toEqual(['a.pdf']);
    expect(next.pageUndoStack).toHaveLength(1);
  });

  it('refuses to delete a file\'s last page', () => {
    const a = makeFile('a.pdf', 1);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const state = stateWith([a], [doc]);
    expect(
      appReducer(state, { type: 'DELETE_PAGE_REF', docId: 'a.pdf#0', pageId: 'a.pdf#p0' }),
    ).toBe(state);
  });

  it('prunes a partition emptied by the deletion', () => {
    const a = makeFile('a.pdf', 3);
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 2));
    const next = appReducer(stateWith([a], [partA, partB]), {
      type: 'DELETE_PAGE_REF',
      docId: 'a.pdf#1',
      pageId: 'a.pdf#p2',
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0']);
  });
});

describe('ROTATE_PAGE_REF', () => {
  it('sets rotation on exactly the targeted page', () => {
    const a = makeFile('a.pdf', 2);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'ROTATE_PAGE_REF',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p1',
      rotation: 90,
    });
    expect(next.workspace.documents[0].pages.map((p) => p.rotation)).toEqual([0, 90]);
  });
});

describe('page-edit undo tier', () => {
  const twoFiles = () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 2);
    return {
      a,
      b,
      state: stateWith(
        [a, b],
        [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2))],
      ),
    };
  };

  it('page mutations push undo and mark the touched paths dirty', () => {
    const { state } = twoFiles();
    const next = appReducer(state, {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'b.pdf#0',
      pageId: 'a.pdf#p1',
      toIndex: 0,
    });
    expect(next.pageUndoStack).toHaveLength(1);
    expect(next.pageUndoStack[0].documents).toBe(state.workspace.documents);
    expect(next.pageDirtyPaths.sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(next.pageRedoStack).toEqual([]);
  });

  it('rejected edits push nothing', () => {
    const { state } = twoFiles();
    const next = appReducer(state, {
      type: 'REORDER_PAGES',
      docId: 'a.pdf#0',
      order: ['a.pdf#p0', 'a.pdf#p1', 'a.pdf#p2'], // identity — not a change
    });
    expect(next).toBe(state);
  });

  it('UNDO_PAGE_OP restores documents and dirty paths; REDO_PAGE_OP reapplies', () => {
    const { state } = twoFiles();
    const edited = appReducer(state, {
      type: 'REORDER_PAGES',
      docId: 'a.pdf#0',
      order: ['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1'],
    });
    const undone = appReducer(edited, { type: 'UNDO_PAGE_OP' });
    expect(undone.workspace.documents).toBe(state.workspace.documents);
    expect(undone.pageDirtyPaths).toEqual([]);
    expect(undone.pageRedoStack).toHaveLength(1);
    const redone = appReducer(undone, { type: 'REDO_PAGE_OP' });
    expect(redone.workspace.documents).toBe(edited.workspace.documents);
    expect(redone.pageDirtyPaths).toEqual(['a.pdf']);
    expect(appReducer(state, { type: 'UNDO_PAGE_OP' })).toBe(state);
  });

  it('CLEAR_PAGE_EDITS resets the tier but leaves the workspace alone', () => {
    const { state } = twoFiles();
    const edited = appReducer(state, {
      type: 'REORDER_PAGES',
      docId: 'a.pdf#0',
      order: ['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1'],
    });
    const cleared = appReducer(edited, { type: 'CLEAR_PAGE_EDITS' });
    expect(cleared.pageUndoStack).toEqual([]);
    expect(cleared.pageRedoStack).toEqual([]);
    expect(cleared.pageDirtyPaths).toEqual([]);
    expect(cleared.workspace.documents).toBe(edited.workspace.documents);
  });
});

describe('zero-page and prune guards', () => {
  it('rejects a cross-file move that would empty the source file', () => {
    const a = makeFile('a.pdf', 1);
    const b = makeFile('b.pdf', 1);
    const state = stateWith(
      [a, b],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1))],
    );
    const next = appReducer(state, {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'b.pdf#0',
      pageId: 'a.pdf#p0',
      toIndex: 0,
    });
    expect(next).toBe(state);
  });

  it('prunes an emptied partition when the file has siblings', () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 1);
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 2));
    const docB = makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1));
    const state = stateWith([a, b], [partA, partB, docB]);
    const next = appReducer(state, {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#1',
      toDocId: 'b.pdf#0',
      pageId: 'a.pdf#p2',
      toIndex: 1,
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0', 'b.pdf#0']);
  });
});

describe('MOVE_PAGE_TO_NEW_DOC', () => {
  it('creates a new partition of the source file at the given slot', () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 1);
    const state = stateWith(
      [a, b],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1))],
    );
    const next = appReducer(state, {
      type: 'MOVE_PAGE_TO_NEW_DOC',
      fromDocId: 'a.pdf#0',
      pageId: 'a.pdf#p1',
      docIndex: 1,
      newDocId: 'new-doc',
      newName: 'a (2)',
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0', 'new-doc', 'b.pdf#0']);
    const created = next.workspace.documents[1];
    expect(created.path).toBe('a.pdf');
    expect(created.name).toBe('a (2)');
    expect(created.pages.map((p) => p.id)).toEqual(['a.pdf#p1']);
    expect(next.pageDirtyPaths).toEqual(['a.pdf']);
  });

  it('prunes an emptied single-page source and adjusts the insert slot', () => {
    const a = makeFile('a.pdf', 3);
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 2));
    const state = stateWith([a], [partA, partB]);
    const next = appReducer(state, {
      type: 'MOVE_PAGE_TO_NEW_DOC',
      fromDocId: 'a.pdf#1',
      pageId: 'a.pdf#p2',
      docIndex: 2,
      newDocId: 'new-doc',
      newName: 'a (2)',
    });
    // Source partition emptied and removed; new doc lands after the remaining one.
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0', 'new-doc']);
  });
});

describe('REORDER_DOCS / RENAME_DOC / REMOVE_DOC', () => {
  it('swaps neighbors and marks dirty only for same-file swaps', () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 1);
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 2));
    const docB = makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1));
    const state = stateWith([a, b], [partA, partB, docB]);

    const crossFile = appReducer(state, { type: 'REORDER_DOCS', docId: 'b.pdf#0', direction: -1 });
    expect(crossFile.workspace.documents.map((d) => d.id)).toEqual([
      'a.pdf#0',
      'b.pdf#0',
      'a.pdf#1',
    ]);
    expect(crossFile.pageDirtyPaths).toEqual([]); // view-only, but still undoable
    expect(crossFile.pageUndoStack).toHaveLength(1);

    const sameFile = appReducer(state, { type: 'REORDER_DOCS', docId: 'a.pdf#1', direction: -1 });
    expect(sameFile.pageDirtyPaths).toEqual(['a.pdf']);

    expect(appReducer(state, { type: 'REORDER_DOCS', docId: 'a.pdf#0', direction: -1 })).toBe(
      state,
    );
  });

  it('renames mark dirty only when the file carries a manifest', () => {
    const a = makeFile('a.pdf', 3);
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 2));
    const multi = appReducer(stateWith([a], [partA, partB]), {
      type: 'RENAME_DOC',
      docId: 'a.pdf#0',
      name: 'Chapter One',
    });
    expect(multi.workspace.documents[0].name).toBe('Chapter One');
    expect(multi.pageDirtyPaths).toEqual(['a.pdf']);

    const plain = makeFile('c.pdf', 2);
    const single = appReducer(
      stateWith([plain], [makeDoc(plain, 'c.pdf#0', makePages('c.pdf', 2))]),
      { type: 'RENAME_DOC', docId: 'c.pdf#0', name: 'Renamed' },
    );
    expect(single.workspace.documents[0].name).toBe('Renamed');
    expect(single.pageDirtyPaths).toEqual([]); // display-only until reindex
  });

  it('removes a partition but never the last document of a file', () => {
    const a = makeFile('a.pdf', 3);
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 2));
    const state = stateWith([a], [partA, partB]);
    const removed = appReducer(state, { type: 'REMOVE_DOC', docId: 'a.pdf#1' });
    expect(removed.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0']);
    expect(removed.pageDirtyPaths).toEqual(['a.pdf']);

    const lastDoc = appReducer(removed, { type: 'REMOVE_DOC', docId: 'a.pdf#0' });
    expect(lastDoc).toBe(removed);
  });
});

describe('UPDATE_FILE with a non-empty page tier (bypassed-gate hardening)', () => {
  const editedState = () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 2);
    const c = makeFile('c.pdf', 2);
    const state = stateWith(
      [a, b, c],
      [
        makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3)),
        makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2)),
        makeDoc(c, 'c.pdf#0', makePages('c.pdf', 2)),
      ],
    );
    // Cross-file move entangles a.pdf and b.pdf; c.pdf stays clean.
    return appReducer(state, {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'b.pdf#0',
      pageId: 'a.pdf#p1',
      toIndex: 0,
    });
  };

  it('resets the tier and drops the dirty paths\' documents for reindexing', () => {
    const edited = editedState();
    const next = appReducer(edited, {
      type: 'UPDATE_FILE',
      path: 'a.pdf',
      pageCount: 2,
      buffer: [9, 9, 9],
      snapshotPath: 'snap1',
    });
    expect(next.pageUndoStack).toEqual([]);
    expect(next.pageRedoStack).toEqual([]);
    expect(next.pageDirtyPaths).toEqual([]);
    // Entangled (dirty) paths' docs dropped; untouched clean file keeps its docs.
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['c.pdf#0']);
    // The file update itself still lands on the snapshot chain.
    expect(next.files.get('a.pdf')?.undoStack).toEqual(['snap1']);
    expect(next.files.get('a.pdf')?.pageCount).toBe(2);
  });

  it('leaves the workspace alone when the tier is empty', () => {
    const a = makeFile('a.pdf', 3);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))]);
    const next = appReducer(state, {
      type: 'UPDATE_FILE',
      path: 'a.pdf',
      pageCount: 2,
      buffer: [9],
      snapshotPath: 'snap1',
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0']);
    expect(next.files.get('a.pdf')?.undoStack).toEqual(['snap1']);
  });
});

describe('COMMIT_PAGE_EDITS', () => {
  it('applies all file updates and clears the tier atomically', () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 2);
    const state = stateWith(
      [a, b],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2))],
    );
    const edited = appReducer(state, {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'b.pdf#0',
      pageId: 'a.pdf#p1',
      toIndex: 0,
    });
    const next = appReducer(edited, {
      type: 'COMMIT_PAGE_EDITS',
      updates: [
        {
          path: 'a.pdf', pageCount: 2, buffer: [1], snapshotPath: 'snapA',
          authored: { pages: ['a#pA', 'a#pB'], documents: [{ id: 'a#0', name: 'a' }] },
        },
        {
          path: 'b.pdf', pageCount: 3, buffer: [2], snapshotPath: 'snapB',
          authored: { pages: ['b#p0', 'b#p1', 'a#p1'], documents: [{ id: 'b#0', name: 'b' }] },
        },
      ],
    });
    expect(next.files.get('a.pdf')).toMatchObject({ pageCount: 2, dirty: true, undoStack: ['snapA'] });
    expect(next.files.get('b.pdf')).toMatchObject({ pageCount: 3, dirty: true, undoStack: ['snapB'] });
    // § F identity channel: the record lands keyed to THE committed buffer
    // object (adoption checks identity, not equality).
    const recA = next.files.get('a.pdf')!.authoredIdentity!;
    expect(recA.pages).toEqual(['a#pA', 'a#pB']);
    expect(recA.buffer).toBe(next.files.get('a.pdf')!.buffer);
    // A later NON-authored update (engine op) drops the record.
    const afterOp = appReducer(next, {
      type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 2, buffer: [7], snapshotPath: 'snapC',
    });
    expect(afterOp.files.get('a.pdf')!.authoredIdentity).toBeUndefined();
    expect(next.pageUndoStack).toEqual([]);
    expect(next.pageRedoStack).toEqual([]);
    expect(next.pageDirtyPaths).toEqual([]);
    // Workspace untouched — the indexer re-derives from the new buffers.
    expect(next.workspace.documents).toBe(edited.workspace.documents);
  });
});

describe('OPEN_FILE with a non-empty page tier', () => {
  it('clears undo history (unreplayable) but keeps pending dirt', () => {
    const a = makeFile('a.pdf', 3);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))]);
    const edited = appReducer(state, {
      type: 'REORDER_PAGES',
      docId: 'a.pdf#0',
      order: ['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1'],
    });
    const next = appReducer(edited, {
      type: 'OPEN_FILE',
      path: 'b.pdf',
      workingPath: 'b.pdf.working',
      name: 'b.pdf',
      pageCount: 2,
      buffer: [5],
    });
    expect(next.pageUndoStack).toEqual([]);
    expect(next.pageRedoStack).toEqual([]);
    expect(next.pageDirtyPaths).toEqual(['a.pdf']); // composition still committable
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0']);
  });
});

describe('RENAME_DOC manifest predicate (file-anchored)', () => {
  it('dirties a single-partition .pdfx file — its manifest persists the name', () => {
    const bundle = makeFile('c.pdfx', 2, 'c.pdfx');
    const state = stateWith([bundle], [makeDoc(bundle, 'c.pdfx#0', makePages('c.pdfx', 2))]);
    const next = appReducer(state, { type: 'RENAME_DOC', docId: 'c.pdfx#0', name: 'Bundle' });
    expect(next.workspace.documents[0].name).toBe('Bundle');
    expect(next.pageDirtyPaths).toEqual(['c.pdfx']);
  });

  it('does not dirty a plain single-doc PDF even if the partition name says .pdfx', () => {
    const plain = makeFile('a.pdf', 2);
    const state = stateWith([plain], [makeDoc(plain, 'a.pdf#0', makePages('a.pdf', 2))]);
    const next = appReducer(state, {
      type: 'RENAME_DOC',
      docId: 'a.pdf#0',
      name: 'archive.pdfx', // display name only — the FILE is a plain .pdf
    });
    expect(next.workspace.documents[0].name).toBe('archive.pdfx');
    expect(next.pageDirtyPaths).toEqual([]);
  });
});

describe('ADD_ANNOTATION / REMOVE_ANNOTATION', () => {
  const ann = { id: 'ann1', kind: 'highlight' as const, x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: '#ffd54a' };

  it('adds to the page, marks dirty, and is undoable', () => {
    const a = makeFile('a.pdf', 2);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'ADD_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p1',
      annotation: ann,
    });
    expect(next.workspace.documents[0].pages[1].annotations).toEqual([ann]);
    expect(next.workspace.documents[0].pages[0].annotations).toBeUndefined();
    expect(next.pageDirtyPaths).toEqual(['a.pdf']);
    expect(next.pageUndoStack).toHaveLength(1);
    const undone = appReducer(next, { type: 'UNDO_PAGE_OP' });
    expect(undone.workspace.documents[0].pages[1].annotations).toBeUndefined();
  });

  it('UPDATE_ANNOTATION edits the note and is undoable; same-note is a no-op', () => {
    const a = makeFile('a.pdf', 1);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const withAnn = appReducer(stateWith([a], [doc]), {
      type: 'ADD_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotation: { ...ann, kind: 'freetext' },
    });
    const updated = appReducer(withAnn, {
      type: 'UPDATE_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationId: 'ann1',
      note: 'hello',
    });
    expect(updated.workspace.documents[0].pages[0].annotations![0].note).toBe('hello');
    expect(updated.pageUndoStack).toHaveLength(2);
    expect(
      appReducer(updated, {
        type: 'UPDATE_ANNOTATION',
        docId: 'a.pdf#0',
        pageId: 'a.pdf#p0',
        annotationId: 'ann1',
        note: 'hello',
      }),
    ).toBe(updated);
  });

  it('RECOLOR_ANNOTATION edits the color and is undoable; same-color is a no-op', () => {
    const a = makeFile('a.pdf', 1);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const withAnn = appReducer(stateWith([a], [doc]), {
      type: 'ADD_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotation: ann,
    });
    const recolored = appReducer(withAnn, {
      type: 'RECOLOR_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationId: 'ann1',
      color: '#2f6fed',
    });
    expect(recolored.workspace.documents[0].pages[0].annotations![0].color).toBe('#2f6fed');
    expect(recolored.pageUndoStack).toHaveLength(2);
    expect(
      appReducer(recolored, {
        type: 'RECOLOR_ANNOTATION',
        docId: 'a.pdf#0',
        pageId: 'a.pdf#p0',
        annotationId: 'ann1',
        color: '#2f6fed',
      }),
    ).toBe(recolored);
  });

  it('removes by id; unknown ids are a no-op', () => {
    const a = makeFile('a.pdf', 1);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const withAnn = appReducer(stateWith([a], [doc]), {
      type: 'ADD_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotation: ann,
    });
    const removed = appReducer(withAnn, {
      type: 'REMOVE_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationId: 'ann1',
    });
    expect(removed.workspace.documents[0].pages[0].annotations).toEqual([]);
    expect(
      appReducer(withAnn, {
        type: 'REMOVE_ANNOTATION',
        docId: 'a.pdf#0',
        pageId: 'a.pdf#p0',
        annotationId: 'nope',
      }),
    ).toBe(withAnn);
  });

  it('handles stamp annotations the same kind-agnostic way as highlight/freetext', () => {
    const a = makeFile('a.pdf', 1);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const stamp = { id: 'stamp1', kind: 'stamp' as const, x: 0.3, y: 0.4, w: 0.32, h: 0.09, color: '#2fbf71', note: 'APPROVED' };
    const withStamp = appReducer(stateWith([a], [doc]), {
      type: 'ADD_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotation: stamp,
    });
    expect(withStamp.workspace.documents[0].pages[0].annotations).toEqual([stamp]);
    const removed = appReducer(withStamp, {
      type: 'REMOVE_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotationId: 'stamp1',
    });
    expect(removed.workspace.documents[0].pages[0].annotations).toEqual([]);
  });
});

describe('annotation rects follow page rotation', () => {
  const base = { id: 'a', kind: 'highlight' as const, x: 0.1, y: 0.2, w: 0.3, h: 0.15, color: '#ffd54a' };

  it('rotateAnnotationRect turns rects with the page', () => {
    expect(rotateAnnotationRect(base, 90)).toMatchObject({ x: 0.65, y: 0.1, w: 0.15, h: 0.3 });
    expect(rotateAnnotationRect(base, 180)).toMatchObject({ x: 0.6, y: 0.65, w: 0.3, h: 0.15 });
    expect(rotateAnnotationRect(base, 270)).toMatchObject({ x: 0.2, y: 0.6, w: 0.15, h: 0.3 });
    // Four quarter-turns compose back to the original (within float noise).
    let r: PageAnnotation = base;
    for (let i = 0; i < 4; i++) r = rotateAnnotationRect(r, 90);
    expect(r.x).toBeCloseTo(base.x, 10);
    expect(r.y).toBeCloseTo(base.y, 10);
  });

  it('ROTATE_PAGE_REF re-projects existing annotations by the delta', () => {
    const a = makeFile('a.pdf', 1);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const annotated = appReducer(stateWith([a], [doc]), {
      type: 'ADD_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotation: base,
    });
    const rotated = appReducer(annotated, {
      type: 'ROTATE_PAGE_REF',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      rotation: 90,
    });
    const page = rotated.workspace.documents[0].pages[0];
    expect(page.rotation).toBe(90);
    expect(page.annotations![0]).toMatchObject({ x: 0.65, y: 0.1, w: 0.15, h: 0.3 });
    // Rotating back restores the original rect.
    const back = appReducer(rotated, {
      type: 'ROTATE_PAGE_REF',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      rotation: 0,
    });
    const restored = back.workspace.documents[0].pages[0].annotations![0];
    expect(restored.x).toBeCloseTo(base.x, 10);
    expect(restored.y).toBeCloseTo(base.y, 10);
    expect(restored.w).toBeCloseTo(base.w, 10);
    expect(restored.h).toBeCloseTo(base.h, 10);
  });

  it('rotateAnnotationRect turns ink points along with the bbox', () => {
    const ink = {
      id: 'i',
      kind: 'ink' as const,
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.1,
      color: '#2f6fed',
      points: [0.1, 0.2, 0.4, 0.3],
    };
    const rotated = rotateAnnotationRect(ink, 90);
    expect(rotated).toMatchObject({ x: 0.7, y: 0.1, w: 0.1, h: 0.3 });
    // Each point re-projects individually, consistent with the new bbox.
    expect(rotated.points![0]).toBeCloseTo(0.8, 10);
    expect(rotated.points![1]).toBeCloseTo(0.1, 10);
    expect(rotated.points![2]).toBeCloseTo(0.7, 10);
    expect(rotated.points![3]).toBeCloseTo(0.4, 10);
    // Four quarter-turns compose back to the original.
    let r: PageAnnotation = ink;
    for (let i = 0; i < 4; i++) r = rotateAnnotationRect(r, 90);
    expect(r.points![0]).toBeCloseTo(ink.points[0], 10);
    expect(r.points![1]).toBeCloseTo(ink.points[1], 10);
    expect(r.points![2]).toBeCloseTo(ink.points[2], 10);
    expect(r.points![3]).toBeCloseTo(ink.points[3], 10);
  });
});

describe('snapshot undo/redo history (multi-level)', () => {
  const withHistory = () => {
    const a = makeFile('a.pdf', 5);
    let state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 5))]);
    // Two whole-file ops → two undo entries.
    state = appReducer(state, { type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 4, buffer: [2], snapshotPath: 'snap1' });
    state = appReducer(state, { type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 3, buffer: [3], snapshotPath: 'snap2' });
    return state;
  };

  it('supports two consecutive undos and preserves redo path', () => {
    let state = withHistory();
    expect(state.files.get('a.pdf')?.undoStack).toEqual(['snap1', 'snap2']);

    state = appReducer(state, { type: 'UNDO', path: 'a.pdf', redoSnapshot: 'redo2' });
    expect(state.files.get('a.pdf')?.undoStack).toEqual(['snap1']); // second undo still possible
    expect(state.files.get('a.pdf')?.redoStack).toEqual(['redo2']);
    expect(state.files.get('a.pdf')?.dirty).toBe(true);

    state = appReducer(state, { type: 'UNDO', path: 'a.pdf', redoSnapshot: 'redo1' });
    expect(state.files.get('a.pdf')?.undoStack).toEqual([]);
    expect(state.files.get('a.pdf')?.redoStack).toEqual(['redo2', 'redo1']);
    expect(state.files.get('a.pdf')?.dirty).toBe(false);

    state = appReducer(state, { type: 'REDO', path: 'a.pdf', undoSnapshot: 'snap1' });
    expect(state.files.get('a.pdf')?.undoStack).toEqual(['snap1']);
    expect(state.files.get('a.pdf')?.redoStack).toEqual(['redo2']);
    expect(state.files.get('a.pdf')?.dirty).toBe(true);
  });

  it('REFRESH_BUFFER swaps bytes without touching history', () => {
    let state = withHistory();
    state = appReducer(state, { type: 'REFRESH_BUFFER', path: 'a.pdf', pageCount: 4, buffer: [9] });
    const f = state.files.get('a.pdf')!;
    expect(f.pageCount).toBe(4);
    expect(f.buffer).toEqual([9]);
    expect(f.undoStack).toEqual(['snap1', 'snap2']); // untouched — the original bug reset these
    expect(f.redoStack).toEqual([]);
  });
});

describe('CLOSE_FILE with pending cross-file edits', () => {
  it('strips pages sourced from the closed file and resets the tier', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 2);
    const state = stateWith(
      [a, b],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2))],
    );
    // Move a page from a.pdf into b's doc, then close a.pdf.
    const moved = appReducer(state, {
      type: 'MOVE_PAGE',
      fromDocId: 'a.pdf#0',
      toDocId: 'b.pdf#0',
      pageId: 'a.pdf#p0',
      toIndex: 0,
    });
    const closed = appReducer(moved, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(closed.workspace.documents.map((d) => d.id)).toEqual(['b.pdf#0']);
    expect(closed.workspace.documents[0].pages.every((p) => p.sourceDocId === 'b.pdf')).toBe(true);
    expect(closed.pageUndoStack).toEqual([]);
    expect(closed.pageRedoStack).toEqual([]);
    expect(closed.pageDirtyPaths).toEqual(['b.pdf']);
  });

  it('resets a path stripped to zero pages instead of keeping an uncommittable strip', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 1);
    // b's only document holds nothing but a-sourced pages (its own page was
    // moved elsewhere earlier in the session).
    const state = {
      ...stateWith(
        [a, b],
        [
          makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1, 1)),
          makeDoc(b, 'b.pdf#0', makePages('a.pdf', 1)),
        ],
      ),
      pageDirtyPaths: ['a.pdf', 'b.pdf'],
    };
    const closed = appReducer(state, { type: 'CLOSE_FILE', path: 'a.pdf' });
    // b's stripped-to-empty doc is dropped — the indexer restores b's pristine
    // composition from its unchanged buffer — and b is no longer dirty.
    expect(closed.workspace.documents).toEqual([]);
    expect(closed.pageDirtyPaths).toEqual([]);
  });
});

describe('MOVE_PAGES (batched multi-select move)', () => {
  it('moves several pages into another doc in workspace order, one undo step', () => {
    const a = makeFile('a.pdf', 4);
    const b = makeFile('b.pdf', 1);
    const docA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 4));
    const docB = makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1));
    const next = appReducer(stateWith([a, b], [docA, docB]), {
      type: 'MOVE_PAGES',
      pageIds: ['a.pdf#p2', 'a.pdf#p0'], // deliberately out of order — result is workspace order
      toDocId: 'b.pdf#0',
      toIndex: 0,
    });
    const [nextA, nextB] = next.workspace.documents;
    expect(pageIds(nextA)).toEqual(['a.pdf#p1', 'a.pdf#p3']);
    expect(pageIds(nextB)).toEqual(['a.pdf#p0', 'a.pdf#p2', 'b.pdf#p0']);
    expect(next.pageUndoStack).toHaveLength(1); // batched = single undo entry
    expect(next.pageDirtyPaths.sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('collects a selection spanning multiple docs, flattened in workspace order', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 2);
    const c = makeFile('c.pdf', 1);
    const docs = [
      makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2)),
      makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2)),
      makeDoc(c, 'c.pdf#0', makePages('c.pdf', 1)),
    ];
    const next = appReducer(stateWith([a, b, c], docs), {
      type: 'MOVE_PAGES',
      pageIds: ['b.pdf#p0', 'a.pdf#p1'],
      toDocId: 'c.pdf#0',
      toIndex: 1,
    });
    const byId = new Map(next.workspace.documents.map((d) => [d.id, d]));
    expect(pageIds(byId.get('a.pdf#0')!)).toEqual(['a.pdf#p0']);
    expect(pageIds(byId.get('b.pdf#0')!)).toEqual(['b.pdf#p1']);
    // a.pdf#p1 precedes b.pdf#p0 in workspace order, so that's the inserted order.
    expect(pageIds(byId.get('c.pdf#0')!)).toEqual(['c.pdf#p0', 'a.pdf#p1', 'b.pdf#p0']);
  });

  it('reorders a multi-selection within the same document', () => {
    const a = makeFile('a.pdf', 5);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 5));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'MOVE_PAGES',
      pageIds: ['a.pdf#p0', 'a.pdf#p1'],
      toDocId: 'a.pdf#0',
      toIndex: 3, // after removal, kept = [p2,p3,p4]; insert at 3 → end
    });
    expect(pageIds(next.workspace.documents[0])).toEqual([
      'a.pdf#p2',
      'a.pdf#p3',
      'a.pdf#p4',
      'a.pdf#p0',
      'a.pdf#p1',
    ]);
  });

  it('is a no-op (no undo entry) when the selection lands exactly where it started', () => {
    const a = makeFile('a.pdf', 3);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const state = stateWith([a], [doc]);
    const next = appReducer(state, {
      type: 'MOVE_PAGES',
      pageIds: ['a.pdf#p0', 'a.pdf#p1'],
      toDocId: 'a.pdf#0',
      toIndex: 0, // kept=[p2]; inserting [p0,p1] at 0 → p0,p1,p2 (unchanged)
    });
    expect(next).toBe(state);
  });

  it('rejects the whole batch if any id is not found', () => {
    const a = makeFile('a.pdf', 3);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const state = stateWith([a], [doc]);
    const next = appReducer(state, {
      type: 'MOVE_PAGES',
      pageIds: ['a.pdf#p0', 'ghost'],
      toDocId: 'a.pdf#0',
      toIndex: 0,
    });
    expect(next).toBe(state);
  });

  it('rejects a move that would empty a source file, and prunes emptied partitions otherwise', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 1);
    const wouldEmpty = stateWith(
      [a, b],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1))],
    );
    // Moving BOTH of a.pdf's pages into b empties a.pdf → rejected atomically.
    expect(
      appReducer(wouldEmpty, {
        type: 'MOVE_PAGES',
        pageIds: ['a.pdf#p0', 'a.pdf#p1'],
        toDocId: 'b.pdf#0',
        toIndex: 0,
      }),
    ).toBe(wouldEmpty);

    // A partition (not a whole file) emptied by the move is pruned.
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 1));
    const c = makeFile('c.pdf', 1);
    const withParts = stateWith(
      [a, c],
      [partA, partB, makeDoc(c, 'c.pdf#0', makePages('c.pdf', 1))],
    );
    const pruned = appReducer(withParts, {
      type: 'MOVE_PAGES',
      pageIds: ['a.pdf#p1'], // empties partB, but a.pdf keeps partA → allowed
      toDocId: 'c.pdf#0',
      toIndex: 0,
    });
    expect(pruned.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0', 'c.pdf#0']);
  });
});

describe('MOVE_PAGES_TO_NEW_DOC (batched extract-to-new-doc)', () => {
  it('creates a new doc from the selection, templated on the first page\'s doc', () => {
    const a = makeFile('a.pdf', 4);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 4));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'MOVE_PAGES_TO_NEW_DOC',
      pageIds: ['a.pdf#p3', 'a.pdf#p1'],
      docIndex: 1,
      newDocId: 'new-doc',
      newName: 'a (extract)',
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0', 'new-doc']);
    const [orig, created] = next.workspace.documents;
    expect(pageIds(orig)).toEqual(['a.pdf#p0', 'a.pdf#p2']);
    expect(created.path).toBe('a.pdf');
    expect(created.name).toBe('a (extract)');
    // Workspace order preserved in the new doc (p1 before p3).
    expect(pageIds(created)).toEqual(['a.pdf#p1', 'a.pdf#p3']);
    expect(next.pageUndoStack).toHaveLength(1);
  });

  it('re-partitions (not rejects) when the selection is every page of its only file', () => {
    const a = makeFile('a.pdf', 2);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2))]);
    // All of a.pdf → the emptied source partition is pruned, but the new doc IS
    // a.pdf (same path), so the file keeps its pages: this re-partitions rather
    // than emptying the file, so it is allowed.
    const next = appReducer(state, {
      type: 'MOVE_PAGES_TO_NEW_DOC',
      pageIds: ['a.pdf#p0', 'a.pdf#p1'],
      docIndex: 1,
      newDocId: 'new-doc',
      newName: 'a (2)',
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['new-doc']);
    expect(pageIds(next.workspace.documents[0])).toEqual(['a.pdf#p0', 'a.pdf#p1']);
  });

  it('rejects when it would empty a DIFFERENT source file', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 1);
    const state = stateWith(
      [a, b],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 1))],
    );
    // New doc templates on a.pdf (first page); pulling b's only page in empties b.
    expect(
      appReducer(state, {
        type: 'MOVE_PAGES_TO_NEW_DOC',
        pageIds: ['a.pdf#p0', 'b.pdf#p0'],
        docIndex: 2,
        newDocId: 'new-doc',
        newName: 'mix',
      }),
    ).toBe(state);
  });
});

describe('DELETE_PAGE_REFS (batched delete)', () => {
  it('removes several pages across docs in one undo step, marking every touched path dirty', () => {
    const a = makeFile('a.pdf', 3);
    const b = makeFile('b.pdf', 3);
    const docs = [
      makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3)),
      makeDoc(b, 'b.pdf#0', makePages('b.pdf', 3)),
    ];
    const next = appReducer(stateWith([a, b], docs), {
      type: 'DELETE_PAGE_REFS',
      pageIds: ['a.pdf#p1', 'b.pdf#p2', 'a.pdf#p0'],
    });
    const [nextA, nextB] = next.workspace.documents;
    expect(pageIds(nextA)).toEqual(['a.pdf#p2']);
    expect(pageIds(nextB)).toEqual(['b.pdf#p0', 'b.pdf#p1']);
    expect(next.pageUndoStack).toHaveLength(1);
    expect(next.pageDirtyPaths.sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('rejects the whole batch if it would empty any file', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 2);
    const state = stateWith(
      [a, b],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2))],
    );
    // Deleting both of a.pdf's pages would materialize a 0-page a.pdf → reject.
    expect(
      appReducer(state, {
        type: 'DELETE_PAGE_REFS',
        pageIds: ['a.pdf#p0', 'a.pdf#p1', 'b.pdf#p0'],
      }),
    ).toBe(state);
  });

  it('prunes an emptied partition when the file keeps pages elsewhere', () => {
    const a = makeFile('a.pdf', 3);
    const partA = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const partB = makeDoc(a, 'a.pdf#1', makePages('a.pdf', 1, 2));
    const next = appReducer(stateWith([a], [partA, partB]), {
      type: 'DELETE_PAGE_REFS',
      pageIds: ['a.pdf#p2'],
    });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0']);
  });

  it('ignores an all-unknown batch', () => {
    const a = makeFile('a.pdf', 2);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2))]);
    expect(appReducer(state, { type: 'DELETE_PAGE_REFS', pageIds: ['ghost'] })).toBe(state);
  });

  it('rejects the whole batch atomically when ANY id is unknown (no partial delete)', () => {
    // A partially-stale selection (e.g. one id left over from before a reindex)
    // must not delete the subset that happens to still match.
    const a = makeFile('a.pdf', 3);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))]);
    expect(
      appReducer(state, { type: 'DELETE_PAGE_REFS', pageIds: ['a.pdf#p0', 'ghost'] }),
    ).toBe(state);
  });
});

describe('ROTATE_PAGE_REFS (batched rotate by delta)', () => {
  it('rotates exactly the selected pages by the delta, one undo step', () => {
    const a = makeFile('a.pdf', 3);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3));
    const next = appReducer(stateWith([a], [doc]), {
      type: 'ROTATE_PAGE_REFS',
      pageIds: ['a.pdf#p0', 'a.pdf#p2'],
      delta: 90,
    });
    expect(next.workspace.documents[0].pages.map((p) => p.rotation)).toEqual([90, 0, 90]);
    expect(next.pageUndoStack).toHaveLength(1);
    expect(next.pageDirtyPaths).toEqual(['a.pdf']);
  });

  it('adds the delta to each page\'s current rotation (wrapping past 360)', () => {
    const a = makeFile('a.pdf', 2);
    const pages = makePages('a.pdf', 2);
    pages[0] = { ...pages[0], rotation: 270 };
    const doc = makeDoc(a, 'a.pdf#0', pages);
    const next = appReducer(stateWith([a], [doc]), {
      type: 'ROTATE_PAGE_REFS',
      pageIds: ['a.pdf#p0'],
      delta: 180,
    });
    expect(next.workspace.documents[0].pages[0].rotation).toBe(90); // 270 + 180 = 450 → 90
  });

  it('re-projects annotations on the rotated pages', () => {
    const a = makeFile('a.pdf', 1);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 1));
    const base = { id: 'x', kind: 'highlight' as const, x: 0.1, y: 0.2, w: 0.3, h: 0.15, color: '#ffd54a' };
    const annotated = appReducer(stateWith([a], [doc]), {
      type: 'ADD_ANNOTATION',
      docId: 'a.pdf#0',
      pageId: 'a.pdf#p0',
      annotation: base,
    });
    const rotated = appReducer(annotated, {
      type: 'ROTATE_PAGE_REFS',
      pageIds: ['a.pdf#p0'],
      delta: 90,
    });
    expect(rotated.workspace.documents[0].pages[0].annotations![0]).toMatchObject({
      x: 0.65,
      y: 0.1,
      w: 0.15,
      h: 0.3,
    });
  });

  it('is a no-op for an empty selection or a zero-normalized delta', () => {
    const a = makeFile('a.pdf', 2);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2))]);
    expect(appReducer(state, { type: 'ROTATE_PAGE_REFS', pageIds: [], delta: 90 })).toBe(state);
    expect(appReducer(state, { type: 'ROTATE_PAGE_REFS', pageIds: ['ghost'], delta: 90 })).toBe(state);
  });

  it('rejects the whole batch atomically when ANY id is unknown (no partial rotate)', () => {
    const a = makeFile('a.pdf', 2);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2))]);
    expect(
      appReducer(state, { type: 'ROTATE_PAGE_REFS', pageIds: ['a.pdf#p0', 'ghost'], delta: 90 }),
    ).toBe(state);
  });
});

describe('REGISTER_IMPORT_SOURCE (byte-only import source, 2n.3)', () => {
  it('adds an importOnly file with no strip, active-file change, or page-tier change', () => {
    const a = makeFile('a.pdf', 3);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))]);
    const next = appReducer(state, {
      type: 'REGISTER_IMPORT_SOURCE',
      path: 'x.pdf',
      workingPath: 'x.pdf.working',
      name: 'x.pdf',
      pageCount: 2,
      buffer: [7],
    });
    expect(next.files.get('x.pdf')).toMatchObject({ importOnly: true, pageCount: 2 });
    expect(next.activeFileId).toBe(state.activeFileId); // NOT made active (unlike OPEN_FILE)
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['a.pdf#0']); // no strip for x.pdf
    expect(next.pageUndoStack).toBe(state.pageUndoStack); // page tier untouched
  });

  it('is idempotent when the path is already open or registered', () => {
    const a = makeFile('a.pdf', 3);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))]);
    expect(
      appReducer(state, {
        type: 'REGISTER_IMPORT_SOURCE',
        path: 'a.pdf',
        workingPath: 'a.pdf.working',
        name: 'a.pdf',
        pageCount: 3,
        buffer: [9],
      }),
    ).toBe(state);
  });
});

describe('IMPORT_PAGES (import-into-doc, 2n.3)', () => {
  it('splices foreign-sourced page refs into the target at the index, one undo step', () => {
    const a = makeFile('a.pdf', 2);
    const doc = makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2));
    const imported = makePages('x.pdf', 2); // sourceDocId = x.pdf (a byte-only source)
    const next = appReducer(stateWith([a], [doc]), {
      type: 'IMPORT_PAGES',
      toDocId: 'a.pdf#0',
      toIndex: 1,
      pages: imported,
    });
    expect(pageIds(next.workspace.documents[0])).toEqual([
      'a.pdf#p0',
      'x.pdf#p0',
      'x.pdf#p1',
      'a.pdf#p1',
    ]);
    expect(next.workspace.documents[0].pageCount).toBe(4);
    expect(next.workspace.documents[0].pages[1].sourceDocId).toBe('x.pdf'); // keeps its source
    expect(next.pageDirtyPaths).toEqual(['a.pdf']);
    expect(next.pageUndoStack).toHaveLength(1);
  });

  it('clamps the insertion index and rejects empty pages / unknown target', () => {
    const a = makeFile('a.pdf', 2);
    const state = stateWith([a], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2))]);
    expect(appReducer(state, { type: 'IMPORT_PAGES', toDocId: 'a.pdf#0', toIndex: 0, pages: [] })).toBe(state);
    expect(
      appReducer(state, { type: 'IMPORT_PAGES', toDocId: 'nope', toIndex: 0, pages: makePages('x.pdf', 1) }),
    ).toBe(state);
    // toIndex past the end clamps to append.
    const appended = appReducer(state, {
      type: 'IMPORT_PAGES',
      toDocId: 'a.pdf#0',
      toIndex: 99,
      pages: makePages('x.pdf', 1),
    });
    expect(pageIds(appended.workspace.documents[0])).toEqual(['a.pdf#p0', 'a.pdf#p1', 'x.pdf#p0']);
  });
});

describe('import-source eviction on reindex (2n.3)', () => {
  const importSource = (path: string, pages: number) => ({
    ...makeFile(path, pages),
    importOnly: true,
  });

  it('evicts an unreferenced import source when the page tier is empty', () => {
    // Post-commit: a.pdf reindexed to its own pages (imported pages baked in),
    // so nothing references x.pdf and the tier is empty → x.pdf is evicted.
    const a = makeFile('a.pdf', 3);
    const state = stateWith(
      [a, importSource('x.pdf', 2)],
      [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))],
    );
    const next = appReducer(state, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))],
    });
    expect(next.files.has('x.pdf')).toBe(false); // evicted
    expect(next.files.has('a.pdf')).toBe(true);
  });

  it('keeps an import source still referenced by a page', () => {
    const a = makeFile('a.pdf', 2);
    const withImport = [...makePages('a.pdf', 2), ...makePages('x.pdf', 1)];
    const state = stateWith([a, importSource('x.pdf', 1)], [makeDoc(a, 'a.pdf#0', withImport)]);
    const next = appReducer(state, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(a, 'a.pdf#0', withImport)], // still holds the x-sourced page
    });
    expect(next.files.has('x.pdf')).toBe(true); // referenced → kept
  });

  it('keeps an import source while the page tier is non-empty (undoable/redoable import)', () => {
    const a = makeFile('a.pdf', 3);
    const state = {
      ...stateWith([a, importSource('x.pdf', 2)], [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))]),
      pageUndoStack: [{ documents: [], dirtyPaths: [] }],
    };
    const next = appReducer(state, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))],
    });
    expect(next.files.has('x.pdf')).toBe(true); // pending edit could still need it
  });
});

describe('OPEN_FILE stale-workspace fix (2p)', () => {
  it("reopening a path drops ITS stale docs and dirt, leaving other files' intact", () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('b.pdf', 1);
    const state: AppState = {
      ...stateWith(
        [a, b],
        [makeDoc(a, 'A', makePages('a.pdf', 2)), makeDoc(b, 'B', makePages('b.pdf', 1))],
      ),
      pageDirtyPaths: ['a.pdf', 'b.pdf'],
    };
    const next = appReducer(state, {
      type: 'OPEN_FILE',
      path: 'a.pdf',
      workingPath: 'a.pdf.working2',
      name: 'a.pdf',
      pageCount: 3,
      buffer: [9, 9, 9],
    });
    // The reopened path's old composition is gone (the async indexer rebuilds
    // from the fresh buffer) — no window where stale, possibly-edited docs
    // can be served against the new bytes.
    expect(next.workspace.documents.some((d) => d.path === 'a.pdf')).toBe(false);
    expect(next.workspace.documents.some((d) => d.path === 'b.pdf')).toBe(true);
    // Its page-tier dirt is meaningless without the composition; b's stays.
    expect(next.pageDirtyPaths).toEqual(['b.pdf']);
    expect(next.files.get('a.pdf')!.pageCount).toBe(3); // fresh entry won
  });

  it('a first open leaves the (empty) workspace untouched for that path', () => {
    const state = stateWith([], []);
    const next = appReducer(state, {
      type: 'OPEN_FILE',
      path: 'new.pdf',
      workingPath: 'new.pdf.working',
      name: 'new.pdf',
      pageCount: 1,
      buffer: [1],
    });
    expect(next.workspace.documents).toEqual([]);
    expect(next.files.has('new.pdf')).toBe(true);
  });
});
