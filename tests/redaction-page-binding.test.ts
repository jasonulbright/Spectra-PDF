// A page number read from the file — a stored /Redact mark, a search hit —
// counts the file's own page order. The canvas seeds marks from such numbers,
// so each one must bind to the page that shows that page of the CURRENT
// bytes, wherever a pending edit moved it, and to nothing while the
// documents still describe the previous bytes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { committedDocuments } from '../src/renderer/lib/workspace-commit';
import { pageForFilePageNumber } from '../src/renderer/lib/redaction';
import type { AppAction, AppState, OpenDocument, OpenFile, PageRef } from '../src/renderer/state/types';

function file(path: string, buffer: number[], pageCount: number): OpenFile {
  return {
    path, workingPath: `${path}.w`, name: path, pageCount, buffer,
    dirty: false, undoStack: [], redoStack: [],
  };
}

function pages(path: string, count: number): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${path}#p${i}`, sourceDocId: path, sourcePageIndex: i, rotation: 0 as const, width: 1, height: 1,
  }));
}

function opened(): AppState {
  const a = file('a.pdf', [1], 3);
  const b = file('b.pdf', [2], 1);
  const docs: OpenDocument[] = [
    { ...a, id: 'a#0', pages: pages('a.pdf', 3), pageCount: 3 },
    { ...b, id: 'b#0', pages: pages('b.pdf', 1), pageCount: 1 },
  ];
  return { ...initialState, files: new Map([['a.pdf', a], ['b.pdf', b]]), workspace: { documents: docs } };
}

const idOf = (s: AppState, n: number): string | null => pageForFilePageNumber(s, 'a.pdf', n)?.id ?? null;

describe('pageForFilePageNumber', () => {
  it('binds each page number to that page of the bytes, not to the slot it sits in', () => {
    const s = appReducer(opened(), {
      type: 'REORDER_PAGES', docId: 'a#0', order: ['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1'],
    });
    expect([1, 2, 3].map((n) => idOf(s, n))).toEqual(['a.pdf#p0', 'a.pdf#p1', 'a.pdf#p2']);
  });

  it('follows a page moved into another file’s document', () => {
    const s = appReducer(opened(), { type: 'MOVE_PAGES', pageIds: ['a.pdf#p1'], toDocId: 'b#0', toIndex: 0 });
    expect(idOf(s, 2)).toBe('a.pdf#p1');
    expect(s.workspace.documents[1].pages[0].id).toBe('a.pdf#p1');
  });

  it('binds the documents a commit composed, and keeps binding through an edit made before the read-back', () => {
    const edited = appReducer(opened(), {
      type: 'REORDER_PAGES', docId: 'a#0', order: ['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1'],
    });
    const buffer = [9];
    const committed = appReducer(edited, {
      type: 'COMMIT_PAGE_EDITS',
      updates: [{
        path: 'a.pdf', pageCount: 3, buffer, snapshotPath: 's',
        authored: { pages: ['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1'], documents: [{ id: 'a#0', name: 'a.pdf' }] },
        documents: committedDocuments(edited.workspace.documents.filter((d) => d.path === 'a.pdf'), buffer),
      }],
      planned: { pageUndoStack: edited.pageUndoStack, pageRedoStack: edited.pageRedoStack },
    } as AppAction);
    // The new bytes hold the reordered pages in that order.
    expect([1, 2, 3].map((n) => idOf(committed, n))).toEqual(['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1']);
    const moved = appReducer(committed, {
      type: 'REORDER_PAGES', docId: 'a#0', order: ['a.pdf#p1', 'a.pdf#p2', 'a.pdf#p0'],
    });
    expect([1, 2, 3].map((n) => idOf(moved, n))).toEqual(['a.pdf#p2', 'a.pdf#p0', 'a.pdf#p1']);
  });

  it('binds nothing while the documents describe the previous bytes', () => {
    const replaced = appReducer(opened(), {
      type: 'UPDATE_FILE', path: 'a.pdf', pageCount: 3, buffer: [7], snapshotPath: 's',
    });
    expect([1, 2, 3].map((n) => idOf(replaced, n))).toEqual([null, null, null]);
  });

  it('binds nothing for a page number the bytes do not have', () => {
    expect(idOf(opened(), 4)).toBeNull();
    expect(idOf(opened(), 0)).toBeNull();
  });

  it('ignores another file’s page at the same index', () => {
    const s = opened();
    const reversed = { ...s, workspace: { documents: [...s.workspace.documents].reverse() } };
    expect(reversed.workspace.documents[0].path).toBe('b.pdf');
    expect(idOf(reversed, 1)).toBe('a.pdf#p0');
  });
});

// The canvas has no DOM test environment: its seed and binding sites are
// pinned to the rules above as source text.
describe('the canvas redaction seed', () => {
  const view = readFileSync(resolve(__dirname, '../src/renderer/components/canvas/WorkspaceCanvasView.tsx'), 'utf8');

  it('binds stored marks and search hits by file page number', () => {
    expect(view).toContain('const pageRef = pageForFilePageNumber(current, path, entry.page);');
    expect(view).toContain('const pageRef = pageForFilePageNumber(readState(), path, page);');
  });

  it('seeds a path only once its documents describe the bytes it holds', () => {
    expect(view.match(/if \(!pathDescribesCurrentBytes\(state, path\)\) continue;/g)).toHaveLength(2);
  });

  it('keeps no mark converted from bytes the file no longer holds', () => {
    expect(view).toContain('if (readState().files.get(path)?.buffer !== f.buffer) return;');
    expect(view).toContain('if (seedSeqRef.current.get(path) !== seq || buffer !== f.buffer) return;');
    expect(view).toContain('return stillCurrent() ? { marks, orphaned, buffer } : stale;');
    expect(view).toContain('if (readState().files.get(batch.path)?.buffer === batch.buffer) {');
  });
});

describe('the canvas overlay', () => {
  it('draws no body for an annotation the loaded bytes already draw', () => {
    const cell = readFileSync(resolve(__dirname, '../src/renderer/components/canvas/PageCell.tsx'), 'utf8');
    expect(cell).toContain('(!!a.baked && !a.geometryDiverged) ||');
  });
});
