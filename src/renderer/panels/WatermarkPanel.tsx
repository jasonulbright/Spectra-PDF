import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, app } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

// Muted set for stamp text — full-strength annotation colors read as marker
// ink, not a watermark.
const WATERMARK_COLORS = ['#808080', '#e0393e', '#2f6fed', '#2fbf71'];

export function WatermarkPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [text, setText] = useState('CONFIDENTIAL');
  const [opacity, setOpacity] = useState(0.15);
  const [angle, setAngle] = useState(45);
  const [color, setColor] = useState(WATERMARK_COLORS[0]);
  const [layer, setLayer] = useState<'over' | 'under'>('over');
  const [pageInput, setPageInput] = useState('all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleApply = useCallback(async () => {
    if (!activeFile) return;
    if (!text.trim()) {
      setStatus(tChrome('panel.watermark.emptyText'));
      return;
    }
    const pages =
      pageInput.trim().toLowerCase() === 'all'
        ? undefined
        : pageInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    // An empty parse must never reach the engine: pages [] means "zero
    // pages" there, and quietly stamping nothing (or, worse, everything)
    // on a typo helps no one.
    if (pages && pages.length === 0) {
      setStatus(tChrome('panel.watermark.badPages'));
      return;
    }
    setBusy(true);
    setStatus(tChrome('panel.watermark.applying'));
    try {
      // Same whole-file-op shape as RotatePanel: snapshot first (runs the
      // commit gate), engine writes the working copy in place, UPDATE_FILE
      // reloads and pushes the snapshot onto the undo chain.
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const result = await call('watermark', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        text: text.trim(),
        opacity,
        angle,
        color,
        layer,
        // The bundled fonts dir lets the engine embed a Unicode font for
        // non-Latin-1 stamps instead of rendering "?" (CJK still refuses — the
        // fallback-face boundary — with a surfaced error).
        font_dir: await app.getEditFontPath(),
        ...(pages ? { pages } : {}),
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      const count = (result as unknown as { pages_watermarked: number }).pages_watermarked;
      setStatus(tChromeCount('panel.watermark.done', count));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(tChrome('panel.common.error', { message: msg }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, text, opacity, angle, color, layer, pageInput, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.watermark.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.text')}</label>
        <input
          data-testid="watermark-text"
          aria-label={tChrome('panel.watermark.textAria')}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        />
        <p className="text-xs text-neutral-500 mt-1">
          {tChrome('panel.watermark.scriptsNote')}
        </p>
      </div>
      <div className="flex gap-6 items-end flex-wrap">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.opacity', { pct: Math.round(opacity * 100) })}</label>
          <input
            data-testid="watermark-opacity"
            aria-label={tChrome('panel.watermark.opacityAria')}
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="w-40"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.angle')}</label>
          <input
            data-testid="watermark-angle"
            aria-label={tChrome('panel.watermark.angleAria')}
            type="number"
            min={-180}
            max={180}
            value={angle}
            onChange={(e) => setAngle(Number(e.target.value))}
            className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.color')}</label>
          <div className="flex items-center gap-1.5 py-1.5">
            {WATERMARK_COLORS.map((c) => (
              <button
                key={c}
                title={c}
                onClick={() => setColor(c)}
                className={'color-swatch w-5 h-5 rounded-full' + (color === c ? ' is-selected' : '')}
                style={{
                  backgroundColor: c,
                  outline: color === c ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.placement')}</label>
          <select
            aria-label={tChrome('panel.watermark.placement')}
            data-testid="watermark-layer"
            value={layer}
            onChange={(e) => setLayer(e.target.value as 'over' | 'under')}
            className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
          >
            <option value="over">{tChrome('panel.watermark.over')}</option>
            <option value="under">{tChrome('panel.watermark.under')}</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.pagesLabel')}</label>
          <input
            data-testid="watermark-pages"
            aria-label={tChrome('panel.watermark.pagesAria')}
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            className="w-40 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <button
        data-testid="watermark-apply"
        onClick={handleApply}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? tChrome('panel.watermark.applyingBtn') : tChrome('panel.watermark.apply')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
