// An operation, a disk undo or redo, and every other publication of new bytes
// place the documents those bytes hold in the same reducer step. Documents of
// the previous bytes, drawn over the new ones, show other pages; anything
// drawn on them is bound to ids the next reindex replaces, and disappears
// without a word. Real bytes, real pdf.js: the documents are read from the
// published file.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AppAction, AppState, OpenFile, PdfBuffer } from '../src/renderer/state/types';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({ loadDocument: vi.fn() }));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import { readPublishedBytes } from '../src/renderer/lib/workspace';
import { needsIndex, workspaceSettled, drawingTarget } from '../src/renderer/lib/workspace-settle';
import { buildRedactionRegions, type RedactionMark } from '../src/renderer/lib/redaction';
import { executeWorkspaceOperation, type OperationIo } from '../src/renderer/lib/operation-transaction';
import { restoreHistory, type HistoryIo } from '../src/renderer/lib/disk-history';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const PATH = 'a.pdf';
const HEIGHT = 400;
const loadDocumentMock = vi.mocked(loadDocument);
const loaded: PDFDocumentProxy[] = [];

function toBytes(buffer: PdfBuffer): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
}

/** Pages told apart by their width. */
async function pdf(widths: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const width of widths) doc.addPage([width, HEIGHT]);
  return doc.save();
}

beforeEach(() => {
  loadDocumentMock.mockReset();
  loadDocumentMock.mockImplementation(async (buffer: PdfBuffer) => {
    const proxy = (await pdfjs.getDocument({ data: toBytes(buffer).slice() }).promise) as PDFDocumentProxy;
    vi.spyOn(proxy.loadingTask, 'destroy');
    loaded.push(proxy);
    return proxy;
  });
});

afterEach(async () => {
  await Promise.all(loaded.splice(0).map((p) => p.loadingTask.destroy().catch(() => {})));
});

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The file `bytes` open as `a.pdf`, its documents read from those bytes. */
async function opened(bytes: Uint8Array): Promise<{ state: AppState; file: OpenFile }> {
  const file: OpenFile = {
    path: PATH, workingPath: 'work', name: PATH, pageCount: 0, buffer: bytes,
    dirty: false, undoStack: [], redoStack: [],
  };
  const read = await readPublishedBytes(file, bytes);
  const withCount = { ...file, pageCount: read.pageCount };
  return {
    file: withCount,
    state: {
      ...initialState,
      activeFileId: PATH,
      files: new Map([[PATH, withCount]]),
      workspace: { documents: read.documents },
    },
  };
}

/** What the workspace indexer does on its next pass. */
async function settle(store: ReturnType<typeof createAppStore>): Promise<void> {
  const state = store.getState();
  const file = state.files.get(PATH)!;
  if (!needsIndex(state, PATH)) return;
  const { documents } = await readPublishedBytes(file, file.buffer!);
  store.dispatch({ type: 'SET_WORKSPACE_DOCUMENTS', path: PATH, documents });
}

const pagesOf = (state: AppState) => state.workspace.documents.flatMap((d) => d.pages);

