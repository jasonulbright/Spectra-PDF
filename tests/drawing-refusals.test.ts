// A page edit is addressed by document and page ids, and a canvas drawing is
// bound to the page its gesture began on. New bytes that a page-tier commit
// did not compose take new ids in the step that places them, so a gesture
// that began before they landed names ids that are gone. Such an edit or
// drawing is refused out loud (one more notice owed); it never lands on
// another page and never vanishes without a word.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { committedDocuments } from '../src/renderer/lib/workspace-commit';
import { withSeededMarks, type RedactionMark } from '../src/renderer/lib/redaction';
import type {
  AppAction,
  AppState,
  OpenDocument,
  OpenFile,
  PageAnnotation,
  PageRef,
  PdfBuffer,
} from '../src/renderer/state/types';

function file(path: string, buffer: PdfBuffer, pageCount: number, over: Partial<OpenFile> = {}): OpenFile {
  return {
    path, workingPath: `${path}.w`, name: path, pageCount, buffer,
    dirty: false, undoStack: [], redoStack: [], ...over,
  };
}

function pages(path: string, prefix: string, count: number, annotations?: PageAnnotation[]): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}#p${i}`, sourceDocId: path, sourcePageIndex: i, rotation: 0 as const, width: 300, height: 400,
    ...(i === 0 && annotations ? { annotations } : {}),
  }));
}

function doc(f: OpenFile, id: string, docPages: PageRef[]): OpenDocument {
  return { ...f, id, pages: docPages, pageCount: docPages.length };
}

const NOTE: PageAnnotation = { id: 'n1', kind: 'note', x: 0.1, y: 0.1, w: 0.05, h: 0.05, color: '#ffd54a', note: 'n' };
const X_BUFFER = [7];

/** a.pdf read at generation 1, and x.pdf registered as an import source. */
function opened(): AppState {
  const a = file('a.pdf', [1], 3);
  const x = file('x.pdf', X_BUFFER, 1, { importOnly: true });
  return {
    ...initialState,
    activeFileId: 'a.pdf',
    files: new Map([['a.pdf', a], ['x.pdf', x]]),
    workspace: { documents: [doc(a, 'a#g1#0', pages('a.pdf', 'a#g1', 3, [NOTE]))] },
  };
}

/** `opened()` after an operation placed a.pdf's new bytes, read at generation
 * 2, with x.pdf registered again as the source of an import. */
function operated(): AppState {
  const before = opened();
  const buffer = [2];
  const read = file('a.pdf', buffer, 3);
  const replaced = appReducer(before, {
    type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 3, buffer, snapshotPath: 's',
    documents: [doc(read, 'a#g2#0', pages('a.pdf', 'a#g2', 3, [NOTE]))],
  });
  return appReducer(replaced, {
    type: 'REGISTER_IMPORT_SOURCE', path: 'x.pdf', workingPath: 'x.pdf.w', name: 'x.pdf', pageCount: 1, buffer: X_BUFFER,
  });
}

