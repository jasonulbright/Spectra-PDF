import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine, type EngineResult } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

export function RecoverPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<EngineResult | null>(null);

  const handleRecover = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('recovered.pdf');
    if (!output) return;
    setBusy(true); setStatus('Recovering pages (Tier 3: per-page salvage)...');
    setReport(null);
    try {
      const r = await call('recover', { file: activeFile.workingPath, output });
      setReport(r);
      if (r.lost === 0) {
        setStatus(`Recovered all ${r.recovered} pages successfully.`);
      } else {
        setStatus(`Recovered ${r.recovered}/${r.total_pages} pages. ${r.lost} page(s) could not be salvaged.`);
      }
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); setReport(null); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a damaged PDF to recover pages" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)</div>
      <p className="text-sm text-neutral-500">
        Salvage recovery for severely damaged PDFs. Extracts each page individually and assembles
        salvageable pages into a new clean PDF. Reports which pages were lost.
      </p>
      <button onClick={handleRecover} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? 'Recovering...' : 'Recover Pages'}
      </button>
      {report && report.lost_pages && report.lost_pages.length > 0 && (
        <div className="bg-neutral-800 rounded p-3 text-xs max-h-48 overflow-y-auto" tabIndex={0} role="region" aria-label="Recovery report">
          <div className="text-neutral-300 mb-1 font-medium">Recovery Report</div>
          <div className="text-green-400 mb-1">Recovered: pages {report.recovered_pages.join(', ')}</div>
          <div className="text-red-400 mb-1">Lost pages:</div>
          {report.lost_pages.map((lp, i: number) => (
            <div key={i} className="text-red-400 pl-2">
              Page {lp.page}: {lp.error}
            </div>
          ))}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
