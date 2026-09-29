// A user-opened file's renderer readers take the engine's decrypted bytes. A
// decrypt that fails must never hand them the encrypted buffer as plaintext:
// the raw-style read then imports ciphertext strings, and the layer remap
// binds groups read from bytes it cannot trust.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AppState, OpenDocument, OpenFile, PdfBuffer } from '../src/renderer/state/types';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({ loadDocument: vi.fn() }));
vi.mock('../src/renderer/lib/annotation-raw-style', () => ({ readRawAnnotationStyles: vi.fn(async () => null) }));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import { readRawAnnotationStyles } from '../src/renderer/lib/annotation-raw-style';
import { indexImportSource } from '../src/renderer/lib/workspace';
import { bytesToBase64, readableBytes, SealedDecryptError, setSealedReader } from '../src/renderer/lib/sealed-edit';
import { parseDocumentSecurity, PERMISSION_NAMES } from '../src/renderer/lib/document-permissions';
import { createLayerSessions, type Layer } from '../src/renderer/lib/layer-session';
import { initialState } from '../src/renderer/state/reducer';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
import { tChrome } from '../src/renderer/i18n';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

const security = (allowed: boolean) => parseDocumentSecurity({
  opener: 'user',
  permissions: Object.fromEntries(PERMISSION_NAMES.map((name) => [name, allowed])),
});
const SEALED = security(true);
const DENIED = security(false);
const CIPHER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xde, 0xad]);
const PLAIN = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02]);

afterEach(() => { setSealedReader(null); vi.mocked(readRawAnnotationStyles).mockClear(); });

describe('readableBytes', () => {
  it('passes an unsealed file through without calling the engine', async () => {
    const reader = vi.fn(); setSealedReader(reader);
    expect(await readableBytes({ workingPath: 'w' }, CIPHER)).toBe(CIPHER);
    expect(reader).not.toHaveBeenCalled();
  });
  it('returns the decrypted bytes of a sealed file', async () => {
    const reader = vi.fn(async () => ({ data: bytesToBase64(PLAIN) })); setSealedReader(reader);
    expect(await readableBytes({ workingPath: 'w', security: SEALED }, CIPHER)).toEqual(PLAIN);
    expect(reader).toHaveBeenCalledWith('sealed_plaintext', { path: 'w', capabilities: ['commentTier'], data: bytesToBase64(CIPHER) });
  });
  it.each(['reject', 'no-data', 'bad-base64', 'no-reader'])('throws SealedDecryptError on a failed decrypt: %s', async (mode) => {
    if (mode !== 'no-reader') setSealedReader(async () => {
      if (mode === 'reject') throw new Error('engine');
      return mode === 'no-data' ? {} : { data: '%%%' };
    });
    await expect(readableBytes({ workingPath: 'w', security: SEALED }, CIPHER)).rejects.toBeInstanceOf(SealedDecryptError);
  });
  it('passes the buffer through when the document denies the capability', async () => {
    const reader = vi.fn(); setSealedReader(reader);
    expect(await readableBytes({ workingPath: 'w', security: DENIED }, CIPHER, 'pageTier')).toBe(CIPHER);
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('workspace raw-style read', () => {
  it('a failed decrypt drops the style sidecar instead of reading ciphertext', async () => {
    vi.mocked(loadDocument).mockImplementation(async (buffer: PdfBuffer) =>
      (await pdfjs.getDocument({ data: new Uint8Array(buffer as Uint8Array).slice() }).promise) as PDFDocumentProxy);
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]);
    const bytes = await pdf.save();
    setSealedReader(async () => { throw new Error('engine'); });
    const file: OpenFile = { path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf', pageCount: 1, buffer: bytes,
      dirty: false, undoStack: [], redoStack: [], security: SEALED };
    const docs = await indexImportSource(file);
    expect(docs[0].pages).toHaveLength(1);
    expect(readRawAnnotationStyles).not.toHaveBeenCalled();
  });
});

describe('layer remap on a sealed file', () => {
  it('a failed decrypt refuses the toggle with an error instead of remapping ciphertext', async () => {
    const pdf = await PDFDocument.create();
    const groups = ['A', 'B', 'C'].map(name => pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of(name) })));
    for (const ref of groups) pdf.addPage().node.set(PDFName.of('Resources'), pdf.context.obj({ Properties: { Group: ref } }));
    pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.obj({ OCGs: groups, D: { ON: groups, OFF: [] } }));
    const original = await pdf.save();
    const a: OpenFile = { path: 'A', workingPath: 'workA', name: 'A', buffer: original, pageCount: 3, dirty: false,
      undoStack: [], redoStack: [], security: SEALED };
    let state: AppState = { ...initialState, pageDirtyPaths: [], activeFileId: 'A', files: new Map([['A', a]]),
      workspace: { documents: [{ ...a, id: 'doc', pages: [0, 1, 2].map(i => ({ id: `page${i}`, sourceDocId: 'A', sourcePageIndex: i, rotation: 0, width: 600, height: 800 })) } as OpenDocument] } };
    const sessions = createLayerSessions(() => state), s = sessions.get(a)!;
    const rows: Layer[] = ['A', 'B', 'C'].map((name, index) => ({ index, name, visible: true, locked: false, processing_step: null }));
    const call = vi.fn(async () => ({ layers: rows, count: 3, complete: true, processing_step_count: 0 }));
    await sessions.load(s, call);
    const operation = vi.fn<PerformOperation>(async () => ({}) as WorkspaceOperationResult);
    setSealedReader(async () => { throw new Error('engine'); });
    await sessions.toggle(s, s.layers[1], s.buffer, operation, call, async () => {
      const buffer = await buildPdf([1, 2].map(pageIndex => ({ sourceKey: 'A', bytes: original, pageIndex, rotation: 0 })), original, 'A');
      state = { ...state, files: new Map(state.files).set('A', { ...a, buffer, pageCount: 2,
        authoredIdentity: { sourceBuffer: a.buffer, buffer, pages: ['page1', 'page2'], documents: [{ id: 'doc', name: 'A' }] } }) };
    });
    expect(operation).not.toHaveBeenCalled();
    expect(s.error).toBe(tChrome('app.operation.unverified'));
  });
});
