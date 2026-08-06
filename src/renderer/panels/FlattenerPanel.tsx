import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useOperations } from '../hooks/useOperations';
import { useFlattenerPreview } from '../hooks/useFlattenerPreview';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';
import { tChrome } from '../i18n';
import {
  FLATTEN_CATEGORIES,
  FLATTEN_DPI_CHOICES,
  regionCount,
  totals,
  unreadablePages,
  type FlattenCategory,
} from '../lib/flattener';

const CATEGORY_KEY = {
  transparent: 'panel.flattener.categoryTransparent',
  affected: 'panel.flattener.categoryAffected',
  rasterized: 'panel.flattener.categoryRasterized',
  outlined_strokes: 'panel.flattener.categoryStrokes',
  outlined_text: 'panel.flattener.categoryText',
  expanded_patterns: 'panel.flattener.categoryPatterns',
} as const satisfies Record<FlattenCategory, string>;

export function FlattenerPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { performOperation } = useOperations();
  const {
    armed, setArmed, report, balance, setBalance, dpi, setDpi,
    shown, toggleCategory, busy, error, invalidate,
  } = useFlattenerPreview();

  const [status, setStatus] = useState('');
  const [applying, setApplying] = useState(false);

  const filePath = activeFile?.path ?? null;
  const counts = totals(report);
  const regions = regionCount(report);
  const unreadable = unreadablePages(report);

  const apply = useCallback(async () => {
    if (!filePath) return;
    setApplying(true);
    setStatus(tChrome('panel.flattener.flattening'));
    try {
      const result = await performOperation(filePath, 'flatten_transparency', {
        balance,
        dpi,
        gs_path: await ensureGsPath(),
      });
      invalidate();
      setStatus(tChrome('panel.flattener.flattened', {
        regions: (result as unknown as { regions?: number }).regions ?? 0,
      }));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', {
        message: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setApplying(false);
    }
  }, [filePath, performOperation, balance, dpi, invalidate]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.flattener.open')} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.flattener.blurb')}</p>

      <label className="flex items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          data-testid="flattener-armed"
          checked={armed}
          onChange={(e) => setArmed(e.target.checked)}
        />
        {tChrome('panel.flattener.preview')}
      </label>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-neutral-500" htmlFor="flattener-balance">
          {tChrome('panel.flattener.balance')}
        </label>
        <input
          id="flattener-balance"
          type="range"
          data-testid="flattener-balance"
          min={0}
          max={100}
          step={5}
          value={Math.round(balance * 100)}
          onChange={(e) => setBalance(Number(e.target.value) / 100)}
        />
        <div className="flex justify-between text-[10px] text-neutral-500">
          <span>{tChrome('panel.flattener.balanceVector')}</span>
          <span data-testid="flattener-balance-value">
            {tChrome('panel.flattener.balanceValue', { percent: Math.round(balance * 100) })}
          </span>
          <span>{tChrome('panel.flattener.balanceRaster')}</span>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-500">
        {tChrome('panel.flattener.resolution')}
        <select
          data-testid="flattener-dpi"
          className="px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
          value={dpi}
          onChange={(e) => setDpi(Number(e.target.value))}
        >
          {FLATTEN_DPI_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {tChrome('panel.flattener.dpiOption', { dpi: choice })}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1" data-testid="flattener-report">
        <div className="text-sm text-neutral-200" data-testid="flattener-regions">
          {tChrome('panel.flattener.regions', { regions })}
        </div>
        {FLATTEN_CATEGORIES.map((category) => (
          <label
            key={category}
            className="flex items-center gap-2 text-xs text-neutral-400"
            data-testid={`flattener-category-${category}`}
          >
            <input
              type="checkbox"
              checked={shown.has(category)}
              onChange={() => toggleCategory(category)}
            />
            {tChrome(CATEGORY_KEY[category], { count: counts[category] })}
          </label>
        ))}
        {unreadable.length > 0 && (
          <div className="text-xs text-amber-400" data-testid="flattener-unreadable">
            {tChrome('panel.flattener.unreadable', { pages: unreadable.join(', ') })}
          </div>
        )}
        {counts.transparent === 0 && report !== null && (
          <div className="text-xs text-neutral-500" data-testid="flattener-none">
            {tChrome('panel.flattener.none')}
          </div>
        )}
      </div>

      <p className="text-xs text-neutral-500">{tChrome('panel.flattener.scope')}</p>

      <div className="flex items-center gap-2">
        <button
          data-testid="flattener-apply"
          disabled={applying || busy || regions === 0}
          onClick={() => void apply()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
        >
          {tChrome('panel.flattener.apply')}
        </button>
      </div>

      <StatusBar message={status || error} busy={busy || applying} />
    </div>
  );
}
