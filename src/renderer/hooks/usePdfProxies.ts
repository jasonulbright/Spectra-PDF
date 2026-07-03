import { useEffect, useState } from 'react';
import { getDocumentProxy } from '../lib/pdfDocCache';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenFile } from '../state/types';

// Resolved pdf.js proxies for the canvas, keyed by files-map key. Pages render
// placeholders until their file's proxy lands; when a buffer changes the map
// entry is swapped once the new proxy resolves.
export function usePdfProxies(files: Map<string, OpenFile>): Map<string, PDFDocumentProxy> {
  const [proxies, setProxies] = useState<Map<string, PDFDocumentProxy>>(() => new Map());

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
      if (!f.buffer) continue;
      getDocumentProxy(path, f.buffer)
        .then((proxy) => {
          if (cancelled) return;
          setProxies((prev) =>
            prev.get(path) === proxy ? prev : new Map(prev).set(path, proxy),
          );
        })
        .catch(() => {
          // load failure — the page keeps its placeholder
        });
    }
    return () => {
      cancelled = true;
    };
  }, [files]);

  return proxies;
}
