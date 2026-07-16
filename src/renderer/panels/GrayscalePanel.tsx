import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';

export function GrayscalePanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleGrayscale = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('grayscale.pdf');
    if (!output) return;
    setBusy(true); setStatus('Converting to grayscale...');
    try {
      const r = await call('grayscale', { file: activeFile.workingPath, output, gs_path: await ensureGsPath() });
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.output_size / 1024).toFixed(0);
      setStatus(`${orig} KB \u2192 ${out} KB`);
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to convert to grayscale" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)</div>
      <p className="text-sm text-neutral-500">Converts all colors to grayscale. Useful for B&amp;W printing or archival.</p>
      <button onClick={handleGrayscale} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? 'Converting...' : 'Convert to Grayscale'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
