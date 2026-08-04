import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine, type EngineResult } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

export function RecoverPanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<EngineResult | null>(null);

  const handleRecover = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('recovered.pdf');
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.recover.recovering'));
    setReport(null);
    try {
      const r = await call('recover', { file: activeFile.workingPath, output });
      setReport(r);
      if (r.lost === 0) {
        setStatus(tChrome('panel.recover.doneAll', { count: r.recovered }));
      } else {
        setStatus(tChrome('panel.recover.donePartial', {
          recovered: r.recovered, total: r.total_pages, lost: r.lost,
        }));
      }
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); setReport(null); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.recover.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <p className="text-sm text-neutral-500">{tChrome('panel.recover.blurb')}</p>
      <button onClick={handleRecover} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.recover.busy') : tChrome('panel.recover.recover')}
      </button>
      {report && report.lost_pages && report.lost_pages.length > 0 && (
        <div className="bg-neutral-800 rounded p-3 text-xs max-h-48 overflow-y-auto" tabIndex={0} role="region" aria-label={tChrome('panel.recover.reportAria')}>
          <div className="text-neutral-300 mb-1 font-medium">{tChrome('panel.recover.reportTitle')}</div>
          <div className="text-green-400 mb-1">{tChrome('panel.recover.recoveredPages', { pages: report.recovered_pages.join(', ') })}</div>
          <div className="text-red-400 mb-1">{tChrome('panel.recover.lostPages')}</div>
          {report.lost_pages.map((lp, i: number) => (
            <div key={i} className="text-red-400 pl-2">
              {tChrome('panel.recover.lostLine', { page: lp.page, error: lp.error })}
            </div>
          ))}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
