import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

export function DeletePanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [pageInput, setPageInput] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!activeFile || !pageInput.trim()) { setStatus(tChrome('panel.delete.enterPages')); return; }
    const pages = pageInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    setBusy(true); setStatus(tChrome('panel.delete.deleting'));
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('delete', { file: activeFile.workingPath, pages, output: activeFile.workingPath });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      setStatus(tChrome('panel.delete.done', { count: pages.length, remaining: info.pages }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, pageInput, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.delete.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.delete.pagesLabel')}</label>
        <input type="text" value={pageInput} onChange={(e) => setPageInput(e.target.value)} placeholder="2,4,6"
          className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
      </div>
      <button onClick={handleDelete} disabled={busy || !pageInput.trim()} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.delete.deletingBtn') : tChrome('panel.delete.delete')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
