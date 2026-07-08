import { getDocumentProxy } from './pdfDocCache';
import { readManifest, partitionPages, stripExtension } from './pdfx-format';
import { importPageAnnotations } from './annotation-import';
import type { OpenDocument, OpenFile, PageAnnotation, PageRef } from '../state/types';

// Derives the workspace's page-level view of an open file: reads the .pdfx
// manifest (if present) to recover document boundaries, and captures per-page
// dimensions for the canvas layout. A plain PDF yields a single document
// covering all pages. Runs off the open/update critical path — see
// useWorkspaceIndexer.
export async function indexOpenFile(file: OpenFile): Promise<OpenDocument[]> {
  if (!file.buffer) return [];
  // The proxy is shared with the canvas renderers via pdfDocCache — it stays
  // alive until the buffer changes or the file closes.
  const doc = await getDocumentProxy(file.path, file.buffer);
  const manifest = await readManifest(doc);
  const partitions = partitionPages(manifest, doc.numPages, stripExtension(file.name));
  const dims: { width: number; height: number }[] = [];
  const annotations: PageAnnotation[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { width, height } = page.getViewport({ scale: 1 });
    dims.push({ width, height });
    annotations.push(await importPageAnnotations(page));
  }
  return partitions.map((partition, docIndex) => ({
    ...file,
    id: `${file.path}#${docIndex}`,
    name: partition.name,
    pageCount: partition.indices.length,
    pages: partition.indices.map(
      (pageIndex): PageRef => ({
        id: `${file.path}#p${pageIndex}`,
        sourceDocId: file.path,
        sourcePageIndex: pageIndex,
        rotation: 0,
        width: dims[pageIndex]?.width ?? 0,
        height: dims[pageIndex]?.height ?? 0,
        ...(annotations[pageIndex]?.length ? { annotations: annotations[pageIndex] } : {}),
      }),
    ),
  }));
}
