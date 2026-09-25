import React, { useState, useEffect, useRef } from 'react';
import { app } from '../lib/tauri-bridge';
import { check } from '@tauri-apps/plugin-updater';
import { useTranslation } from 'react-i18next';
import { loadSettings } from '../lib/app-settings';
import { isPrimaryWindow } from '../lib/window-label';
import { tChrome } from '../i18n';
import { runLaunchCheck, runManualCheck, type UpdateState } from '../lib/update-check';

// Updates are notify-only. This bar tells the user a newer release exists and hands
// you to the releases page. It NEVER downloads or installs anything.
//
// Why that is the safer design, not just the preferred one: an updater that
// installs signed payloads is a code-execution channel into every user's
// machine, gated on the signing key. Notify-only deletes that channel --
// a forged manifest can lie about a version NUMBER and nothing else, because
// the destination is compiled into the Rust command rather than read from the
// manifest, and no install path exists for it to reach.
//
// The check itself still goes through the updater plugin: it already does
// signature verification and version comparison, and the result is used for
// exactly one thing -- deciding whether to render this bar.
const FAILED_KEYS = {
  network: 'dialog.update.failedNetwork',
  signature: 'dialog.update.failedSignature',
  other: 'dialog.update.failedOther',
} as const;

interface UpdateBarProps {
  /** Bumped by Help ▸ Check for Updates to run a user-visible check. */
  checkSignal?: number;
}

export function UpdateBar({ checkSignal = 0 }: UpdateBarProps): React.ReactElement | null {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const dismiss = () => setState({ status: 'idle' });

  // Launch check: opt-outable (Settings) and overridable machine-wide by the
  // enterprise DisableAutoUpdate policy, which wins over the preference.
  //
  // Only the window the app opened by itself checks. A window opened FROM
  // another window is not a launch, and a second check five seconds later
  // producing a second bar is noise on a notify-only posture. Help ▸ Check for
  // Updates stays per window and is unaffected.
  useEffect(() => {
    if (!isPrimaryWindow()) return;
    if (!loadSettings().checkUpdatesOnLaunch) return;
    let cancelled = false;
    void app.checkAutoUpdateDisabled().then((disabled) => {
      if (disabled || cancelled) return;
      setTimeout(async () => {
        const next = await runLaunchCheck(check);
        if (next.status === 'available' && !cancelled) setState(next);
      }, 5000);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Manual check (Help ▸ Check for Updates) — deliberately ignores the launch
  // preference: the user asked for it explicitly. The enterprise policy still
  // wins, and says so rather than silently reporting "up to date".
  const lastSignal = useRef(0);
  useEffect(() => {
    if (checkSignal === 0 || checkSignal === lastSignal.current) return;
    lastSignal.current = checkSignal;
    let cancelled = false;
    void (async () => {
      setState({ status: 'checking' });
      const next = await runManualCheck({ isDisabled: () => app.checkAutoUpdateDisabled(), check });
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [checkSignal]);

  if (state.status === 'idle') return null;

  return (
    <div
      data-testid="update-bar"
      className="app-banner flex items-center gap-3 px-4 py-1.5 bg-blue-900/60 border-b border-blue-800 text-sm shrink-0"
    >
      {state.status === 'checking' && (
        <span className="text-blue-200">{tChrome('dialog.update.checking')}</span>
      )}
      {state.status === 'uptodate' && (
        <>
          <span className="text-blue-200">{tChrome('dialog.update.upToDate')}</span>
          <button
            data-testid="update-dismiss"
            onClick={dismiss}
            className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs"
          >
            {tChrome('dialog.update.dismiss')}
          </button>
        </>
      )}
      {state.status === 'disabled' && (
        <>
          <span className="text-blue-200">{tChrome('dialog.update.managed')}</span>
          <button
            data-testid="update-dismiss"
            onClick={dismiss}
            className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs"
          >
            {tChrome('dialog.update.dismiss')}
          </button>
        </>
      )}
      {state.status === 'failed' && (
        <>
          <span data-testid="update-failed" data-kind={state.kind} className="text-blue-200">
            {tChrome(FAILED_KEYS[state.kind])}
          </span>
          <button
            data-testid="update-dismiss"
            onClick={dismiss}
            className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs"
          >
            {tChrome('dialog.update.dismiss')}
          </button>
        </>
      )}
      {state.status === 'available' && (
        <>
          <span className="text-blue-200">{tChrome('dialog.update.available', { version: state.version })}</span>
          <button
            data-testid="update-view-release"
            onClick={() => {
              void app.openReleasesPage().catch(() => {});
              dismiss();
            }}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium"
          >
            {tChrome('dialog.update.viewRelease')}
          </button>
          <button
            data-testid="update-dismiss"
            onClick={dismiss}
            className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs"
          >
            {tChrome('dialog.update.dismiss')}
          </button>
        </>
      )}
    </div>
  );
}
