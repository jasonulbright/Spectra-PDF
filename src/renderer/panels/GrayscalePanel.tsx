import React, { useState, useCallback } from 'react';
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
import { CONSENT_DECLINED, useEncryptionConsent } from '../hooks/useEncryptionConsent';

export function GrayscalePanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const gs = useGsCapability();
  const { runWithConsent, consentDialog } = useEncryptionConsent();

  const handleGrayscale = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "grayscale"));
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.grayscale.converting'));
    try {
      const gs_path = await requireGsPath();
      const font_dir = await app.getEditFontPath();
      // The conversion cannot carry a protected document's encryption; the
      // engine refuses, and the consent dialog is what re-runs it.
      const r = await runWithConsent((drop_encryption) => call('grayscale', {
        file: activeFile.workingPath, output, gs_path, font_dir, drop_encryption,
      }));
      if (r === CONSENT_DECLINED) { setStatus(''); return; }
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.output_size / 1024).toFixed(0);
      const line = tChrome('panel.grayscale.result', { from: orig, to: out });
      setStatus(r.encryption_removed ? tChrome('panel.common.resultUnprotected', { result: line }) : line);
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, call, saveFile, runWithConsent]);

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
