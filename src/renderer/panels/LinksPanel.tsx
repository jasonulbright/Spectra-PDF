import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

interface Link {
  page: number;
  index: number;
  kind: 'uri' | 'internal' | 'other';
  target: string;
  rect: number[] | null;
}

export function LinksPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [links, setLinks] = useState<Link[]>([]);
  const [editing, setEditing] = useState<{ page: number; index: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = await call('list_links', { file: workingPath });
      setLinks((res as unknown as { links: Link[] }).links ?? []);
    } catch {
      setLinks([]);
    }
  }, [workingPath, call]);

  useEffect(() => {
    setEditing(null);
    if (!buffer || !workingPath) {
      setLinks([]);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  const runMutation = useCallback(
    async (method: string, params: Record<string, unknown>, done: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus('Working…');
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call(method, { file: activeFile.workingPath, output: activeFile.workingPath, ...params });
        const buf = await file.readBuffer(activeFile.workingPath);
        const info = await call('get_page_count', { file: activeFile.workingPath });
        dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
        await refresh();
        setStatus(done);
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, dispatch, refresh],
  );

  const saveUrl = useCallback(
    (l: Link) => {
      if (!draft.trim()) {
        setStatus('Enter a URL');
        return;
      }
      setEditing(null);
      void runMutation('set_link_url', { page: l.page, index: l.index, url: draft.trim() }, 'Link updated');
    },
    [draft, runMutation],
  );

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to manage its links" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      {links.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="links-empty">This document has no links.</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="links-list">
          <div className="text-sm text-neutral-300" data-testid="links-summary">
            {links.length} link{links.length === 1 ? '' : 's'}
          </div>
          {links.map((l) => {
            const isEditing = editing?.page === l.page && editing?.index === l.index;
            return (
              <div key={`${l.page}:${l.index}`} data-testid="link-item" className="flex items-center gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-neutral-500">Page {l.page} · {l.kind}</div>
                  {isEditing ? (
                    <input
                      data-testid={`link-url-input-${l.page}-${l.index}`}
                      type="text"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveUrl(l);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      className="w-full mt-0.5 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
                    />
                  ) : (
                    <div className="text-sm text-neutral-200 truncate" title={l.target}>{l.target || '(no target)'}</div>
                  )}
                </div>
                {isEditing ? (
                  <button
                    data-testid={`link-save-${l.page}-${l.index}`}
                    onClick={() => saveUrl(l)}
                    disabled={busy}
                    className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded"
                  >
                    Save
                  </button>
                ) : (
                  <button
                    data-testid={`link-edit-${l.page}-${l.index}`}
                    onClick={() => {
                      setDraft(l.kind === 'uri' ? l.target : '');
                      setEditing({ page: l.page, index: l.index });
                    }}
                    disabled={busy}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                  >
                    Set URL
                  </button>
                )}
                <button
                  data-testid={`link-delete-${l.page}-${l.index}`}
                  onClick={() => void runMutation('delete_link', { page: l.page, index: l.index }, 'Link removed')}
                  disabled={busy}
                  className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
