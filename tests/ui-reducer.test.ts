// The ui slice (Phase 4 M1): view/tool/selection actions, the selection
// modifier semantics that moved from WorkspaceCanvasView into the reducer,
// and the buffer-identity invalidation that moved with them.
import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState, OpenDocument, OpenFile, PageRef } from '../src/renderer/state/types';

function makeFile(path: string, pageCount: number): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path.split('/').pop() ?? path,
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

// Two docs, 3 + 2 pages → flat order a#p0 a#p1 a#p2 b#p0 b#p1.
function twoDocState(): AppState {
  const a = makeFile('a.pdf', 3);
  const b = makeFile('b.pdf', 2);
  return stateWith(
    [a, b],
    [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3)), makeDoc(b, 'b.pdf#0', makePages('b.pdf', 2))],
  );
}

const select = (s: AppState, pageIds: string[], anchor: string | null): AppState =>
  appReducer(s, { type: 'UI_SET_SELECTION', pageIds, anchor });

const selected = (s: AppState): string[] => [...s.ui.selectedPageIds].sort();

describe('ui view/tool actions', () => {
  it('sets the view', () => {
    const next = appReducer(initialState, { type: 'UI_SET_VIEW', view: 'canvas' });
    expect(next.ui.view).toBe('canvas');
  });

  it('is a no-op object-wise when the view is unchanged', () => {
    const s = appReducer(initialState, { type: 'UI_SET_VIEW', view: 'canvas' });
    expect(appReducer(s, { type: 'UI_SET_VIEW', view: 'canvas' })).toBe(s);
  });

  it('leaving the canvas resets the tool and clears the selection (the old unmount semantics)', () => {
    let s = appReducer(twoDocState(), { type: 'UI_SET_VIEW', view: 'canvas' });
    s = appReducer(s, { type: 'UI_SET_TOOL', tool: 'highlight' });
    s = select(s, ['a.pdf#p0', 'a.pdf#p1'], 'a.pdf#p1');
    const next = appReducer(s, { type: 'UI_SET_VIEW', view: 'operations' });
    expect(next.ui.tool).toBe('select');
    expect(next.ui.selectedPageIds.size).toBe(0);
    expect(next.ui.selectionAnchor).toBeNull();
  });

  it('switching between non-canvas views keeps the tool', () => {
    let s = appReducer(initialState, { type: 'UI_SET_TOOL', tool: 'redact' });
    s = appReducer(s, { type: 'UI_SET_VIEW', view: 'operations' });
    expect(s.ui.tool).toBe('redact'); // only canvas → elsewhere resets
  });

  it('sets the active operation', () => {
    const next = appReducer(initialState, { type: 'UI_SET_ACTIVE_OP', op: 'compress' });
    expect(next.ui.activeOp).toBe('compress');
  });
});

describe('UI_SELECT_PAGE', () => {
  it('single replaces the selection and moves the anchor', () => {
    let s = select(twoDocState(), ['a.pdf#p0'], 'a.pdf#p0');
    s = appReducer(s, { type: 'UI_SELECT_PAGE', pageId: 'b.pdf#p1', mode: 'single' });
    expect(selected(s)).toEqual(['b.pdf#p1']);
    expect(s.ui.selectionAnchor).toBe('b.pdf#p1');
  });

  it('toggle adds and removes, updating the anchor', () => {
    let s = select(twoDocState(), ['a.pdf#p0'], 'a.pdf#p0');
    s = appReducer(s, { type: 'UI_SELECT_PAGE', pageId: 'a.pdf#p2', mode: 'toggle' });
    expect(selected(s)).toEqual(['a.pdf#p0', 'a.pdf#p2']);
    expect(s.ui.selectionAnchor).toBe('a.pdf#p2');
    s = appReducer(s, { type: 'UI_SELECT_PAGE', pageId: 'a.pdf#p0', mode: 'toggle' });
    expect(selected(s)).toEqual(['a.pdf#p2']);
  });

  it('range selects across the workspace-flattened order and keeps the anchor', () => {
    let s = select(twoDocState(), ['a.pdf#p1'], 'a.pdf#p1');
    s = appReducer(s, { type: 'UI_SELECT_PAGE', pageId: 'b.pdf#p0', mode: 'range' });
    expect(selected(s)).toEqual(['a.pdf#p1', 'a.pdf#p2', 'b.pdf#p0']);
    expect(s.ui.selectionAnchor).toBe('a.pdf#p1'); // a further shift-click re-extends
  });

  it('range without an anchor falls back to single-select', () => {
    const s = appReducer(twoDocState(), { type: 'UI_SELECT_PAGE', pageId: 'b.pdf#p0', mode: 'range' });
    expect(selected(s)).toEqual(['b.pdf#p0']);
    expect(s.ui.selectionAnchor).toBe('b.pdf#p0');
  });

  it('context keeps a selection containing the page (anchor moves)', () => {
    let s = select(twoDocState(), ['a.pdf#p0', 'a.pdf#p1'], 'a.pdf#p0');
    s = appReducer(s, { type: 'UI_SELECT_PAGE', pageId: 'a.pdf#p1', mode: 'context' });
    expect(selected(s)).toEqual(['a.pdf#p0', 'a.pdf#p1']);
    expect(s.ui.selectionAnchor).toBe('a.pdf#p1');
  });

  it('context replaces a selection NOT containing the page', () => {
    let s = select(twoDocState(), ['a.pdf#p0'], 'a.pdf#p0');
    s = appReducer(s, { type: 'UI_SELECT_PAGE', pageId: 'b.pdf#p1', mode: 'context' });
    expect(selected(s)).toEqual(['b.pdf#p1']);
  });
});

