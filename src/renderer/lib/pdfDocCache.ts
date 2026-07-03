import { loadDocument } from './pdfRenderer';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfBuffer } from '../state/types';

// One live pdf.js document per open file, shared by the workspace indexer and
// the canvas page renderers. Entries are keyed by files-map key and are stale
// as soon as the file's buffer identity changes (same rule the indexer uses),
// at which point the old proxy is destroyed and a new one is loaded.
interface CacheEntry {
  buffer: PdfBuffer;
  promise: Promise<PDFDocumentProxy>;
}

const cache = new Map<string, CacheEntry>();

function destroyEntry(entry: CacheEntry): void {
  void entry.promise.then((proxy) => proxy.loadingTask.destroy()).catch(() => {});
}

export function getDocumentProxy(path: string, buffer: PdfBuffer): Promise<PDFDocumentProxy> {
  const existing = cache.get(path);
  if (existing && existing.buffer === buffer) return existing.promise;
  if (existing) destroyEntry(existing);
  const entry: CacheEntry = { buffer, promise: loadDocument(buffer) };
  cache.set(path, entry);
  return entry.promise;
}

// Drop cached proxies for files that are no longer open.
export function evictExcept(openPaths: ReadonlySet<string>): void {
  for (const [path, entry] of cache) {
    if (openPaths.has(path)) continue;
    destroyEntry(entry);
    cache.delete(path);
  }
}
