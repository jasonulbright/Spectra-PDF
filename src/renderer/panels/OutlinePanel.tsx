import React, { useCallback, useEffect, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import type { OutlineNode } from '../hooks/useEngine';

// Immutable tree update by index path.
function updateAt(nodes: OutlineNode[], path: number[], fn: (n: OutlineNode) => OutlineNode | null): OutlineNode[] {
  const [head, ...rest] = path;
  return nodes.flatMap((node, i) => {
    if (i !== head) return [node];
    if (rest.length === 0) {
      const next = fn(node);
      return next ? [next] : [];
    }
    return [{ ...node, children: updateAt(node.children, rest, fn) }];
  });
}

function NodeRow({
  node,
  path,
  pageCount,
  onChange,
}: {
  node: OutlineNode;
  path: number[];
  pageCount: number;
  onChange: (path: number[], fn: (n: OutlineNode) => OutlineNode | null) => void;
}): React.ReactElement {
  return (
    <div style={{ marginLeft: path.length > 1 ? 16 : 0 }}>
      <div className="flex items-center gap-2 py-0.5 group">
        <input
          data-testid="outline-title"
          value={node.title}
          onChange={(e) => onChange(path, (n) => ({ ...n, title: e.target.value }))}
          className="flex-1 min-w-0 px-2 py-0.5 bg-transparent hover:bg-neutral-800 focus:bg-neutral-800 border border-transparent focus:border-neutral-700 rounded text-sm focus:outline-none"
        />
        <input
          data-testid="outline-page"
          type="number"
          min={1}
          max={pageCount}
          value={node.page ?? ''}
          placeholder="—"
          title="Target page"
          onChange={(e) => {
            const v = e.target.value === '' ? null : Math.max(1, Math.min(pageCount, Number(e.target.value)));
            onChange(path, (n) => ({ ...n, page: v }));
          }}
          className="w-16 px-2 py-0.5 bg-neutral-800 border border-neutral-700 rounded text-xs text-right focus:outline-none focus:border-blue-500"
        />
        <button
          title="Add child bookmark"
          onClick={() =>
            onChange(path, (n) => ({ ...n, children: [...n.children, { title: 'Untitled', page: null, children: [] }] }))
          }
          className="px-1.5 text-neutral-500 hover:text-neutral-200 opacity-0 group-hover:opacity-100 text-xs"
        >
          +
        </button>
        <button
          title="Remove bookmark (and children)"
          onClick={() => onChange(path, () => null)}
          className="px-1.5 text-neutral-500 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs"
        >
          x
        </button>
      </div>
      {node.children.map((child, i) => (
        <NodeRow key={i} node={child} path={[...path, i]} pageCount={pageCount} onChange={onChange} />
      ))}
    </div>
  );
}

export function OutlinePanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // (Re)load whenever the active file or its bytes change.
  useEffect(() => {
    if (!activeFile) return;
    const key = `${activeFile.path}#${activeFile.pageCount}#${activeFile.undoStack.length}`;
    if (key === loadedFor) return;
    let cancelled = false;
    call('get_outline', { file: activeFile.workingPath })
      .then((res) => {
        if (cancelled) return;
        setNodes((res.outline as OutlineNode[]) ?? []);
        setLoadedFor(key);
        setEdited(false);
        setStatus(res.truncated ? 'Outline truncated (too many bookmarks)' : '');
      })
      .catch((e: unknown) => setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [activeFile, call, loadedFor]);

  const onChange = useCallback((path: number[], fn: (n: OutlineNode) => OutlineNode | null) => {
    setNodes((prev) => updateAt(prev, path, fn));
    setEdited(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    setBusy(true);
    setStatus('Saving bookmarks…');
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('set_outline', {
        file: activeFile.workingPath,
        outline: nodes,
        output: activeFile.workingPath,
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      dispatch({
        type: 'UPDATE_FILE',
        path: activeFile.path,
        pageCount: activeFile.pageCount,
        buffer,
        snapshotPath,
      });
      setEdited(false);
      setStatus('Bookmarks saved');
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, nodes, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to edit its bookmarks" />;

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="text-sm text-neutral-400 shrink-0">
        Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto border border-neutral-800 rounded p-2">
        {nodes.length === 0 ? (
          <div className="text-sm text-neutral-500 px-2 py-4">No bookmarks yet.</div>
        ) : (
          nodes.map((node, i) => (
            <NodeRow key={i} node={node} path={[i]} pageCount={activeFile.pageCount} onChange={onChange} />
          ))
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          data-testid="outline-add"
          onClick={() => {
            setNodes((prev) => [...prev, { title: 'Untitled', page: null, children: [] }]);
            setEdited(true);
          }}
          className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm font-medium"
        >
          Add bookmark
        </button>
        <button
          data-testid="outline-save"
          onClick={handleSave}
          disabled={busy || !edited}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          {busy ? 'Saving…' : 'Save bookmarks'}
        </button>
      </div>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
