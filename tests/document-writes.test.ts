import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginDocumentWrite, whileDocumentLeaves, __documentWriteCount } from '../src/renderer/lib/document-writes';
import { createPageLabelDrafts, previewLabel, type LabelRange } from '../src/renderer/lib/page-label-drafts';
import { createOwnedOperationRuns } from '../src/renderer/lib/owned-operation-run';
import { writeRedactionMarks } from '../src/renderer/lib/redaction-write';
import { restoreHistory, type HistoryIo } from '../src/renderer/lib/disk-history';
import { serializeWorkspacePublication } from '../src/renderer/lib/workspace-publication';
import { runCommitGate, setCommitGate } from '../src/renderer/lib/commit-gate';
import { isTrackableMethod } from '../src/renderer/hooks/useOperationQueue';
import { initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState, OpenDocument, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';

// A gesture that writes a document is recorded from its first line; a move
// of the document waits until no gesture of it is recorded. Each flow class
// below awaits something (a gate, a probe, the lane) before its write starts;
// the move is asked for during that await and must leave only after the
// write.

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
/** One macrotask: every microtask a runnable waiter needs has run. */
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function workspace() {
  const a: OpenFile = { path: 'A', workingPath: 'work-A', buffer: new Uint8Array([1]), pageCount: 3, name: 'A',
    dirty: false, undoStack: [], redoStack: [] };
  let state: AppState = { ...initialState, pageDirtyPaths: [], files: new Map([['A', a]]), activeFileId: 'A',
    workspace: { documents: [{ ...a, id: 'doc-A', pages: [0, 1, 2].map(i => ({ id: `id-${i}`, sourceDocId: 'A',
      sourcePageIndex: i, rotation: 0, width: 1, height: 1 })) } as OpenDocument] } };
  const events: string[] = [];
  const read = () => state;
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
  // The write itself, as the rewrite records it at its entry.
  const operation = vi.fn<PerformOperation>(async (path) => {
    const ended = beginDocumentWrite(`work-${path}`);
    try {
      events.push('write');
      const publication = { ...state.files.get(path)!, buffer: new Uint8Array([8]) };
      change({ files: new Map(state.files).set(path, publication) });
      return { output: publication.workingPath, publication } as WorkspaceOperationResult;
    } finally { ended(); }
  });
  const leave = () => whileDocumentLeaves('work-A', async () => { events.push('left'); });
  return { a, read, change, events, operation, leave };
}

afterEach(() => setCommitGate(null));

describe('a move waits for every write gesture asked for before it', () => {
  it('a draft apply waiting at its own gate', async () => {
    const w = workspace();
    const drafts = createPageLabelDrafts(w.read);
    const d = drafts.get(w.a)!;
    const rows = (prefix: string): LabelRange[] => [{ start: 1, style: 'D', prefix, startAt: 5 }];
    await drafts.load(d, async () => ({ complete: true, count: 1,
      ranges: [{ start: 0, style: 'D', prefix: 'Old', start_at: 5 }],
      labels: [1, 2, 3].map(i => previewLabel(rows('Old'), i)) }));
    drafts.change(d, d.buffer, () => rows('New'));
    const gate = deferred();
    const applied = drafts.apply(d, w.operation, async () => ({ complete: true, count: 1,
      ranges: [{ start: 0, style: 'D', prefix: 'Old', start_at: 5 }],
      labels: [1, 2, 3].map(i => previewLabel(rows('Old'), i)) }) as never, () => gate.promise);
    const left = w.leave();
    await turn();
    expect(w.events).toEqual([]);
    gate.resolve();
    await Promise.all([applied, left]);
    expect(w.events).toEqual(['write', 'left']);
    expect(d.error).toBe('');
    expect(__documentWriteCount()).toBe(0);
  });

  it('an owned panel run waiting before its write', async () => {
    const w = workspace();
    const runs = createOwnedOperationRuns(w.read);
    const run = runs.begin(w.a)!;
    const gate = deferred();
    const performed = (async () => {
      await gate.promise;
      try { await run.perform(w.operation, 'rotate', {}); } finally { run.finish(); }
    })();
    const left = w.leave();
    await turn();
    expect(w.events).toEqual([]);
    gate.resolve();
    await Promise.all([performed, left]);
    expect(w.events).toEqual(['write', 'left']);
  });

  it('a redaction waiting for its Ghostscript probe', async () => {
    const w = workspace();
    const probe = deferred<string>();
    const redacted = writeRedactionMarks('A', [], w.read(), 'redact', w.read, w.operation,
      async () => { throw new Error('no geometry needed'); }, () => probe.promise);
    const left = w.leave();
    await turn();
    expect(w.events).toEqual([]);
    probe.resolve('gs');
    await Promise.all([redacted, left]);
    expect(w.events).toEqual(['write', 'left']);
  });

  it('an undo queued behind the publication lane', async () => {
    const w = workspace();
    w.change({ pageUndoStack: [{ documents: w.read().workspace.documents, dirtyPaths: [], action: { type: 'NOOP' } } as never] });
    let releaseLane!: () => void;
    const blocker = serializeWorkspacePublication(() => new Promise<void>(r => { releaseLane = r; }));
    const dispatch = (action: AppAction) => { w.events.push(action.type); };
    const undone = restoreHistory('undo', w.read, dispatch, {} as HistoryIo);
    const left = w.leave();
    await turn();
    expect(w.events).toEqual([]);
    releaseLane();
    await Promise.all([blocker, undone, left]);
    expect(w.events).toEqual(['UNDO_PAGE_OP', 'left']);
  });

  it('the App handlers that await before their write record it from their first line', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    for (const name of ['offerRedactionResidue', 'handleWidgetAction', 'handleSanitizeDocument', 'handleEditText',
      'handleEditParagraph', 'handleMergeParagraph', 'handleAddText', 'handleEditVector', 'handleEditImage', 'handleEditImagesGroup']) {
      const start = app.indexOf(`const ${name} = useCallback(`);
      expect(start).toBeGreaterThan(-1);
      expect(app.slice(start, start + 2000)).toMatch(/=> writeGesture\(path, async \(\)/);
    }
  });
});

describe('a gesture asked for while the document leaves', () => {
  it('is admitted while a recorded gesture still runs, and the move waits for it too', async () => {
    const w = workspace();
    const ended = beginDocumentWrite('work-A');
    const left = w.leave();
    // Continues the recorded gesture: admitted, and waited for.
    const inner = beginDocumentWrite('work-A');
    ended();
    await turn();
    expect(w.events).toEqual([]);
    w.events.push('inner done');
    inner();
    await left;
    expect(w.events).toEqual(['inner done', 'left']);
  });

  it('refuses at its start once nothing is recorded, and cancels the move', async () => {
    const steps = deferred();
    let cancelledAtEnd: boolean | null = null;
    const left = whileDocumentLeaves('work-A', async (cancelled) => {
      await steps.promise;
      cancelledAtEnd = cancelled();
    });
    await turn();
    expect(() => beginDocumentWrite('work-A')).toThrow(/moved to another window/);
    steps.resolve();
    await left;
    expect(cancelledAtEnd).toBe(true);
    // Once the move is over, writes are accepted again.
    beginDocumentWrite('work-A')();
    expect(__documentWriteCount()).toBe(0);
  });
});

describe('a save asked for after an undo', () => {
  it('waits for the undo queued before it on the document', async () => {
    const w = workspace();
    w.change({ pageUndoStack: [{ documents: w.read().workspace.documents, dirtyPaths: [], action: { type: 'NOOP' } } as never] });
    let releaseLane!: () => void;
    const blocker = serializeWorkspacePublication(() => new Promise<void>(r => { releaseLane = r; }));
    const dispatch = (action: AppAction) => { w.events.push(action.type); };
    const undone = restoreHistory('undo', w.read, dispatch, {} as HistoryIo);
    const saved = runCommitGate(['work-A']).then(() => { w.events.push('save'); });
    await turn();
    expect(w.events).toEqual([]);
    releaseLane();
    await Promise.all([blocker, undone, saved]);
    expect(w.events).toEqual(['UNDO_PAGE_OP', 'save']);
  });
});

describe('methods that run while a write chain is held', () => {
  it('stay internal: a gated call naming the working copy would wait for a disk undo that waits for that chain', () => {
    // io.confirm reads the signature policy, and a save reseals and reattaches
    // a certificate-opened copy, each while the copy's write chain is held.
    for (const method of ['signature_policy', 'pubkey_reseal', 'pubkey_reattach']) {
      expect(isTrackableMethod(method)).toBe(false);
    }
  });
});

describe('a gesture refused because its document is moving says so', () => {
  const moving = /moved to another window/;

  it('a draft apply shows the move refusal in its panel and keeps the document here', async () => {
    const w = workspace();
    const drafts = createPageLabelDrafts(w.read);
    const d = drafts.get(w.a)!;
    const rows = (prefix: string): LabelRange[] => [{ start: 1, style: 'D', prefix, startAt: 5 }];
    const reply = async () => ({ complete: true, count: 1, ranges: [{ start: 0, style: 'D', prefix: 'Old', start_at: 5 }],
      labels: [1, 2, 3].map(i => previewLabel(rows('Old'), i)) }) as never;
    await drafts.load(d, reply);
    drafts.change(d, d.buffer, () => rows('New'));
    let stays: boolean | null = null;
    await whileDocumentLeaves('work-A', async (cancelled) => {
      await drafts.apply(d, w.operation, reply, async () => {});
      stays = cancelled();
    });
    expect(d.error).toMatch(moving);
    expect(w.events).toEqual([]);
    expect(stays).toBe(true);
  });

  it('an owned panel run does not begin and keeps the document here; the move reports it', async () => {
    const w = workspace();
    const runs = createOwnedOperationRuns(w.read);
    let stays: boolean | null = null;
    await whileDocumentLeaves('work-A', async (cancelled) => {
      expect(runs.begin(w.a)).toBeNull();
      stays = cancelled();
    });
    expect(stays).toBe(true);
    // The panel shows nothing for a run that did not begin: the move says why.
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const handOff = app.slice(app.indexOf('const handOffDocument = useCallback('), app.indexOf('const handleMoveToNewWindow'));
    expect(handOff).toContain("tChrome(moved ? 'app.window.moveRefusedAction' : 'app.window.moveCancelled')");
    expect(handOff).toMatch(/finally \{\s*refused = cancelled\(\);/);
  });

  it('an undo pressed during the move fails with the move refusal', async () => {
    const w = workspace();
    await whileDocumentLeaves('work-A', async () => {
      await expect(restoreHistory('undo', w.read, () => {}, {} as HistoryIo)).rejects.toThrow(moving);
    });
  });

});

describe('an undo of a document that became active after the key press', () => {
  it('records the document it restores, so a move of that document waits for it', async () => {
    const w = workspace();
    const b: OpenFile = { ...w.a, path: 'B', workingPath: 'work-B', buffer: new Uint8Array([2]) };
    w.change({ files: new Map([['A', w.a], ['B', b]]) });
    let releaseLane!: () => void;
    const blocker = serializeWorkspacePublication(() => new Promise<void>(r => { releaseLane = r; }));
    const reading = deferred();
    const io: HistoryIo = {
      read: async () => { w.events.push('restore B'); await reading.promise; w.events.push('restored B'); throw new Error('stop here'); },
      write: async () => {}, remove: async () => {},
      index: async () => ({ pageCount: 1, documents: [] }),
      transaction: { publish: async () => ({}), abort: async () => ({}), acknowledge: async () => {} },
    };
    w.change({ files: new Map([['A', w.a], ['B', { ...b, undoStack: ['snap'] }]]) });
    const undone = restoreHistory('undo', w.read, () => {}, io).catch(() => {});
    // The user switches to B before the undo's turn.
    w.change({ activeFileId: 'B' });
    let leftB = false;
    await turn();
    releaseLane();
    await blocker;
    // The undo's turn has run once both documents are recorded.
    for (let i = 0; i < 50 && __documentWriteCount() < 2; i++) await turn();
    expect(__documentWriteCount()).toBe(2);
    const left = whileDocumentLeaves('work-B', async () => { leftB = true; w.events.push('left B'); });
    await turn();
    expect(leftB).toBe(false);
    reading.resolve();
    await Promise.all([undone, left]);
    expect(w.events).toEqual(['restore B', 'restored B', 'left B']);
  });
});
