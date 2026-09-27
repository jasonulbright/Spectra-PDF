import { describe, expect, it } from 'vitest';
import { confirmDirtySnapshots, dirtyPromptSnapshots, sameDirtyPromptSnapshot, unconfirmedDirtySnapshots } from '../src/renderer/lib/dirty-prompt';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageRef, PdfBuffer } from '../src/renderer/state/types';

function file(path: string, buffer: PdfBuffer): OpenFile {
  return { path, workingPath: `${path}.w`, name: path, pageCount: 1, buffer, dirty: false, undoStack: [], redoStack: [] };
}

function page(path: string): PageRef {
  return { id: `${path}#p0`, sourceDocId: path, sourcePageIndex: 0, rotation: 0, width: 300, height: 400 };
}

function documentFor(source: OpenFile): OpenDocument {
  return { ...source, id: `${source.path}#0`, pages: [page(source.path)] };
}

describe('dirty prompt snapshots', () => {
  it('does not ask again for unchanged dirty state already covered by the answer', () => {
    const snapshot = { path: 'a.pdf', editRevision: 3, bufferRevision: new Uint8Array([1]) };

    expect(sameDirtyPromptSnapshot(snapshot, { ...snapshot })).toBe(true);
    expect(unconfirmedDirtySnapshots(new Map([['a.pdf', snapshot]]), [snapshot])).toEqual([]);
  });

  it('asks for a file that became dirty while an earlier prompt was open', () => {
    const prior = { path: 'a.pdf', editRevision: 1, bufferRevision: new Uint8Array([1]) };
    const newlyDirty = { path: 'b.pdf', editRevision: 1, bufferRevision: new Uint8Array([2]) };

    expect(unconfirmedDirtySnapshots(new Map([['a.pdf', prior]]), [prior, newlyDirty])).toEqual([
      newlyDirty,
    ]);
  });

  it('asks again when the same file receives edits while its prompt is open', () => {
    const prior = { path: 'a.pdf', editRevision: 3, bufferRevision: new Uint8Array([1]) };
    const edited = { ...prior, editRevision: 4 };

    expect(sameDirtyPromptSnapshot(prior, edited)).toBe(false);
    expect(unconfirmedDirtySnapshots(new Map([['a.pdf', prior]]), [edited])).toEqual([edited]);
  });

  it('prompts again for a second file that becomes dirty while the first prompt is open', async () => {
    const a = { path: 'a.pdf', editRevision: 1, bufferRevision: new Uint8Array([1]) };
    const b = { path: 'b.pdf', editRevision: 1, bufferRevision: new Uint8Array([2]) };
    let live = [a];
    const prompted: string[][] = [];

    await expect(confirmDirtySnapshots(
      () => live,
      async (pending) => {
        prompted.push(pending.map(({ path }) => path));
        if (prompted.length === 1) live = [a, b];
        return 'discard';
      },
      async () => true,
    )).resolves.toBe(true);

    expect(prompted).toEqual([['a.pdf'], ['b.pdf']]);
  });

  it('prompts again if a file is edited while its own prompt is open', async () => {
    const first = { path: 'a.pdf', editRevision: 1, bufferRevision: new Uint8Array([1]) };
    const edited = { ...first, editRevision: 2 };
    let live = [first];
    let prompts = 0;

    await expect(confirmDirtySnapshots(
      () => live,
      async () => {
        prompts += 1;
        if (prompts === 1) live = [edited];
        return 'discard';
      },
      async () => true,
    )).resolves.toBe(true);

    expect(prompts).toBe(2);
  });

  it('keeps a saved page revision stable across the indexer read-back', () => {
    const original = file('A.pdf', [1]);
    let state: AppState = {
      ...initialState,
      files: new Map([[original.path, original]]),
      workspace: { documents: [documentFor(original)] },
    };
    state = appReducer(state, { type: 'ROTATE_PAGE_REF', docId: 'A.pdf#0', pageId: 'A.pdf#p0', rotation: 90 });
    const before = dirtyPromptSnapshots(state, ['A.pdf']);
    const beforeReadBack = state.workspace.documents[0];
    const indexed = state.workspace.documents.map((document) => ({
      ...document,
      pages: document.pages.map((item) => ({ ...item })),
    }));

    state = appReducer(state, { type: 'SET_WORKSPACE_DOCUMENTS', path: 'A.pdf', documents: indexed });

    expect(state.workspace.documents[0]).not.toBe(beforeReadBack);
    expect(dirtyPromptSnapshots(state, ['A.pdf'])).toEqual(before);
  });

  it('advances the dirty revision when a new page edit lands after a save snapshot', () => {
    const original = file('A.pdf', [1]);
    let state: AppState = {
      ...initialState,
      files: new Map([[original.path, original]]),
      workspace: { documents: [documentFor(original)] },
    };
    state = appReducer(state, { type: 'ROTATE_PAGE_REF', docId: 'A.pdf#0', pageId: 'A.pdf#p0', rotation: 90 });
    const before = dirtyPromptSnapshots(state, ['A.pdf'])[0];
    state = appReducer(state, { type: 'ROTATE_PAGE_REF', docId: 'A.pdf#0', pageId: 'A.pdf#p0', rotation: 180 });
    const after = dirtyPromptSnapshots(state, ['A.pdf'])[0];
    state = appReducer(state, { type: 'UNDO_PAGE_OP' });
    const afterUndo = dirtyPromptSnapshots(state, ['A.pdf'])[0];

    expect(after.editRevision).toBeGreaterThan(before.editRevision);
    expect(sameDirtyPromptSnapshot(before, after)).toBe(false);
    expect(afterUndo.editRevision).toBeGreaterThan(after.editRevision);
    expect(sameDirtyPromptSnapshot(after, afterUndo)).toBe(false);
  });
});
