import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';

export function PdfaPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [level, setLevel] = useState('2b');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleConvert = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('output-pdfa.pdf');
    if (!output) return;
    setBusy(true); setStatus('Converting to PDF/A...');
    try {
      const r = await call('convert_pdfa', { file: activeFile.workingPath, output, level, gs_path: await ensureGsPath() });
      setStatus(`Converted to ${r.level} (${(r.output_size / 1024).toFixed(0)} KB)`);
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, level, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to convert to PDF/A" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span></div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">Conformance Level</label>
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm">
          <option value="1b">PDF/A-1b</option><option value="2b">PDF/A-2b</option><option value="3b">PDF/A-3b</option>
        </select>
      </div>
      <button onClick={handleConvert} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? 'Converting...' : 'Convert to PDF/A'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
