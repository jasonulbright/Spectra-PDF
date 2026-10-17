import React, { useState, useEffect, useRef, useCallback } from 'react';
import { updates } from '../lib/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { loadSettings, subscribeSettings, updatePrefsOf, SETTINGS_KEY, type Settings } from '../lib/app-settings';
import { isPrimaryWindow } from '../lib/window-label';
import { tChrome } from '../i18n';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import {
  barView,
  runInstallClick,
  runManualCheck,
  type CheckOutcome,
  type UpdatePhase,
  type UpdatePrefs,
} from '../lib/update-check';

const FAILED_KEYS = {
  network: 'dialog.update.failedNetwork',
  signature: 'dialog.update.failedSignature',
  disabled: 'dialog.update.managed',
  other: 'dialog.update.failedOther',
} as const;

const APPLIED_KEYS = {
  installed: 'dialog.update.appliedInstalled',
  deferred: 'dialog.update.appliedDeferred',
  failed: 'dialog.update.appliedFailed',
} as const;

interface UpdateBarProps {
  /** Bumped by Help ▸ Check for Updates to run a user-visible check. */
  checkSignal?: number;
  /** The app's normal quit flow, asked to relaunch. Rust arms the relaunch
   * only when that quit reaches the final exit. */
  onRestart: () => Promise<void>;
}

export function UpdateBar({ checkSignal = 0, onRestart }: UpdateBarProps): React.ReactElement | null {
  useTranslation();
  const status = useUpdateStatus();
  const [prefs, setPrefs] = useState<UpdatePrefs>(() => updatePrefsOf(loadSettings()));
  const [manual, setManual] = useState<CheckOutcome | 'checking' | null>(null);
  const [dismissedPhase, setDismissedPhase] = useState<UpdatePhase | null>(null);
  const [showLastApply, setShowLastApply] = useState(() => isPrimaryWindow());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const deps = useRef({ status: updates.status, check: updates.check, prepare: updates.prepare }).current;

  useEffect(() => {
    if (status?.phase !== dismissedPhase) setDismissedPhase(null);
  }, [status?.phase, dismissedPhase]);

  // The launch check runs in Rust on the first configure; its failure stays
  // silent, a failed download does not.
  const [failedFrom, setFailedFrom] = useState<UpdatePhase | null>(null);
  const lastPhase = useRef<UpdatePhase | null>(null);
  useEffect(() => {
    const phase = status?.phase ?? null;
    if (phase === lastPhase.current) return;
    if (phase === 'failed') setFailedFrom(lastPhase.current);
    lastPhase.current = phase;
  }, [status?.phase]);

  // Rust holds the preferences app-wide; each window pushes at start and on change.
  // A change made in another window arrives here as a storage event only.
  useEffect(() => {
    void updates.configure(prefsRef.current).catch(() => {});
    const follow = (settings: Settings, push: boolean) => {
      const next = updatePrefsOf(settings);
      const prev = prefsRef.current;
      if (next.checkOnLaunch === prev.checkOnLaunch && next.applyAutomatically === prev.applyAutomatically) return;
      prefsRef.current = next;
      setPrefs(next);
      if (push) void updates.configure(next).catch(() => {});
    };
    const unsubscribe = subscribeSettings((settings) => follow(settings, true));
    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_KEY) follow(loadSettings(), false);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const lastSignal = useRef(0);
  useEffect(() => {
    if (checkSignal === 0 || checkSignal === lastSignal.current) return;
    lastSignal.current = checkSignal;
    let cancelled = false;
    setDismissedPhase(null);
    setManual('checking');
    void runManualCheck(deps, prefsRef.current).then((outcome) => {
      if (!cancelled) setManual(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [checkSignal, deps]);

  const dismiss = useCallback(() => {
    setManual(null);
    setShowLastApply(false);
    setDismissedPhase(status?.phase ?? null);
  }, [status?.phase]);

  const install = useCallback(() => {
    setManual(null);
    void runInstallClick(deps);
  }, [deps]);

  const restart = useCallback(async () => {
    await onRestart();
  }, [onRestart]);

  const view = barView({ status, prefs, manual, dismissedPhase, showLastApply, failedFrom });
  if (view.kind === 'none') return null;

  const dismissButton = (
    <button
      data-testid="update-dismiss"
      onClick={dismiss}
      className="px-2 py-0.5 text-blue-400 hover:text-blue-200 text-xs"
    >
      {tChrome('dialog.update.dismiss')}
    </button>
  );
  const primaryClass = 'px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium';

  return (
    <div
      data-testid="update-bar"
      data-state={view.kind}
      className="app-banner flex items-center gap-3 px-4 py-1.5 bg-blue-900/60 border-b border-blue-800 text-sm shrink-0"
    >
      {view.kind === 'checking' && <span className="text-blue-200">{tChrome('dialog.update.checking')}</span>}
      {view.kind === 'uptodate' && (
        <>
          <span className="text-blue-200">{tChrome('dialog.update.upToDate')}</span>
          {dismissButton}
        </>
      )}
      {view.kind === 'managed' && (
        <>
          <span className="text-blue-200">{tChrome('dialog.update.managed')}</span>
          {dismissButton}
        </>
      )}
      {view.kind === 'checkFailed' && (
        <>
          <span data-testid="update-failed" data-kind={view.failure} className="text-blue-200">
            {tChrome(FAILED_KEYS[view.failure])}
          </span>
          {dismissButton}
        </>
      )}
      {view.kind === 'downloading' && (
        <span data-testid="update-progress" className="text-blue-200">
          {view.percent === null
            ? tChrome('dialog.update.downloading')
            : tChrome('dialog.update.downloadingPercent', { percent: view.percent })}
        </span>
      )}
      {view.kind === 'verifying' && <span className="text-blue-200">{tChrome('dialog.update.verifying')}</span>}
      {view.kind === 'ready' && (
        <>
          <span className="text-blue-200">{tChrome('dialog.update.ready')}</span>
          <button data-testid="update-restart" onClick={() => void restart()} className={primaryClass}>
            {tChrome('dialog.update.restartNow')}
          </button>
          {dismissButton}
        </>
      )}
      {view.kind === 'available' && (
        <>
          <span className="text-blue-200">{tChrome('dialog.update.available', { version: view.version })}</span>
          {view.install && (
            <button data-testid="update-install" onClick={install} className={primaryClass}>
              {tChrome('dialog.update.install')}
            </button>
          )}
          <button
            data-testid="update-view-release"
            onClick={() => {
              void updates.openRelease().catch(() => {});
            }}
            className={view.install ? 'px-2 py-0.5 text-blue-300 hover:text-blue-100 text-xs' : primaryClass}
          >
            {tChrome('dialog.update.viewRelease')}
          </button>
          {dismissButton}
        </>
      )}
      {view.kind === 'prepareFailed' && (
        <>
          <span data-testid="update-prepare-failed" className="text-blue-200">
            {tChrome('dialog.update.prepareFailed')}
          </span>
          {dismissButton}
        </>
      )}
      {view.kind === 'applied' && (
        <>
          <span data-testid="update-applied" data-outcome={view.outcome} className="text-blue-200">
            {tChrome(APPLIED_KEYS[view.outcome], { version: view.version })}
          </span>
          {dismissButton}
        </>
      )}
    </div>
  );
}
