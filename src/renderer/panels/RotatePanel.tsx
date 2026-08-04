import React, { useState, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

export function RotatePanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [angle, setAngle] = useState<90 | 180 | 270>(90);
  const [pageInput, setPageInput] = useState('all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleRotate = useCallback(async () => {
    if (!activeFile) return;
    const pages = pageInput.trim().toLowerCase() === 'all' ? 'all' : pageInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    setBusy(true); setStatus(tChrome('panel.rotate.rotating'));
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('rotate', { file: activeFile.workingPath, pages, angle, output: activeFile.workingPath });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      setStatus(tChrome('panel.rotate.done', {
        pages: typeof pages === 'string' ? 'all' : pages.length,
        angle,
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(tChrome('panel.common.error', { message: msg }));
    }
    finally { setBusy(false); }
  }, [activeFile, angle, pageInput, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.rotate.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <div className="flex gap-4">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.rotate.angle')}</label>
          <select aria-label={tChrome('panel.rotate.angleAria')} value={angle} onChange={(e) => setAngle(Number(e.target.value) as 90 | 180 | 270)} className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm">
            <option value={90}>{tChrome('panel.rotate.cw90')}</option>
            <option value={180}>{tChrome('panel.rotate.flip180')}</option>
            <option value={270}>{tChrome('panel.rotate.ccw90')}</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.rotate.pagesLabel')}</label>
          <input type="text" aria-label={tChrome('panel.rotate.pagesAria')} value={pageInput} onChange={(e) => setPageInput(e.target.value)} className="w-48 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
      </div>
      <button onClick={handleRotate} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.rotate.rotating') : tChrome('panel.rotate.rotate')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
