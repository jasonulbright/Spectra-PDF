import { useEffect, useMemo, useState } from 'react';
import { getDocumentProxy } from '../lib/pdfDocCache';
import {
  pruneProxyEntries,
  visibleProxies,
  withProxyEntry,
  type ProxyEntries,
} from '../lib/pdf-proxy-entries';
import {
  EMPTY_RENDER_HEALTH,
  markRenderFailed,
  markRenderSucceeded,
  pruneRenderHealth,
  type RenderHealth,
} from '../lib/render-health';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenFile } from '../state/types';

export interface PdfProxyState {
  readonly proxies: Map<string, PDFDocumentProxy>;
  /** Files the engine opened whose CURRENT bytes pdf.js refused to load. */
  readonly health: RenderHealth;
}

// Resolved pdf.js proxies for the canvas, keyed by files-map key and pinned to
// the buffer each was loaded from. Pages render placeholders until their file's
// proxy lands; a path whose buffer changed exposes nothing until the NEW bytes
// load, so a failed reload cannot leave the previous document on the canvas
// while the panels and saves address the new one.
export function usePdfProxies(files: Map<string, OpenFile>): Map<string, PDFDocumentProxy> {
  return usePdfProxyState(files).proxies;
}

// The same load, with pdf.js's verdict kept rather than discarded. A rejection
// here is the ONLY honest signal that a document the engine opened will never
// draw — there is no timer heuristic behind it and no second attempt implied.
export function usePdfProxyState(files: Map<string, OpenFile>): PdfProxyState {
  const [entries, setEntries] = useState<ProxyEntries>(() => new Map());
  const [health, setHealth] = useState<RenderHealth>(EMPTY_RENDER_HEALTH);

  useEffect(() => {
    const openPaths = new Set(files.keys());
    setHealth((prev) => pruneRenderHealth(prev, openPaths));
  }, [files]);

  useEffect(() => {
    let cancelled = false;
    // The stale entry goes the moment the buffer changes — not when the new
    // load answers, which for a rejection is never.
    setEntries((prev) => pruneProxyEntries(prev, files));
    for (const [path, f] of files) {
      const buffer = f.buffer;
      if (!buffer) continue;
      getDocumentProxy(path, buffer)
        .then((proxy) => {
          if (cancelled) return;
          setEntries((prev) => withProxyEntry(prev, path, buffer, proxy, files));
          setHealth((prev) => markRenderSucceeded(prev, path));
        })
        .catch(() => {
          // load failure — the page keeps its placeholder, and the canvas says
          // so once for the document rather than leaving a blank rectangle.
          if (cancelled) return;
          setHealth((prev) => markRenderFailed(prev, path, buffer));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [files]);

  const proxies = useMemo(() => visibleProxies(entries, files), [entries, files]);
  return useMemo(() => ({ proxies, health }), [proxies, health]);
}
