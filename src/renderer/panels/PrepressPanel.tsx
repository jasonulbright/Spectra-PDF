import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';
import { dialog } from '../lib/tauri-bridge';

// Phase 9.S5 — ICC-managed CMYK conversion for prepress (Ghostscript). Like
// grayscale/pdfa it writes a new file (the "Optimize" tool group's pattern);
// the render intent maps to Ghostscript's ICC transform.
// Only intents that produce a DISTINCT result with the bundled default CMYK
// profile are offered — that profile carries no Saturation table, so
// "saturation" would render identically to "perceptual" (a control that does
// nothing, the § I.0 silent-degradation class). It returns to the picker when
// a user-picked destination profile is in play only if that profile defines
// it — which we cannot know cheaply, so it stays withheld (recorded).
const RENDER_INTENTS: { value: string; label: string }[] = [
  { value: 'relative', label: 'Relative colorimetric (print default)' },
  { value: 'perceptual', label: 'Perceptual (photographic)' },
  { value: 'absolute', label: 'Absolute colorimetric (proofing)' },
];

// O6 tail: PDF/X print masters. X-3 is the colour-managed default; X-1a the
// CMYK-only legacy exchange; X-4 allows live transparency.
const PDFX_VERSIONS: { value: number; label: string }[] = [
  { value: 3, label: 'PDF/X-3 (colour-managed, default)' },
  { value: 1, label: 'PDF/X-1a (legacy CMYK exchange)' },
  { value: 4, label: 'PDF/X-4 (keeps live transparency)' },
];

/** The destination-profile row shared by both actions: empty = Ghostscript's
 * built-in default CMYK; "bundled" = gs's own default_cmyk.icc by ROM name
 * (extractable, so PDF/X can embed it); or a user's .icc file. */
type ProfileChoice = { kind: 'default' } | { kind: 'bundled' } | { kind: 'file'; path: string };

const profileParam = (p: ProfileChoice): string =>
  p.kind === 'default' ? '' : p.kind === 'bundled' ? 'default_cmyk.icc' : p.path;

export function PrepressPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
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
    const output = await saveFile('cmyk.pdf');
    if (!output) return;
    setBusy(true);
    setStatus('Converting to CMYK…');
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
      setStatus(`Saved CMYK PDF — ${orig} KB → ${out} KB`);
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, saveFile, renderIntent, profile]);

  const handlePdfx = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('pdfx.pdf');
    if (!output) return;
    setBusy(true);
    setStatus('Creating PDF/X master…');
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
        `Saved ${r.pdfx_version} master` +
          (r.embedded_profile
            ? ' with the destination profile embedded in its output intent'
            : ` — output intent names ${identifier}`),
      );
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, saveFile, pdfxVersion, profile, condition, identifier]);

  if (!activeFile)
    return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to prepare for print" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount}{' '}
        pages)
      </div>
      <p className="text-sm text-neutral-500">
        Converts the document&apos;s colours to DeviceCMYK for commercial printing, through a
        colour-managed (ICC) transform. Writes a new file.
      </p>
      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <span className="w-28 shrink-0 text-neutral-400">Render intent</span>
        <select
          data-testid="cmyk-render-intent"
          value={renderIntent}
          onChange={(e) => setRenderIntent(e.target.value)}
          className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        >
          {RENDER_INTENTS.map((ri) => (
            <option key={ri.value} value={ri.value}>
              {ri.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2 text-sm text-neutral-300">
        <span className="w-28 shrink-0 text-neutral-400">Destination</span>
        <select
          data-testid="cmyk-dest-profile"
          value={profile.kind}
          onChange={(e) => {
            const k = e.target.value;
            if (k === 'file') void pickProfile();
            else setProfile({ kind: k as 'default' | 'bundled' });
          }}
          className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="default">Ghostscript default CMYK</option>
          <option value="bundled">Bundled profile (default_cmyk.icc)</option>
          <option value="file">Choose an .icc file…</option>
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
        {busy ? 'Converting…' : 'Convert to CMYK'}
      </button>

      <div className="border-t border-neutral-800 pt-4 flex flex-col gap-3">
        <p className="text-sm text-neutral-500">
          Or produce a <span className="text-neutral-300">PDF/X print master</span> — the CMYK
          conversion plus a conformance marker and an output intent naming the printing
          condition (embedding the chosen destination profile when one is set above).
        </p>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="w-28 shrink-0 text-neutral-400">Standard</span>
          <select
            data-testid="pdfx-version"
            value={pdfxVersion}
            onChange={(e) => setPdfxVersion(Number(e.target.value))}
            className="px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          >
            {PDFX_VERSIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="w-28 shrink-0 text-neutral-400">Condition</span>
          <input
            data-testid="pdfx-condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className="flex-1 max-w-md px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="w-28 shrink-0 text-neutral-400">Identifier</span>
          <input
            data-testid="pdfx-identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="Registered characterization, e.g. CGATS TR001 or FOGRA39"
            className="flex-1 max-w-md px-2.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </label>
        <button
          data-testid="pdfx-convert"
          onClick={handlePdfx}
          disabled={busy}
          className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          {busy ? 'Working…' : 'Create PDF/X'}
        </button>
      </div>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
