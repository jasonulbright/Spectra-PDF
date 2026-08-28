import React, { useState, useCallback, useEffect } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { StandardsAlterations } from '../components/StandardsAlterations';
import { gsBlocked, gsPathIfAvailable, requireGsPath } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from '../components/GsRequiredNotice';
import { iccBlocked } from '../lib/icc-assent';
import { useIccAssent } from '../hooks/useIccAssent';
import { IccLicenceNotice } from '../components/IccLicenceNotice';
import { app, dialog } from '../lib/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import type { PanelKey } from '../i18n-panels';
import { suffixedOutputName } from '../lib/output-names';
import type { StandardsReport } from '../lib/standards-report';

// ICC-managed CMYK conversion for prepress (Ghostscript). Like
// grayscale/pdfa it writes a new file (the "Optimize" tool group's pattern);
// the render intent maps to Ghostscript's ICC transform.
// All four ICC intents are offered. Saturation was withheld while the
// destination was a profile with no B2A2 table, where it rendered
// identically to perceptual — a control that does nothing. The installed
// press profiles carry that table, so the intent is distinct and offering it
// is the honest state.
const RENDER_INTENTS: { value: string; label: PanelKey }[] = [
  { value: 'relative', label: 'panel.prepress.intentRelative' },
  { value: 'perceptual', label: 'panel.prepress.intentPerceptual' },
  { value: 'saturation', label: 'panel.prepress.intentSaturation' },
  { value: 'absolute', label: 'panel.prepress.intentAbsolute' },
];

// tail: PDF/X print masters. X-3 is the colour-managed default; X-1a the
// CMYK-only legacy exchange; X-4 allows live transparency.
const PDFX_VERSIONS: { value: number; label: PanelKey }[] = [
  { value: 3, label: 'panel.prepress.x3' },
  { value: 1, label: 'panel.prepress.x1a' },
  { value: 4, label: 'panel.prepress.x4' },
];

/**
 * The destination-profile row shared by both actions.
 *
 * The engine resolves an empty `dest_profile` to the installed default press,
 * an ICC DESCRIPTION STRING to that installed press, and anything else as a
 * file path. The previous middle choice sent the literal `default_cmyk.icc`,
 * a Ghostscript ROM name the profile resolver now refuses by name.
 */
type ProfileChoice =
  | { kind: 'default' }
  | { kind: 'installed'; name: string }
  | { kind: 'file'; path: string };

export const profileParam = (p: ProfileChoice): string =>
  p.kind === 'default' ? '' : p.kind === 'installed' ? p.name : p.path;

/**
 * Does this destination come out of the BUNDLED set?
 *
 * The colour-profile licence covers the profiles that SHIP with the product,
 * so it gates those two choices and not a file the user pointed at. A declined
 * copy therefore still converts against the user's own profile — the line
 * between a named-disabled capability and a crippled one, and the same line
 * `icc_profiles.resolve` draws engine-side.
 */
const usesBundledProfile = (p: ProfileChoice): boolean => p.kind !== 'file';

export function PrepressPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const gs = useGsCapability();
  const icc = useIccAssent();
  const [report, setReport] = useState<StandardsReport | null>(null);
  const [renderIntent, setRenderIntent] = useState('relative');
  const [profile, setProfile] = useState<ProfileChoice>({ kind: 'default' });
  // Both actions resolve a destination profile, so both are blocked by an
  // unaccepted licence — but only while the destination is a bundled one.
  const iccBlocks = iccBlocked(icc) && usesBundledProfile(profile);
  // The presses this machine actually has, and which of them an unnamed
  // destination resolves to. Read from the engine rather than named in a
  // string: the picker has to offer real profiles, and the default has to be
  // called what it is.
  const [presses, setPresses] = useState<{ default: string; names: string[] } | null>(null);
  const [pdfxVersion, setPdfxVersion] = useState(3);
  // Empty by default, and empty is not "unset": the engine READS both off the
  // destination profile, so a hardcoded pair would declare a characterization
  // the chosen press may not have.
  const [condition, setCondition] = useState('');
  const [identifier, setIdentifier] = useState('');

  const workingPath = activeFile?.workingPath ?? null;
  useEffect(() => {
    if (!workingPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('list_simulation_profiles', {
          file: workingPath,
          gs_path: await gsPathIfAvailable(),
          icc_dir: await app.getIccPath(),
        });
        if (cancelled) return;
        const bundled = ((res ?? {}) as { bundled?: Record<string, unknown> }).bundled ?? {};
        const names = Array.isArray(bundled.names) ? bundled.names.map(String) : [];
        setPresses({ default: String(bundled.default ?? ''), names });
      } catch {
        // A listing that cannot be read leaves the default press and a file
        // of the user's own — never a picker offering a press that is not
        // installed.
        if (!cancelled) setPresses({ default: '', names: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workingPath, call]);

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
        gs_path: await requireGsPath(),
        font_dir: await app.getEditFontPath(),
        icc_dir: await app.getIccPath(),
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
        // Empty travels: the engine derives both from the profile, and
        // sending a placeholder would declare a condition the press does not.
        condition,
        identifier,
        gs_path: await requireGsPath(),
        icc_dir: await app.getIccPath(),
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
            else if (k === 'installed') {
              setProfile({ kind: 'installed', name: presses?.names[0] ?? '' });
            } else setProfile({ kind: 'default' });
          }}
          className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="default">
            {presses && presses.default !== ''
              ? tChrome('panel.prepress.profileDefaultNamed', { name: presses.default })
              : tChrome('panel.prepress.profileDefault')}
          </option>
          {presses !== null && presses.names.length > 0 && (
            <option value="installed">{tChrome('panel.prepress.profileInstalled')}</option>
          )}
          <option value="file">{tChrome('panel.prepress.profileFile')}</option>
        </select>
        {profile.kind === 'installed' && presses !== null && (
          <select
            data-testid="cmyk-dest-press"
            aria-label={tChrome('panel.prepress.profileInstalledAria')}
            value={profile.name}
            onChange={(e) => setProfile({ kind: 'installed', name: e.target.value })}
            className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          >
            {presses.names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {profile.kind === 'file' && (
          <span className="text-xs text-neutral-400 truncate" title={profile.path}>
            {profile.path.split(/[\\/]/).pop()}
          </span>
        )}
      </div>
      <GsRequiredNotice capability={gs} testId="prepress-gs" />
      <IccLicenceNotice state={icc} testId="prepress-icc" />
      <button
        data-testid="cmyk-convert"
        onClick={handleConvert}
        disabled={busy || gsBlocked(gs) || iccBlocks}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
      >
        {busy ? tChrome('panel.prepress.converting') : tChrome('panel.prepress.convertCmyk')}
      </button>

      <div className="border-t border-neutral-800 pt-4 flex flex-col gap-3">
        <p className="text-sm text-neutral-500">{tChrome('panel.prepress.pdfxBlurb')}</p>
        <p data-testid="pdfx-claim-note" className="text-xs text-neutral-500">
          {tChrome('panel.prepress.pdfxNote')}
        </p>
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
          disabled={busy || gsBlocked(gs) || iccBlocks}
          className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
        >
          {busy ? tChrome('panel.prepress.working') : tChrome('panel.prepress.createPdfx')}
        </button>
      </div>
      <StatusBar message={status} busy={busy} />
      <StandardsAlterations report={report} />
    </div>
  );
}
