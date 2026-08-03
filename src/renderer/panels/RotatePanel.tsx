import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

export function RotatePanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [angle, setAngle] = useState<90 | 180 | 270>(90);
  const [pageInput, setPageInput] = useState('all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleRotate = useCallback(async () => {
    if (!activeFile) return;
    const pages = pageInput.trim().toLowerCase() === 'all' ? 'all' : pageInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    setBusy(true); setStatus('Rotating...');
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('rotate', { file: activeFile.workingPath, pages, angle, output: activeFile.workingPath });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      setStatus(`Rotated ${typeof pages === 'string' ? 'all' : pages.length} pages by ${angle} degrees`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(`Error: ${msg}`);
    }
    finally { setBusy(false); }
  }, [activeFile, angle, pageInput, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to rotate pages" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)</div>
      <div className="flex gap-4">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Angle</label>
          <select aria-label="Rotation angle" value={angle} onChange={(e) => setAngle(Number(e.target.value) as 90 | 180 | 270)} className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm">
            <option value={90}>90 CW</option><option value={180}>180</option><option value={270}>90 CCW</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Pages (e.g. 1,3,5 or all)</label>
          <input type="text" aria-label="Pages to rotate" value={pageInput} onChange={(e) => setPageInput(e.target.value)} className="w-48 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
      </div>
      <button onClick={handleRotate} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? 'Rotating...' : 'Rotate'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
