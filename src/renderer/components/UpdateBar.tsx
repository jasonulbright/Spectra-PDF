import React, { useState, useEffect, useRef } from 'react';
import { app } from '../lib/tauri-bridge';
import { check } from '@tauri-apps/plugin-updater';

// idle = nothing to show. checking/uptodate/disabled are manual-check states
// (Help ▸ Check for Updates); available/downloading/ready drive the install
// flow (reached by the silent auto-check on mount or a manual check).
type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'disabled';

interface UpdateBarProps {
  /** Bumped by Help ▸ Check for Updates to run a user-visible check. */
  checkSignal?: number;
}

export function UpdateBar({ checkSignal = 0 }: UpdateBarProps): React.ReactElement | null {
  const [state, setState] = useState<UpdateState>('idle');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [updateObj, setUpdateObj] = useState<Awaited<ReturnType<typeof check>> | null>(null);

  // Silent auto-check on mount: only surfaces if an update is available.
  useEffect(() => {
    app.checkAutoUpdateDisabled().then((disabled) => {
      if (disabled) return;
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

  // Manual check (Help menu) — shows checking → available / up-to-date /
  // enterprise-disabled. Skip the initial render (signal 0).
  const lastSignal = useRef(0);
  useEffect(() => {
    if (checkSignal === 0 || checkSignal === lastSignal.current) return;
    lastSignal.current = checkSignal;
    let cancelled = false;
    (async () => {
      setState('checking');
      try {
        if (await app.checkAutoUpdateDisabled()) {
          if (!cancelled) setState('disabled');
          return;
        }
        const update = await check();
        if (cancelled) return;
        if (update) {
          setVersion(update.version);
          setUpdateObj(update);
          setState('available');
        } else {
          setState('uptodate');
        }
      } catch (e) {
        console.error('[updater] Manual check failed:', e);
        if (!cancelled) setState('uptodate');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkSignal]);

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
    window.location.reload();
  };

  if (state === 'idle') return null;

  return (
    <div data-testid="update-bar" className="app-banner flex items-center gap-3 px-4 py-1.5 bg-blue-900/60 border-b border-blue-800 text-sm shrink-0">
      {state === 'checking' && <span className="text-blue-200">Checking for updates…</span>}
      {state === 'uptodate' && (
        <>
          <span className="text-blue-200">You’re up to date.</span>
          <button onClick={() => setState('idle')} className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs">
            Dismiss
          </button>
        </>
      )}
      {state === 'disabled' && (
        <>
          <span className="text-blue-200">Updates are managed by your organization.</span>
          <button onClick={() => setState('idle')} className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs">
            Dismiss
          </button>
        </>
      )}
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
