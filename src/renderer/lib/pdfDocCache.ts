import { loadDocument } from './pdfRenderer';
import { documentPassword } from './document-passwords';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfBuffer } from '../state/types';
import { releaseSelectionCache, retainSelectionCache } from './ocr-selection';

// One live pdf.js document per open file, shared by the workspace indexer and
// the canvas page renderers. Entries are keyed by files-map key and are stale
// as soon as the file's buffer identity changes (same rule the indexer uses),
// at which point the old proxy is destroyed and a new one is loaded.
interface CacheEntry {
  path: string;
  buffer: PdfBuffer;
  promise: Promise<PDFDocumentProxy>;
  /** SHA-256 of the bytes, hex. Two documents over equal bytes share it. */
  contentKey: Promise<string>;
  released: boolean;
  /** The entry that took this one's path for other bytes. */
  successor: CacheEntry | null;
}

const cache = new Map<string, CacheEntry>();
const contentKeys = new WeakMap<PDFDocumentProxy, Promise<string>>();
const entryOf = new WeakMap<PDFDocumentProxy, CacheEntry>();
let unhashed = 0;

function ownBytes(buffer: PdfBuffer): Uint8Array<ArrayBuffer> {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (buffer instanceof Uint8Array) return new Uint8Array(buffer);
  return Uint8Array.from(buffer);
}

/** The content key of `buffer`: SHA-256 of its bytes, as hex. The digest takes
 * its own copy of the bytes when called, so a later detach of `buffer` does not
 * reach it. A failed digest yields a key no other document has. */
export function contentKeyOfBuffer(buffer: PdfBuffer): Promise<string> {
  let digest: Promise<ArrayBuffer>;
  try {
    digest = crypto.subtle.digest('SHA-256', ownBytes(buffer));
  } catch (e) {
    digest = Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  return digest.then(
    (hash) => Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
    () => `unhashed-${++unhashed}`,
  );
}

/** The content key of a document this cache loaded, settled once its hash is
 * done; null for a document the cache did not load. */
export function contentKeyOf(proxy: PDFDocumentProxy): Promise<string> | null {
  return contentKeys.get(proxy) ?? null;
}

/** The load of the newest document that replaced `proxy` for its path, by
 * replacement or by a load after its eviction: it resolves when that document
 * loaded and rejects when its load failed. Null when nothing replaced `proxy`.
 * A failed load leaves the cache, so a later call can return the same failed
 * load only when nothing newer stands behind it. */
export function replacementOf(proxy: PDFDocumentProxy): Promise<PDFDocumentProxy> | null {
  const entry = entryOf.get(proxy);
  if (!entry) return null;
  let next = entry;
  for (;;) {
    if (next.successor) {
      next = next.successor;
      continue;
    }
    const current = cache.get(next.path);
    if (current && current !== next) {
      next = current;
      continue;
    }
    return next === entry ? null : next.promise;
  }
}

// Each entry holds its content key from load to eviction, so the recognition
// cache for those bytes lives exactly as long as some cached document shows
// them. A replaced entry lets go only after its successor holds its own key:
// for equal bytes the count would otherwise touch zero between the two and
// drop the recognition the successor is about to serve.
function releaseEntry(entry: CacheEntry, after?: Promise<unknown>): void {
  if (entry.released) return;
  entry.released = true;
  void Promise.all([entry.contentKey, after]).then(([key]) => releaseSelectionCache(key));
}

// A request sent to a proxy whose transport has started terminating never
// settles, so a holder mid-read hangs on the destroyed proxy. Holders that
// must finish (the workspace indexer) listen here and start over.
type EvictionListener = (path: string, buffer: PdfBuffer) => void;
const evictionListeners = new Set<EvictionListener>();

export function subscribeProxyEvictions(listener: EvictionListener): () => void {
  evictionListeners.add(listener);
  return () => {
    evictionListeners.delete(listener);
  };
}

function destroyEntry(path: string, entry: CacheEntry, successorKey?: Promise<string>): void {
  releaseEntry(entry, successorKey);
  void entry.promise.then((proxy) => proxy.loadingTask.destroy()).catch(() => {});
  for (const listener of [...evictionListeners]) listener(path, entry.buffer);
}

export function getDocumentProxy(path: string, buffer: PdfBuffer): Promise<PDFDocumentProxy> {
  const existing = cache.get(path);
  if (existing && existing.buffer === buffer) return existing.promise;
  const contentKey = contentKeyOfBuffer(buffer);
  void contentKey.then(retainSelectionCache);
  if (existing) destroyEntry(path, existing, contentKey);
  const entry: CacheEntry = {
    path, buffer, promise: loadDocument(buffer, documentPassword(path)), contentKey, released: false, successor: null,
  };
  if (existing) existing.successor = entry;
  // Registered before any holder's reaction to the same promise, so a holder
  // handed the proxy always finds its key.
  void entry.promise.then((proxy) => {
    contentKeys.set(proxy, contentKey);
    entryOf.set(proxy, entry);
  }, () => {});
  // A rejected load must not stay cached: retriers (the indexer re-running
  // on state changes, useWorkspaceForms' bounded retry) would replay the
  // same cached rejection forever instead of re-attempting the load.
  void entry.promise.catch(() => {
    releaseEntry(entry);
    if (cache.get(path) === entry) cache.delete(path);
  });
  cache.set(path, entry);
  return entry.promise;
}

// Entry point for callers whose buffer crossed an async gap.
// getDocumentProxy trusts its caller: handed a superseded
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
    cache.delete(path);
    destroyEntry(path, entry);
  }
}

/** A deliberate retry must discard a proxy that cached a failed page read. */
export function evictDocumentProxy(path: string, buffer: PdfBuffer): void {
  const entry = cache.get(path);
  if (!entry || entry.buffer !== buffer) return;
  cache.delete(path);
  destroyEntry(path, entry);
}
