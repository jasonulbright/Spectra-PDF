// Buffer-identity bookkeeping for the canvas's pdf.js proxies.
//
// A proxy is only ever valid for the exact bytes it was loaded from. Keying
// the canvas map by path alone leaves the OLD proxy exposed when the same
// path takes new bytes and the new load FAILS — the canvas then draws the
// previous document while every panel and every save targets the new one.
// These are the pure rules; `usePdfProxies` holds them in React state.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenFile, PdfBuffer } from '../state/types';

export interface ProxyEntry {
  /** The bytes this proxy was loaded from — identity, never contents. */
  readonly buffer: PdfBuffer;
  readonly proxy: PDFDocumentProxy;
}

export type ProxyEntries = ReadonlyMap<string, ProxyEntry>;

/**
 * Drop every entry whose path is closed or whose recorded buffer is no longer
 * the file's current one. Returns `entries` unchanged when nothing is stale,
 * so a React state setter can bail out of a re-render.
 */
export function pruneProxyEntries(
  entries: ProxyEntries,
  files: ReadonlyMap<string, OpenFile>,
): ProxyEntries {
  let changed = false;
  const next = new Map(entries);
  for (const [path, entry] of entries) {
    const file = files.get(path);
    if (file && file.buffer === entry.buffer) continue;
    next.delete(path);
    changed = true;
  }
  return changed ? next : entries;
}

/**
 * Record a resolved proxy against the buffer it was loaded from. A result for
 * a buffer the file no longer holds is discarded rather than stored: it
 * crossed an async gap and lost.
 */
export function withProxyEntry(
  entries: ProxyEntries,
  path: string,
  buffer: PdfBuffer,
  proxy: PDFDocumentProxy,
  files: ReadonlyMap<string, OpenFile>,
): ProxyEntries {
  if (files.get(path)?.buffer !== buffer) return entries;
  const held = entries.get(path);
  if (held && held.buffer === buffer && held.proxy === proxy) return entries;
  return new Map(entries).set(path, { buffer, proxy });
}

/**
 * The map the canvas renders from: a path appears only while its recorded
 * buffer IS the file's current buffer. A failed reload therefore shows a
 * placeholder, never the previous document's pages.
 */
export function visibleProxies(
  entries: ProxyEntries,
  files: ReadonlyMap<string, OpenFile>,
): Map<string, PDFDocumentProxy> {
  const out = new Map<string, PDFDocumentProxy>();
  for (const [path, entry] of entries) {
    if (files.get(path)?.buffer === entry.buffer) out.set(path, entry.proxy);
  }
  return out;
}