/** Every page edit, addressed to the documents and pages of generation `g`. */
function edits(g: 'a#g1' | 'a#g2'): [string, AppAction][] {
  const docId = `${g}#0`;
  const p = (i: number): string => `${g}#p${i}`;
  const onPage = { docId, pageId: p(0) };
  return [
    ['REORDER_PAGES', { type: 'REORDER_PAGES', docId, order: [p(1), p(0), p(2)] }],
    ['MOVE_PAGE', { type: 'MOVE_PAGE', fromDocId: docId, toDocId: docId, pageId: p(0), toIndex: 2 }],
    ['MOVE_PAGE_TO_NEW_DOC', { type: 'MOVE_PAGE_TO_NEW_DOC', fromDocId: docId, pageId: p(0), docIndex: 1, newDocId: 'n#0', newName: 'n' }],
    ['MOVE_PAGES', { type: 'MOVE_PAGES', pageIds: [p(0)], toDocId: docId, toIndex: 3 }],
    ['MOVE_PAGES_TO_NEW_DOC', { type: 'MOVE_PAGES_TO_NEW_DOC', pageIds: [p(0)], docIndex: 1, newDocId: 'n#0', newName: 'n' }],
    ['IMPORT_PAGES', {
      type: 'IMPORT_PAGES', toDocId: docId, toIndex: 0,
      pages: [{ id: 'x#p0', sourceDocId: 'x.pdf', sourcePageIndex: 0, rotation: 0, width: 300, height: 400 }],
      sources: [{ path: 'x.pdf', buffer: X_BUFFER }],
    }],
    ['DELETE_PAGE_REF', { type: 'DELETE_PAGE_REF', ...onPage }],
    ['DELETE_PAGE_REFS', { type: 'DELETE_PAGE_REFS', pageIds: [p(0)] }],
    ['SPLIT_DOC', { type: 'SPLIT_DOC', docId, atIndex: 1, newDocId: 'n#0', newName: 'n' }],
    ['ADD_ANNOTATION', { type: 'ADD_ANNOTATION', ...onPage, annotation: { ...NOTE, id: 'n2' } }],
    ['REGROUP_COUNT_MARKS', { type: 'REGROUP_COUNT_MARKS', ...onPage, annotationIds: ['n1'], group: 'G', color: '#000000', symbol: 's' }],
    ['UPDATE_ANNOTATION', { type: 'UPDATE_ANNOTATION', ...onPage, annotationId: 'n1', note: 'changed' }],
    ['RECOLOR_ANNOTATION', { type: 'RECOLOR_ANNOTATION', ...onPage, annotationId: 'n1', color: '#000000' }],
    ['REMOVE_ANNOTATION', { type: 'REMOVE_ANNOTATION', ...onPage, annotationId: 'n1' }],
    ['TRANSFORM_ANNOTATIONS', {
      type: 'TRANSFORM_ANNOTATIONS', docId,
      edits: [{ pageId: p(0), annotationId: 'n1', x: 0.2, y: 0.2, w: 0.05, h: 0.05 }],
    }],
    ['REORDER_ANNOTATIONS', { type: 'REORDER_ANNOTATIONS', ...onPage, annotationIds: ['n1'], direction: 'back' }],
    ['RESTYLE_ANNOTATIONS', { type: 'RESTYLE_ANNOTATIONS', ...onPage, annotationIds: ['n1'], style: { opacity: 0.5 } }],
    ['RECALIBRATE_ANNOTATION', {
      type: 'RECALIBRATE_ANNOTATION', ...onPage, annotationId: 'n1',
      measureUnitsPerPt: 2, measureUnit: 'mm', measureRatio: '1:2', note: '2 mm',
    }],
    ['RECOLOR_ANNOTATIONS', { type: 'RECOLOR_ANNOTATIONS', ...onPage, annotationIds: ['n1'], color: '#000000' }],
    ['REMOVE_ANNOTATIONS', { type: 'REMOVE_ANNOTATIONS', ...onPage, annotationIds: ['n1'] }],
    ['ROTATE_PAGE_REF', { type: 'ROTATE_PAGE_REF', ...onPage, rotation: 90 }],
    ['ROTATE_PAGE_REFS', { type: 'ROTATE_PAGE_REFS', pageIds: [p(0)], delta: 90 }],
    ['REORDER_DOCS', { type: 'REORDER_DOCS', docId, direction: 1 }],
    ['RENAME_DOC', { type: 'RENAME_DOC', docId, name: 'renamed' }],
    ['REMOVE_DOC', { type: 'REMOVE_DOC', docId }],
  ];
}

/** The workspace and the page tier untouched, and one more notice owed. */
function expectRefused(next: AppState, state: AppState): void {
  expect(next.workspace).toBe(state.workspace);
  expect(next.pageUndoStack).toBe(state.pageUndoStack);
  expect(next.pageDirtyPaths).toBe(state.pageDirtyPaths);
  expect(next.pageEditRefusals).toBe(state.pageEditRefusals + 1);
}

describe('a page edit that began on documents new bytes replaced', () => {
  it.each(edits('a#g1'))('%s is refused with a notice', (_type, action) => {
    const state = operated();
    expectRefused(appReducer(state, action), state);
  });

  it.each(edits('a#g2'))('%s on the documents of the new bytes is not refused', (_type, action) => {
    const state = operated();
    expect(appReducer(state, action).pageEditRefusals).toBe(state.pageEditRefusals);
  });
});

describe('a page edit that names a page in another document than the one it names', () => {
  // Both documents are current; the page sits in the other one.
  function two(): AppState {
    const a = file('a.pdf', [1], 1);
    const b = file('b.pdf', [2], 1);
    return {
      ...initialState,
      files: new Map([['a.pdf', a], ['b.pdf', b]]),
      workspace: {
        documents: [doc(a, 'a#0', pages('a.pdf', 'a', 1, [NOTE])), doc(b, 'b#0', pages('b.pdf', 'b', 1))],
      },
    };
  }

  it.each<[string, AppAction]>([
    ['ADD_ANNOTATION', { type: 'ADD_ANNOTATION', docId: 'b#0', pageId: 'a#p0', annotation: { ...NOTE, id: 'n2' } }],
    ['MOVE_PAGE', { type: 'MOVE_PAGE', fromDocId: 'b#0', toDocId: 'b#0', pageId: 'a#p0', toIndex: 0 }],
    ['MOVE_PAGE_TO_NEW_DOC', { type: 'MOVE_PAGE_TO_NEW_DOC', fromDocId: 'b#0', pageId: 'a#p0', docIndex: 0, newDocId: 'n#0', newName: 'n' }],
    ['TRANSFORM_ANNOTATIONS', {
      type: 'TRANSFORM_ANNOTATIONS', docId: 'b#0',
      edits: [{ pageId: 'a#p0', annotationId: 'n1', x: 0.2, y: 0.2, w: 0.05, h: 0.05 }],
    }],
  ])('%s is refused with a notice', (_type, action) => {
    const state = two();
    expectRefused(appReducer(state, action), state);
  });
});

