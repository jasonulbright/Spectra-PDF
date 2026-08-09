import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { PageRangeField } from '../components/PageRangeField';
import { parsePageRangeField } from '../lib/page-range';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

export function DeletePanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [pageInput, setPageInput] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!activeFile || !pageInput.trim()) { setStatus(tChrome('panel.delete.enterPages')); return; }
    const scope = parsePageRangeField(pageInput);
    // `all` is readable syntax that names every page — a delete of which is a
    // zero-page file, refused three layers down. Refusing it here says so.
    if ('error' in scope || scope.pages === undefined) {
      setStatus(tChrome('panel.delete.badPages'));
      return;
    }
    const pages = scope.pages;
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
      <PageRangeField
        value={pageInput}
        onChange={setPageInput}
        label="panel.delete.pagesLabel"
        ariaLabel="panel.delete.pagesAria"
        testIdPrefix="delete"
        className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
      />
      <button onClick={handleDelete} disabled={busy || !pageInput.trim()} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.delete.deletingBtn') : tChrome('panel.delete.delete')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
