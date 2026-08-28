import React, { useCallback, useEffect, useState } from 'react';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from '../components/GsRequiredNotice';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { useSeparationPreview } from '../hooks/useSeparationPreview';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import {
  DEFAULT_INK_DENSITY,
  MAX_INK_DENSITY,
  MIN_INK_DENSITY,
  aliasIsAllowed,
  convertedToProcessMessage,
  orderInks,
  readSkippedShadings,
  resolveAlias,
  type Ink,
} from '../lib/separation-preview';

interface TransformComparison {
  match: boolean;
  alternate_a: string;
  alternate_b: string;
  diverges_at: number | null;
  max_delta: number;
}

function inkSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ink';
}

function swatch(rgb: number[] | null): string {
  const [r, g, b] = rgb && rgb.length === 3 ? rgb : [128, 128, 128];
  return `rgb(${r}, ${g}, ${b})`;
}

export function InkManagerPanel(): React.ReactElement {
  useTranslation();
  const gs = useGsCapability();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const {
    aliases, setAlias, densities, setDensity, sequence, moveInk, invalidate,
  } = useSeparationPreview();

  const [inks, setInks] = useState<Ink[]>([]);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  /** A refused alias whose only remaining objection is the appearance change
   *  the user has now been shown. */
  const [pendingAlias, setPendingAlias] = useState<{ source: string; target: string } | null>(null);

  const workingPath = activeFile?.workingPath ?? null;
  const filePath = activeFile?.path ?? null;
  const buffer = activeFile?.buffer ?? null;

  useEffect(() => {
    if (!workingPath) {
      setInks([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('list_inks', { file: workingPath });
        if (!cancelled) setInks((res as unknown as { inks?: Ink[] }).inks ?? []);
      } catch (e: unknown) {
        if (!cancelled) {
          setStatus(tChrome('panel.common.error', {
            message: e instanceof Error ? e.message : String(e),
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workingPath, buffer, call]);

  const usable = orderInks(
    inks.filter((i) => i.kind === 'process' || i.kind === 'spot'),
    sequence,
  );
  const spots = usable.filter((i) => i.kind === 'spot');
  const current = usable.find((i) => i.name === selected) ?? spots[0] ?? usable[0] ?? null;

  const applyAlias = useCallback(
    async (source: string, target: string, accept: boolean) => {
      if (!filePath) return;
      setBusy(true);
      setStatus(tChrome('panel.inkManager.applying'));
      try {
        const r = await performOperation(filePath, 'alias_ink', {
          source, target, accept_target_transform: accept,
        });
        if (r === EDIT_DECLINED) {
          setStatus('');
          return;
        }
        setPendingAlias(null);
        invalidate();
        setStatus(tChrome('panel.inkManager.aliasApplied', { source, target }));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        setPendingAlias({ source, target });
        setStatus(tChrome('panel.common.error', { message }));
      } finally {
        setBusy(false);
      }
    },
    [filePath, performOperation, invalidate],
  );

  const convertToProcess = useCallback(
    async (name: string) => {
      if (!filePath) return;
      setBusy(true);
      setStatus(tChrome('panel.inkManager.converting'));
      try {
        const result = await performOperation(filePath, 'spot_to_process', { inks: [name] });
        if (result === EDIT_DECLINED) {
          setStatus('');
          return;
        }
        invalidate();
        setStatus(convertedToProcessMessage(name, readSkippedShadings(result)));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setBusy(false);
      }
    },
    [filePath, performOperation, invalidate],
  );

  const compare = useCallback(
    async (source: string, target: string) => {
      if (!workingPath) return;
      setBusy(true);
      try {
        const res = await call('compare_ink_transforms', { file: workingPath, a: source, b: target });
        const result = res as unknown as TransformComparison;
        setStatus(
          result.match
            ? tChrome('panel.inkManager.sameColour', { source, target })
            : tChrome('panel.inkManager.differentColour', {
                source,
                target,
                tint: ((result.diverges_at ?? 0) * 100).toFixed(0),
              }),
        );
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setBusy(false);
      }
    },
    [workingPath, call],
  );

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.inkManager.open')} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <GsRequiredNotice capability={gs} testId="ink-manager-gs" />
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.inkManager.blurb')}</p>

      <div className="flex flex-col gap-1" data-testid="ink-manager-list">
        {usable.map((ink, index) => {
          const slug = inkSlug(ink.name);
          const shownAs = resolveAlias(aliases, ink.name);
          return (
            <div
              key={ink.name}
              data-testid={`ink-manager-ink-${slug}`}
              className={
                'flex items-center gap-2 px-2 py-1.5 border rounded ' +
                (current?.name === ink.name
                  ? 'bg-neutral-800 border-neutral-600'
                  : 'bg-neutral-800/60 border-neutral-800')
              }
              onClick={() => setSelected(ink.name)}
            >
              <span
                aria-hidden
                className="w-4 h-4 rounded-sm border border-neutral-600 shrink-0"
                style={{ background: swatch(ink.display_rgb) }}
              />
              <span className="text-sm text-neutral-200 min-w-0 truncate flex-1" title={ink.name}>
                {ink.name}
              </span>
              {shownAs !== ink.name && (
                <span className="text-xs text-amber-400" data-testid={`ink-manager-shown-as-${slug}`}>
                  {tChrome('panel.inkManager.shownAs', { name: shownAs })}
                </span>
              )}
              <label className="flex items-center gap-1 text-xs text-neutral-500">
                {tChrome('panel.inkManager.density')}
                <input
                  type="number"
                  data-testid={`ink-manager-density-${slug}`}
                  className="w-14 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
                  min={MIN_INK_DENSITY}
                  max={MAX_INK_DENSITY}
                  step={0.05}
                  value={densities.get(ink.name) ?? DEFAULT_INK_DENSITY}
                  onChange={(e) => setDensity(ink.name, Number(e.target.value))}
                />
              </label>
              <button
                data-testid={`ink-manager-up-${slug}`}
                aria-label={tChrome('panel.inkManager.moveUp')}
                disabled={index === 0}
                onClick={() => moveInk(ink.name, -1)}
                className="px-1.5 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded disabled:opacity-60"
              >
                ↑
              </button>
              <button
                data-testid={`ink-manager-down-${slug}`}
                aria-label={tChrome('panel.inkManager.moveDown')}
                disabled={index === usable.length - 1}
                onClick={() => moveInk(ink.name, 1)}
                className="px-1.5 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded disabled:opacity-60"
              >
                ↓
              </button>
            </div>
          );
        })}
        {usable.length === 0 && (
          <div className="text-xs text-neutral-500" data-testid="ink-manager-empty">
            {tChrome('panel.inkManager.noInks')}
          </div>
        )}
      </div>

      <p className="text-xs text-neutral-500">{tChrome('panel.inkManager.settingsNote')}</p>

      {current && (
        <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            {tChrome('panel.inkManager.aliasHeading', { name: current.name })}
          </div>
          <div className="flex items-center gap-2">
            <select
              data-testid="ink-manager-alias-target"
              aria-label={tChrome('panel.inkManager.aliasTargetAria')}
              className="flex-1 min-w-0 px-2 py-1 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
              value={resolveAlias(aliases, current.name) === current.name
                ? ''
                : resolveAlias(aliases, current.name)}
              onChange={(e) => setAlias(current.name, e.target.value || null)}
            >
              <option value="">{tChrome('panel.inkManager.aliasNone')}</option>
              {usable
                .filter((i) => aliasIsAllowed(aliases, current.name, i.name))
                .map((i) => (
                  <option key={i.name} value={i.name}>{i.name}</option>
                ))}
            </select>
            <button
              data-testid="ink-manager-compare"
              disabled={busy || resolveAlias(aliases, current.name) === current.name}
              onClick={() => void compare(current.name, resolveAlias(aliases, current.name))}
              className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-60"
            >
              {tChrome('panel.inkManager.compare')}
            </button>
            <button
              data-testid="ink-manager-apply-alias"
              disabled={busy || resolveAlias(aliases, current.name) === current.name}
              onClick={() => void applyAlias(current.name, resolveAlias(aliases, current.name), false)}
              className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-60"
            >
              {tChrome('panel.inkManager.applyAlias')}
            </button>
          </div>
          <p className="text-xs text-neutral-500">{tChrome('panel.inkManager.aliasNote')}</p>
          {pendingAlias && (
            <button
              data-testid="ink-manager-apply-anyway"
              disabled={busy}
              onClick={() => void applyAlias(pendingAlias.source, pendingAlias.target, true)}
              className="self-start px-2 py-1 text-xs bg-amber-700 hover:bg-amber-600 rounded disabled:opacity-60"
            >
              {tChrome('panel.inkManager.applyAnyway')}
            </button>
          )}

          {current.kind === 'spot' && (
            <>
              <div className="text-xs uppercase tracking-wide text-neutral-500 mt-2">
                {tChrome('panel.inkManager.convertHeading')}
              </div>
              <p className="text-xs text-neutral-500">{tChrome('panel.inkManager.convertNote')}</p>
              <button
                data-testid="ink-manager-convert"
                disabled={busy}
                onClick={() => void convertToProcess(current.name)}
                className="self-start px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-60"
              >
                {tChrome('panel.inkManager.convert', { name: current.name })}
              </button>
            </>
          )}
        </div>
      )}

      <StatusBar message={status} busy={busy} />
    </div>
  );
}
