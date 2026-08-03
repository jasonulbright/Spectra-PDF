import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { getDocumentProxy } from '../lib/pdfDocCache';
import {
  flattenReadingOrder,
  nodePreview,
  pageMcidText,
  pathKey,
  sameParent,
  type StructTree,
} from '../lib/struct-tree';

// The Reading Order panel (§ I.6) — the per-page view of the structure tree's
// traversal order, which is the order assistive technology reads the page in.
// Up/down moves an entry among its SIBLING tags in one atomic engine step;
// entries in different branches say so and point at the Tags tree, where
// indent/outdent can restructure — an honest refusal, never a silent no-op.

export function ReadingOrderPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [tree, setTree] = useState<StructTree | null>(null);
  const [page, setPage] = useState(1);
  const [texts, setTexts] = useState<Map<number, Map<number, string>>>(() => new Map());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const path = activeFile?.path ?? null;
  const pageCount = activeFile?.pageCount ?? 1;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = (await call('get_struct_tree', { file: workingPath })) as unknown as StructTree;
      setTree(res);
    } catch {
      setTree(null);
    }
  }, [workingPath, call]);

  useEffect(() => {
    if (!buffer || !workingPath) {
      setTree(null);
      return;
    }
    setTexts(new Map());
    void refresh();
  }, [buffer, workingPath, refresh]);

  useEffect(() => {
    setPage((p) => Math.min(Math.max(1, p), Math.max(1, pageCount)));
  }, [pageCount]);

  const entries = useMemo(
    () => (tree && tree.tagged ? flattenReadingOrder(tree.root, page) : []),
    [tree, page],
  );

  // The one page on show gets full text previews.
  useEffect(() => {
    if (!path || !buffer || texts.has(page) || entries.length === 0) return;
    let stale = false;
    void (async () => {
      try {
        const proxy = await getDocumentProxy(path, buffer);
        const map = await pageMcidText(proxy, page);
        if (!stale) setTexts((prev) => new Map(prev).set(page, map));
      } catch {
        // previews are a nicety; the order list works without them
      }
    })();
    return () => {
      stale = true;
    };
  }, [path, buffer, page, texts, entries.length]);

  const moveEntry = useCallback(
    async (index: number, delta: -1 | 1) => {
      const entry = entries[index];
      const neighbor = entries[index + delta];
      if (!activeFile || !entry || !neighbor) return;
      setBusy(true);
      setStatus('Working…');
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call('move_struct_node', {
          file: activeFile.workingPath,
          output: activeFile.workingPath,
          path: entry.node.path,
          direction: 'to',
          index: neighbor.node.path[neighbor.node.path.length - 1],
        });
        const buf = await file.readBuffer(activeFile.workingPath);
        const info = await call('get_page_count', { file: activeFile.workingPath });
        dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
        setStatus('Reading order updated');
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [entries, activeFile, call, dispatch],
  );

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to review its reading order" />;

  const pageTexts = texts;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="text-sm text-neutral-400 shrink-0">
        Working on: <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      {!tree || !tree.tagged ? (
        <p className="text-sm text-neutral-500" data-testid="order-untagged">
          This document has no structure tags, so it has no reading order to edit — assistive
          technology falls back to raw content order.
        </p>
      ) : (
        <div className="flex flex-col gap-3 flex-1 min-h-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-neutral-400">Page</span>
            <button
              type="button"
              data-testid="order-prev-page"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={busy || page <= 1}
              aria-label="Previous page"
              className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded"
            >
              ‹
            </button>
            <input
              data-testid="order-page-input"
              type="number"
              min={1}
              max={pageCount}
              value={page}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setPage(Math.min(Math.max(1, Math.round(v)), pageCount));
              }}
              aria-label="Page"
              className="w-16 px-2 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-sm text-neutral-200"
            />
            <span className="text-xs text-neutral-500">of {pageCount}</span>
            <button
              type="button"
              data-testid="order-next-page"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={busy || page >= pageCount}
              aria-label="Next page"
              className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded"
            >
              ›
            </button>
          </div>
          {entries.length === 0 ? (
            <p className="text-sm text-neutral-500" data-testid="order-empty">
              No tagged content on this page.
            </p>
          ) : (
            <ol className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1" data-testid="order-list" tabIndex={0} aria-label="Reading order">
              {entries.map((entry, i) => {
                const key = pathKey(entry.node.path);
                const preview = nodePreview(entry.node, pageTexts);
                const upOk = i > 0 && sameParent(entry.node.path, entries[i - 1].node.path);
                const downOk =
                  i < entries.length - 1 && sameParent(entry.node.path, entries[i + 1].node.path);
                const branchHint =
                  'In a different branch of the tag tree — restructure it in the Tags panel';
                return (
                  <li
                    key={key}
                    data-testid={`order-item-${i}`}
                    className="flex items-center gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
                  >
                    <span className="text-xs text-neutral-500 w-6 text-right shrink-0">{i + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-neutral-200">
                        &lt;{entry.node.type}&gt;
                        {entry.hasObjr && <span className="text-xs text-neutral-500"> [annotation]</span>}
                      </div>
                      {preview && (
                        <div className="text-xs text-neutral-400 truncate" title={preview}>
                          {preview}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      data-testid={`order-up-${i}`}
                      onClick={() => void moveEntry(i, -1)}
                      disabled={busy || !upOk}
                      title={i === 0 ? 'Already first on this page' : upOk ? 'Read this earlier' : branchHint}
                      aria-label="Move earlier in the reading order"
                      className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      data-testid={`order-down-${i}`}
                      onClick={() => void moveEntry(i, 1)}
                      disabled={busy || !downOk}
                      title={
                        i === entries.length - 1
                          ? 'Already last on this page'
                          : downOk
                            ? 'Read this later'
                            : branchHint
                      }
                      aria-label="Move later in the reading order"
                      className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded"
                    >
                      ↓
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
