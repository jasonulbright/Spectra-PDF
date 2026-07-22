import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';

// Phase 9.S5 — ICC-managed CMYK conversion for prepress (Ghostscript). Like
// grayscale/pdfa it writes a new file (the "Optimize" tool group's pattern);
// the render intent maps to Ghostscript's ICC transform.
// Only intents that produce a DISTINCT result with the bundled default CMYK
// profile are offered — that profile carries no Saturation table, so
// "saturation" would render identically to "perceptual" (a control that does
// nothing, the § I.0 silent-degradation class). It returns to the picker when
// a profile that defines it is bundled (the destination-profile follow-on).
const RENDER_INTENTS: { value: string; label: string }[] = [
  { value: 'relative', label: 'Relative colorimetric (print default)' },
  { value: 'perceptual', label: 'Perceptual (photographic)' },
  { value: 'absolute', label: 'Absolute colorimetric (proofing)' },
];

export function PrepressPanel(): React.ReactElement {
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [renderIntent, setRenderIntent] = useState('relative');

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
  }, [activeFile, call, saveFile, renderIntent]);

  if (!activeFile)
    return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to convert to CMYK" />;

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
      <button
        data-testid="cmyk-convert"
        onClick={handleConvert}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? 'Converting…' : 'Convert to CMYK'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
