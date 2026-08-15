import React from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useSeparationPreview } from '../hooks/useSeparationPreview';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { localizeEngineMessage } from '../lib/engine-messages';
import {
  DEFAULT_INK_DENSITY,
  MAX_INK_DENSITY,
  MAX_TAC_LIMIT,
  MIN_INK_DENSITY,
  MIN_TAC_LIMIT,
  coverageRows,
  inkRows,
  inventoryIsComplete,
  orderInks,
  type Ink,
  type InkRow,
} from '../lib/separation-preview';

/** A stable test handle for an ink row. The ink NAME is document content and
 *  is shown verbatim; this is only a selector. */
function inkSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ink';
}

function swatch(rgb: number[] | null): string {
  const [r, g, b] = rgb && rgb.length === 3 ? rgb : [128, 128, 128];
  return `rgb(${r}, ${g}, ${b})`;
}

export function OutputPreviewPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const {
    armed, setArmed, inks, inkUnknown, plates, coverage, hidden, toggleInk, showAllInks,
    hideAllInks, densities, setDensity, aliases, sequence, limitPct, setLimitPct, alarm,
    setAlarm, overprint, setOverprint, stats, busy, error,
  } = useSeparationPreview();

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.outputPreview.open')} />;
  }

  // The preview still renders: a plate that IS known is honest, and withholding
  // it would trade a stated gap for a blank panel. What the engine could not
  // read is stated beside it, and every figure measured over the plate set
  // carries the caveat that the set may be short one ink.
  const unknown = inkUnknown.map(localizeEngineMessage);
  const complete = inventoryIsComplete({ unknown: inkUnknown });

  const coverageByName = new Map(coverageRows(coverage).map((row) => [row.name, row.pct]));
  const nonInks: Ink[] = inks.filter((i) => i.kind === 'all' || i.kind === 'none');
  // An aliased colorant is DRAWN as another ink, so it is not a row of its
  // own — the ink it joined names it instead.
  const rows = inkRows(orderInks(plates, sequence), aliases);
  const processRows = rows.filter((r) => r.plate.kind === 'process');
  const spotRows = rows.filter((r) => r.plate.kind === 'spot');

  const inkRow = ({ plate, aliasedFrom }: InkRow): React.ReactElement => {
    const slug = inkSlug(plate.name);
    const pct = coverageByName.get(plate.name);
    const density = densities.get(plate.name) ?? DEFAULT_INK_DENSITY;
    return (
      <div
        key={plate.name}
        data-testid={`output-preview-ink-${slug}`}
        className="flex items-center gap-2 px-2 py-1.5 bg-neutral-800/60 border border-neutral-800 rounded"
      >
        <input
          type="checkbox"
          data-testid={`output-preview-toggle-${slug}`}
          checked={!hidden.has(plate.name)}
          onChange={() => toggleInk(plate.name)}
          aria-label={plate.name}
        />
        <span
          aria-hidden
          className="w-4 h-4 rounded-sm border border-neutral-600 shrink-0"
          style={{ background: swatch(plate.display_rgb) }}
        />
        <span className="text-sm text-neutral-200 min-w-0 truncate flex-1" title={plate.name}>
          {plate.name}
        </span>
        {aliasedFrom.length > 0 && (
          <span
            className="text-xs text-amber-400 truncate"
            data-testid={`output-preview-merged-${slug}`}
          >
            {tChrome('panel.outputPreview.merged', { names: aliasedFrom.join(', ') })}
          </span>
        )}
        {pct !== undefined && (
          <span
            className="text-xs text-neutral-400 tabular-nums"
            data-testid={`output-preview-coverage-${slug}`}
          >
            {tChrome('panel.outputPreview.coverageValue', { pct: pct.toFixed(1) })}
          </span>
        )}
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.outputPreview.density')}
          <input
            type="number"
            data-testid={`output-preview-density-${slug}`}
            className="w-14 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={MIN_INK_DENSITY}
            max={MAX_INK_DENSITY}
            step={0.05}
            value={density}
            onChange={(e) => setDensity(plate.name, Number(e.target.value))}
          />
        </label>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-400">
          {tChrome('panel.common.workingOn')}{' '}
          <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <button
          data-testid="output-preview-arm"
          aria-pressed={armed}
          onClick={() => setArmed(!armed)}
          className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700"
        >
          {armed
            ? tChrome('panel.outputPreview.disarm')
            : tChrome('panel.outputPreview.arm')}
        </button>
      </div>

      <p className="text-xs text-neutral-500">{tChrome('panel.outputPreview.blurb')}</p>

      {!complete && (
        <div className="text-xs text-amber-400" data-testid="output-preview-unknown">
          {tChrome('panel.outputPreview.unknownNote', { reasons: unknown.join(' ') })}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            data-testid="output-preview-overprint"
            checked={overprint}
            onChange={(e) => setOverprint(e.target.checked)}
          />
          {tChrome('panel.outputPreview.overprint')}
        </label>
        <div className="flex items-center gap-2 text-sm text-neutral-300">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="output-preview-alarm"
              checked={alarm}
              onChange={(e) => setAlarm(e.target.checked)}
            />
            {tChrome('panel.outputPreview.alarm')}
          </label>
          <input
            type="number"
            data-testid="output-preview-limit"
            aria-label={tChrome('panel.outputPreview.limitAria')}
            className="w-20 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={MIN_TAC_LIMIT}
            max={MAX_TAC_LIMIT}
            step={5}
            value={limitPct}
            onChange={(e) => setLimitPct(Number(e.target.value))}
          />
        </div>
      </div>

      {stats && (
        <div className="text-sm text-neutral-300" data-testid="output-preview-stats">
          <div data-testid="output-preview-maxtac">
            {tChrome('panel.outputPreview.maxTac', { pct: stats.max_tac.toFixed(1) })}
          </div>
          <div
            className={stats.over_pixels > 0 ? 'text-amber-400 text-xs' : 'text-neutral-500 text-xs'}
            data-testid="output-preview-over"
          >
            {stats.over_pixels > 0
              ? tChrome('panel.outputPreview.overLimit', {
                  pct: (stats.over_fraction * 100).toFixed(2),
                  limit: limitPct,
                })
              : tChrome('panel.outputPreview.withinLimit', { limit: limitPct })}
          </div>
          {!complete && (
            <div className="text-xs text-amber-400" data-testid="output-preview-tac-caveat">
              {tChrome('panel.outputPreview.figuresCaveat')}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          {tChrome('panel.outputPreview.inks')}
        </div>
        <div className="flex gap-1">
          <button
            data-testid="output-preview-show-all"
            onClick={showAllInks}
            className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700"
          >
            {tChrome('panel.outputPreview.showAll')}
          </button>
          <button
            data-testid="output-preview-hide-all"
            onClick={hideAllInks}
            className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700"
          >
            {tChrome('panel.outputPreview.hideAll')}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1" data-testid="output-preview-ink-list">
        {processRows.map(inkRow)}
        {spotRows.length > 0 && (
          <div className="text-xs uppercase tracking-wide text-neutral-500 mt-2">
            {tChrome('panel.outputPreview.spots')}
          </div>
        )}
        {spotRows.map(inkRow)}
        {plates.length === 0 && !busy && (
          <div className="text-xs text-neutral-500" data-testid="output-preview-empty">
            {tChrome('panel.outputPreview.noPlates')}
          </div>
        )}
        {!complete && (
          <div className="text-xs text-amber-400" data-testid="output-preview-plates-caveat">
            {tChrome('panel.outputPreview.platesCaveat')}
          </div>
        )}
      </div>

      <p className="text-xs text-neutral-500">{tChrome('panel.outputPreview.coverageNote')}</p>

      {nonInks.length > 0 && (
        <div className="text-xs text-neutral-500" data-testid="output-preview-special-inks">
          {tChrome('panel.outputPreview.specialInks', {
            names: nonInks.map((i) => i.name).join(', '),
          })}
        </div>
      )}

      <StatusBar
        message={error ? tChrome('panel.common.error', { message: error }) : ''}
        busy={busy}
      />
    </div>
  );
}