describe('UI_SELECT_ALL_PAGES / UI_CLEAR_SELECTION', () => {
  it('select-all covers the workspace order with the first page as anchor', () => {
    const s = appReducer(twoDocState(), { type: 'UI_SELECT_ALL_PAGES' });
    expect(s.ui.selectedPageIds.size).toBe(5);
    expect(s.ui.selectionAnchor).toBe('a.pdf#p0');
  });

  it('select-all with no pages is a no-op', () => {
    expect(appReducer(initialState, { type: 'UI_SELECT_ALL_PAGES' })).toBe(initialState);
  });

  it('clear empties selection and anchor', () => {
    let s = appReducer(twoDocState(), { type: 'UI_SELECT_ALL_PAGES' });
    s = appReducer(s, { type: 'UI_CLEAR_SELECTION' });
    expect(s.ui.selectedPageIds.size).toBe(0);
    expect(s.ui.selectionAnchor).toBeNull();
  });
});

describe('selection invalidation on buffer-identity changes', () => {
  // Positional PageRef ids re-bind after any reindex — every action that
  // replaces a file's bytes (or closes a file) must clear the selection
  // (formerly the canvas's buffer-watching effect).
  const cases: [string, (s: AppState) => AppAction][] = [
    ['UPDATE_FILE', () => ({
      type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 3, buffer: [9], snapshotPath: 'snap',
    })],
    ['REFRESH_BUFFER', () => ({
      type: 'REFRESH_BUFFER', path: 'a.pdf', pageCount: 3, buffer: [9],
    })],
    ['COMMIT_PAGE_EDITS', () => ({
      type: 'COMMIT_PAGE_EDITS',
      updates: [{ path: 'a.pdf', pageCount: 3, buffer: [9], snapshotPath: 'snap' }],
    })],
    ['CLOSE_FILE', () => ({ type: 'CLOSE_FILE', path: 'a.pdf' })],
  ];
  for (const [name, make] of cases) {
    it(`${name} clears the selection`, () => {
      const s = select(twoDocState(), ['b.pdf#p0'], 'b.pdf#p0');
      const next = appReducer(s, make(s));
      expect(next.ui.selectedPageIds.size).toBe(0);
      expect(next.ui.selectionAnchor).toBeNull();
    });
  }

  it('a REOPEN (OPEN_FILE on an open path) clears; a fresh OPEN_FILE does not', () => {
    const s = select(twoDocState(), ['b.pdf#p0'], 'b.pdf#p0');
    const reopened = appReducer(s, {
      type: 'OPEN_FILE', path: 'a.pdf', workingPath: 'w', name: 'a.pdf', pageCount: 3, buffer: [9],
    });
    expect(reopened.ui.selectedPageIds.size).toBe(0);
    const fresh = appReducer(s, {
      type: 'OPEN_FILE', path: 'c.pdf', workingPath: 'w', name: 'c.pdf', pageCount: 1, buffer: [9],
    });
    expect(selected(fresh)).toEqual(['b.pdf#p0']);
  });

  it('REGISTER_IMPORT_SOURCE leaves the selection alone', () => {
    const s = select(twoDocState(), ['b.pdf#p0'], 'b.pdf#p0');
    const next = appReducer(s, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'src.pdf', workingPath: 'w', name: 'src.pdf', pageCount: 1, buffer: [9],
    });
    expect(selected(next)).toEqual(['b.pdf#p0']);
  });
});
