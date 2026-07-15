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

  // `OpenDocument.id` is POSITIONAL (`path#docIndex`), reassigned from scratch on
  // every reindex — so the same id string can come back meaning a DIFFERENT
  // partition. Same invalidation every other buffer-replacing case applies to
  // positional selection ids.
  it('drops a per-doc focus into a path whose documents are re-indexed', () => {
    const a = makeFile('book.pdfx', 5);
    const focused = appReducer(
      { ...partitionedState(), activeFileId: 'book.pdfx' },
      { type: 'UI_FOCUS_DOC', docId: 'book.pdfx#1' },
    );
    expect(focused.ui.focusedDocId).toBe('book.pdfx#1');
    // The two partitions are reordered and committed; the reindex hands back
    // the SAME id strings now naming swapped content.
    const reindexed = appReducer(focused, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'book.pdfx',
      documents: [
        makeDoc(a, 'book.pdfx#0', makePages('book.pdfx', 2, 3)),
        makeDoc(a, 'book.pdfx#1', makePages('book.pdfx', 3)),
      ],
    });
    // Without this the view silently showed the OTHER partition under the same id.
    expect(reindexed.ui.focusedDocId).toBeNull();
  });

  // THE case that makes a "did the content actually move?" check unsound, and
  // why this clears unconditionally. Two partitions of EQUAL page count swap:
  // page ids are `path#p{ABSOLUTE index}`, so slot #1's id array is bit-identical
  // before and after (both ['#p2','#p3']) while it now names the OTHER partition.
  // Any comparison of ids/lengths sees "unchanged" and keeps a focus pointing at
  // the wrong content.
  it('drops the focus when equal-size partitions swap (identical ids, different content)', () => {
    const a = makeFile('book.pdfx', 4);
    const alpha = makePages('book.pdfx', 2); // #p0 #p1
    const beta = makePages('book.pdfx', 2, 2); // #p2 #p3
    const start = stateWith(
      [a],
      [makeDoc(a, 'book.pdfx#0', alpha), makeDoc(a, 'book.pdfx#1', beta)],
    );
    const focused = appReducer(
      { ...start, activeFileId: 'book.pdfx' },
      { type: 'UI_FOCUS_DOC', docId: 'book.pdfx#1' },
    );
    // Beta moved up and the commit reindexed: slot #1 is now Alpha, but its
    // derived ids are the SAME strings Beta's slot had.
    const reindexed = appReducer(focused, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'book.pdfx',
      documents: [
        makeDoc(a, 'book.pdfx#0', makePages('book.pdfx', 2)),
        makeDoc(a, 'book.pdfx#1', makePages('book.pdfx', 2, 2)),
      ],
    });
    expect(reindexed.ui.focusedDocId).toBeNull();
  });

  it('drops a per-doc focus when the focused id vanishes (partitions collapse to one)', () => {
    const a = makeFile('book.pdfx', 5);
    const focused = appReducer(
      { ...partitionedState(), activeFileId: 'book.pdfx' },
      { type: 'UI_FOCUS_DOC', docId: 'book.pdfx#1' },
    );
    const reindexed = appReducer(focused, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'book.pdfx',
      documents: [makeDoc(a, 'book.pdfx#0', makePages('book.pdfx', 5))],
    });
    expect(reindexed.ui.focusedDocId).toBeNull();
  });

  // Reopening an already-open file dispatches only SET_ACTIVE_FILE — the stale
  // focus survived and outranked the active file in resolution.
  it('drops a per-doc focus when the active file changes underneath it', () => {
    const focused = appReducer(twoDocState(), { type: 'UI_FOCUS_DOC', docId: 'b.pdf#0' });
    expect(focused.ui.focusedDocId).toBe('b.pdf#0');
    const switched = appReducer(focused, { type: 'SET_ACTIVE_FILE', path: 'a.pdf' });
    expect(switched.activeFileId).toBe('a.pdf');
    expect(switched.ui.focusedDocId).toBeNull();
  });

  it('keeps a per-doc focus when SET_ACTIVE_FILE re-activates the same file', () => {
    const s = appReducer(
      { ...partitionedState(), activeFileId: 'book.pdfx' },
      { type: 'UI_FOCUS_DOC', docId: 'book.pdfx#1' },
    );
    const again = appReducer(s, { type: 'SET_ACTIVE_FILE', path: 'book.pdfx' });
    expect(again.ui.focusedDocId).toBe('book.pdfx#1');
  });

  // Ownership is tested against the real documents, not a string prefix: OS
  // paths may contain '#', so "a.pdf" is a literal prefix of the DISTINCT open
  // file "a.pdf#draft.pdf", whose doc ids start with "a.pdf#".
  it('does not clear another file whose path merely starts with the re-indexed one', () => {
    const a = makeFile('a.pdf', 2);
    const b = makeFile('a.pdf#draft.pdf', 2); // a legal, distinct path
    const start = stateWith(
      [a, b],
      [
        makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2)),
        makeDoc(b, 'a.pdf#draft.pdf#0', makePages('a.pdf#draft.pdf', 2)),
      ],
    );
    const focused = appReducer(start, { type: 'UI_FOCUS_DOC', docId: 'a.pdf#draft.pdf#0' });
    expect(focused.ui.focusedDocId).toBe('a.pdf#draft.pdf#0');
    // Re-indexing 'a.pdf' must not touch the OTHER file's focus.
    const reindexed = appReducer(focused, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 2))],
    });
    expect(reindexed.ui.focusedDocId).toBe('a.pdf#draft.pdf#0');
  });

  it('leaves a per-doc focus alone when a DIFFERENT path re-indexes', () => {
    const b = makeFile('b.pdf', 2);
    const focused = appReducer(twoDocState(), { type: 'UI_FOCUS_DOC', docId: 'b.pdf#0' });
    const reindexed = appReducer(focused, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(makeFile('a.pdf', 3), 'a.pdf#0', makePages('a.pdf', 3))],
    });
    expect(reindexed.ui.focusedDocId).toBe('b.pdf#0');
  });

  // M4.1e — the reading position the Pages panel highlights/scroll-follows. It
  // is a positional id like every other, so it invalidates on the same triggers
  // (roadmap § F): a stale one would mis-highlight a different physical page.
  it('tracks the current page and clears it on a tab switch', () => {
    // Start IN doc-land: focusTab short-circuits a no-op switch, so reading
    // position must be established on a real doc tab first.
    const inDoc = appReducer(twoDocState(), { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    const s = appReducer(inDoc, { type: 'UI_SET_CURRENT_PAGE', pageId: 'a.pdf#p2' });
    expect(s.ui.currentPageId).toBe('a.pdf#p2');
    // ...to another doc tab, and out of doc-land entirely.
    expect(appReducer(s, { type: 'UI_FOCUS_TAB', tab: { doc: 'b.pdf' } }).ui.currentPageId).toBeNull();
    expect(appReducer(s, { type: 'UI_FOCUS_TAB', tab: 'home' }).ui.currentPageId).toBeNull();
  });

  it('clears the current page when the active file changes underneath it', () => {
    const s = appReducer(twoDocState(), { type: 'UI_SET_CURRENT_PAGE', pageId: 'b.pdf#p0' });
    expect(appReducer(s, { type: 'SET_ACTIVE_FILE', path: 'a.pdf' }).ui.currentPageId).toBeNull();
  });

  it('clears the current page when its own file re-indexes (ids are REUSED)', () => {
    const a = makeFile('a.pdf', 3);
    const s = appReducer(twoDocState(), { type: 'UI_SET_CURRENT_PAGE', pageId: 'a.pdf#p2' });
    const reindexed = appReducer(s, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))],
    });
    expect(reindexed.ui.currentPageId).toBeNull();
  });

  // Clause 2 of the ownership test (`action.documents.some(...)`) exists for a
  // close-then-reopen: the id is gone from `prev` but the incoming set RE-CLAIMS
  // it, and it must not silently re-bind to whatever now holds that slot. Both
  // other tests have the id in `prev` too, so clause 1 alone would pass them —
  // this one fails without clause 2.
  it('clears an id absent from prev but RE-CLAIMED by the incoming documents', () => {
    const a = makeFile('a.pdf', 3);
    // a.pdf is open but has no indexed documents yet (just closed/reopened).
    const s0 = stateWith([a], []);
    const s = appReducer(s0, { type: 'UI_SET_CURRENT_PAGE', pageId: 'a.pdf#p1' });
    expect(s.ui.currentPageId).toBe('a.pdf#p1');
    const reindexed = appReducer(s, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(a, 'a.pdf#0', makePages('a.pdf', 3))], // re-claims a.pdf#p1
    });
    expect(reindexed.ui.currentPageId).toBeNull();
  });

  it('is a no-op for the same current page (the scroll-driven dispatch must not churn)', () => {
    const s = appReducer(twoDocState(), { type: 'UI_SET_CURRENT_PAGE', pageId: 'a.pdf#p1' });
    // Same value -> same state reference, so useReducer consumers bail out.
    expect(appReducer(s, { type: 'UI_SET_CURRENT_PAGE', pageId: 'a.pdf#p1' })).toBe(s);
  });

  it('leaves the current page alone when a DIFFERENT file re-indexes', () => {
    const b = makeFile('b.pdf', 2);
    const s = appReducer(twoDocState(), { type: 'UI_SET_CURRENT_PAGE', pageId: 'b.pdf#p0' });
    const reindexed = appReducer(s, {
      type: 'SET_WORKSPACE_DOCUMENTS',
      path: 'a.pdf',
      documents: [makeDoc(makeFile('a.pdf', 3), 'a.pdf#0', makePages('a.pdf', 3))],
    });
    expect(reindexed.ui.currentPageId).toBe('b.pdf#p0');
    void b;
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

  // M4.1g: a document OPENS in the reading view (§ 6.1 — a PDF is something you
  // read; the board is the tool you switch to when you want to rearrange it).
  // Pinned so the flip can't be silently reverted: it was held back until every
  // default-flip gate closed, and un-flipping would quietly undo that milestone.
  it('opens in the READING view by default', () => {
    expect(initialState.ui.docViewMode).toBe('document');
  });

  it('sets the document view mode (M4) and no-ops on the same mode', () => {
    const board = appReducer(initialState, { type: 'UI_SET_DOC_VIEW_MODE', mode: 'organize' });
    expect(board.ui.docViewMode).toBe('organize');
    expect(appReducer(board, { type: 'UI_SET_DOC_VIEW_MODE', mode: 'organize' })).toBe(board); // referential no-op
    const doc = appReducer(board, { type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' });
    expect(doc.ui.docViewMode).toBe('document');
    expect(appReducer(doc, { type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' })).toBe(doc);
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
