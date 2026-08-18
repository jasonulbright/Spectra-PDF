import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { PageRangeField } from '../components/PageRangeField';
import { parsePageRangeField } from '../lib/page-range';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

export function DeletePanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { performOperation } = useOperations();
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
      // A panel delete rewrites the whole file, so it takes the whole-file
      // signed-document decision rather than the page tier's delta-aware one.
      const result = await performOperation(activeFile.path, 'delete', { pages });
      if (result === EDIT_DECLINED) {
        setStatus('');
        return;
      }
      // The engine's own counts: a page number outside the file is dropped by
      // `delete`, so `pages.length` would over-report what it removed.
      const answer = result as unknown as { pages_deleted?: number; pages_remaining?: number } | null;
      setStatus(tChrome('panel.delete.done', {
        count: answer?.pages_deleted ?? pages.length,
        remaining: answer?.pages_remaining ?? 0,
      }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, pageInput, performOperation]);

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
