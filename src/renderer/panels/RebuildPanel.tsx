import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';

export function RebuildPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleRebuild = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('rebuilt.pdf');
    if (!output) return;
    setBusy(true); setStatus('Rebuilding PDF (Tier 2: Ghostscript round-trip)...');
    try {
      const r = await call('rebuild', { file: activeFile.workingPath, output, gs_path: await ensureGsPath() });
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.rebuilt_size / 1024).toFixed(0);
      setStatus(`Rebuilt: ${orig} KB -> ${out} KB, ${r.pages} pages.`);
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to rebuild" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)</div>
      <p className="text-sm text-neutral-500">
        Deep rebuild via Ghostscript. Re-renders every page through the GS interpreter into a fresh PDF.
        Fixes font embedding issues, colorspace problems, and corrupt content streams.
      </p>
      <p className="text-xs text-amber-500/80">
        Note: May lose interactive elements (form fields, JavaScript actions). Use Tier 1 Repair first for lighter fixes.
      </p>
      <button onClick={handleRebuild} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? 'Rebuilding...' : 'Rebuild'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
