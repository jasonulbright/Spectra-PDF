import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine, type EngineResult } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

export function RepairPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<EngineResult | null>(null);

  const handleCheck = useCallback(async () => {
    if (!activeFile) return;
    setBusy(true); setStatus('Validating PDF structure...');
    try {
      const r = await call('check', { file: activeFile.workingPath });
      setCheckResult(r);
      const { errors, warnings } = r.summary;
      if (errors === 0 && warnings === 0) {
        setStatus('PDF structure is valid. No issues found.');
      } else {
        setStatus(`Found ${errors} error(s), ${warnings} warning(s).`);
      }
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); setCheckResult(null); }
    finally { setBusy(false); }
  }, [activeFile, call]);

  const handleRepair = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('repaired.pdf');
    if (!output) return;
    setBusy(true); setStatus('Repairing PDF (Tier 1: QPDF rewrite)...');
    try {
      const r = await call('repair', { file: activeFile.workingPath, output });
      const issues = r.issues_found?.length || 0;
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.repaired_size / 1024).toFixed(0);
      setStatus(`Repaired: ${orig} KB -> ${out} KB, ${r.pages} pages. ${issues} issue(s) addressed.`);
    } catch (e: unknown) { setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to repair" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)</div>
      <p className="text-sm text-neutral-500">
        Light repair using pikepdf/QPDF. Fixes broken xref tables, stream lengths, and page tree corruption.
        Preserves annotations, bookmarks, and metadata.
      </p>
      <div className="flex gap-2">
        <button onClick={handleCheck} disabled={busy} className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm font-medium">
          {busy && !status.includes('Repairing') ? 'Checking...' : 'Validate First'}
        </button>
        <button onClick={handleRepair} disabled={busy} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
          {busy && status.includes('Repairing') ? 'Repairing...' : 'Repair'}
        </button>
      </div>
      {checkResult && checkResult.issues && checkResult.issues.length > 0 && (
        <div className="bg-neutral-800 rounded p-3 text-xs max-h-48 overflow-y-auto" tabIndex={0} role="region" aria-label="Validation report">
          {checkResult.issues.map((issue, i: number) => (
            <div key={i} className={`py-0.5 ${
              issue.severity === 'error' ? 'text-red-400' :
              issue.severity === 'warning' ? 'text-amber-400' : 'text-neutral-400'
            }`}>
              [{issue.severity}] {issue.category}: {issue.message}
            </div>
          ))}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
