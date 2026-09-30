import { describe, expect, it } from 'vitest';
import { confirmDirtySnapshots, dirtyPromptSnapshots, sameDirtyPromptSnapshot, saveKeepingLaterEdits, saveListedFiles, unconfirmedDirtySnapshots } from '../src/renderer/lib/dirty-prompt';
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

describe('saving in place keeps edits made during the write', () => {
  const dirtyState = (editRevision: number): AppState => ({
    ...initialState,
    files: new Map([['a.pdf', { ...file('a.pdf', new Uint8Array([1]) as unknown as PdfBuffer), dirty: true, editRevision }]]),
  });

  it('marks saved when nothing changed during the write', async () => {
    const state = dirtyState(1);
    expect(await saveKeepingLaterEdits(() => state, 'a.pdf', async () => true)).toEqual({ written: true, markSaved: true });
  });

  it('does not mark saved when an edit landed while writing', async () => {
    let state = dirtyState(1);
    const result = await saveKeepingLaterEdits(() => state, 'a.pdf', async () => {
      state = dirtyState(2);
      return true;
    });
    expect(result).toEqual({ written: true, markSaved: false });
  });

  it('marks nothing when the write is refused', async () => {
    const state = dirtyState(1);
    expect(await saveKeepingLaterEdits(() => state, 'a.pdf', async () => false)).toEqual({ written: false, markSaved: false });
  });
});

describe('saving a list of files', () => {
  const fixed: AppState = {
    ...initialState,
    files: new Map(['a.pdf', 'web.pdf', 'b.pdf'].map((p) => [p, { ...file(p, new Uint8Array([1]) as unknown as PdfBuffer), dirty: true, editRevision: 1 }])),
  };
  const state = (): AppState => fixed;

  function recorder(saveAsAnswer: boolean) {
    const log: string[] = [];
    return {
      log,
      io: {
        route: (path: string) => (path === 'gone.pdf' ? null : path === 'web.pdf' ? 'saveAs' as const : 'save' as const),
        write: async (path: string) => { log.push(`write ${path}`); return true; },
        saveAs: async (path: string) => { log.push(`saveAs ${path}`); return saveAsAnswer; },
        markSaved: (path: string) => { log.push(`saved ${path}`); },
      },
    };
  }

  it('asks Save As for a downloaded document that is not the active one', async () => {
    const { log, io } = recorder(true);
    expect(await saveListedFiles(state, ['a.pdf', 'gone.pdf', 'web.pdf', 'b.pdf'], io)).toBe(true);
    expect(log).toEqual(['write a.pdf', 'saved a.pdf', 'saveAs web.pdf', 'write b.pdf', 'saved b.pdf']);
  });

  it('stops at a cancelled Save As and leaves the rest unsaved', async () => {
    const { log, io } = recorder(false);
    expect(await saveListedFiles(state, ['a.pdf', 'web.pdf', 'b.pdf'], io)).toBe(false);
    expect(log).toEqual(['write a.pdf', 'saved a.pdf', 'saveAs web.pdf']);
  });
});
