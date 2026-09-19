// Page edits made while a commit is being built, or after it lands but before
// the reindex of its bytes, are pending edits on the documents the commit
// composed for its bytes. The reindex re-derives those documents; the edits
// must be carried onto them (the commit's ids are adopted, so the recorded
// edits still address the same pages) or refused with a notice — never
// dropped while the path stays dirty.
import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { editsSincePlan } from '../src/renderer/state/page-tier';
import { workspaceSettled } from '../src/renderer/lib/workspace-settle';
import { committedDocuments } from '../src/renderer/lib/workspace-commit';
import { buildMergedPageRefs, mergedPageSources } from '../src/renderer/lib/merge-docs';
import type {
  AppAction,
  AppState,
  OpenDocument,
  OpenFile,
  PageAnnotation,
  PageRef,
  PdfBuffer,
} from '../src/renderer/state/types';

const W = 300;
const H = 400;

function file(path: string, buffer: PdfBuffer, pageCount: number, over: Partial<OpenFile> = {}): OpenFile {
  return {
    path, workingPath: `${path}.w`, name: path, pageCount, buffer,
    dirty: false, undoStack: [], redoStack: [], ...over,
  };
}

function page(path: string, index: number, over: Partial<PageRef> = {}): PageRef {
  return {
    id: `${path}#p${index}`, sourceDocId: path, sourcePageIndex: index,
    rotation: 0, width: W, height: H, ...over,
  };
}

function doc(f: OpenFile, id: string, pages: PageRef[]): OpenDocument {
  return { ...f, id, pages, pageCount: pages.length };
}

function state(files: OpenFile[], documents: OpenDocument[]): AppState {
  return { ...initialState, files: new Map(files.map((f) => [f.path, f])), workspace: { documents } };
}

const run = (s: AppState, ...actions: AppAction[]): AppState => actions.reduce(appReducer, s);

const pagesOf = (s: AppState, path: string): PageRef[] =>
  s.workspace.documents.filter((d) => d.path === path).flatMap((d) => d.pages);

const pageById = (s: AppState, id: string): PageRef => {
  const found = s.workspace.documents.flatMap((d) => d.pages).find((p) => p.id === id);
  if (!found) throw new Error(`no page ${id}`);
  return found;
};

interface Committed {
  state: AppState;
  // Per committed path: the documents the plan read, and the buffer written.
  plans: Map<string, { documents: OpenDocument[]; buffer: number[] }>;
}

/** What `commitPageEdits` dispatches for the dirty paths of `planned`. The
 * edits in `during` land after the plan was read and before the landing,
 * the way a gesture lands while the build and the publication are awaited. */
function commit(planned: AppState, during: AppAction[] = []): Committed {
  const plans = new Map<string, { documents: OpenDocument[]; buffer: number[] }>();
  for (const path of planned.pageDirtyPaths) {
    plans.set(path, {
      documents: planned.workspace.documents.filter((d) => d.path === path),
      buffer: [plans.size + 100],
    });
  }
  const live = run(planned, ...during);
  const next = appReducer(live, {
    type: 'COMMIT_PAGE_EDITS',
    updates: [...plans].map(([path, plan]) => ({
      path,
      pageCount: plan.documents.reduce((n, d) => n + d.pages.length, 0),
      buffer: plan.buffer,
      snapshotPath: `${path}.snap`,
      authored: {
        pages: plan.documents.flatMap((d) => d.pages.map((p) => p.id)),
        documents: plan.documents.map((d) => ({ id: d.id, name: d.name })),
      },
      documents: committedDocuments(plan.documents, plan.buffer),
    })),
    planned: { pageUndoStack: planned.pageUndoStack, pageRedoStack: planned.pageRedoStack },
  });
  return { state: next, plans };
}

/** The documents the indexer derives from the committed bytes, with the
 * commit's ids adopted: every page now reads from the committed file at its
 * new position, its committed turn is baked into the page (the viewport's
 * size swaps, the pending rotation reads 0), and its annotations come back as
 * imports of what the commit wrote, under fresh annotation ids. */
function reindexed(c: Committed, path: string): OpenDocument[] {
  const plan = c.plans.get(path)!;
  const committedFile = c.state.files.get(path)!;
  let position = 0;
  return plan.documents.map((d) => ({
    ...committedFile,
    id: d.id,
    name: d.name,
    pageCount: d.pages.length,
    pages: d.pages.map((p): PageRef => {
      const turned = p.rotation === 90 || p.rotation === 270;
      const fresh: PageRef = {
        id: p.id,
        sourceDocId: path,
        sourcePageIndex: position++,
        rotation: 0,
        width: turned ? p.height : p.width,
        height: turned ? p.width : p.height,
      };
      if (p.annotations?.length) {
        fresh.annotations = p.annotations.map((a) => ({
          ...a,
          id: `${a.id}@reimported`,
          importedOriginal: {
            subtype: 'Square', rect: [0, 0, 10, 10], color: a.color, hasAppearance: true,
          },
        }));
      }
      return fresh;
    }),
  }));
}

const land = (c: Committed, s: AppState, path: string): AppState =>
  appReducer(s, { type: 'SET_WORKSPACE_DOCUMENTS', path, documents: reindexed(c, path) });

