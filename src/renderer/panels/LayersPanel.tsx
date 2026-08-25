import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import {
  processingStepLabel,
  processingStepNote,
  type ProcessingStep,
} from '../lib/processing-steps';

interface Layer {
  index: number;
  name: string;
  visible: boolean;
  processing_step: ProcessingStep | null;
}

export function LayersPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const [layers, setLayers] = useState<Layer[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    try {
      const res = await call('list_layers', { file: workingPath });
      setLayers((res as unknown as { layers: Layer[] }).layers ?? []);
    } catch {
      setLayers([]);
    }
  }, [workingPath, call]);

  useEffect(() => {
    if (!buffer || !workingPath) {
      setLayers([]);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  const toggle = useCallback(
    async (layer: Layer) => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(layer.visible ? tChrome('panel.layers.hiding', { name: layer.name }) : tChrome('panel.layers.showing', { name: layer.name }));
      try {
        const r = await performOperation(activeFile.path, 'set_layer_visibility', {
          index: layer.index,
          visible: !layer.visible,
        });
        if (r === EDIT_DECLINED) {
          setStatus('');
          return;
        }
        await refresh();
        setStatus(layer.visible ? tChrome('panel.layers.hidden', { name: layer.name }) : tChrome('panel.layers.shown', { name: layer.name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [activeFile, performOperation, refresh],
  );

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.layers.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      {layers.length === 0 ? (
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
                  disabled={busy}
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
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
