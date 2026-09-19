// A commit plans only from documents indexed from their file's current
// buffer. Between a buffer change and its reindex the documents describe the
// previous bytes, and a plan read from them writes the wrong pages.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import {
  awaitSettledWorkspace,
  clearIndexFailure,
  needsIndex,
  pathDescribesCurrentBytes,
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

/** A page-tier commit landed: its documents are composed for the new buffer,
 * and the read-back of that buffer has not landed. */
function composed(): AppState {
  const s = superseded();
  const current = s.files.get('a.pdf')!;
  return { ...s, workspace: { documents: [{ ...indexed(current), provisional: true }] } };
}

const pending = async (p: Promise<void>): Promise<string> =>
  Promise.race([p.then(() => 'resolved', () => 'rejected'), new Promise<string>((r) => setTimeout(() => r('pending'), 10))]);

describe('workspaceSettled', () => {
  it('holds only while every document names its file’s current buffer', () => {
    expect(workspaceSettled(settled())).toBe(true);
    expect(workspaceSettled(superseded())).toBe(false);
    expect(workspaceSettled(initialState)).toBe(true);
  });

  it('waits for the read-back of documents a commit composed for its bytes', () => {
    expect(workspaceSettled(composed())).toBe(false);
  });
});

describe('needsIndex', () => {
  it('asks for an index of a path with no documents, superseded ones, or composed ones', () => {
    expect(needsIndex(settled(), 'a.pdf')).toBe(false);
    expect(needsIndex(superseded(), 'a.pdf')).toBe(true);
    expect(needsIndex(composed(), 'a.pdf')).toBe(true);
    expect(needsIndex(settled(), 'b.pdf')).toBe(true);
  });

  it('is what the workspace indexer asks (pinned as source text: the hook has no DOM test)', () => {
    const hook = readFileSync(resolve(__dirname, '../src/renderer/hooks/useWorkspaceIndexer.ts'), 'utf8');
    expect(hook).toContain('if (!needsIndex(indexed, path)) continue;');
  });
});

describe('the harness commit', () => {
  it('returns once the read-back of the committed bytes has landed', () => {
    const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
    expect(app).toMatch(
      /commitPendingEdits: async \(\) => \{\s*await commitRef\.current\(\);\s*await awaitSettledWorkspace\(readState, subscribeState\)\.catch\(\(\) => \{\}\);/,
    );
  });
});

describe('pathDescribesCurrentBytes', () => {
  it('holds for documents read from or composed for the current bytes', () => {
    expect(pathDescribesCurrentBytes(settled(), 'a.pdf')).toBe(true);
    expect(pathDescribesCurrentBytes(composed(), 'a.pdf')).toBe(true);
  });

  it('fails for superseded documents, a path with no documents, and a closed path', () => {
    expect(pathDescribesCurrentBytes(superseded(), 'a.pdf')).toBe(false);
    const s = settled();
    expect(pathDescribesCurrentBytes({ ...s, workspace: { documents: [] } }, 'a.pdf')).toBe(false);
    expect(pathDescribesCurrentBytes({ ...s, files: new Map() }, 'a.pdf')).toBe(false);
  });

  it('fails while one partition of the path is superseded', () => {
    const s = composed();
    const stale = { ...s.workspace.documents[0], id: 'a.pdf#1', buffer: [1] };
    expect(pathDescribesCurrentBytes({ ...s, workspace: { documents: [...s.workspace.documents, stale] } }, 'a.pdf')).toBe(false);
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

  it('refuses when the read-back of composed documents failed', async () => {
    const store = createAppStore(composed());
    const current = store.getState().files.get('a.pdf')!.buffer!;
    const wait = awaitSettledWorkspace(store.getState, store.subscribe);
    expect(await pending(wait)).toBe('pending');
    recordIndexFailure(current);
    await expect(wait).rejects.toThrow('The document or history changed. Try again.');
    clearIndexFailure(current);
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
