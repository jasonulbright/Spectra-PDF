import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

interface Annot {
  page: number;
  subtype: string;
  rect: number[] | null;
  contents: string;
  author: string;
}
interface Overview {
  annotations: Annot[];
  count: number;
  by_type: Record<string, number>;
}

export function CommentsPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = await call('list_annotations', { file: workingPath });
      setOverview(res as unknown as Overview);
    } catch {
      setOverview(null);
    }
  }, [workingPath, call]);

  useEffect(() => {
    setConfirming(false);
    if (!buffer || !workingPath) {
      setOverview(null);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  const deleteAll = useCallback(async () => {
    if (!activeFile) return;
    setConfirming(false);
    setBusy(true);
    setStatus('Deleting comments…');
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const r = await call('delete_all_annotations', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
      });
      const buf = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
      await refresh();
      const n = (r as unknown as { removed: number }).removed;
      setStatus(`Removed ${n} comment${n === 1 ? '' : 's'} (undo with Ctrl+Z)`);
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, dispatch, refresh]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to review its comments" />;

  const count = overview?.count ?? 0;
  const types = Object.entries(overview?.by_type ?? {});

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      {count === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="comments-empty">This document has no comments.</p>
      ) : (
        <>
          <div className="text-sm text-neutral-300" data-testid="comments-summary">
            {count} comment{count === 1 ? '' : 's'}
            {types.length > 0 && <span className="text-neutral-500"> — {types.map(([t, n]) => `${n} ${t}`).join(', ')}</span>}
          </div>
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto" data-testid="comments-list">
            {overview!.annotations.map((a, i) => (
              <div key={i} data-testid="comment-item" className="px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded">
                <div className="text-xs text-neutral-400">Page {a.page} · {a.subtype}{a.author ? ` · ${a.author}` : ''}</div>
                {a.contents && <div className="text-sm text-neutral-200 truncate" title={a.contents}>{a.contents}</div>}
              </div>
            ))}
          </div>
          {confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-amber-300">Delete all {count} comments?</span>
              <button
                data-testid="comments-delete-confirm"
                onClick={() => void deleteAll()}
                disabled={busy}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded text-sm font-medium"
              >
                Delete all
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              data-testid="comments-delete-all"
              onClick={() => setConfirming(true)}
              disabled={busy}
              className="self-start px-3 py-1.5 bg-neutral-800 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-50 rounded text-sm font-medium"
            >
              Delete all comments
            </button>
          )}
        </>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
