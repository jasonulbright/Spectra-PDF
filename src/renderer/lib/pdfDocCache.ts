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
  // A rejected load must not stay cached: retriers (the indexer re-running
  // on state changes, useWorkspaceForms' bounded retry) would replay the
  // same cached rejection forever instead of re-attempting the load.
  void entry.promise.catch(() => {
    if (cache.get(path) === entry) cache.delete(path);
  });
  cache.set(path, entry);
  return entry.promise;
}

// Entry point for callers whose buffer crossed an async gap (Phase 9,
// round 24 tail). getDocumentProxy trusts its caller: handed a superseded
// buffer, it would EVICT + DESTROY the live entry for the path's CURRENT
// bytes — re-creating the mid-flight-destroy hang on whoever holds that
// proxy. The cache cannot know files-currency, so an async-gap caller states
// it: when isStillWanted() is false at call time nothing is touched and null
// comes back. Synchronous callers keep using getDocumentProxy directly.
export function requestDocumentProxy(
  path: string,
  buffer: PdfBuffer,
  isStillWanted: () => boolean,
): Promise<PDFDocumentProxy> | null {
  if (!isStillWanted()) return null;
  return getDocumentProxy(path, buffer);
}

// Drop cached proxies for files that are no longer open.
export function evictExcept(openPaths: ReadonlySet<string>): void {
  for (const [path, entry] of cache) {
    if (openPaths.has(path)) continue;
    destroyEntry(entry);
    cache.delete(path);
  }
}