/** The widths the workspace shows, read from the file's current bytes. */
async function shownWidths(state: AppState): Promise<number[]> {
  const doc = (await pdfjs.getDocument({ data: toBytes(state.files.get(PATH)!.buffer!).slice() }).promise) as PDFDocumentProxy;
  try {
    const widths: number[] = [];
    for (const page of pagesOf(state)) {
      const p = await doc.getPage(page.sourcePageIndex + 1);
      widths.push(p.view[2] - p.view[0]);
    }
    return widths;
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** A mark drawn on the page with id `pageId`, as the canvas draws it. */
function markOn(state: AppState, pageId: string): RedactionMark {
  const page = pagesOf(state).find((p) => p.id === pageId)!;
  return { id: `mark-${pageId}`, path: PATH, pageId, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, rotationAtDraw: page.rotation };
}

/** Where `mark` redacts: the page number of the file and the width of that page. */
async function redacted(state: AppState, mark: RedactionMark): Promise<{ page: number; width: number }[]> {
  const doc = (await pdfjs.getDocument({ data: toBytes(state.files.get(PATH)!.buffer!).slice() }).promise) as PDFDocumentProxy;
  try {
    const { files } = await buildRedactionRegions(state.workspace.documents, [mark], async (page) => {
      const p = await doc.getPage(page.sourcePageIndex + 1);
      const [x0, y0, x1, y1] = p.view;
      return { box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, bakedRotate: p.rotate };
    });
    const out: { page: number; width: number }[] = [];
    for (const region of files.flatMap((f) => f.regions)) {
      const p = await doc.getPage(region.page);
      out.push({ page: region.page, width: p.view[2] - p.view[0] });
    }
    return out;
  } finally {
    await doc.loadingTask.destroy();
  }
}

describe('readPublishedBytes', () => {
  it('reads the page count and the documents of the bytes, under new ids, through a document of its own', async () => {
    const before = await opened(await pdf([100, 150, 200]));
    const next = await pdf([150, 200]);
    const read = await readPublishedBytes(before.file, next);
    expect(read.pageCount).toBe(2);
    expect(read.documents).toHaveLength(1);
    const [doc] = read.documents;
    expect(doc.buffer).toBe(next);
    expect(doc.path).toBe(PATH);
    expect(doc.provisional).toBeUndefined();
    expect(doc.pages.map((p) => [p.sourceDocId, p.sourcePageIndex, p.width])).toEqual([
      [PATH, 0, 150],
      [PATH, 1, 200],
    ]);
    const previous = new Set(pagesOf(before.state).map((p) => p.id));
    expect(doc.pages.some((p) => previous.has(p.id))).toBe(false);
    expect(loaded.at(-1)!.loadingTask.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses bytes whose pages pdf.js cannot read, and still destroys its document', async () => {
    const { file } = await opened(await pdf([100]));
    const bytes = await pdf([100, 150]);
    loadDocumentMock.mockImplementationOnce(async (buffer: PdfBuffer) => {
      const proxy = (await pdfjs.getDocument({ data: toBytes(buffer).slice() }).promise) as PDFDocumentProxy;
      vi.spyOn(proxy.loadingTask, 'destroy');
      loaded.push(proxy);
      proxy.getPage = () => Promise.reject(new Error('unreadable page'));
      return proxy;
    });
    await expect(readPublishedBytes(file, bytes)).rejects.toThrow('unreadable page');
    expect(loaded.at(-1)!.loadingTask.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses bytes pdf.js cannot load', async () => {
    const { file } = await opened(await pdf([100]));
    loadDocumentMock.mockRejectedValueOnce(new Error('Invalid PDF structure'));
    await expect(readPublishedBytes(file, new Uint8Array([1, 2, 3]))).rejects.toThrow('Invalid PDF structure');
  });
});

/** An operation that deletes the first page, published through the real
 * transaction against an in-memory disk. */
async function operation(start: { state: AppState; file: OpenFile }) {
  const store = createAppStore(start.state);
  const disk = new Map<string, Uint8Array>([['work', toBytes(start.file.buffer!).slice()]]);
  const actions: AppAction[] = [];
  const io: OperationIo = {
    confirm: async () => true,
    commit: async () => {},
    read: async (path) => disk.get(path)!.slice(),
    write: async (path, bytes) => { disk.set(path, bytes.slice()); },
    remove: async (path) => { disk.delete(path); },
    index: readPublishedBytes,
    track: async (_method, _params, run) => run(),
    callStaged: async (_method, params) => {
      const doc = await PDFDocument.load(disk.get(params.file as string)!);
      doc.removePage(0);
      disk.set(params.output as string, await doc.save());
      return { output: params.output };
    },
    transaction: {
      publish: async (id, [entry]) => {
        expect(hash(disk.get('work')!)).toBe(entry.expectedWorkingSha256);
        disk.set(`backup-${id}`, disk.get('work')!.slice());
        disk.set('work', disk.get(entry.stagedPath)!.slice());
        return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
      },
      abort: async () => ({ status: 'rolledBack', snapshots: [], detail: '' }),
      acknowledge: async () => {},
    },
  };
  const dispatch = (action: AppAction) => { actions.push(action); store.dispatch(action); };
  await executeWorkspaceOperation(PATH, 'delete', { pages: [1] }, store.getState, dispatch, io);
  return { store, disk, actions };
}

describe('an operation', () => {
  it('places the documents of its bytes in the step that places the bytes', async () => {
    const start = await opened(await pdf([100, 150, 200]));
    const { store, actions } = await operation(start);
    expect(actions.map((a) => a.type)).toEqual(['UPDATE_FILE']);
    const state = store.getState();
    expect(await shownWidths(state)).toEqual([150, 200]);
    expect(state.workspace.documents.every((d) => d.buffer === state.files.get(PATH)!.buffer)).toBe(true);
    expect(workspaceSettled(state)).toBe(true);
    expect(needsIndex(state, PATH)).toBe(false);
  });

  it('keeps a redaction mark drawn right after it on the page it was drawn on', async () => {
    const start = await opened(await pdf([100, 150, 200]));
    const { store } = await operation(start);
    const drawnOn = pagesOf(store.getState())[1];
    const mark = markOn(store.getState(), drawnOn.id);
    expect(await redacted(store.getState(), mark)).toEqual([{ page: 2, width: 200 }]);
    await settle(store);
    expect(pagesOf(store.getState()).map((p) => p.id)).toContain(drawnOn.id);
    expect(await redacted(store.getState(), mark)).toEqual([{ page: 2, width: 200 }]);
  });

  it('refuses, with a notice, an edit that began on the documents it replaced', async () => {
    const start = await opened(await pdf([100, 150, 200]));
    const before = pagesOf(start.state)[1];
    const docId = start.state.workspace.documents[0].id;
    const { store } = await operation(start);
    const replaced = store.getState();
    store.dispatch({
      type: 'ADD_ANNOTATION', docId, pageId: before.id,
      annotation: { id: 'n1', kind: 'note', x: 0.1, y: 0.1, w: 0.05, h: 0.05, color: '#ffd54a', note: 'n' },
    });
    const after = store.getState();
    expect(after.workspace).toBe(replaced.workspace);
    expect(after.pageUndoStack).toEqual([]);
    expect(after.pageEditRefusals).toBe(replaced.pageEditRefusals + 1);
  });
});

describe('a disk undo and redo', () => {
  async function history() {
    const three = await pdf([100, 150, 200]);
    const two = await pdf([150, 200]);
    const start = await opened(two);
    const file = { ...start.file, undoStack: ['s1'], dirty: true };
    const store = createAppStore({ ...start.state, files: new Map([[PATH, file]]) });
    const disk = new Map<string, Uint8Array>([['work', two.slice()], ['s1', three.slice()]]);
    const io: HistoryIo = {
      read: async (path) => disk.get(path)!.slice(),
      write: async (path, bytes) => { disk.set(path, bytes.slice()); },
      remove: async (path) => { disk.delete(path); },
      index: readPublishedBytes,
      transaction: {
        publish: async (id, [entry]) => {
          disk.set(`backup-${id}`, disk.get(entry.workingPath)!.slice());
          disk.set(entry.workingPath, disk.get(entry.stagedPath)!.slice());
          return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
        },
        abort: async () => ({ status: 'rolledBack', snapshots: [], detail: '' }),
        acknowledge: async () => {},
      },
    };
    return { store, io };
  }

  it('place the documents of the restored bytes in the step that restores them', async () => {
    const { store, io } = await history();
    await restoreHistory('undo', store.getState, store.dispatch, io);
    const undone = store.getState();
    expect(await shownWidths(undone)).toEqual([100, 150, 200]);
    expect(needsIndex(undone, PATH)).toBe(false);
    await restoreHistory('redo', store.getState, store.dispatch, io);
    const redone = store.getState();
    expect(await shownWidths(redone)).toEqual([150, 200]);
    expect(needsIndex(redone, PATH)).toBe(false);
  });

  it('keep a redaction mark drawn right after an undo on the page it was drawn on', async () => {
    const { store, io } = await history();
    await restoreHistory('undo', store.getState, store.dispatch, io);
    const drawnOn = pagesOf(store.getState())[0];
    const mark = markOn(store.getState(), drawnOn.id);
    await settle(store);
    expect(await redacted(store.getState(), mark)).toEqual([{ page: 1, width: 100 }]);
  });
});

describe('a drawing that ends on the page its render showed', () => {
  it('lands only while the page is still there, over the same bytes, turned the same way', async () => {
    const start = await opened(await pdf([100, 150]));
    const [doc] = start.state.workspace.documents;
    const page = doc.pages[0];
    const seen = { docId: doc.id, pageId: page.id, buffer: doc.buffer, rotation: page.rotation };
    expect(drawingTarget(start.state, seen)).toEqual({ doc, page });
    // The render showed other bytes than the document holds now.
    expect(drawingTarget(start.state, { ...seen, buffer: new Uint8Array([1]) })).toBeNull();
    // The page was turned while the gesture ran.
    expect(drawingTarget(start.state, { ...seen, rotation: 90 })).toBeNull();
    // The document or the page is gone.
    expect(drawingTarget(start.state, { ...seen, docId: 'gone' })).toBeNull();
    expect(drawingTarget(start.state, { ...seen, pageId: 'gone' })).toBeNull();
    // The document no longer describes its file's bytes.
    const files = new Map(start.state.files).set(PATH, { ...start.file, buffer: new Uint8Array([2]) });
    expect(drawingTarget({ ...start.state, files }, seen)).toBeNull();
  });
});
