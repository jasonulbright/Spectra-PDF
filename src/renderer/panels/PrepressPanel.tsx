import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { StandardsAlterations } from '../components/StandardsAlterations';
import { ensureGsPath } from './SettingsPanel';
import { dialog } from '../lib/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import type { PanelKey } from '../i18n-panels';
import { suffixedOutputName } from '../lib/output-names';
import type { StandardsReport } from '../lib/standards-report';

// ICC-managed CMYK conversion for prepress (Ghostscript). Like
// grayscale/pdfa it writes a new file (the "Optimize" tool group's pattern);
// the render intent maps to Ghostscript's ICC transform.
// Only intents that produce a DISTINCT result with the bundled default CMYK
// profile are offered — that profile carries no Saturation table, so
// "saturation" would render identically to "perceptual" (a control that does
// nothing, the silent-degradation class). It returns to the picker when
// a user-picked destination profile is in play only if that profile defines
// it — which we cannot know cheaply, so it stays withheld (recorded).
const RENDER_INTENTS: { value: string; label: PanelKey }[] = [
  { value: 'relative', label: 'panel.prepress.intentRelative' },
  { value: 'perceptual', label: 'panel.prepress.intentPerceptual' },
  { value: 'absolute', label: 'panel.prepress.intentAbsolute' },
];

// tail: PDF/X print masters. X-3 is the colour-managed default; X-1a the
// CMYK-only legacy exchange; X-4 allows live transparency.
const PDFX_VERSIONS: { value: number; label: PanelKey }[] = [
  { value: 3, label: 'panel.prepress.x3' },
  { value: 1, label: 'panel.prepress.x1a' },
  { value: 4, label: 'panel.prepress.x4' },
];

/** The destination-profile row shared by both actions: empty = Ghostscript's
 * built-in default CMYK; "bundled" = gs's own default_cmyk.icc by ROM name
 * (extractable, so PDF/X can embed it); or a user's .icc file. */
type ProfileChoice = { kind: 'default' } | { kind: 'bundled' } | { kind: 'file'; path: string };

const profileParam = (p: ProfileChoice): string =>
  p.kind === 'default' ? '' : p.kind === 'bundled' ? 'default_cmyk.icc' : p.path;

export function PrepressPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<StandardsReport | null>(null);
  const [renderIntent, setRenderIntent] = useState('relative');
  const [profile, setProfile] = useState<ProfileChoice>({ kind: 'default' });
  const [pdfxVersion, setPdfxVersion] = useState(3);
  const [condition, setCondition] = useState('Commercial and specialty printing');
  const [identifier, setIdentifier] = useState('CGATS TR001');

  const pickProfile = useCallback(async () => {
    const p = await dialog.pickIccFile();
    if (p) setProfile({ kind: 'file', path: p });
  }, []);

  const handleConvert = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "cmyk"));
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('panel.prepress.convertingCmyk'));
    // A report left on screen would describe a file this action did not write.
    setReport(null);
    try {
      const r = await call('convert_cmyk', {
        file: activeFile.workingPath,
        output,
        render_intent: renderIntent,
        dest_profile: profileParam(profile),
        gs_path: await ensureGsPath(),
      });
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.output_size / 1024).toFixed(0);
      setStatus(tChrome('panel.prepress.cmykDone', { from: orig, to: out }));
      // A colour conversion can destroy a printing plate while every mark
      // stays on the page, so its own report is drawn beside the result.
      setReport(r);
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, saveFile, renderIntent, profile]);

  const handlePdfx = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "pdfx"));
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('panel.prepress.creatingPdfx'));
    setReport(null);
    try {
      const r = await call('convert_pdfx', {
        file: activeFile.workingPath,
        output,
        version: pdfxVersion,
        dest_profile: profileParam(profile),
        condition,
        identifier,
        gs_path: await ensureGsPath(),
      });
      setStatus(
        tChrome('panel.prepress.pdfxDone', {
          version: r.pdfx_version,
          suffix: r.embedded_profile
            ? tChrome('panel.prepress.pdfxEmbedded')
            : tChrome('panel.prepress.pdfxNames', { identifier }),
        }),
      );
      setReport(r);
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, saveFile, pdfxVersion, profile, condition, identifier]);

  if (!activeFile)
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.prepress.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})
      </div>
      <p className="text-sm text-neutral-500">{tChrome('panel.prepress.blurb')}</p>
      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <span className="w-28 shrink-0 text-neutral-400">{tChrome('panel.prepress.renderIntent')}</span>
        <select
          data-testid="cmyk-render-intent"
          value={renderIntent}
          onChange={(e) => setRenderIntent(e.target.value)}
          className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        >
          {RENDER_INTENTS.map((ri) => (
            <option key={ri.value} value={ri.value}>
              {tChrome(ri.label)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2 text-sm text-neutral-300">
        <span className="w-28 shrink-0 text-neutral-400">{tChrome('panel.prepress.destination')}</span>
        <select
          data-testid="cmyk-dest-profile"
          aria-label={tChrome('panel.prepress.destinationAria')}
          value={profile.kind}
          onChange={(e) => {
            const k = e.target.value;
            if (k === 'file') void pickProfile();
            else setProfile({ kind: k as 'default' | 'bundled' });
          }}
          className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="default">{tChrome('panel.prepress.profileDefault')}</option>
          <option value="bundled">{tChrome('panel.prepress.profileBundled')}</option>
          <option value="file">{tChrome('panel.prepress.profileFile')}</option>
        </select>
        {profile.kind === 'file' && (
          <span className="text-xs text-neutral-400 truncate" title={profile.path}>
            {profile.path.split(/[\\/]/).pop()}
          </span>
        )}
      </div>
      <button
        data-testid="cmyk-convert"
        onClick={handleConvert}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? tChrome('panel.prepress.converting') : tChrome('panel.prepress.convertCmyk')}
      </button>

      <div className="border-t border-neutral-800 pt-4 flex flex-col gap-3">
        <p className="text-sm text-neutral-500">{tChrome('panel.prepress.pdfxBlurb')}</p>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="w-28 shrink-0 text-neutral-400">{tChrome('panel.prepress.standard')}</span>
          <select
            data-testid="pdfx-version"
            value={pdfxVersion}
            onChange={(e) => setPdfxVersion(Number(e.target.value))}
            className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          >
            {PDFX_VERSIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {tChrome(v.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="w-28 shrink-0 text-neutral-400">{tChrome('panel.prepress.condition')}</span>
          <input
            data-testid="pdfx-condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className="flex-1 max-w-md px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="w-28 shrink-0 text-neutral-400">{tChrome('panel.prepress.identifier')}</span>
          <input
            data-testid="pdfx-identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={tChrome('panel.prepress.identifierPlaceholder')}
            className="flex-1 max-w-md px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </label>
        <button
          data-testid="pdfx-convert"
          onClick={handlePdfx}
          disabled={busy}
          className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          {busy ? tChrome('panel.prepress.working') : tChrome('panel.prepress.createPdfx')}
        </button>
      </div>
      <StatusBar message={status} busy={busy} />
      <StandardsAlterations report={report} />
    </div>
  );
}
