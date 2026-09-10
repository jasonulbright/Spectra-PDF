import React, { useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { useLayerSessions } from '../state/AppStateProvider';
import type { Layer } from '../lib/layer-session';
import { runCommitGate } from '../lib/commit-gate';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import {
  processingStepLabel,
  processingStepNote,
} from '../lib/processing-steps';

export function LayersPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const sessions = useLayerSessions(), session = sessions.get(activeFile);
  const layers = session?.layers ?? [], busy = !!session?.busy, buffer = session?.buffer ?? null;
  const ready = !!session?.loaded && sessions.at(session), status = session?.error || session?.status || '';
  useEffect(() => { if (session) void sessions.load(session, call); });
  useEffect(() => () => { if (session) sessions.cancelLoad(session); }, [session, sessions]);
  const toggle = useCallback(async (layer: Layer) => {
    if (session) await sessions.toggle(session, layer, buffer, performOperation, call, runCommitGate);
  }, [session, sessions, buffer, performOperation, call]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.layers.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      {session?.loaded && layers.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="layers-empty">{tChrome('panel.layers.empty')}</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="layers-list">
          <p className="text-xs text-neutral-500">{tChrome('panel.layers.hint')}</p>
          {layers.map((l) => {
            const step = l.processing_step;
            const note = step ? processingStepNote(step.status) : '';
            return (
              <label
                key={l.index}
                data-testid={`layer-${l.index}`}
                className="flex items-start gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded cursor-pointer"
              >
                <input
                  data-testid={`layer-toggle-${l.index}`}
                  type="checkbox"
                  checked={l.visible}
                  disabled={busy || !ready || l.locked}
                  onChange={() => void toggle(l)}
                  className="mt-0.5 rounded bg-neutral-800 border-neutral-700"
                />
                <span className="min-w-0 flex flex-col">
                  <span className="text-sm text-neutral-200 truncate" title={l.name}>{l.name}</span>
                  {step && (
                    <span
                      data-testid={`layer-step-${l.index}`}
                      className="text-xs text-amber-400/90 truncate"
                      title={tChrome('panel.layers.stepTitle')}
                    >
                      {tChrome('panel.layers.step', { step: processingStepLabel(step) })}
                      {note && <span className="text-neutral-500"> — {note}</span>}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {session?.error && <div data-testid="layers-error" role="alert">
        {session.error}
        <button data-testid="layers-retry" disabled={busy} onClick={() => sessions.retry(session)}>{tChrome('app.commit.retry')}</button>
      </div>}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
