import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

interface Attachment {
  name: string;
  size: number;
  description: string;
  mime: string;
}

function human(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [items, setItems] = useState<Attachment[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = await call('list_attachments', { file: workingPath });
      setItems((res as unknown as { attachments: Attachment[] }).attachments ?? []);
    } catch {
      setItems([]);
    }
  }, [workingPath, call]);

  useEffect(() => {
    if (!buffer || !workingPath) {
      setItems([]);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  const reloadFile = useCallback(
    async (snapshotPath: string) => {
      if (!activeFile) return;
      const buf = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
    },
    [activeFile, call, dispatch],
  );

  const handleAdd = useCallback(async () => {
    if (!activeFile) return;
    const source = await dialog.pickAnyFile();
    if (!source) return;
    setBusy(true);
    setStatus('Attaching…');
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const r = await call('add_attachment', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        source,
      });
      await reloadFile(snapshotPath);
      await refresh();
      setStatus(`Attached ${(r as unknown as { name: string }).name}`);
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, reloadFile, refresh]);

  const handleExtract = useCallback(
    async (name: string) => {
      if (!activeFile) return;
      const output = await saveFile(name);
      if (!output) return;
      setBusy(true);
      setStatus('Extracting…');
      try {
        await call('extract_attachment', { file: activeFile.workingPath, name, output });
        setStatus(`Saved ${name}`);
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, saveFile],
  );

  const handleRemove = useCallback(
    async (name: string) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus('Removing…');
      try {
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call('remove_attachment', { file: activeFile.workingPath, output: activeFile.workingPath, name });
        await reloadFile(snapshotPath);
        await refresh();
        setStatus(`Removed ${name}`);
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, reloadFile, refresh],
  );

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to manage its attachments" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <div>
        <button
          data-testid="attach-add"
          onClick={handleAdd}
          disabled={busy}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          Attach a file…
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="attach-empty">This document has no attachments.</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="attach-list">
          {items.map((a) => (
            <div key={a.name} data-testid="attach-item" className="flex items-center gap-3 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-neutral-200 truncate" title={a.name}>{a.name}</div>
                <div className="text-xs text-neutral-500">
                  {human(a.size)}{a.mime ? ` · ${a.mime}` : ''}{a.description ? ` · ${a.description}` : ''}
                </div>
              </div>
              <button
                data-testid={`attach-extract-${a.name}`}
                onClick={() => handleExtract(a.name)}
                disabled={busy}
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
              >
                Save…
              </button>
              <button
                data-testid={`attach-remove-${a.name}`}
                onClick={() => handleRemove(a.name)}
                disabled={busy}
                className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
