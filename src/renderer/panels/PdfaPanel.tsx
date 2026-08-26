import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { StandardsAlterations } from '../components/StandardsAlterations';
import { gsBlocked, requireGsPath } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from '../components/GsRequiredNotice';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { suffixedOutputName } from '../lib/output-names';
import type { StandardsReport } from '../lib/standards-report';

export function PdfaPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [level, setLevel] = useState('2b');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<StandardsReport | null>(null);
  const gs = useGsCapability();

  const handleConvert = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "pdfa"));
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.pdfa.converting'));
    // The previous run's report describes a file this run is replacing.
    setReport(null);
    try {
      const r = await call('convert_pdfa', { file: activeFile.workingPath, output, level, gs_path: await requireGsPath() });
      // The file's own claim, read back out of its metadata — not the level
      // that was asked for. The engine refuses when the two disagree, so they
      // agree here; stating the read-back one keeps the sentence true to what
      // was verified rather than to what was requested.
      setStatus(tChrome('panel.pdfa.done', {
        level: r.declared_conformance || r.level,
        size: (r.output_size / 1024).toFixed(0),
      }));
      setReport(r);
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, level, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.pdfa.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span></div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.pdfa.level')}</label>
        <select aria-label={tChrome('panel.pdfa.levelAria')} value={level} onChange={(e) => setLevel(e.target.value)} className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm">
          <option value="1b">PDF/A-1b</option><option value="2b">PDF/A-2b</option><option value="3b">PDF/A-3b</option>
        </select>
      </div>
      <p data-testid="pdfa-claim-note" className="text-xs text-neutral-500">
        {tChrome('panel.pdfa.claimNote')}
      </p>
      <GsRequiredNotice capability={gs} testId="pdfa-gs" />
      <button onClick={handleConvert} disabled={busy || gsBlocked(gs)} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.pdfa.convertingBtn') : tChrome('panel.pdfa.convert')}
      </button>
      <StatusBar message={status} busy={busy} />
      <StandardsAlterations report={report} />
    </div>
  );
}
