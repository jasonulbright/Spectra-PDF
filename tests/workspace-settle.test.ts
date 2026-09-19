// A commit plans only from documents indexed from their file's current
// buffer. Between a buffer change and its reindex the documents describe the
// previous bytes, and a plan read from them writes the wrong pages.
import { describe, expect, it } from 'vitest';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import {
  awaitSettledWorkspace,
  clearIndexFailure,
  recordIndexFailure,
  workspaceSettled,
} from '../src/renderer/lib/workspace-settle';
import type { AppState, OpenDocument, OpenFile } from '../src/renderer/state/types';

function file(path: string, buffer: number[]): OpenFile {
  return {
    path, workingPath: `${path}.w`, name: path, pageCount: 1, buffer,
    dirty: false, undoStack: [], redoStack: [],
  };
}

function indexed(f: OpenFile): OpenDocument {
  return {
    ...f, id: `${f.path}#0`, pageCount: 1,
    pages: [{ id: `${f.path}#p0`, sourceDocId: f.path, sourcePageIndex: 0, rotation: 0, width: 1, height: 1 }],
  };
}

function settled(): AppState {
  const a = file('a.pdf', [1]);
  return { ...initialState, files: new Map([['a.pdf', a]]), workspace: { documents: [indexed(a)] } };
}

/** The file's buffer replaced (a commit landed); its reindex has not. */
function superseded(): AppState {
  const s = settled();
  return { ...s, files: new Map(s.files).set('a.pdf', { ...s.files.get('a.pdf')!, buffer: [2] }) };
}

const pending = async (p: Promise<void>): Promise<string> =>
  Promise.race([p.then(() => 'resolved', () => 'rejected'), new Promise<string>((r) => setTimeout(() => r('pending'), 10))]);

describe('workspaceSettled', () => {
  it('holds only while every document names its file’s current buffer', () => {
    expect(workspaceSettled(settled())).toBe(true);
    expect(workspaceSettled(superseded())).toBe(false);
    expect(workspaceSettled(initialState)).toBe(true);
  });
});

describe('awaitSettledWorkspace', () => {
  it('resolves at once on a settled workspace', async () => {
    const store = createAppStore(settled());
    expect(await pending(awaitSettledWorkspace(store.getState, store.subscribe))).toBe('resolved');
  });

  it('waits for the reindex of the current buffer to land', async () => {
    const store = createAppStore(superseded());
    const wait = awaitSettledWorkspace(store.getState, store.subscribe);
    expect(await pending(wait)).toBe('pending');
    const current = store.getState().files.get('a.pdf')!;
    store.dispatch({ type: 'SET_WORKSPACE_DOCUMENTS', path: 'a.pdf', documents: [indexed(current)] });
    expect(await pending(wait)).toBe('resolved');
  });

  it('refuses instead of waiting forever when the index of the awaited buffer failed', async () => {
    const store = createAppStore(superseded());
    const current = store.getState().files.get('a.pdf')!.buffer!;
    const wait = awaitSettledWorkspace(store.getState, store.subscribe);
    expect(await pending(wait)).toBe('pending');
    recordIndexFailure(current);
    await expect(wait).rejects.toThrow('The document or history changed. Try again.');
    // A retried index clears the mark, and the next wait waits for it.
    clearIndexFailure(current);
    expect(await pending(awaitSettledWorkspace(store.getState, store.subscribe))).toBe('pending');
  });

  it('ignores a failed index of a buffer nothing waits on', async () => {
    const store = createAppStore(superseded());
    // The superseded documents' own buffer: nothing indexes it any more.
    recordIndexFailure(store.getState().workspace.documents[0].buffer!);
    const wait = awaitSettledWorkspace(store.getState, store.subscribe);
    expect(await pending(wait)).toBe('pending');
    const current = store.getState().files.get('a.pdf')!;
    store.dispatch({ type: 'SET_WORKSPACE_DOCUMENTS', path: 'a.pdf', documents: [indexed(current)] });
    expect(await pending(wait)).toBe('resolved');
  });
});