/** b.pdf, five pages in one document, with the last page's quarter-turn
 * pending — the edit the first commit carries. */
function pendingTurn(): AppState {
  const b = file('b.pdf', [1], 5);
  const s = state([b], [doc(b, 'b#0', [0, 1, 2, 3, 4].map((i) => page('b.pdf', i)))]);
  return run(s, { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdf#p4'], delta: 90 });
}

const TURN: AppAction = { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdf#p4'], delta: 90 };

describe('an edit made after a commit lands and before its reindex lands', () => {
  it('rotate: the second turn is carried onto the re-derived page, not dropped', () => {
    const c = commit(pendingTurn());
    const edited = appReducer(c.state, TURN);
    // On the committed frame: the first turn is written into the page.
    expect(pageById(edited, 'b.pdf#p4').rotation).toBe(90);
    const s = land(c, edited, 'b.pdf');
    const p4 = pageById(s, 'b.pdf#p4');
    // The committed bytes bake the first turn; the pending one is the second.
    expect(p4.rotation).toBe(90);
    expect(p4.sourcePageIndex).toBe(4);
    expect([p4.width, p4.height]).toEqual([H, W]);
    expect(s.workspace.documents[0].buffer).toBe(c.plans.get('b.pdf')!.buffer);
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
    expect(s.pageUndoStack).toHaveLength(1);
    expect(s.pageEditRefusals).toBe(0);
    // Undo returns to exactly the committed composition on the new bytes.
    const undone = appReducer(s, { type: 'UNDO_PAGE_OP' });
    expect(pageById(undone, 'b.pdf#p4').rotation).toBe(0);
    expect(undone.pageDirtyPaths).toEqual([]);
    expect(undone.workspace.documents[0].buffer).toBe(c.plans.get('b.pdf')!.buffer);
  });

  it('rotate through the absolute single-page action: carried as the turn it made', () => {
    const c = commit(pendingTurn());
    // Absolute on the committed frame, where the first turn reads 0.
    const edited = appReducer(c.state, {
      type: 'ROTATE_PAGE_REF', docId: 'b#0', pageId: 'b.pdf#p4', rotation: 270,
    });
    const s = land(c, edited, 'b.pdf');
    expect(pageById(s, 'b.pdf#p4').rotation).toBe(270);
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
  });

  // A commit waits until every document names its file's current bytes, so a
  // partition made in the window must take the committed bytes when carried.
  it('split: the new partition is carried onto the committed bytes, and the landing settles', () => {
    const c = commit(pendingTurn());
    const edited = appReducer(c.state, {
      type: 'SPLIT_DOC', docId: 'b#0', atIndex: 2, newDocId: 'b#split', newName: 'tail',
    });
    expect(workspaceSettled(edited)).toBe(false);
    const s = land(c, edited, 'b.pdf');
    expect(s.workspace.documents.map((d) => [d.id, d.pages.length])).toEqual([['b#0', 2], ['b#split', 3]]);
    expect(s.workspace.documents.every((d) => d.buffer === c.plans.get('b.pdf')!.buffer)).toBe(true);
    expect(workspaceSettled(s)).toBe(true);
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
  });

  it('delete: the page stays deleted and the file stays dirty', () => {
    const c = commit(pendingTurn());
    const edited = appReducer(c.state, { type: 'DELETE_PAGE_REFS', pageIds: ['b.pdf#p1'] });
    const s = land(c, edited, 'b.pdf');
    expect(pagesOf(s, 'b.pdf').map((p) => p.id)).toEqual(['b.pdf#p0', 'b.pdf#p2', 'b.pdf#p3', 'b.pdf#p4']);
    // Every surviving page indexes the committed bytes at its committed slot.
    expect(pagesOf(s, 'b.pdf').map((p) => p.sourcePageIndex)).toEqual([0, 2, 3, 4]);
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
    expect(s.pageEditRefusals).toBe(0);
  });

  it('reorder: the new order is carried', () => {
    const c = commit(pendingTurn());
    const order = ['b.pdf#p4', 'b.pdf#p0', 'b.pdf#p1', 'b.pdf#p2', 'b.pdf#p3'];
    const edited = appReducer(c.state, { type: 'REORDER_PAGES', docId: 'b#0', order });
    const s = land(c, edited, 'b.pdf');
    expect(pagesOf(s, 'b.pdf').map((p) => p.id)).toEqual(order);
    expect(pagesOf(s, 'b.pdf')[0].sourcePageIndex).toBe(4);
    expect(pagesOf(s, 'b.pdf')[0].rotation).toBe(0); // the turn is baked, not re-applied
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
  });

  it('insert: pages imported from a byte-only source are carried', () => {
    const c = commit(pendingTurn());
    const x = file('x.pdf', [7], 1, { importOnly: true });
    const withSource = appReducer(c.state, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'x.pdf', workingPath: 'x.w', name: 'x.pdf', pageCount: 1, buffer: x.buffer!,
    });
    const edited = appReducer(withSource, {
      type: 'IMPORT_PAGES', toDocId: 'b#0', toIndex: 2, pages: [page('x.pdf', 0)],
      sources: [{ path: 'x.pdf', buffer: x.buffer! }],
    });
    const s = land(c, edited, 'b.pdf');
    expect(pagesOf(s, 'b.pdf').map((p) => p.id)).toEqual([
      'b.pdf#p0', 'b.pdf#p1', 'x.pdf#p0', 'b.pdf#p2', 'b.pdf#p3', 'b.pdf#p4',
    ]);
    expect(pageById(s, 'x.pdf#p0').sourceDocId).toBe('x.pdf');
    expect(s.files.has('x.pdf')).toBe(true); // still referenced, tier non-empty
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
  });

  it('insert: pages whose indexes were read from the superseded bytes are refused with a notice', () => {
    const planned = pendingTurn();
    const c = commit(planned);
    const before = c.state;
    // Pages read from b.pdf's previous buffer, e.g. an import that reused the
    // open file's bytes before the commit replaced them.
    const edited = appReducer(before, {
      type: 'IMPORT_PAGES', toDocId: 'b#0', toIndex: 0, pages: [page('b.pdf', 3, { id: 'copy' })],
      sources: [{ path: 'b.pdf', buffer: planned.files.get('b.pdf')!.buffer! }],
    });
    expect(edited.workspace).toBe(before.workspace);
    expect(edited.pageEditRefusals).toBe(1);
  });

  it('undo: the undone edit stays redoable on the re-derived documents', () => {
    const c = commit(pendingTurn());
    const edited = run(c.state, TURN, { type: 'UNDO_PAGE_OP' });
    const s = land(c, edited, 'b.pdf');
    expect(pageById(s, 'b.pdf#p4').rotation).toBe(0);
    expect(s.pageDirtyPaths).toEqual([]);
    expect(s.pageUndoStack).toEqual([]);
    expect(s.pageRedoStack).toHaveLength(1);
    expect(s.pageRedoStack[0].documents[0].buffer).toBe(c.plans.get('b.pdf')!.buffer);
    const redone = appReducer(s, { type: 'REDO_PAGE_OP' });
    expect(pageById(redone, 'b.pdf#p4').rotation).toBe(90);
    expect(redone.pageDirtyPaths).toEqual(['b.pdf']);
  });

  it('undo of several: the redo order survives the rebuild', () => {
    const c = commit(pendingTurn());
    const edited = run(
      c.state,
      { type: 'MOVE_PAGE', fromDocId: 'b#0', toDocId: 'b#0', pageId: 'b.pdf#p4', toIndex: 0 },
      { type: 'MOVE_PAGE', fromDocId: 'b#0', toDocId: 'b#0', pageId: 'b.pdf#p3', toIndex: 0 },
      { type: 'UNDO_PAGE_OP' },
      { type: 'UNDO_PAGE_OP' },
    );
    const s = land(c, edited, 'b.pdf');
    expect(s.pageRedoStack).toHaveLength(2);
    const once = appReducer(s, { type: 'REDO_PAGE_OP' });
    expect(pagesOf(once, 'b.pdf').map((p) => p.id)).toEqual([
      'b.pdf#p4', 'b.pdf#p0', 'b.pdf#p1', 'b.pdf#p2', 'b.pdf#p3',
    ]);
    const twice = appReducer(once, { type: 'REDO_PAGE_OP' });
    expect(pagesOf(twice, 'b.pdf').map((p) => p.id)).toEqual([
      'b.pdf#p3', 'b.pdf#p4', 'b.pdf#p0', 'b.pdf#p1', 'b.pdf#p2',
    ]);
  });

  it('redo: a redone edit is carried and stays undoable', () => {
    const c = commit(pendingTurn());
    const edited = run(c.state, TURN, { type: 'UNDO_PAGE_OP' }, { type: 'REDO_PAGE_OP' });
    const s = land(c, edited, 'b.pdf');
    expect(pageById(s, 'b.pdf#p4').rotation).toBe(90);
    expect(s.pageUndoStack).toHaveLength(1);
    expect(s.pageRedoStack).toEqual([]);
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
  });

  it('a move into a file the commit did not touch carries the committed page', () => {
    const a = file('a.pdf', [5], 1);
    const start = pendingTurn();
    const withA: AppState = {
      ...start,
      files: new Map(start.files).set('a.pdf', a),
      workspace: { documents: [...start.workspace.documents, doc(a, 'a#0', [page('a.pdf', 0)])] },
    };
    const c = commit(withA);
    const edited = appReducer(c.state, {
      type: 'MOVE_PAGES', pageIds: ['b.pdf#p4'], toDocId: 'a#0', toIndex: 1,
    });
    const s = land(c, edited, 'b.pdf');
    const moved = pagesOf(s, 'a.pdf')[1];
    expect(moved.id).toBe('b.pdf#p4');
    // It now reads from the committed bytes, where the turn is baked.
    expect(moved.sourcePageIndex).toBe(4);
    expect(moved.rotation).toBe(0);
    expect([...s.pageDirtyPaths].sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('annotations: one added in the window is carried; an edit to a committed one is refused and said', () => {
    const note: PageAnnotation = { id: 'n1', kind: 'note', x: 0.1, y: 0.1, w: 0.05, h: 0.05, color: '#ffd54a', note: 'hi' };
    const start = run(pendingTurn(), { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotation: note });
    const c = commit(start);
    const added: PageAnnotation = { ...note, id: 'n2', note: 'later' };
    const edited = run(
      c.state,
      { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p1', annotation: added },
      { type: 'RECOLOR_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotationId: 'n1', color: '#000000' },
    );
    // The committed note is in the bytes with no fingerprint of what the
    // commit wrote, so the recolor is refused when it is made, not later.
    expect(pageById(edited, 'b.pdf#p0').annotations?.map((a) => [a.id, a.color, a.baked])).toEqual([
      ['n1', '#ffd54a', true],
    ]);
    expect(edited.pageEditRefusals).toBe(1);
    const s = land(c, edited, 'b.pdf');
    expect(pageById(s, 'b.pdf#p1').annotations?.map((a) => a.id)).toEqual(['n2']);
    // The committed note came back as an import under a new id.
    expect(pageById(s, 'b.pdf#p0').annotations?.map((a) => [a.id, a.color])).toEqual([
      ['n1@reimported', '#ffd54a'],
    ]);
    expect(s.pageEditRefusals).toBe(1);
    expect(s.pageUndoStack).toHaveLength(1);
    expect(s.pageDirtyPaths).toEqual(['b.pdf']);
  });

  it('a read-back whose ids do not survive refuses the edits made meanwhile with a notice and drops their dirt', () => {
    // A read-back that does not adopt the commit's ids mints a fresh generation.
    const b = file('b.pdf', [1], 3);
    const s0 = state([b], [doc(b, 'b#0', [0, 1, 2].map((i) => page('b.pdf', i)))]);
    const c = commit(run(s0, { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdf#p0'], delta: 90 }));
    const edited = appReducer(c.state, { type: 'DELETE_PAGE_REFS', pageIds: ['b.pdf#p1'] });
    expect(edited.pageDirtyPaths).toEqual(['b.pdf']);
    const newBytes = c.state.files.get('b.pdf')!;
    const s = appReducer(edited, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'b.pdf',
      documents: [doc(newBytes, 'b#g9#0', [0, 1, 2].map((i) => page('b.pdf', i, { id: `b#g9#p${i}` })))],
    });
    expect(pagesOf(s, 'b.pdf')).toHaveLength(3);
    expect(s.pageDirtyPaths).toEqual([]);
    expect(s.pageUndoStack).toEqual([]);
    expect(s.pageEditRefusals).toBe(1);
  });

  it('edits the stacks no longer record (another file closed) are refused with a notice, not kept dirty', () => {
    const a = file('a.pdf', [5], 1);
    const start = pendingTurn();
    const withA: AppState = {
      ...start,
      files: new Map(start.files).set('a.pdf', a),
      workspace: { documents: [...start.workspace.documents, doc(a, 'a#0', [page('a.pdf', 0)])] },
    };
    const c = commit(withA);
    const edited = run(c.state, TURN, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(edited.pageUndoStack).toEqual([]);
    expect(edited.pageDirtyPaths).toEqual(['b.pdf']);
    const s = land(c, edited, 'b.pdf');
    expect(pageById(s, 'b.pdf#p4').rotation).toBe(0);
    expect(s.pageDirtyPaths).toEqual([]);
    expect(s.pageEditRefusals).toBe(1);
  });

  it('a selected page the read-back could not carry is pruned wherever it sat', () => {
    // b.pdf's read-back does not adopt the commit's ids; a page moved out of
    // its composed documents meanwhile sits in a.pdf's document.
    const a = file('a.pdf', [5], 1);
    const b = file('b.pdf', [1], 2);
    const s0 = state([a, b], [
      doc(a, 'a#0', [page('a.pdf', 0)]),
      doc(b, 'b#0', [page('b.pdf', 0), page('b.pdf', 1)]),
    ]);
    const c = commit(run(s0, { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdf#p0'], delta: 90 }));
    const moved = run(
      c.state,
      { type: 'MOVE_PAGES', pageIds: ['b.pdf#p1'], toDocId: 'a#0', toIndex: 1 },
      { type: 'UI_SET_SELECTION', pageIds: ['b.pdf#p1', 'a.pdf#p0'], anchor: 'b.pdf#p1' },
    );
    const newBytes = c.state.files.get('b.pdf')!;
    const s = appReducer(moved, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'b.pdf',
      documents: [doc(newBytes, 'b#g4#0', [0, 1].map((i) => page('b.pdf', i, { id: `b#g4#p${i}` })))],
    });
    expect(pagesOf(s, 'a.pdf').map((p) => p.id)).toEqual(['a.pdf#p0']);
    expect([...s.ui.selectedPageIds]).toEqual(['a.pdf#p0']);
    expect(s.ui.selectionAnchor).toBeNull();
    expect(s.pageEditRefusals).toBe(1);
  });

  it('keeps a reading position that names a document still to be indexed', () => {
    const c = commit(pendingTurn());
    const waiting = appReducer(c.state, { type: 'UI_SET_CURRENT_PAGE', pageId: 'c.pdf#p0' });
    const s = land(c, appReducer(waiting, TURN), 'b.pdf');
    expect(s.ui.currentPageId).toBe('c.pdf#p0');
  });

  it('an index of a buffer the file no longer holds does not land', () => {
    const c = commit(pendingTurn());
    const stale = reindexed(c, 'b.pdf').map((d) => ({ ...d, buffer: [42] }));
    const edited = appReducer(c.state, TURN);
    const s = appReducer(edited, { type: 'SET_WORKSPACE_DOCUMENTS', path: 'b.pdf', documents: stale });
    expect(s).toBe(edited);
  });

  it("partitions interleaved with another file's documents keep their slots", () => {
    const b = file('b.pdfx', [1], 2);
    const a = file('a.pdf', [5], 1);
    const s0 = state([b, a], [
      doc(b, 'b#0', [page('b.pdfx', 0)]),
      doc(a, 'a#0', [page('a.pdf', 0)]),
      doc(b, 'b#1', [page('b.pdfx', 1)]),
    ]);
    const c = commit(run(s0, { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdfx#p1'], delta: 90 }));
    const edited = appReducer(c.state, { type: 'REORDER_DOCS', docId: 'a#0', direction: -1 });
    const s = land(c, edited, 'b.pdfx');
    expect(s.workspace.documents.map((d) => d.id)).toEqual(['a#0', 'b#0', 'b#1']);
    expect(s.pageEditRefusals).toBe(0);
  });
});

describe('the documents a commit lands', () => {
  /** b.pdf, four pages; the plan reorders them and turns one. */
  function reorderedAndTurned(): AppState {
    const b = file('b.pdf', [1], 4);
    const pages = [0, 1, 2, 3].map((i) => page('b.pdf', i, { width: 100 + i, height: 400 }));
    const s = state([b], [doc(b, 'b#0', pages)]);
    return run(
      s,
      { type: 'REORDER_PAGES', docId: 'b#0', order: ['b.pdf#p2', 'b.pdf#p0', 'b.pdf#p3', 'b.pdf#p1'] },
      { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdf#p0'], delta: 90 },
    );
  }

  it('read every page from the new bytes at its written position, from the moment the commit lands', () => {
    const c = commit(reorderedAndTurned());
    const committed = c.plans.get('b.pdf')!.buffer;
    const [landed] = c.state.workspace.documents;
    expect(landed.buffer).toBe(committed);
    expect(landed.provisional).toBe(true);
    expect(landed.pages.map((p) => [p.id, p.sourceDocId, p.sourcePageIndex, p.rotation])).toEqual([
      ['b.pdf#p2', 'b.pdf', 0, 0],
      ['b.pdf#p0', 'b.pdf', 1, 0],
      ['b.pdf#p3', 'b.pdf', 2, 0],
      ['b.pdf#p1', 'b.pdf', 3, 0],
    ]);
    // The written quarter turn swaps the page's viewport size.
    expect([pageById(c.state, 'b.pdf#p0').width, pageById(c.state, 'b.pdf#p0').height]).toEqual([400, 100]);
    expect(c.state.pageDirtyPaths).toEqual([]);
    expect(workspaceSettled(c.state)).toBe(false);
  });

  it('are not placed for a file that closed before the commit landed', () => {
    const planned = reorderedAndTurned();
    const closed = appReducer(planned, { type: 'CLOSE_FILE', path: 'b.pdf' });
    const buffer = [9];
    const s = appReducer(closed, {
      type: 'COMMIT_PAGE_EDITS',
      updates: [{
        path: 'b.pdf', pageCount: 4, buffer, snapshotPath: 's',
        authored: { pages: [], documents: [] },
        documents: committedDocuments(planned.workspace.documents, buffer),
      }],
      planned: { pageUndoStack: closed.pageUndoStack, pageRedoStack: closed.pageRedoStack },
    });
    expect(s.files.has('b.pdf')).toBe(false);
    expect(s.workspace.documents).toEqual([]);
  });

  it('are replaced by the read-back, which settles the workspace', () => {
    const c = commit(reorderedAndTurned());
    const s = land(c, c.state, 'b.pdf');
    expect(s.workspace.documents[0].provisional).toBeUndefined();
    expect(workspaceSettled(s)).toBe(true);
    expect(s.pageEditRefusals).toBe(0);
  });

  const note: PageAnnotation = { id: 'n1', kind: 'note', x: 0.1, y: 0.1, w: 0.05, h: 0.05, color: '#ffd54a', note: 'hi' };
  const shape: PageAnnotation = {
    id: 's1', kind: 'shape', shapeType: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3, color: '#ff0000',
    importedOriginal: { subtype: 'Square', rect: [1, 2, 3, 4], color: '#ff0000', hasAppearance: true },
  };
  const count: PageAnnotation = {
    id: 'c1', kind: 'count', x: 0.5, y: 0.5, w: 0.02, h: 0.02, color: '#00ff00',
    countGroup: 'Doors', countSymbol: 'circle', countSeq: 1, note: 'Doors 1',
  };
  const measure: PageAnnotation = {
    id: 'm1', kind: 'measure', measureKind: 'distance', x: 0.1, y: 0.6, w: 0.2, h: 0, points: [0.1, 0.6, 0.3, 0.6],
    color: '#0000ff', note: '1 in', measureUnitsPerPt: 1, measureUnit: 'in', measureRatio: '1 in = 1 in',
  };

  /** A committed page whose annotations the commit wrote. */
  function committedWithAnnotations(): Committed {
    const start = run(
      pendingTurn(),
      { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotation: note },
      { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotation: shape },
      { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotation: count },
      { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotation: measure },
    );
    return commit(start);
  }

  it('carry the annotations the commit wrote as baked, without the fingerprints the bytes no longer hold', () => {
    const c = committedWithAnnotations();
    const annotations = pageById(c.state, 'b.pdf#p0').annotations!;
    expect(annotations.map((a) => [a.id, a.baked, a.importedOriginal])).toEqual([
      ['n1', true, undefined],
      ['s1', true, undefined],
      ['c1', true, undefined],
      ['m1', true, undefined],
    ]);
  });

  const target = { docId: 'b#0', pageId: 'b.pdf#p0' };
  const refusedEdits: [string, AppAction][] = [
    ['UPDATE_ANNOTATION', { type: 'UPDATE_ANNOTATION', ...target, annotationId: 'n1', note: 'changed' }],
    ['RECOLOR_ANNOTATION', { type: 'RECOLOR_ANNOTATION', ...target, annotationId: 'n1', color: '#000000' }],
    ['REMOVE_ANNOTATION', { type: 'REMOVE_ANNOTATION', ...target, annotationId: 'n1' }],
    ['RECALIBRATE_ANNOTATION', {
      type: 'RECALIBRATE_ANNOTATION', ...target, annotationId: 'm1',
      measureUnitsPerPt: 2, measureUnit: 'in', measureRatio: '1 in = 2 in', note: '2 in',
    }],
    ['RECOLOR_ANNOTATIONS', { type: 'RECOLOR_ANNOTATIONS', ...target, annotationIds: ['s1'], color: '#000000' }],
    ['REMOVE_ANNOTATIONS', { type: 'REMOVE_ANNOTATIONS', ...target, annotationIds: ['s1'] }],
    ['RESTYLE_ANNOTATIONS', { type: 'RESTYLE_ANNOTATIONS', ...target, annotationIds: ['s1'], style: { strokeWidth: 5 } }],
    ['TRANSFORM_ANNOTATIONS', {
      type: 'TRANSFORM_ANNOTATIONS', docId: 'b#0',
      edits: [{ pageId: 'b.pdf#p0', annotationId: 's1', x: 0.4, y: 0.4, w: 0.3, h: 0.3 }],
    }],
    ['REORDER_ANNOTATIONS', { type: 'REORDER_ANNOTATIONS', ...target, annotationIds: ['s1'], direction: 'front' }],
    ['REGROUP_COUNT_MARKS', {
      type: 'REGROUP_COUNT_MARKS', ...target, annotationIds: ['c1'], group: 'Windows', color: '#0000ff', symbol: 'square',
    }],
  ];

  it.each(refusedEdits)('refuse %s on a baked annotation until the read-back, and say so', (_name, action) => {
    const c = committedWithAnnotations();
    const s = appReducer(c.state, action);
    expect(s.workspace).toBe(c.state.workspace);
    expect(s.pageUndoStack).toBe(c.state.pageUndoStack);
    expect(s.pageDirtyPaths).toEqual([]);
    expect(s.pageEditRefusals).toBe(c.state.pageEditRefusals + 1);
    // After the read-back the same edit lands on the import it became.
    const back = land(c, c.state, 'b.pdf');
    const reimported = JSON.parse(JSON.stringify(action).replace(/"(n1|s1|c1|m1)"/g, '"$1@reimported"')) as AppAction;
    const edited = appReducer(back, reimported);
    expect(edited.pageUndoStack).toHaveLength(back.pageUndoStack.length + 1);
    expect(edited.pageEditRefusals).toBe(back.pageEditRefusals);
  });

  it('let a baked annotation turn with its page, and let new ones be edited', () => {
    const c = committedWithAnnotations();
    const turned = appReducer(c.state, { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdf#p0'], delta: 90 });
    expect(turned.pageEditRefusals).toBe(0);
    expect(pageById(turned, 'b.pdf#p0').annotations![0]).toMatchObject({
      id: 'n1', baked: true, x: expect.closeTo(0.85, 9), y: expect.closeTo(0.1, 9),
    });
    const added: PageAnnotation = { ...note, id: 'n2' };
    const withNew = run(
      c.state,
      { type: 'ADD_ANNOTATION', ...target, annotation: added },
      { type: 'RECOLOR_ANNOTATION', ...target, annotationId: 'n2', color: '#000000' },
      { type: 'REORDER_ANNOTATIONS', ...target, annotationIds: ['n2'], direction: 'back' },
    );
    expect(withNew.pageEditRefusals).toBe(0);
    expect(withNew.pageUndoStack).toHaveLength(3);
  });

  it('refuse a copy of a page that carries baked annotations until the read-back, and say so', () => {
    const c = committedWithAnnotations();
    const a = file('a.pdf', [5], 1);
    const withA: AppState = {
      ...c.state,
      files: new Map(c.state.files).set('a.pdf', a),
      workspace: { documents: [...c.state.workspace.documents, doc(a, 'a#0', [page('a.pdf', 0)])] },
    };
    const source = withA.workspace.documents[0];
    const copy = (s: AppState): AppAction => ({
      type: 'IMPORT_PAGES', toDocId: 'a#0', toIndex: 1,
      pages: buildMergedPageRefs(s.workspace.documents[0]),
      sources: mergedPageSources(s.workspace.documents, s.files, s.workspace.documents[0]),
    });
    const refused = appReducer(withA, copy(withA));
    expect(refused.workspace).toBe(withA.workspace);
    expect(refused.pageEditRefusals).toBe(withA.pageEditRefusals + 1);
    // Once the read-back lands, the copy carries imports and lands.
    const back = land(c, withA, 'b.pdf');
    expect(back.workspace.documents[0].id).toBe(source.id);
    const copied = appReducer(back, copy(back));
    expect(copied.pageUndoStack).toHaveLength(back.pageUndoStack.length + 1);
    expect(copied.pageEditRefusals).toBe(back.pageEditRefusals);
  });

  it('number a count mark placed before the read-back after the ones the commit wrote', () => {
    const c = committedWithAnnotations();
    const mark: PageAnnotation = { ...count, id: 'c2', countSeq: undefined, note: undefined };
    const s = appReducer(c.state, { type: 'ADD_ANNOTATION', ...target, annotation: mark });
    expect(pageById(s, 'b.pdf#p0').annotations!.find((a) => a.id === 'c2')).toMatchObject({ countSeq: 2, note: 'Doors 2' });
  });

  it('refuse, while the commit is published, an edit made to an annotation the commit then wrote', () => {
    const start = run(pendingTurn(), { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotation: note });
    const c = commit(start, [
      { type: 'RECOLOR_ANNOTATION', docId: 'b#0', pageId: 'b.pdf#p0', annotationId: 'n1', color: '#000000' },
      TURN,
    ]);
    expect(c.state.pageEditRefusals).toBe(1);
    expect(pageById(c.state, 'b.pdf#p0').annotations!.map((a) => [a.color, a.baked])).toEqual([['#ffd54a', true]]);
    // The turn made during the commit is carried and stays undoable.
    expect(pageById(c.state, 'b.pdf#p4').rotation).toBe(90);
    expect(c.state.pageUndoStack).toHaveLength(1);
  });
});

describe('where re-derived documents land', () => {
  // Fresh ids name no outgoing slot, so no slot is theirs to keep: the
  // re-derived partitions land together at the first outgoing slot.
  it('partitions read from new bytes land as one block', () => {
    const b = file('b.pdfx', [1], 2);
    const a = file('a.pdf', [5], 1);
    const s0 = state([b, a], [
      doc(b, 'b#0', [page('b.pdfx', 0)]),
      doc(a, 'a#0', [page('a.pdf', 0)]),
      doc(b, 'b#1', [page('b.pdfx', 1)]),
    ]);
    const buffer = [2];
    const newBytes = file('b.pdfx', buffer, 2);
    const s = appReducer(s0, {
      type: 'UPDATE_FILE', path: 'b.pdfx', pageCount: 2, buffer, snapshotPath: 's',
      documents: [
        doc(newBytes, 'b#g2#0', [page('b.pdfx', 0, { id: 'b#g2#p0' })]),
        doc(newBytes, 'b#g2#1', [page('b.pdfx', 1, { id: 'b#g2#p1' })]),
      ],
    });
    expect(s.workspace.documents.map((d) => d.id)).toEqual(['b#g2#0', 'b#g2#1', 'a#0']);
  });

  it('an adopted reindex keeps each partition in its own slot', () => {
    const b = file('b.pdfx', [1], 2);
    const a = file('a.pdf', [5], 1);
    const s0 = state([b, a], [
      doc(b, 'b#0', [page('b.pdfx', 0)]),
      doc(a, 'a#0', [page('a.pdf', 0)]),
      doc(b, 'b#1', [page('b.pdfx', 1)]),
    ]);
    const c = commit(run(s0, { type: 'ROTATE_PAGE_REFS', pageIds: ['b.pdfx#p0'], delta: 90 }));
    const s = land(c, c.state, 'b.pdfx');
    expect(s.workspace.documents.map((d) => d.id)).toEqual(['b#0', 'a#0', 'b#1']);
  });
});

describe('an edit made while the commit is built and published', () => {
  it('stays pending, undoable, and dirties only what it touched', () => {
    const a = file('a.pdf', [5], 2);
    const start = pendingTurn();
    const withA: AppState = {
      ...start,
      files: new Map(start.files).set('a.pdf', a),
      workspace: {
        documents: [...start.workspace.documents, doc(a, 'a#0', [page('a.pdf', 0), page('a.pdf', 1)])],
      },
    };
    const c = commit(withA, [
      { type: 'DELETE_PAGE_REFS', pageIds: ['a.pdf#p1'] },
      TURN,
    ]);
    // The commit contained only b.pdf's first turn.
    expect(c.plans.has('a.pdf')).toBe(false);
    expect([...c.state.pageDirtyPaths].sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(c.state.pageUndoStack).toHaveLength(2);
    expect(c.state.pageUndoStack[0].dirtyPaths).toEqual([]);
    expect(pagesOf(c.state, 'a.pdf').map((p) => p.id)).toEqual(['a.pdf#p0']);
    expect(c.state.pageEditRefusals).toBe(0);
    // The reindex carries both onto the committed bytes.
    const s = land(c, c.state, 'b.pdf');
    expect(pageById(s, 'b.pdf#p4').rotation).toBe(90);
    expect(pagesOf(s, 'a.pdf').map((p) => p.id)).toEqual(['a.pdf#p0']);
    expect([...s.pageDirtyPaths].sort()).toEqual(['a.pdf', 'b.pdf']);
    // Undoing both leaves nothing to commit.
    const clean = run(s, { type: 'UNDO_PAGE_OP' }, { type: 'UNDO_PAGE_OP' });
    expect(clean.pageDirtyPaths).toEqual([]);
    expect(pagesOf(clean, 'a.pdf')).toHaveLength(2);
  });

  it('shows the committed bytes, re-derives every other dirty path, and says so when the stacks no longer show what the plan held', () => {
    const a = file('a.pdf', [5], 1);
    const start = pendingTurn();
    const withA: AppState = {
      ...start,
      files: new Map(start.files).set('a.pdf', a),
      workspace: { documents: [...start.workspace.documents, doc(a, 'a#0', [page('a.pdf', 0)])] },
    };
    // a.pdf is edited during the commit, which holds only b.pdf.
    const c = commit(withA, [
      { type: 'ROTATE_PAGE_REFS', pageIds: ['a.pdf#p0'], delta: 180 },
      TURN,
      { type: 'OPEN_FILE', path: 'z.pdf', workingPath: 'z.w', name: 'z.pdf', pageCount: 1, buffer: [3] },
    ]);
    expect([...c.plans.keys()]).toEqual(['b.pdf']);
    // Which pending edit the plan held is unknown, so the ones made during the
    // commit are dropped and said: b.pdf shows exactly its new bytes, and
    // a.pdf, which could hold a page moved from b.pdf, waits for its own
    // index.
    expect(pageById(c.state, 'b.pdf#p4')).toMatchObject({ sourcePageIndex: 4, rotation: 0 });
    expect(pagesOf(c.state, 'a.pdf')).toEqual([]);
    expect(c.state.pageDirtyPaths).toEqual([]);
    expect(c.state.pageEditRefusals).toBe(1);
  });

  it('drops, when the stacks no longer show what the plan held, a page moved out of a committed file meanwhile', () => {
    const a = file('a.pdf', [5], 1);
    const start = pendingTurn();
    const withA: AppState = {
      ...start,
      files: new Map(start.files).set('a.pdf', a),
      workspace: { documents: [...start.workspace.documents, doc(a, 'a#0', [page('a.pdf', 0)])] },
    };
    const c = commit(withA, [
      { type: 'MOVE_PAGES', pageIds: ['b.pdf#p1'], toDocId: 'a#0', toIndex: 1 },
      { type: 'OPEN_FILE', path: 'z.pdf', workingPath: 'z.w', name: 'z.pdf', pageCount: 1, buffer: [3] },
    ]);
    // The moved page indexes b.pdf's previous bytes; it is not left in a.pdf
    // to name another page of the new ones. b.pdf keeps it where it was written.
    const holders = c.state.workspace.documents.filter((d) => d.pages.some((p) => p.id === 'b.pdf#p1'));
    expect(holders.map((d) => d.path)).toEqual(['b.pdf']);
    expect(pageById(c.state, 'b.pdf#p1')).toMatchObject({ sourceDocId: 'b.pdf', sourcePageIndex: 1 });
    expect(pagesOf(c.state, 'a.pdf')).toEqual([]);
    expect(c.state.pageEditRefusals).toBe(1);
  });
});

describe('editsSincePlan', () => {
  const entry = (): AppState['pageUndoStack'][number] => ({
    documents: [], dirtyPaths: [], action: { type: 'REMOVE_DOC', docId: 'x' },
  });

  it('is empty for the planned stacks themselves', () => {
    const planned = { pageUndoStack: [entry()], pageRedoStack: [entry()] };
    expect(editsSincePlan(planned, planned)).toEqual([]);
  });

  it('returns the entries pushed on top of the planned ones', () => {
    const e1 = entry();
    const e2 = entry();
    const planned = { pageUndoStack: [e1], pageRedoStack: [entry()] };
    expect(editsSincePlan({ pageUndoStack: [e1, e2], pageRedoStack: [] }, planned)).toEqual([e2]);
  });

  it('is null after an undo, a redo, a reset, or a rewritten entry', () => {
    const e1 = entry();
    const planned = { pageUndoStack: [e1], pageRedoStack: [] };
    expect(editsSincePlan({ pageUndoStack: [], pageRedoStack: [entry()] }, planned)).toBeNull();
    expect(editsSincePlan({ pageUndoStack: [e1, entry()], pageRedoStack: [entry()] }, planned)).toBeNull();
    expect(editsSincePlan({ pageUndoStack: [], pageRedoStack: [] }, planned)).toBeNull();
    expect(editsSincePlan({ pageUndoStack: [entry(), entry()], pageRedoStack: [] }, planned)).toBeNull();
  });
});