describe('a page edit on documents that do not describe their file’s bytes', () => {
  it('is refused with a notice', () => {
    const state = opened();
    const files = new Map(state.files).set('a.pdf', { ...state.files.get('a.pdf')!, buffer: [9] });
    const stale = { ...state, files };
    expectRefused(
      appReducer(stale, { type: 'ADD_ANNOTATION', docId: 'a#g1#0', pageId: 'a#g1#p1', annotation: { ...NOTE, id: 'n2' } }),
      stale,
    );
  });

  it('lands on the documents a page-tier commit composed for its bytes', () => {
    const edited = appReducer(opened(), { type: 'ROTATE_PAGE_REFS', pageIds: ['a#g1#p1'], delta: 90 });
    const buffer = [3];
    const committed = appReducer(edited, {
      type: 'COMMIT_PAGE_EDITS',
      updates: [{
        path: 'a.pdf', pageCount: 3, buffer, snapshotPath: 's',
        authored: { pages: ['a#g1#p0', 'a#g1#p1', 'a#g1#p2'], documents: [{ id: 'a#g1#0', name: 'a.pdf' }] },
        documents: committedDocuments(edited.workspace.documents, buffer),
      }],
      planned: { pageUndoStack: edited.pageUndoStack, pageRedoStack: edited.pageRedoStack },
    });
    const next = appReducer(committed, {
      type: 'ADD_ANNOTATION', docId: 'a#g1#0', pageId: 'a#g1#p2', annotation: { ...NOTE, id: 'n2' },
    });
    expect(next.pageEditRefusals).toBe(committed.pageEditRefusals);
    expect(next.pageUndoStack).toHaveLength(1);
  });
});

describe('REORDER_PAGES', () => {
  it.each<[string, string[]]>([
    ['a page is missing', ['a#g1#p1', 'a#g1#p0']],
    ['a page is added', ['a#g1#p1', 'a#g1#p0', 'a#g1#p2', 'x#p0']],
    ['a page is repeated', ['a#g1#p1', 'a#g1#p1', 'a#g1#p2']],
    ['a page is not the document’s', ['a#g1#p1', 'a#g1#p0', 'x#p0']],
  ])('refuses an order read from other pages (%s) with a notice', (_case, order) => {
    const state = opened();
    expectRefused(appReducer(state, { type: 'REORDER_PAGES', docId: 'a#g1#0', order }), state);
  });

  it('keeps the same order as a no-op', () => {
    const state = opened();
    expect(appReducer(state, { type: 'REORDER_PAGES', docId: 'a#g1#0', order: ['a#g1#p0', 'a#g1#p1', 'a#g1#p2'] }))
      .toBe(state);
  });
});

describe('NOTE_EDIT_REFUSED', () => {
  it('owes one more notice and changes nothing else', () => {
    const state = opened();
    expectRefused(appReducer(state, { type: 'NOTE_EDIT_REFUSED' }), state);
  });
});

