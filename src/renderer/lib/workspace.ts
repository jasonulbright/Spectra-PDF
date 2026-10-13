import type { PDFDocumentProxy } from 'pdfjs-dist';
import { contentKeyOf, contentKeyOfPlaced, getDocumentProxy } from './pdfDocCache';
import { loadDocument } from './pdfRenderer';
import { documentPassword } from './document-passwords';
import { readManifest, partitionPages, stripExtension } from './pdfx-format';
import { importPage } from './annotation-import';
import { NO_UPRIGHT_STAMPS, recordUprightStamps, uprightStampsAmong } from './upright-record';
import type { UprightStamp } from './upright-record';
import { readRawAnnotationStyles, type RawAnnotStyle } from './annotation-raw-style';
import { readableBytes, SealedDecryptError } from './sealed-edit';
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
  return withOwnDocument(buffer, documentPassword(file.path), (doc) => indexDocument(file, buffer, doc));
}

// The bytes an operation or a disk undo or redo is about to place, read through
// a pdf.js document of their own: the shared proxy still draws the bytes being
// replaced. The documents land in the same step as the bytes. Bytes that
// pdf.js cannot load, or whose pages it cannot read, refuse the publication:
// placed anyway, they would show as a document with no pages.
export const readPublishedBytes: ReadPublishedBytes = (file, buffer) =>
  withOwnDocument(buffer, documentPassword(file.path), async (doc) => ({
    pageCount: doc.numPages,
    documents: await indexDocument({ ...file, buffer }, buffer, doc),
  }));

async function withOwnDocument<T>(
  buffer: PdfBuffer,
  password: string | undefined,
  read: (doc: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const doc = await loadDocument(buffer, password);
  try {
    return await read(doc);
  } finally {
    void Promise.resolve()
      .then(() => doc.loadingTask.destroy())
      .catch(() => {});
  }
}

function toUint8(buffer: PdfBuffer): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : Uint8Array.from(buffer);
}

/** The bytes pdf-lib can read of `buffer`: `buffer` itself, a user-opened
 *  file's decrypted bytes, or null when that decrypt failed. */
async function sidecarBytes(file: OpenFile, shown: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await readableBytes(file, shown);
  } catch (e) {
    if (e instanceof SealedDecryptError) return null;
    throw e;
  }
}

interface PageImport {
  annotations: PageAnnotation[];
  untouchedSlots: number[];
  /** The stamps a render of the page draws upright. */
  uprightStamps: readonly UprightStamp[];
}

async function importPages(doc: PDFDocumentProxy, rawStyles: RawAnnotStyle[][] | null): Promise<PageImport[]> {
  const out: PageImport[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push(await importPage(await doc.getPage(i), rawStyles?.[i - 1]));
  return out;
}

// The raw-style sidecar: pdf-lib reads the /Annots entries pdf.js
// hides (/IC /CA /BE /CL /RD /LE), so shape/callout imports are faithful.
// null (unparseable) degrades those imports to untouched. A user-opened
// file's text entries are read from its decrypted bytes; a failed decrypt
// takes the same null, since ciphertext strings would import as garbage.
//
// The import pairs a pdf.js annotation with its sidecar entry by object
// number, so both are read from the same bytes. The engine's decrypting save
// renumbers every object: the decrypted bytes of a user-opened file get a
// pdf.js document of their own, and the shown document's annotation ids are
// never compared with them. Decrypted bytes pdf.js cannot read, or reads with
// another page count, are no sidecar.
//
// A render names an upright stamp by its id in the shown document. A page the
// other document lists such a stamp for is listed again from the shown one; a
// read that fails lists none.
async function importAnnotations(file: OpenFile, buffer: PdfBuffer, doc: PDFDocumentProxy): Promise<PageImport[]> {
  const shown = toUint8(buffer);
  const bytes = await sidecarBytes(file, shown);
  if (bytes === null) return importPages(doc, null);
  if (bytes === shown) return importPages(doc, await readRawAnnotationStyles(bytes));
  try {
    const imported = await withOwnDocument(bytes, undefined, async (own) =>
      own.numPages === doc.numPages ? importPages(own, await readRawAnnotationStyles(bytes)) : null);
    if (imported) return withShownUprightStamps(doc, imported);
  } catch {
    // Falls through to the import without a sidecar.
  }
  return importPages(doc, null);
}

async function withShownUprightStamps(doc: PDFDocumentProxy, imported: PageImport[]): Promise<PageImport[]> {
  const out: PageImport[] = [];
  for (const [index, page] of imported.entries()) {
    if (page.uprightStamps.length === 0) {
      out.push(page);
      continue;
    }
    let uprightStamps = NO_UPRIGHT_STAMPS;
    try {
      uprightStamps = uprightStampsAmong(await (await doc.getPage(index + 1)).getAnnotations());
    } catch {
      // No upright stamp is recorded for the page.
    }
    out.push({ ...page, uprightStamps });
  }
  return out;
}

// The record a render reads is keyed by the content key of the bytes. A
// cached document has its key. Bytes read through a document of their own
// are hashed only when a page of them holds an upright stamp: a page with no
// record renders as a page with none. The key promise is the one the cache
// takes for the same buffer object when the bytes are placed, so the record
// is written before the cache binds the key to its document.
function recordUprightPages(buffer: PdfBuffer, doc: PDFDocumentProxy, imported: PageImport[]): void {
  const pages = imported.map((page) => page.uprightStamps);
  const key = contentKeyOf(doc) ?? (pages.some((stamps) => stamps.length > 0) ? contentKeyOfPlaced(buffer) : null);
  if (key) recordUprightStamps(key, pages);
}

async function indexDocument(file: OpenFile, buffer: PdfBuffer, doc: PDFDocumentProxy): Promise<OpenDocument[]> {
  const manifest = await readManifest(doc);
  const partitions = partitionPages(manifest, doc.numPages, stripExtension(file.name));
  const dims: { width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { width, height } = page.getViewport({ scale: 1 });
    dims.push({ width, height });
  }
  const imported = await importAnnotations(file, buffer, doc);
  recordUprightPages(buffer, doc, imported);
  const annotations = imported.map((page) => page.annotations);
  const untouched = imported.map((page) => page.untouchedSlots);
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
        ...(untouched[pageIndex]?.length ? { untouchedAnnotationSlots: untouched[pageIndex] } : {}),
      }),
    ),
  }));
  return adoptAuthoredIdentity(positional, file.authoredIdentity, buffer);
}
