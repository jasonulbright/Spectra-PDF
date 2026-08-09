import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import { suffixedOutputName } from '../lib/output-names';

export function RebuildPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleRebuild = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "rebuilt"));
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.rebuild.rebuilding'));
    try {
      const r = await call('rebuild', { file: activeFile.workingPath, output, gs_path: await ensureGsPath() });
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.rebuilt_size / 1024).toFixed(0);
      setStatus(tChrome('panel.rebuild.done', { from: orig, to: out, pages: r.pages }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.rebuild.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <p className="text-sm text-neutral-500">{tChrome('panel.rebuild.blurb')}</p>
      <p className="text-xs text-amber-500/80">{tChrome('panel.rebuild.note')}</p>
      <button onClick={handleRebuild} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.rebuild.rebuildingBtn') : tChrome('panel.rebuild.rebuild')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
