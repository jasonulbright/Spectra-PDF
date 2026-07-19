import { useEffect, useRef, useState } from 'react';
import { readFormFields } from '../lib/forms';
import type { FormField } from '../lib/forms';
import { projectFieldWidgets } from '../lib/form-overlay';
import type { OverlayWidget, PageBox } from '../lib/form-overlay';
import { getDocumentProxy } from '../lib/pdfDocCache';
import type { OpenFile, PdfBuffer } from '../state/types';

export interface FileFormInfo {
  fields: FormField[];
  // sourcePageIndex -> widgets, display-normalized at the page's BAKED
  // orientation (PageCell projects by the in-memory rotation at render).
  widgetsByPage: ReadonlyMap<number, OverlayWidget[]>;
}

interface CacheEntry {
  buffer: PdfBuffer;
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
//
// Geometry is resolved from pdfDocCache BY (path, buffer) — never from a
// proxies map keyed by path alone (Phase 9). A map entry can belong to a
// superseded buffer, and a getPage whose proxy is destroyed mid-flight can
// PEND FOREVER (no rejection — instrumented live under CPU load: such reads
// neither resolved nor rejected for 30s+), which silently disabled this
// hook's whole catch/retry path. Resolved by buffer, a hang can only happen
// when a NEWER buffer destroyed the entry — and that buffer's files dispatch
// refires this effect, so a hung run is always superseded, never
// load-bearing. It also pins fields and page boxes to the SAME bytes: a
// post-commit read must not project new widgets through old geometry.
export function useWorkspaceForms(files: Map<string, OpenFile>): ReadonlyMap<string, FileFormInfo> {
  const [published, setPublished] = useState<ReadonlyMap<string, FileFormInfo>>(new Map());
  const cacheRef = useRef(new Map<string, CacheEntry>());
  const genRef = useRef(0);
  // Transient-failure retries, keyed per (path, buffer identity): a read
  // can fail for reasons that heal on their own (e.g. a proxy load rejected
  // under resource pressure — pdfDocCache drops a rejected load, so each
  // retry genuinely re-attempts it). Bounded so a genuinely unreadable form
  // stops churning; the count resets when the buffer changes again.
  const failsRef = useRef(new Map<string, { buffer: PdfBuffer; count: number }>());

  useEffect(() => {
    const gen = ++genRef.current;
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const run = async (): Promise<void> => {
      const cache = cacheRef.current;
      for (const path of [...cache.keys()]) {
        const f = files.get(path);
        if (!f || f.importOnly || !f.buffer) cache.delete(path);
      }
      let transientFailure = false;
      const work: Promise<void>[] = [];
      for (const [path, f] of files) {
        if (f.importOnly || !f.buffer) continue;
        const cached = cache.get(path);
        if (cached && cached.buffer === f.buffer) continue;
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
              if (pageIndexes.size > 0) {
                // SUPERSEDED runs must not touch the proxy cache: the
                // buffer captured above went stale during the (slow)
                // readFormFields await, and getDocumentProxy for a stale
                // buffer would DESTROY the canvas's live newer proxy —
                // re-creating the mid-flight-destroy hang on the current
                // generation (review-caught HIGH, repro'd against the
                // real cache). The newer generation's own run covers the
                // fresh buffer; just stop.
                if (gen !== genRef.current) return;
                // The shared canvas proxy for THESE bytes; form-less files
                // never wait on (or fail with) the pdf.js load at all.
                const proxy = await getDocumentProxy(path, buffer);
                for (const i of pageIndexes) {
                  if (i < 0 || i >= proxy.numPages) continue;
                  const page = await proxy.getPage(i + 1);
                  const [vx0, vy0, vx1, vy1] = page.view;
                  geo.set(i, {
                    box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
                    bakedRotate: page.rotate,
                  });
                }
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
              failsRef.current.delete(path);
            } catch {
              // A failed re-read keeps the PREVIOUS good read published
              // (review note: publishing empty fields here would make the
              // pending-value pruning wipe values over a transient hiccup —
              // the same hazard stale-while-revalidate exists to prevent).
              // CRITICALLY it must NOT cache the old info under the NEW
              // buffer identity — that claimed the read happened, so every
              // later pass skipped it and the file's forms froze at the
              // pre-edit state FOREVER (a field created during the failure
              // window never appeared — live-caught by the e2e read-back
              // under CPU load). Leave the old cache entry in place (the
              // publish below keeps it visible) and retry.
              const fails = failsRef.current.get(path);
              const count = fails && fails.buffer === buffer ? fails.count + 1 : 1;
              failsRef.current.set(path, { buffer, count });
              if (count < 5) transientFailure = true;
              // After 5 strikes the mismatch stays unresolved but quiet —
              // a permanently unreadable form must not retry forever; the
              // FormsPanel surfaces read errors, the canvas stays as-is.
              return;
            }
            if (!alive || gen !== genRef.current) return; // superseded run
            cache.set(path, { buffer, info });
          })(),
        );
      }
      await Promise.all(work);
      if (!alive || gen !== genRef.current) return;
      const next = new Map<string, FileFormInfo>();
      for (const [path, entry] of cache) next.set(path, entry.info);
      setPublished(next);
      if (transientFailure) {
        retryTimer = setTimeout(() => {
          if (alive && gen === genRef.current) void run();
        }, 250);
      }
    };
    void run();
    return () => {
      alive = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [files]);

  return published;
}
