// pdf.js can load bytes and then fail on a page. The engine opens such a
// file, so it keeps its tab, its page count and every panel the engine
// serves, and the canvas says in place that its pages could not be displayed:
// the same answer as for bytes pdf.js does not load at all. A publication of
// such bytes refuses instead: it would replace a document that showed.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFNumber } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AppState, OpenDocument, OpenFile, PdfBuffer } from '../src/renderer/state/types';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({ loadDocument: vi.fn() }));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import { evictExcept } from '../src/renderer/lib/pdfDocCache';
import { indexOpenFile, readPublishedBytes } from '../src/renderer/lib/workspace';
import {
  clearIndexFailure,
  indexVerdicts,
  pagesUnreadable,
  recordIndexFailure,
  recordIndexSuccess,
  subscribeIndexVerdicts,
} from '../src/renderer/lib/workspace-settle';
import { initialState } from '../src/renderer/state/reducer';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const loadDocumentMock = vi.mocked(loadDocument);
const loaded: PDFDocumentProxy[] = [];

function toBytes(buffer: PdfBuffer): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
}

beforeEach(() => {
  loadDocumentMock.mockReset();
  loadDocumentMock.mockImplementation(async (buffer: PdfBuffer) => {
    const proxy = (await pdfjs.getDocument({ data: toBytes(buffer).slice() }).promise) as PDFDocumentProxy;
    loaded.push(proxy);
    return proxy;
  });
});

afterEach(async () => {
  evictExcept(new Set());
  await Promise.all(loaded.splice(0).map((p) => p.loadingTask.destroy().catch(() => {})));
});

/** Two pages, the first of which the page tree names by a number: pdf.js
 * loads the file and cannot read that page. */
async function unreadable(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.addPage([300, 400]);
  doc.catalog.Pages().Kids().set(0, doc.context.register(PDFNumber.of(7)));
  return doc.save({ useObjectStreams: false });
}

function file(buffer: PdfBuffer): OpenFile {
  return {
    path: 'broken.pdf', workingPath: 'broken.pdf.w', name: 'broken.pdf', pageCount: 2, buffer,
    dirty: false, undoStack: [], redoStack: [],
  };
}

function opened(f: OpenFile, documents: OpenDocument[] = []): AppState {
  return { ...initialState, files: new Map([[f.path, f]]), workspace: { documents } };
}

describe('bytes pdf.js loads and cannot read a page of', () => {
  it('fail the open’s index, and a publication refuses them', async () => {
    const bytes = await unreadable();
    const proxy = (await pdfjs.getDocument({ data: bytes.slice() }).promise) as PDFDocumentProxy;
    loaded.push(proxy);
    expect(proxy.numPages).toBeGreaterThan(0);
    await expect(proxy.getPage(1)).rejects.toThrow();
    await expect(indexOpenFile(file(bytes))).rejects.toThrow();
    await expect(readPublishedBytes(file(bytes), bytes)).rejects.toThrow();
  });

  it('show as unreadable once their index failed, and through a retry of it', async () => {
    const bytes = await unreadable();
    const f = file(bytes);
    const error = await indexOpenFile(f).catch((e: unknown) => e);
    const heard: number[] = [];
    const stop = subscribeIndexVerdicts(() => heard.push(1));
    try {
      expect(pagesUnreadable(opened(f), f, indexVerdicts())).toBe(false);
      const before = indexVerdicts();
      recordIndexFailure(bytes, error);
      expect(indexVerdicts()).not.toBe(before);
      expect(heard.length).toBe(1);
      expect(pagesUnreadable(opened(f), f, indexVerdicts())).toBe(true);
      // The retry the indexer starts on its next pass keeps the notice.
      clearIndexFailure(bytes);
      expect(pagesUnreadable(opened(f), f, indexVerdicts())).toBe(true);
      // The same verdict again changes nothing a subscriber reads.
      const known = indexVerdicts();
      recordIndexFailure(bytes, error);
      expect(indexVerdicts()).toBe(known);
      // A run that reads the bytes takes the verdict away.
      recordIndexSuccess(bytes);
      expect(indexVerdicts()).not.toBe(known);
      expect(pagesUnreadable(opened(f), f, indexVerdicts())).toBe(false);
    } finally {
      stop();
    }
  });

  it('never name a file whose documents were read from its bytes, or other bytes', () => {
    const buffer = [1];
    const f = file(buffer);
    recordIndexFailure(buffer, new Error('failed once'));
    const read: OpenDocument = {
      ...f, id: 'broken.pdf#g1#0', pageCount: 1,
      pages: [{ id: 'broken.pdf#g1#p0', sourceDocId: 'broken.pdf', sourcePageIndex: 0, rotation: 0, width: 1, height: 1 }],
    };
    expect(pagesUnreadable(opened(f, [read]), f, indexVerdicts())).toBe(false);
    const other = file([2]);
    expect(pagesUnreadable(opened(other), other, indexVerdicts())).toBe(false);
    recordIndexSuccess(buffer);
  });
});

// The hook and the canvas have no DOM test environment: their sites are
// pinned to the rules above as source text.
const source = (path: string): string =>
  readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

describe('the workspace indexer', () => {
  const hook = source('src/renderer/hooks/useWorkspaceIndexer.ts');

  it('records each run’s verdict with the error it failed with', () => {
    expect(hook).toContain('if (runs.current.live(path, token)) recordIndexFailure(buffer, error);');
    expect(hook).toContain('recordIndexSuccess(buffer);\n          dispatch({ type: \'SET_WORKSPACE_DOCUMENTS\', path, documents });');
  });
});

describe('the canvas', () => {
  const view = source('src/renderer/components/canvas/WorkspaceCanvasView.tsx');

  it('names a file whose pages pdf.js could not read in the notice for bytes it could not draw', () => {
    expect(view).toContain('const knownIndexes = useSyncExternalStore(subscribeIndexVerdicts, indexVerdicts);');
    expect(view).toContain(
      'if (!isUnrenderable(renderHealth, f.path, f.buffer) && !pagesUnreadable(state, f, knownIndexes)) continue;',
    );
    expect(view).toContain('}, [state, renderHealth, knownIndexes]);');
  });
});
