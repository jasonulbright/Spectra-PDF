// Importing pages from a file reads that file's pages through pdf.js. The
// canvas and the workspace indexer share one proxy per open file, and that
// proxy is destroyed the moment the file takes new bytes (a commit lands) or,
// for a file not open yet, on the next workspace change. A request on a
// destroyed proxy never settles in the browser's worker, and fails with an
// internal error in this test's worker, so an import reading the shared proxy
// waits forever or fails with no notice. The import reads a proxy of its own;
// the pages it returns index the bytes it read, and IMPORT_PAGES refuses them
// when the file no longer holds those bytes.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenFile, PdfBuffer } from '../src/renderer/state/types';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({ loadDocument: vi.fn() }));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import { evictExcept, getDocumentProxy } from '../src/renderer/lib/pdfDocCache';
import { indexImportSource } from '../src/renderer/lib/workspace';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const loadDocumentMock = vi.mocked(loadDocument);
const loaded: PDFDocumentProxy[] = [];
// Called right after a page request is sent on any loaded proxy.
let onPageRequested: ((n: number) => void) | null = null;

function toBytes(buffer: PdfBuffer): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
}

async function pdf(widths: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const width of widths) doc.addPage([width, 400]);
  return doc.save();
}

function open(buffer: Uint8Array): OpenFile {
  return {
    path: 'a.pdf', workingPath: 'a.pdf.w', name: 'a.pdf', pageCount: 3, buffer,
    dirty: false, undoStack: [], redoStack: [],
  };
}

const settleWithin = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);

beforeEach(() => {
  loadDocumentMock.mockReset();
  loadDocumentMock.mockImplementation(async (buffer: PdfBuffer) => {
    const proxy = (await pdfjs.getDocument({ data: toBytes(buffer).slice() }).promise) as PDFDocumentProxy;
    vi.spyOn(proxy.loadingTask, 'destroy');
    const getPage = proxy.getPage.bind(proxy);
    proxy.getPage = (n: number) => {
      const pending = getPage(n);
      onPageRequested?.(n);
      return pending;
    };
    loaded.push(proxy);
    return proxy;
  });
});

afterEach(async () => {
  evictExcept(new Set());
  await Promise.all(loaded.splice(0).map((p) => p.loadingTask.destroy().catch(() => {})));
});

describe('indexImportSource', () => {
  it('finishes when a commit replaces the open file’s bytes while it reads them', async () => {
    const before = await pdf([100, 150, 200]);
    const after = await pdf([200, 100, 150]);
    // The canvas holds the shared proxy of the bytes the import reads.
    await getDocumentProxy('a.pdf', before);
    const reading = indexImportSource(open(before));
    // The commit lands: the canvas asks for the new bytes, which destroys the
    // shared proxy of the old ones, and a close would evict every proxy.
    void getDocumentProxy('a.pdf', after);
    evictExcept(new Set());
    const docs = await settleWithin(reading, 5000);
    expect(docs).not.toBe('pending');
    if (docs === 'pending') return;
    // The pages index the bytes the import read.
    expect(docs.flatMap((d) => d.pages.map((p) => [p.sourceDocId, p.sourcePageIndex, p.width]))).toEqual([
      ['a.pdf', 0, 100],
      ['a.pdf', 1, 150],
      ['a.pdf', 2, 200],
    ]);
  });

  it('finishes when the bytes are replaced while one of its page requests is in flight', async () => {
    const before = await pdf([100, 150, 200]);
    const after = await pdf([200, 100, 150]);
    await getDocumentProxy('a.pdf', before);
    onPageRequested = (n) => {
      if (n !== 2) return;
      onPageRequested = null;
      void getDocumentProxy('a.pdf', after);
    };
    const docs = await settleWithin(indexImportSource(open(before)), 5000);
    expect(docs).not.toBe('pending');
    if (docs === 'pending') return;
    expect(docs.flatMap((d) => d.pages.map((p) => p.width))).toEqual([100, 150, 200]);
  });

  it('reads a proxy of its own and destroys it when done', async () => {
    const bytes = await pdf([100]);
    const shared = await getDocumentProxy('a.pdf', bytes);
    await indexImportSource(open(bytes));
    expect(loadDocumentMock).toHaveBeenCalledTimes(2);
    const own = loaded[1];
    expect(own).not.toBe(shared);
    // The import's own proxy is destroyed; the shared one still serves.
    expect(own.loadingTask.destroy).toHaveBeenCalledTimes(1);
    expect(shared.loadingTask.destroy).not.toHaveBeenCalled();
    expect(await shared.getPage(1)).toBeTruthy();
  });

  it('reads nothing for a file with no bytes', async () => {
    expect(await indexImportSource({ ...open(new Uint8Array()), buffer: null })).toEqual([]);
    expect(loadDocumentMock).not.toHaveBeenCalled();
  });
});

describe('the import into a document', () => {
  it('reads its sources through their own proxies', () => {
    const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
    expect(app).toContain('const docs = await indexImportSource({');
    expect(app).not.toContain('indexOpenFile');
  });
});
