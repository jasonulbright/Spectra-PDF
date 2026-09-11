import React, { useState, useCallback, useEffect } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { gsBlocked, requireGsPath } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from '../components/GsRequiredNotice';
import { app } from '../lib/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import { suffixedOutputName } from '../lib/output-names';
import { consentStopped, useEncryptionConsent } from '../hooks/useEncryptionConsent';

import { useOwnedDocumentRun } from '../hooks/useOwnedDocumentRun';
import { runCommitGate } from '../lib/commit-gate';

export function GrayscalePanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const gs = useGsCapability();
  const { runWithConsent, consentDialog } = useEncryptionConsent();
  const beginRun = useOwnedDocumentRun(activeFile);
  useEffect(() => { setStatus(''); }, [activeFile?.workingPath, activeFile?.buffer]);

  const handleGrayscale = useCallback(async () => {
    const run = beginRun();
    if (!run || !activeFile) return;
    setBusy(true); setStatus(tChrome('panel.grayscale.converting'));
    try {
      await run.prepare(runCommitGate);
      const output = await saveFile(suffixedOutputName(activeFile.name, 'grayscale'));
      if (!output) { if (run.visible()) setStatus(''); return; }
      run.assertCurrent();
      const gs_path = await requireGsPath();
      const font_dir = await app.getEditFontPath();
      // The conversion cannot carry a protected document's encryption; the
      // engine refuses, and the consent dialog is what re-runs it.
      const r = await runWithConsent((drop_encryption) => call('grayscale', {
        file: activeFile.workingPath, output, gs_path, font_dir, drop_encryption,
      }, { assertCurrent: run.assertCurrent }), { isCurrent: run.isCurrent, subject: `${activeFile.name} → ${output}` });
      if (consentStopped(r)) { if (run.visible()) setStatus(''); return; }
      if (!run.visible()) return;
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.output_size / 1024).toFixed(0);
      const line = tChrome('panel.grayscale.result', { from: orig, to: out });
      setStatus(r.encryption_removed ? tChrome('panel.common.resultUnprotected', { result: line }) : line);
    } catch (e: unknown) { if (run.visible()) setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { run.finish(); setBusy(false); }
  }, [activeFile, call, saveFile, runWithConsent, beginRun]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.grayscale.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <p className="text-sm text-neutral-500">{tChrome('panel.grayscale.blurb')}</p>
      <GsRequiredNotice capability={gs} testId="grayscale-gs" />
      <button data-testid="grayscale-convert" onClick={handleGrayscale} disabled={busy || gsBlocked(gs)} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium">
        {busy ? tChrome('panel.grayscale.convertingBtn') : tChrome('panel.grayscale.convert')}
      </button>
      <StatusBar message={status} busy={busy} />
      {consentDialog}
    </div>
  );
}
