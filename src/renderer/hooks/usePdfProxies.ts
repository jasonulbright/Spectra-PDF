import { useEffect, useMemo, useState } from 'react';
import { getDocumentProxy } from '../lib/pdfDocCache';
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

// Resolved pdf.js proxies for the canvas, keyed by files-map key. Pages render
// placeholders until their file's proxy lands; when a buffer changes the map
// entry is swapped once the new proxy resolves.
export function usePdfProxies(files: Map<string, OpenFile>): Map<string, PDFDocumentProxy> {
  return usePdfProxyState(files).proxies;
}

// The same load, with pdf.js's verdict kept rather than discarded. A rejection
// here is the ONLY honest signal that a document the engine opened will never
// draw — there is no timer heuristic behind it and no second attempt implied.
export function usePdfProxyState(files: Map<string, OpenFile>): PdfProxyState {
  const [proxies, setProxies] = useState<Map<string, PDFDocumentProxy>>(() => new Map());
  const [health, setHealth] = useState<RenderHealth>(EMPTY_RENDER_HEALTH);

  useEffect(() => {
    const openPaths = new Set(files.keys());
    setHealth((prev) => pruneRenderHealth(prev, openPaths));
  }, [files]);

  useEffect(() => {
    let cancelled = false;
    setProxies((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!files.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const [path, f] of files) {
      const buffer = f.buffer;
      if (!buffer) continue;
      getDocumentProxy(path, buffer)
        .then((proxy) => {
          if (cancelled) return;
          setProxies((prev) =>
            prev.get(path) === proxy ? prev : new Map(prev).set(path, proxy),
          );
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

  return useMemo(() => ({ proxies, health }), [proxies, health]);
}
