import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocumentProxy } from './pdfDocCache';
import { loadDocument } from './pdfRenderer';
import { readManifest, partitionPages, stripExtension } from './pdfx-format';
import { importPageAnnotations } from './annotation-import';
import { readRawAnnotationStyles } from './annotation-raw-style';
import {
  adoptAuthoredIdentity,
  nextGeneration,
  positionalDocId,
  positionalPageId,
} from './durable-identity';
import type { OpenDocument, OpenFile, PageAnnotation, PageRef, PdfBuffer } from '../state/types';
import type { ReadPublishedBytes } from './workspace-settle';

// Derives the workspace's page-level view of an open file: reads the .pdfx
// manifest (if present) to recover document boundaries, and captures per-page
// dimensions for the canvas layout. A plain PDF yields a single document
// covering all pages. An open, and a page-tier commit's read-back, are indexed
// off the critical path (useWorkspaceIndexer); an operation or a disk undo or
// redo reads the bytes it publishes before it places them
// (readPublishedBytes).
//
// Identity: positional ids are minted
// under a fresh per-path GENERATION each index, so an id from before any
// rebuild can never re-bind to the wrong physical page; when the buffer
// is the one the page-tier commit just authored, the commit's published
// ids are ADOPTED over the positional ones (ids only — dims, rotation,
// and annotations always come from freshly reading the baked bytes).
export async function indexOpenFile(file: OpenFile): Promise<OpenDocument[]> {
  if (!file.buffer) return [];
  // The proxy is shared with the canvas renderers via pdfDocCache — it stays
  // alive until the buffer changes or the file closes.
  return indexDocument(file, file.buffer, await getDocumentProxy(file.path, file.buffer));
}

// The pages of a file being imported into another document, read through a
// pdf.js document of their own. The shared proxy of an open file is destroyed
// the moment the file takes new bytes (a commit, an operation), and the cache
// destroys the proxy of a path that is not open yet on the next workspace
// change. A request on a destroyed proxy never settles in the worker, so an
// import reading the shared proxy could wait forever. The pages index
// `file.buffer`; the import is refused when the file no longer holds it.
export async function indexImportSource(file: OpenFile): Promise<OpenDocument[]> {
  const buffer = file.buffer;
  if (!buffer) return [];
  return withOwnDocument(buffer, (doc) => indexDocument(file, buffer, doc));
}

// The bytes an operation or a disk undo or redo is about to place, read through
// a pdf.js document of their own: the shared proxy still draws the bytes being
// replaced. The documents land in the same step as the bytes. Bytes that
// pdf.js cannot load, or whose pages it cannot read, refuse the publication:
// placed anyway, they would show as a document with no pages.
export const readPublishedBytes: ReadPublishedBytes = (file, buffer) =>
  withOwnDocument(buffer, async (doc) => ({
    pageCount: doc.numPages,
    documents: await indexDocument({ ...file, buffer }, buffer, doc),
  }));

async function withOwnDocument<T>(buffer: PdfBuffer, read: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const doc = await loadDocument(buffer);
  try {
    return await read(doc);
  } finally {
    void Promise.resolve()
      .then(() => doc.loadingTask.destroy())
      .catch(() => {});
  }
}

async function indexDocument(file: OpenFile, buffer: PdfBuffer, doc: PDFDocumentProxy): Promise<OpenDocument[]> {
  const manifest = await readManifest(doc);
  const partitions = partitionPages(manifest, doc.numPages, stripExtension(file.name));
  // The raw-style sidecar: pdf-lib reads the /Annots entries pdf.js
  // hides (/IC /CA /BE /CL /RD /LE), so shape/callout imports are faithful.
  // null (encrypted/unparseable) degrades those imports to untouched.
  const rawStyles = await readRawAnnotationStyles(buffer);
  const dims: { width: number; height: number }[] = [];
  const annotations: PageAnnotation[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { width, height } = page.getViewport({ scale: 1 });
    dims.push({ width, height });
    annotations.push(await importPageAnnotations(page, rawStyles?.[i - 1]));
  }
  const generation = nextGeneration(file.path);
  const positional = partitions.map((partition, docIndex) => ({
    ...file,
    id: positionalDocId(file.path, generation, docIndex),
    name: partition.name,
    pageCount: partition.indices.length,
    pages: partition.indices.map(
      (pageIndex): PageRef => ({
        id: positionalPageId(file.path, generation, pageIndex),
        sourceDocId: file.path,
        sourcePageIndex: pageIndex,
        rotation: 0,
        width: dims[pageIndex]?.width ?? 0,
        height: dims[pageIndex]?.height ?? 0,
        ...(annotations[pageIndex]?.length ? { annotations: annotations[pageIndex] } : {}),
      }),
    ),
  }));
  return adoptAuthoredIdentity(positional, file.authoredIdentity, buffer);
}
