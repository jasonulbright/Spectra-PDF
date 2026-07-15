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

// M4.1c — per-document focus for the reading view. The board renders every doc
// at once, but the reading view renders exactly ONE, and a tab addresses a FILE
// while a `.pdfx` partitions one file into several documents — so without this
// the reading view could only ever show a file's FIRST partition.
describe('ui per-document focus (M4.1c)', () => {
  // One .pdfx file partitioned into two documents, sharing a path.
  function partitionedState(): AppState {
    const a = makeFile('book.pdfx', 5);
    return stateWith(
      [a],
      [
        makeDoc(a, 'book.pdfx#0', makePages('book.pdfx', 3)),
        makeDoc(a, 'book.pdfx#1', makePages('book.pdfx', 2, 3)),
      ],
    );
  }

  it('focuses a partition of the already-active file', () => {
    const s = appReducer(
      { ...partitionedState(), activeFileId: 'book.pdfx' },
      { type: 'UI_FOCUS_DOC', docId: 'book.pdfx#1' },
    );
    expect(s.ui.focusedDocId).toBe('book.pdfx#1');
    expect(s.activeFileId).toBe('book.pdfx'); // unchanged — same file
  });

  it('focusing a doc in ANOTHER file activates that file and its tab', () => {
    const s = appReducer(twoDocState(), { type: 'UI_FOCUS_DOC', docId: 'b.pdf#0' });
    expect(s.ui.focusedDocId).toBe('b.pdf#0');
    expect(s.activeFileId).toBe('b.pdf');
    expect(s.ui.focusedTab).toEqual({ doc: 'b.pdf' });
  });

  it('rejects an unknown doc rather than stranding the reading view', () => {
    const before = twoDocState();
    expect(appReducer(before, { type: 'UI_FOCUS_DOC', docId: 'gone.pdf#7' })).toBe(before);
  });

  it('switching tabs clears a per-doc focus (it names the file being left)', () => {
    const focused = appReducer(twoDocState(), { type: 'UI_FOCUS_DOC', docId: 'b.pdf#0' });
    expect(focused.ui.focusedDocId).toBe('b.pdf#0');
    const switched = appReducer(focused, { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    expect(switched.ui.focusedDocId).toBeNull();
    // ...and leaving doc-land entirely also clears it.
    const home = appReducer(focused, { type: 'UI_FOCUS_TAB', tab: 'home' });
    expect(home.ui.focusedDocId).toBeNull();
  });

  it('clearing to null returns to the default (first doc of the active file)', () => {
    const focused = appReducer(
      { ...partitionedState(), activeFileId: 'book.pdfx' },
      { type: 'UI_FOCUS_DOC', docId: 'book.pdfx#1' },
    );
    const cleared = appReducer(focused, { type: 'UI_FOCUS_DOC', docId: null });
    expect(cleared.ui.focusedDocId).toBeNull();
  });
});

describe('ui tab/tool actions (Phase 4 M2)', () => {
  it('focuses a tab', () => {
    const next = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: 'tools' });
    expect(next.ui.focusedTab).toBe('tools');
  });

  it('is a no-op object-wise when the tab is unchanged', () => {
    const s = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: 'tools' });
    expect(appReducer(s, { type: 'UI_FOCUS_TAB', tab: 'tools' })).toBe(s);
  });

  it('focusing a doc tab activates that file', () => {
    const next = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: { doc: 'b.pdf' } });
    expect(next.ui.focusedTab).toEqual({ doc: 'b.pdf' });
    expect(next.activeFileId).toBe('b.pdf');
  });

  it('rejects focusing a doc tab for a file that is not open', () => {
    const s = twoDocState();
    expect(appReducer(s, { type: 'UI_FOCUS_TAB', tab: { doc: 'gone.pdf' } })).toBe(s);
  });

  it('leaving doc-land resets the tool and clears the selection (old unmount semantics)', () => {
    let s = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    s = appReducer(s, { type: 'UI_SET_TOOL', tool: 'highlight' });
    s = select(s, ['a.pdf#p0', 'a.pdf#p1'], 'a.pdf#p1');
    const next = appReducer(s, { type: 'UI_FOCUS_TAB', tab: 'tools' });
    expect(next.ui.tool).toBe('select');
    expect(next.ui.selectedPageIds.size).toBe(0);
    expect(next.ui.selectionAnchor).toBeNull();
  });

  it('doc→doc switches keep the tool and selection (same board, different file)', () => {
    let s = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    s = appReducer(s, { type: 'UI_SET_TOOL', tool: 'redact' });
    s = select(s, ['a.pdf#p0'], 'a.pdf#p0');
    const next = appReducer(s, { type: 'UI_FOCUS_TAB', tab: { doc: 'b.pdf' } });
    expect(next.ui.tool).toBe('redact');
    expect(next.ui.selectedPageIds.size).toBe(1);
    expect(next.activeFileId).toBe('b.pdf');
  });

  it('home↔tools switches keep the tool (only leaving doc-land resets)', () => {
    let s = appReducer(twoDocState(), { type: 'UI_SET_TOOL', tool: 'redact' });
    s = appReducer(s, { type: 'UI_FOCUS_TAB', tab: 'tools' });
    expect(s.ui.tool).toBe('redact');
  });

  it('sets the document view mode (M4) and no-ops on the same mode', () => {
    expect(initialState.ui.docViewMode).toBe('organize');
    const doc = appReducer(initialState, { type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' });
    expect(doc.ui.docViewMode).toBe('document');
    expect(appReducer(doc, { type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' })).toBe(doc); // referential no-op
  });

  it('sets the active operation', () => {
    const next = appReducer(initialState, { type: 'UI_SET_ACTIVE_OP', op: 'compress' });
    expect(next.ui.activeOp).toBe('compress');
  });
});

describe('doc-tab lifecycle', () => {
  it('SET_ACTIVE_FILE follows the tab in doc-land, not elsewhere', () => {
    let s = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    s = appReducer(s, { type: 'SET_ACTIVE_FILE', path: 'b.pdf' });
    expect(s.ui.focusedTab).toEqual({ doc: 'b.pdf' });
    // From Tools, activating a file must not yank onto the board.
    let t = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: 'tools' });
    t = appReducer(t, { type: 'SET_ACTIVE_FILE', path: 'b.pdf' });
    expect(t.ui.focusedTab).toBe('tools');
  });

  it('closing the focused doc falls back to the next doc, else Home', () => {
    let s = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    s = appReducer(s, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(s.ui.focusedTab).toEqual({ doc: 'b.pdf' });
    s = appReducer(s, { type: 'CLOSE_FILE', path: 'b.pdf' });
    expect(s.ui.focusedTab).toBe('home');
  });

  it('closing an unfocused doc leaves the focused tab alone', () => {
    let s = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: { doc: 'b.pdf' } });
    s = appReducer(s, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(s.ui.focusedTab).toEqual({ doc: 'b.pdf' });
  });
});

describe('recent files', () => {
  it('sets the recent list', () => {
    const next = appReducer(initialState, { type: 'UI_SET_RECENT_FILES', files: ['a.pdf', 'b.pdf'] });
    expect(next.ui.recentFiles).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('nav pane (M3)', () => {
  it('opens on a panel; re-opening the active panel closes (icon-strip toggle)', () => {
    let s = appReducer(initialState, { type: 'UI_OPEN_NAV_PANEL', panel: 'pages' });
    expect(s.ui.navPane).toMatchObject({ open: true, panel: 'pages' });
    s = appReducer(s, { type: 'UI_OPEN_NAV_PANEL', panel: 'pages' });
    expect(s.ui.navPane.open).toBe(false);
  });

  it('switches panel without closing when a different panel is opened', () => {
    let s = appReducer(initialState, { type: 'UI_OPEN_NAV_PANEL', panel: 'pages' });
    s = appReducer(s, { type: 'UI_OPEN_NAV_PANEL', panel: 'bookmarks' });
    expect(s.ui.navPane).toMatchObject({ open: true, panel: 'bookmarks' });
  });

  it('toggles open/closed', () => {
    let s = appReducer(initialState, { type: 'UI_TOGGLE_NAV_PANE' });
    expect(s.ui.navPane.open).toBe(true);
    s = appReducer(s, { type: 'UI_TOGGLE_NAV_PANE' });
    expect(s.ui.navPane.open).toBe(false);
  });

  it('clamps the width to both ends and no-ops when unchanged', () => {
    const s = appReducer(initialState, { type: 'UI_SET_NAV_PANE_WIDTH', width: 50 });
    expect(s.ui.navPane.width).toBe(180); // NAV_PANE_MIN_WIDTH
    const huge = appReducer(initialState, { type: 'UI_SET_NAV_PANE_WIDTH', width: 9999 });
    expect(huge.ui.navPane.width).toBe(520); // NAV_PANE_MAX_WIDTH — never buries the board
    const wide = appReducer(initialState, { type: 'UI_SET_NAV_PANE_WIDTH', width: 300 });
    expect(wide.ui.navPane.width).toBe(300);
    expect(appReducer(wide, { type: 'UI_SET_NAV_PANE_WIDTH', width: 300 })).toBe(wide);
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
