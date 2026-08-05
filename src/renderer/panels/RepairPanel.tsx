import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine, type EngineResult } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

export function RepairPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // Which operation is running — the busy-button labels used to sniff
  // the English status text (status.includes('Repairing')), which a
  // localized status silently breaks. State, not string matching.
  const [busyOp, setBusyOp] = useState<'check' | 'repair' | null>(null);
  const [checkResult, setCheckResult] = useState<EngineResult | null>(null);

  const handleCheck = useCallback(async () => {
    if (!activeFile) return;
    setBusy(true); setBusyOp('check'); setStatus(tChrome('panel.repair.validating'));
    try {
      const r = await call('check', { file: activeFile.workingPath });
      setCheckResult(r);
      const { errors, warnings } = r.summary;
      if (errors === 0 && warnings === 0) {
        setStatus(tChrome('panel.repair.valid'));
      } else {
        setStatus(tChrome('panel.repair.found', { errors, warnings }));
      }
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); setCheckResult(null); }
    finally { setBusy(false); setBusyOp(null); }
  }, [activeFile, call]);

  const handleRepair = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('repaired.pdf');
    if (!output) return;
    setBusy(true); setBusyOp('repair'); setStatus(tChrome('panel.repair.repairing'));
    try {
      const r = await call('repair', { file: activeFile.workingPath, output });
      const issues = r.issues_found?.length || 0;
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.repaired_size / 1024).toFixed(0);
      setStatus(tChrome('panel.repair.repaired', {
        from: orig, to: out, pages: r.pages, issues,
      }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); setBusyOp(null); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.repair.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <p className="text-sm text-neutral-500">{tChrome('panel.repair.blurb')}</p>
      <div className="flex gap-2">
        <button onClick={handleCheck} disabled={busy} className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm font-medium">
          {busyOp === 'check' ? tChrome('panel.repair.checking') : tChrome('panel.repair.validateFirst')}
        </button>
        <button onClick={handleRepair} disabled={busy} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
          {busyOp === 'repair' ? tChrome('panel.repair.busy') : tChrome('panel.repair.repair')}
        </button>
      </div>
      {checkResult && checkResult.issues && checkResult.issues.length > 0 && (
        <div className="bg-neutral-800 rounded p-3 text-xs max-h-48 overflow-y-auto" tabIndex={0} role="region" aria-label={tChrome('panel.repair.reportAria')}>
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
