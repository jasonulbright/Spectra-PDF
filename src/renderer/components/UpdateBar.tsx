import React, { useState, useEffect } from 'react';
import { app } from '../lib/tauri-bridge';
import { check } from '@tauri-apps/plugin-updater';

type UpdateState = 'idle' | 'available' | 'downloading' | 'ready';

export function UpdateBar(): React.ReactElement | null {
  const [state, setState] = useState<UpdateState>('idle');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [updateObj, setUpdateObj] = useState<Awaited<ReturnType<typeof check>> | null>(null);

  useEffect(() => {
    // Check if auto-update is disabled by enterprise policy
    app.checkAutoUpdateDisabled().then((disabled) => {
      if (disabled) return;
      // Check for updates after a short delay
      setTimeout(async () => {
        try {
          const update = await check();
          if (update) {
            setVersion(update.version);
            setUpdateObj(update);
            setState('available');
          }
        } catch (e) {
          console.log('[updater] Check failed:', e);
        }
      }, 5000);
    });
  }, []);

  const handleDownload = async () => {
    if (!updateObj) return;
    setState('downloading');
    try {
      await updateObj.downloadAndInstall((event) => {
        if (event.event === 'Progress') {
          const p = event.data as { chunkLength: number; contentLength: number | null };
          if (p.contentLength) {
            setPercent(Math.round((p.chunkLength / p.contentLength) * 100));
          }
        } else if (event.event === 'Finished') {
          setState('ready');
        }
      });
    } catch (e) {
      console.error('[updater] Download failed:', e);
      setState('available');
    }
  };

  const handleInstall = () => {
    // Tauri's downloadAndInstall in passive mode restarts automatically.
    // This button is shown if the download completed but restart hasn't happened yet.
    // The update will apply on next app launch.
    window.location.reload();
  };

  if (state === 'idle') return null;

  return (
    <div className="app-banner flex items-center gap-3 px-4 py-1.5 bg-blue-900/60 border-b border-blue-800 text-sm shrink-0">
      {state === 'available' && (
        <>
          <span className="text-blue-200">Update available: v{version}</span>
          <button
            onClick={handleDownload}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium"
          >
            Download
          </button>
          <button
            onClick={() => setState('idle')}
            className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs"
          >
            Skip
          </button>
        </>
      )}
      {state === 'downloading' && (
        <>
          <span className="text-blue-200">Downloading v{version}...</span>
          <div className="w-32 h-1.5 bg-blue-950 rounded overflow-hidden">
            <div
              className="h-full bg-blue-400 transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-blue-400 text-xs">{percent}%</span>
        </>
      )}
      {state === 'ready' && (
        <>
          <span className="text-blue-200">v{version} ready to install</span>
          <button
            onClick={handleInstall}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium"
          >
            Restart Now
          </button>
          <button
            onClick={() => setState('idle')}
            className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs"
          >
            Later
          </button>
        </>
      )}
    </div>
  );
}
