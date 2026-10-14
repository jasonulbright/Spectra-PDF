import { loadDocument } from './pdfRenderer';
import { documentPassword } from './document-passwords';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfBuffer } from '../state/types';
import { releaseSelectionCache, retainSelectionCache } from './ocr-selection';
import { releaseAppearanceRasters, retainAppearanceRasters } from './appearance-raster';
import {
  bindUprightDocument, carryUprightPages, expectUprightKey, holdUprightRecord, releaseUprightRecord, uprightDocumentDestroyed,
  uprightPagesOf,
} from './upright-record';

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
  /** The loaded document. */
  proxy: PDFDocumentProxy | null;
  /** The page indexes the replaced document had an upright stamp on. They
   * name pages that may hold one in this document, and no stamp. */
  uprightCarry: readonly number[];
}

const NO_PAGES: readonly number[] = Object.freeze([]);
const placedKeys = new WeakMap<object, Promise<string>>();

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

/** The content key of `buffer`, one digest and one promise per buffer object.
 * A reader of bytes that are placed afterwards and the cache that then loads
 * them share the promise, so what the reader does when the key settles is
 * done before the cache binds the key to the document. */
export function contentKeyOfPlaced(buffer: PdfBuffer): Promise<string> {
  let key = placedKeys.get(buffer);
  if (!key) placedKeys.set(buffer, (key = contentKeyOfBuffer(buffer)));
  return key;
}

/** The content key of a document this cache loaded, settled once its hash is
 * done; null for a document the cache did not load. */
export function contentKeyOf(proxy: PDFDocumentProxy): Promise<string> | null {
  return contentKeys.get(proxy) ?? null;
}

/** A second document over the bytes of `proxy`, outside this cache: nothing
 * else renders it and its holder destroys it. It is opened as `proxy` was:
 * the entry's buffer, and the password its path has at the time of the call,
 * which is read for this load and kept nowhere else. A document this cache
 * did not load is refused: `getData()` gives the bytes as stored, encrypted
 * for a password document, and no record says how they were opened. */
export function openPrivateCopy(proxy: PDFDocumentProxy): Promise<PDFDocumentProxy> {
  const entry = entryOf.get(proxy);
  if (!entry) return Promise.reject(new Error('private copy: the document was not loaded by the proxy cache'));
  return loadDocument(entry.buffer, documentPassword(entry.path));
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
  void Promise.all([entry.contentKey, after]).then(([key]) => {
    releaseSelectionCache(key);
    releaseAppearanceRasters(key);
    releaseUprightRecord(key);
  });
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
  // A read of the upright stamps that is pending on the document settles
  // before the destruction starts: its request may never be answered.
  void entry.promise.then((proxy) => {
    uprightDocumentDestroyed(proxy);
    return proxy.loadingTask.destroy();
  }).catch(() => {});
  for (const listener of [...evictionListeners]) listener(path, entry.buffer);
}

export function getDocumentProxy(path: string, buffer: PdfBuffer): Promise<PDFDocumentProxy> {
  const existing = cache.get(path);
  if (existing && existing.buffer === buffer) return existing.promise;
  const contentKey = contentKeyOfPlaced(buffer);
  void contentKey.then((key) => {
    retainSelectionCache(key);
    retainAppearanceRasters(key);
    holdUprightRecord(key);
  });
  // The pages the replaced document has an upright stamp on, or the pages it
  // was told itself when it has not loaded.
  const uprightCarry = !existing ? NO_PAGES : existing.proxy ? uprightPagesOf(existing.proxy) : existing.uprightCarry;
  if (existing) destroyEntry(path, existing, contentKey);
  const entry: CacheEntry = {
    path, buffer, promise: loadDocument(buffer, documentPassword(path)), contentKey, released: false, successor: null,
    proxy: null, uprightCarry,
  };
  if (existing) existing.successor = entry;
  // Registered before any holder's reaction to the same promise, so a holder
  // handed the proxy always finds its key and the pages it was told.
  void entry.promise.then((proxy) => {
    contentKeys.set(proxy, contentKey);
    entryOf.set(proxy, entry);
    entry.proxy = proxy;
    expectUprightKey(proxy, contentKey);
    if (entry.released) return;
    carryUprightPages(proxy, entry.uprightCarry);
  }, () => {});
  // A render looks the record of upright stamps up by document, with no
  // wait: the settled key is bound to the document here.
  void Promise.all([entry.promise, contentKey]).then(([proxy, key]) => bindUprightDocument(proxy, key), () => {});
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
