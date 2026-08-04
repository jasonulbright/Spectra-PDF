import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

interface Layer {
  index: number;
  name: string;
  visible: boolean;
}

export function LayersPanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
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
        const snapshotPath = await file.snapshot(activeFile.workingPath);
        await call('set_layer_visibility', {
          file: activeFile.workingPath,
          output: activeFile.workingPath,
          index: layer.index,
          visible: !layer.visible,
        });
        const buf = await file.readBuffer(activeFile.workingPath);
        const info = await call('get_page_count', { file: activeFile.workingPath });
        dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
        await refresh();
        setStatus(layer.visible ? tChrome('panel.layers.hidden', { name: layer.name }) : tChrome('panel.layers.shown', { name: layer.name }));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, dispatch, refresh],
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
          {layers.map((l) => (
            <label
              key={l.index}
              data-testid={`layer-${l.index}`}
              className="flex items-center gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded cursor-pointer"
            >
              <input
                data-testid={`layer-toggle-${l.index}`}
                type="checkbox"
                checked={l.visible}
                disabled={busy}
                onChange={() => void toggle(l)}
                className="rounded bg-neutral-800 border-neutral-700"
              />
              <span className="text-sm text-neutral-200 truncate" title={l.name}>{l.name}</span>
            </label>
          ))}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
