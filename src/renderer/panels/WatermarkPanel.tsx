import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

// Muted set for stamp text — full-strength annotation colors read as marker
// ink, not a watermark.
const WATERMARK_COLORS = ['#808080', '#e0393e', '#2f6fed', '#2fbf71'];

export function WatermarkPanel(): React.ReactElement {
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
      setStatus('Error: watermark text is empty');
      return;
    }
    const pages =
      pageInput.trim().toLowerCase() === 'all'
        ? undefined
        : pageInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    setBusy(true);
    setStatus('Applying watermark...');
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
        ...(pages ? { pages } : {}),
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      const count = (result as unknown as { pages_watermarked: number }).pages_watermarked;
      setStatus(`Watermarked ${count} page${count === 1 ? '' : 's'}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, text, opacity, angle, color, layer, pageInput, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to watermark" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">Text</label>
        <input
          data-testid="watermark-text"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        />
        <p className="text-xs text-neutral-500 mt-1">Latin characters only — others render as "?"</p>
      </div>
      <div className="flex gap-6 items-end flex-wrap">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Opacity ({Math.round(opacity * 100)}%)</label>
          <input
            data-testid="watermark-opacity"
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
          <label className="block text-sm text-neutral-400 mb-1">Angle (°)</label>
          <input
            data-testid="watermark-angle"
            type="number"
            min={-180}
            max={180}
            value={angle}
            onChange={(e) => setAngle(Number(e.target.value))}
            className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Color</label>
          <div className="flex items-center gap-1.5 py-1.5">
            {WATERMARK_COLORS.map((c) => (
              <button
                key={c}
                title={c}
                onClick={() => setColor(c)}
                className="w-5 h-5 rounded-full"
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
          <label className="block text-sm text-neutral-400 mb-1">Placement</label>
          <select
            data-testid="watermark-layer"
            value={layer}
            onChange={(e) => setLayer(e.target.value as 'over' | 'under')}
            className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
          >
            <option value="over">Over content</option>
            <option value="under">Behind content</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Pages (e.g. 1,3,5 or all)</label>
          <input
            data-testid="watermark-pages"
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
        {busy ? 'Applying...' : 'Apply Watermark'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
