import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

export function OptimizePanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [linearize, setLinearize] = useState(true);
  const [stripMeta, setStripMeta] = useState(false);
  const [compressStreams, setCompressStreams] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleOptimize = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('optimized.pdf');
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.optimize.optimizing'));
    try {
      const r = await call('optimize', {
        file: activeFile.workingPath, output,
        linearize, strip_metadata: stripMeta, compress_streams: compressStreams,
      });
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.output_size / 1024).toFixed(0);
      const ratio = ((1 - r.output_size / r.original_size) * 100).toFixed(1);
      setStatus(tChrome('panel.optimize.result', { from: orig, to: out, ratio }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, linearize, stripMeta, compressStreams, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.optimize.open')} />;

  const checks = [
    { label: tChrome('panel.optimize.linearize'), checked: linearize, set: setLinearize, hint: tChrome('panel.optimize.linearizeHint') },
    { label: tChrome('panel.optimize.stripMeta'), checked: stripMeta, set: setStripMeta, hint: tChrome('panel.optimize.stripMetaHint') },
    { label: tChrome('panel.optimize.compressStreams'), checked: compressStreams, set: setCompressStreams, hint: tChrome('panel.optimize.compressStreamsHint') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <div className="flex flex-col gap-2">
        {checks.map((c) => (
          <label key={c.label} className="flex items-start gap-2 cursor-pointer group">
            <input type="checkbox" checked={c.checked} onChange={(e) => c.set(e.target.checked)}
              className="mt-0.5 accent-blue-600" />
            <div>
              <span className="text-sm text-neutral-300 group-hover:text-neutral-200">{c.label}</span>
              <p className="text-xs text-neutral-500">{c.hint}</p>
            </div>
          </label>
        ))}
      </div>
      <button onClick={handleOptimize} disabled={busy || (!linearize && !stripMeta && !compressStreams)}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.optimize.optimizing') : tChrome('panel.optimize.optimize')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
