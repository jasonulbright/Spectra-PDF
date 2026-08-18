// Tab order is the user's order.
//
// Order is the `files` Map's insertion order and nothing else — `tabFiles`
// reads it straight off — so a move rebuilds the Map rather than keeping a
// second list beside it. These pin what the rebuild may and may not touch: the
// arrangement changes, and no document does.
import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { placeTabAt, tabFiles } from '../src/renderer/state/selectors';
import type { AppState, OpenFile, PdfBuffer } from '../src/renderer/state/types';

const BUFFER: PdfBuffer = [1, 2, 3];

function file(path: string, over: Partial<OpenFile> = {}): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount: 2,
    buffer: BUFFER,
    dirty: false,
    undoStack: [],
    redoStack: [],
    ...over,
  };
}

function stateWith(files: OpenFile[]): AppState {
  return {
    ...initialState,
    files: new Map(files.map((f) => [f.path, f])),
    activeFileId: files.find((f) => !f.importOnly)?.path ?? null,
  };
}

const order = (state: AppState): string[] => tabFiles(state).map((f) => f.path);
const mapOrder = (state: AppState): string[] => [...state.files.keys()];

const four = (): AppState => stateWith([file('a'), file('b'), file('c'), file('d')]);

const reorder = (state: AppState, path: string, index: number): AppState =>
  appReducer(state, { type: 'REORDER_FILE', path, index });

describe('REORDER_FILE', () => {
  it('moves the first tab to the end', () => {
    expect(order(reorder(four(), 'a', 3))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves the last tab to the front', () => {
    expect(order(reorder(four(), 'd', 0))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves a middle tab in both directions', () => {
    expect(order(reorder(four(), 'c', 1))).toEqual(['a', 'c', 'b', 'd']);
    expect(order(reorder(four(), 'b', 2))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('clamps an index past either end instead of refusing', () => {
    // A drop can name a gap the strip no longer has — the tab it was measured
    // against closed while the pointer was held. An insert that cannot fail is
    // what lets the index travel without a handshake.
    expect(order(reorder(four(), 'a', 99))).toEqual(['b', 'c', 'd', 'a']);
    // Below zero is the front of the strip, not a position counted back from
    // the end — which is what an unclamped index would mean here.
    expect(order(reorder(four(), 'd', -1))).toEqual(['d', 'a', 'b', 'c']);
    expect(order(reorder(four(), 'd', -99))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('changes nothing at all when the tab is already there', () => {
    const state = four();
    // Identity, not just equality: a reorder that moves nothing must not
    // re-render every consumer of the file map either.
    expect(reorder(state, 'b', 1)).toBe(state);
    expect(reorder(state, 'b', 1).files).toBe(state.files);
  });

  it('leaves a path with no tab where it is', () => {
    const state = stateWith([file('a'), file('ghost', { importOnly: true }), file('b')]);
    expect(reorder(state, 'ghost', 0)).toBe(state);
    expect(reorder(state, 'never-opened', 0)).toBe(state);
  });

  it('counts only tabs, and leaves import sources in their own slots', () => {
    // A byte-only import source has no tab, so it is not a position a drop can
    // name: the index space is the user's own strip. It keeps the Map slot it
    // has, and the tabs fill the rest in their new order.
    const state = stateWith([
      file('a'),
      file('ghost', { importOnly: true }),
      file('b'),
      file('c'),
    ]);
    const moved = reorder(state, 'a', 2);
    expect(order(moved)).toEqual(['b', 'c', 'a']);
    expect(mapOrder(moved)).toEqual(['b', 'ghost', 'c', 'a']);
    expect(moved.files.get('ghost')?.importOnly).toBe(true);

    // And the tab count is what the index clamps against, not the file count:
    // index 2 is the last tab, so naming 3 is naming a gap that is not there,
    // and for the tab already last that has to be nothing at all rather than a
    // move to a position past the end of the strip.
    expect(order(reorder(state, 'a', 3))).toEqual(['b', 'c', 'a']);
    expect(reorder(state, 'c', 3)).toBe(state);
  });

  it('is arrangement, not an edit: nothing is dirtied and no history moves', () => {
    const dirty = stateWith([file('a', { dirty: true, undoStack: ['snap-1'] }), file('b')]);
    const before: AppState = {
      ...dirty,
      pageDirtyPaths: ['a'],
      pageUndoStack: [{ documents: [], dirtyPaths: ['a'] }],
    };
    const after = reorder(before, 'b', 0);
    expect(order(after)).toEqual(['b', 'a']);
    // A user who rearranged tabs has not touched a document; an undo here
    // would undo their last real edit instead.
    expect(after.pageUndoStack).toBe(before.pageUndoStack);
    expect(after.pageRedoStack).toBe(before.pageRedoStack);
    expect(after.pageDirtyPaths).toBe(before.pageDirtyPaths);
    expect(after.files.get('a')).toBe(before.files.get('a'));
    expect(after.files.get('a')?.undoStack).toEqual(['snap-1']);
    expect(after.files.get('b')?.dirty).toBe(false);
    // Which document is active is not a question about arrangement.
    expect(after.activeFileId).toBe(before.activeFileId);
    expect(after.ui).toBe(before.ui);
    expect(after.workspace).toBe(before.workspace);
  });
});

describe('OPEN_FILE at an index', () => {
  const open = (state: AppState, path: string, index?: number): AppState =>
    appReducer(state, {
      type: 'OPEN_FILE',
      path,
      workingPath: `${path}.working`,
      name: path,
      pageCount: 2,
      buffer: BUFFER,
      index,
    });

  it('appends when the open named no position', () => {
    expect(order(open(four(), 'e'))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('lands at the gap a dropped tab was released in', () => {
    // The receiving window measured the gap itself and painted a caret there;
    // the index is what makes the drop land where the caret promised.
    expect(order(open(four(), 'e', 0))).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(order(open(four(), 'e', 2))).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(order(open(four(), 'e', 4))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('clamps a position the strip no longer has', () => {
    // The tabs changed while the document was being opened. Clamping is what
    // makes an insert unable to fail.
    expect(order(open(four(), 'e', 40))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(order(open(four(), 'e', -3))).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  it('opens the document either way', () => {
    const opened = open(four(), 'e', 1);
    expect(opened.activeFileId).toBe('e');
    expect(opened.files.get('e')?.pageCount).toBe(2);
    expect(opened.files.size).toBe(5);
  });

  it('counts gaps in tab space when an import source is open', () => {
    const state = stateWith([file('a'), file('ghost', { importOnly: true }), file('b')]);
    expect(order(open(state, 'e', 1))).toEqual(['a', 'e', 'b']);
  });
});

describe('placeTabAt', () => {
  it('returns the same map when there is nothing to do', () => {
    const files = new Map([['a', file('a')]]);
    expect(placeTabAt(files, 'a', 0)).toBe(files);
    expect(placeTabAt(files, 'b', 0)).toBe(files);
  });

  it('truncates a fractional index rather than landing between gaps', () => {
    const files = new Map([
      ['a', file('a')],
      ['b', file('b')],
      ['c', file('c')],
    ]);
    expect([...placeTabAt(files, 'a', 1.9).keys()]).toEqual(['b', 'a', 'c']);
    // 0.5 is the gap the tab is already in, so it is not a move — and a
    // rebuilt map for a move that did not happen re-renders every consumer of
    // the file list.
    expect(placeTabAt(files, 'a', 0.9)).toBe(files);
  });
});