describe('the documents a publication places with its bytes', () => {
  const read = (buffer: PdfBuffer, over: Partial<OpenDocument> = {}): OpenDocument[] =>
    [{ ...doc(file('a.pdf', buffer, 3), 'a#g2#0', pages('a.pdf', 'a#g2', 3)), ...over }];

  it.each<[string, (buffer: PdfBuffer) => OpenDocument[]]>([
    ['were read from equal bytes in another buffer', () => read([2])],
    ['belong to another file', (buffer) => read(buffer, { path: 'b.pdf' })],
    ['were composed rather than read', (buffer) => read(buffer, { provisional: true })],
  ])('are refused when they %s', (_case, documents) => {
    const state = opened();
    const buffer = [2];
    expect(appReducer(state, {
      type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 3, buffer, snapshotPath: 's', documents: documents(buffer),
    })).toBe(state);
    expect(appReducer(state, { type: 'REFRESH_BUFFER', path: 'a.pdf', pageCount: 3, buffer, documents: documents(buffer) }))
      .toBe(state);
    const history = { ...state, files: new Map(state.files).set('a.pdf', { ...state.files.get('a.pdf')!, undoStack: ['s1'] }) };
    expect(appReducer(history, {
      type: 'RESTORE_HISTORY', direction: 'undo', expected: history, path: 'a.pdf', snapshotPath: 's1',
      counterpart: 'r1', buffer, pageCount: 3, documents: documents(buffer),
    })).toBe(history);
  });

  it('none drops the path’s documents and keeps every other file’s', () => {
    const state = opened();
    const b = file('b.pdf', [5], 1);
    const withB = {
      ...state,
      files: new Map(state.files).set('b.pdf', b),
      workspace: { documents: [...state.workspace.documents, doc(b, 'b#0', pages('b.pdf', 'b', 1))] },
    };
    const next = appReducer(withB, { type: 'REFRESH_BUFFER', path: 'a.pdf', pageCount: 3, buffer: [2], documents: [] });
    expect(next.workspace.documents.map((d) => d.id)).toEqual(['b#0']);
  });

  it('drop the reading position and focus the previous documents held', () => {
    const state = appReducer(
      appReducer(opened(), { type: 'UI_FOCUS_DOC', docId: 'a#g1#0' }),
      { type: 'UI_SET_CURRENT_PAGE', pageId: 'a#g1#p1' },
    );
    expect(state.ui.focusedDocId).toBe('a#g1#0');
    const buffer = [2];
    const next = appReducer(state, { type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 3, buffer, snapshotPath: 's', documents: read(buffer) });
    expect(next.ui.focusedDocId).toBeNull();
    expect(next.ui.currentPageId).toBeNull();
  });

  it('let a byte-only import source nothing references go', () => {
    const state = opened();
    expect(state.files.has('x.pdf')).toBe(true);
    const buffer = [2];
    const next = appReducer(state, { type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 3, buffer, snapshotPath: 's', documents: read(buffer) });
    expect(next.files.has('x.pdf')).toBe(false);
    expect(next.files.get('a.pdf')!.buffer).toBe(buffer);
  });
});

describe('withSeededMarks', () => {
  const mark = (id: string, path: string, seeded?: true): RedactionMark => ({
    id, path, pageId: 'p', rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, rotationAtDraw: 0, ...(seeded ? { seeded } : {}),
  });

  it('keeps the marks drawn since the bytes changed and replaces the path’s earlier seed', () => {
    const next = withSeededMarks(
      [mark('drawn', 'a.pdf'), mark('earlier', 'a.pdf', true), mark('other', 'b.pdf'), mark('other-seed', 'b.pdf', true)],
      'a.pdf',
      [mark('stored', 'a.pdf')],
    );
    expect(next.map((m) => [m.id, m.seeded ?? false])).toEqual([
      ['drawn', false],
      ['other', false],
      ['other-seed', true],
      ['stored', true],
    ]);
  });
});

// The canvas and the App have no DOM test environment: their drawing and
// harness sites are pinned to the rules above as source text.
const source = (path: string): string =>
  readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

describe('the canvas', () => {
  const view = source('src/renderer/components/canvas/WorkspaceCanvasView.tsx');

  it('refuses, with the notice, a drawing that cannot land where it was drawn', () => {
    expect(view).toContain("drawingTarget(readState(), { docId: rendered.id, pageId, buffer: rendered.buffer, rotation: rotationAtDraw })");
    expect(view).toContain("if (!target) dispatch({ type: 'NOTE_EDIT_REFUSED' });");
  });

  it('resolves every mark, guide and band through that rule', () => {
    // Redaction mark, guide, and the signature, new-field, add-text, crop,
    // bead, link, snapshot and add-image bands.
    expect(view.match(/const target = acceptDrawing\(/g)).toHaveLength(10);
    expect(view).not.toContain('if (!placementDocsCurrent(state.files, docs, doc.path)) return;');
  });

  it('keeps the marks drawn while the stored ones are read back', () => {
    expect(view).toContain('setMarks((prev) => withSeededMarks(prev, path, seeded));');
  });

  it('hands the harness ids from the store', () => {
    expect(view).toContain('getWorkspacePageIds: () => readState().workspace.documents.flatMap((d) => d.pages.map((p) => p.id)),');
    expect(view).toContain('getSelectedPageIds: () => [...readState().ui.selectedPageIds],');
    expect(view).toContain('harnessAddMarkRef.current = (rect) => {\n    const now = readState();');
    expect(view).toContain('readState().workspace.documents.map((d) => ({ id: d.id, path: d.path, name: d.name, pages: d.pages.length })),');
  });
});

describe('the App', () => {
  const app = source('src/renderer/App.tsx');

  it('publishes every operation, fill, field creation, image edit and history step with the documents of its bytes', () => {
    expect(app.match(/index: readPublishedBytes/g)).toHaveLength(5);
    expect(app).not.toContain('getPageCount');
  });

  it('hands the harness ids from the store', () => {
    expect(app).toContain('harnessFirstPageRef.current = () => {\n    const now = readState();');
    expect(app).toContain('harnessFirstAnnotationRef.current = () => {\n    const now = readState();');
    expect(app).toContain('const d = readState().workspace.documents.find((x) => x.id === docId);');
  });
});
