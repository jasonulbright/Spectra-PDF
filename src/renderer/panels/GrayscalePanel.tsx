import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import { suffixedOutputName } from '../lib/output-names';

export function GrayscalePanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleGrayscale = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "grayscale"));
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.grayscale.converting'));
    try {
      const r = await call('grayscale', { file: activeFile.workingPath, output, gs_path: await ensureGsPath() });
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.output_size / 1024).toFixed(0);
      setStatus(tChrome('panel.grayscale.result', { from: orig, to: out }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.grayscale.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <p className="text-sm text-neutral-500">{tChrome('panel.grayscale.blurb')}</p>
      <button onClick={handleGrayscale} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.grayscale.convertingBtn') : tChrome('panel.grayscale.convert')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
