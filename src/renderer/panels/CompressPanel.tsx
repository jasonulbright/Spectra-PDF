import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath, getSettings } from './SettingsPanel';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

const PRESET_DPI: Record<string, number> = { screen: 72, ebook: 150, printer: 300, prepress: 300 };

export function CompressPanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [quality, setQuality] = useState<string>(() => getSettings().compressionQuality);
  const [dpi, setDpi] = useState<number>(PRESET_DPI[getSettings().compressionQuality] || 150);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handlePresetChange = (preset: string) => {
    setQuality(preset);
    if (preset !== 'custom') {
      setDpi(PRESET_DPI[preset] || 150);
    }
  };

  const handleDpiChange = (value: number) => {
    setDpi(value);
    setQuality('custom');
  };

  const handleCompress = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('compressed.pdf');
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.compress.compressing'));
    try {
      const params: Record<string, unknown> = {
        file: activeFile.workingPath, output, gs_path: await ensureGsPath(),
      };
      if (quality === 'custom') {
        params.dpi = dpi;
        params.quality = 'ebook'; // fallback label
      } else {
        params.quality = quality;
      }
      const r = await call('compress', params);
      const ratio = ((1 - r.compressed_size / r.original_size) * 100).toFixed(1);
      setStatus(`${(r.original_size / 1024).toFixed(0)} KB \u2192 ${(r.compressed_size / 1024).toFixed(0)} KB (${ratio}% reduction)`);
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, quality, dpi, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.compress.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.compress.quality')}</label>
        <select aria-label={tChrome('panel.compress.presetAria')} value={quality} onChange={(e) => handlePresetChange(e.target.value)} className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm">
          <option value="screen">{tChrome('panel.compress.screen')}</option>
          <option value="ebook">{tChrome('panel.compress.ebook')}</option>
          <option value="printer">{tChrome('panel.compress.printer')}</option>
          <option value="prepress">{tChrome('panel.compress.prepress')}</option>
          <option value="custom">{tChrome('panel.compress.custom')}</option>
        </select>
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.compress.dpiLabel', { dpi })}</label>
        <input type="range" aria-label={tChrome('panel.compress.dpiAria')} min={72} max={600} step={1} value={dpi}
          onChange={(e) => handleDpiChange(Number(e.target.value))}
          className="w-64 accent-blue-600" />
        <div className="flex justify-between w-64 text-xs text-neutral-600">
          <span>72</span><span>150</span><span>300</span><span>600</span>
        </div>
      </div>
      <button onClick={handleCompress} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.compress.compressing') : tChrome('panel.compress.compress')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
