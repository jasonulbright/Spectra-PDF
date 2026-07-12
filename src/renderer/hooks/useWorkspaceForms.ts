import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { readFormFields } from '../lib/forms';
import type { FormField } from '../lib/forms';
import { projectFieldWidgets } from '../lib/form-overlay';
import type { OverlayWidget, PageBox } from '../lib/form-overlay';
import type { OpenFile, PdfBuffer } from '../state/types';

export interface FileFormInfo {
  fields: FormField[];
  // sourcePageIndex -> widgets, display-normalized at the page's BAKED
  // orientation (PageCell projects by the in-memory rotation at render).
  widgetsByPage: ReadonlyMap<number, OverlayWidget[]>;
}

interface CacheEntry {
  buffer: PdfBuffer;
  proxy: PDFDocumentProxy;
  info: FileFormInfo;
}

// Per-file AcroForm read + widget projection for the canvas overlay (2n.4b).
// Re-reads a file when its buffer identity changes — the same signal the
// workspace indexer and FormsPanel key on — and keeps the PREVIOUS read
// published while the new one is in flight (stale-while-revalidate), so the
// pending-value pruning in WorkspaceCanvasView never sees a transient gap
// and wipes values typed before an unrelated commit. Byte-only import
// sources are excluded: their fields join the TARGET file's /AcroForm at
// commit (2n.4a's multi-source carry) and become fillable there.
export function useWorkspaceForms(
  files: Map<string, OpenFile>,
  proxies: Map<string, PDFDocumentProxy>,
): ReadonlyMap<string, FileFormInfo> {
  const [published, setPublished] = useState<ReadonlyMap<string, FileFormInfo>>(new Map());
  const cacheRef = useRef(new Map<string, CacheEntry>());
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    let alive = true;
    const run = async (): Promise<void> => {
      const cache = cacheRef.current;
      for (const path of [...cache.keys()]) {
        const f = files.get(path);
        if (!f || f.importOnly || !f.buffer || !proxies.has(path)) cache.delete(path);
      }
      const work: Promise<void>[] = [];
      for (const [path, f] of files) {
        if (f.importOnly || !f.buffer) continue;
        const proxy = proxies.get(path);
        if (!proxy) continue; // not renderable yet — no geometry source
        const cached = cache.get(path);
        if (cached && cached.buffer === f.buffer && cached.proxy === proxy) continue;
        const buffer = f.buffer;
        work.push(
          (async () => {
            let info: FileFormInfo;
            try {
              const { fields } = await readFormFields(buffer);
              const pageIndexes = new Set<number>();
              for (const field of fields) {
                for (const w of field.widgets) pageIndexes.add(w.pageIndex);
              }
              const geo = new Map<number, { box: PageBox; bakedRotate: number }>();
              for (const i of pageIndexes) {
                if (i < 0 || i >= proxy.numPages) continue;
                const page = await proxy.getPage(i + 1);
                const [vx0, vy0, vx1, vy1] = page.view;
                geo.set(i, {
                  box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
                  bakedRotate: page.rotate,
                });
              }
              const widgetsByPage = new Map<number, OverlayWidget[]>();
              for (const field of fields) {
                const per = projectFieldWidgets(path, field, (i) => geo.get(i) ?? null);
                for (const [pi, arr] of per) {
                  const existing = widgetsByPage.get(pi);
                  if (existing) existing.push(...arr);
                  else widgetsByPage.set(pi, arr);
                }
              }
              info = { fields, widgetsByPage };
            } catch {
              // A failed re-read keeps the PREVIOUS good read published
              // (review note: publishing empty fields here would make the
              // pending-value pruning wipe values over a transient hiccup —
              // the same hazard stale-while-revalidate exists to prevent). A
              // file whose form was never readable simply has no overlay;
              // the FormsPanel surfaces read errors, the canvas stays quiet.
              const prev = cache.get(path);
              info = prev ? prev.info : { fields: [], widgetsByPage: new Map() };
            }
            if (!alive || gen !== genRef.current) return; // superseded run
            cache.set(path, { buffer, proxy, info });
          })(),
        );
      }
      await Promise.all(work);
      if (!alive || gen !== genRef.current) return;
      const next = new Map<string, FileFormInfo>();
      for (const [path, entry] of cache) next.set(path, entry.info);
      setPublished(next);
    };
    void run();
    return () => {
      alive = false;
    };
  }, [files, proxies]);

  return published;
}
