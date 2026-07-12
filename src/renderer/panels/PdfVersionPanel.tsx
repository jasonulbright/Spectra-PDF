import React, { useState, useCallback, useEffect } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

const VERSIONS = ['1.4', '1.5', '1.6', '1.7', '2.0'];

export function PdfVersionPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [version, setVersion] = useState('1.7');
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Keyed on workingPath (stable per path, unlike the activeFile object
  // which swaps on every buffer update) — the intent the old lint-suppressed
  // `activeFile?.path` dependency encoded.
  const workingPath = activeFile?.workingPath ?? null;
  useEffect(() => {
    if (!workingPath) { setCurrentVersion(null); return; }
    let cancelled = false;
    call('get_pdf_version', { file: workingPath }).then((r) => {
      if (!cancelled) {
        setCurrentVersion(r.version);
        setStatus(`Current version: PDF ${r.version}`);
      }
    }).catch((e: unknown) => { if (!cancelled) setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { cancelled = true; };
  }, [workingPath, call]);

  const handleSetVersion = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('reversion.pdf');
    if (!output) return;
    setBusy(true); setStatus('Setting PDF version...');
    try {
      const r = await call('set_pdf_version', { file: activeFile.workingPath, output, version });
      setStatus(`PDF ${r.original_version} \u2192 PDF ${r.target_version}`);
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, version, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to change its version" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span></div>
      {currentVersion && (
        <div className="text-sm text-neutral-500">Current version: <span className="text-neutral-300">PDF {currentVersion}</span></div>
      )}
      <div>
        <label className="block text-sm text-neutral-400 mb-1">Target Version</label>
        <select value={version} onChange={(e) => setVersion(e.target.value)} className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm">
          {VERSIONS.map((v) => <option key={v} value={v}>PDF {v}</option>)}
        </select>
      </div>
      <button onClick={handleSetVersion} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? 'Setting version...' : 'Set Version'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
