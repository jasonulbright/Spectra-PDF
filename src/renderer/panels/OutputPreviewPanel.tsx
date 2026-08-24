import React from 'react';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from '../components/GsRequiredNotice';
import { useIccAssent } from '../hooks/useIccAssent';
import { IccLicenceNotice } from '../components/IccLicenceNotice';
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
  blackInkIsForced,
  coverageRows,
  inkRows,
  inspectInkIsAFloor,
  inspectIsAvailable,
  inventoryIsComplete,
  orderInks,
  resolutionState,
  simulationIsLive,
  type Ink,
  type InkRow,
  type InspectedKind,
  type InspectedObject,
  type SimulationSource,
} from '../lib/separation-preview';

/** The kind labels, one per object class the walk emits. */
const KIND_KEYS: Record<InspectedKind, Parameters<typeof tChrome>[0]> = {
  fill: 'panel.outputPreview.inspectKindFill',
  stroke: 'panel.outputPreview.inspectKindStroke',
  fillstroke: 'panel.outputPreview.inspectKindFillstroke',
  text: 'panel.outputPreview.inspectKindText',
  image: 'panel.outputPreview.inspectKindImage',
  vector: 'panel.outputPreview.inspectKindVector',
  shading: 'panel.outputPreview.inspectKindShading',
  form: 'panel.outputPreview.inspectKindForm',
};

/** A component value is a number and is formatted, never translated. The
 *  document's own identifiers — a colorant, a colour-space resource name —
 *  ride placeholders verbatim for the same reason in reverse. */
function componentText(values: readonly number[]): string {
  return values.map((v) => (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(4))).join('  ');
}

function objectSwatch(rgb: number[] | null): string | undefined {
  if (!rgb || rgb.length !== 3) return undefined;
  const byte = (c: number): number => Math.max(0, Math.min(255, Math.round(c * 255)));
  return `rgb(${byte(rgb[0])}, ${byte(rgb[1])}, ${byte(rgb[2])})`;
}

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
  const gs = useGsCapability();
  // Soft-proofing resolves a bundled press profile, so it carries the same
  // licence gate the conversions do.
  const icc = useIccAssent();
  const { activeFile, openNewFiles } = useActiveFile();
  const {
    armed, setArmed, inks, inkUnknown, plates, coverage, hidden, toggleInk, showAllInks,
    hideAllInks, densities, setDensity, aliases, sequence, limitPct, setLimitPct, alarm,
    setAlarm, overprint, setOverprint, simulationProfiles, simulationSource,
    setSimulationSource, pickSimulationProfile, simulationPress, setSimulationPress,
    setPaperWhite, setBlackInk, simulation,
    stats, busy, error, inspection, inspectBusy, inspectError,
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

  // Every proof control renders from what the engine says it USED, never from
  // what was asked for: a request the engine refused must not be able to look
  // honoured. A null record is "could not tell", which is not "off".
  const proofing = simulation !== null && simulationIsLive(simulation.source);
  const usedPaperWhite = simulation?.intent === 'absolute';
  const usedBlackInk = proofing && simulation !== null && !simulation.black_point_compensation;
  const blackInkForced = blackInkIsForced(usedPaperWhite);

  const chooseSource = (next: SimulationSource): void => {
    if (next === 'file') void pickSimulationProfile();
    else setSimulationSource(next);
  };

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

  const inspectedObject = (object: InspectedObject, top: boolean): React.ReactElement => {
    const colour = object.colour;
    const state = resolutionState(object);
    const swatch = objectSwatch(colour.rgb);
    return (
      <div
        key={`${object.index}`}
        data-testid={top ? 'output-preview-inspect-top' : `output-preview-inspect-under-${object.index}`}
        className="flex flex-col gap-0.5 px-2 py-1.5 bg-neutral-800/60 border border-neutral-800 rounded"
      >
        <div className="flex items-center gap-2">
          {swatch !== undefined && (
            <span
              aria-hidden
              className="w-4 h-4 rounded-sm border border-neutral-600 shrink-0"
              style={{ background: swatch }}
            />
          )}
          <span className="text-sm text-neutral-200" data-testid={top ? 'output-preview-inspect-kind' : undefined}>
            {tChrome(KIND_KEYS[object.kind])}
          </span>
        </div>
        {object.unknown && (
          <div className="text-xs text-amber-400" data-testid="output-preview-inspect-unknown-object">
            {tChrome('panel.outputPreview.inspectUnknownObject')}
          </div>
        )}
        {colour.family !== '' && (
          <div className="text-xs text-neutral-400" data-testid={top ? 'output-preview-inspect-space' : undefined}>
            {tChrome('panel.outputPreview.inspectSpace', { space: colour.family })}
          </div>
        )}
        {colour.resource !== '' && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.outputPreview.inspectResource', { name: colour.resource })}
          </div>
        )}
        {colour.colorants.length > 0 && (
          <div className="text-xs text-neutral-400" data-testid={top ? 'output-preview-inspect-colorant' : undefined}>
            {tChrome('panel.outputPreview.inspectColorant', {
              names: colour.colorants.join(', '),
            })}
          </div>
        )}
        {colour.components.length > 0 && (
          <div
            className="text-xs text-neutral-400 tabular-nums"
            data-testid={top ? 'output-preview-inspect-components' : undefined}
          >
            {tChrome('panel.outputPreview.inspectComponents', {
              values: componentText(colour.components),
            })}
          </div>
        )}
        {colour.base !== '' && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.outputPreview.inspectBase', { space: colour.base })}
          </div>
        )}
        {colour.alternate !== '' && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.outputPreview.inspectAlternate', { space: colour.alternate })}
          </div>
        )}
        {colour.n !== null && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.outputPreview.inspectComponentCount', { count: colour.n })}
          </div>
        )}
        {colour.patternType !== null && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.outputPreview.inspectPatternType', { type: colour.patternType })}
          </div>
        )}
        {object.resolution !== null && object.resolution.bpc > 0 && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.outputPreview.inspectDepth', { bpc: object.resolution.bpc })}
          </div>
        )}
        <div
          className="text-xs text-neutral-400"
          data-testid={top ? 'output-preview-inspect-resolution' : undefined}
        >
          {state === 'measured' && object.resolution !== null
            ? tChrome('panel.outputPreview.inspectResolution', {
                dpi: object.resolution.dpi,
              })
            : state === 'unmeasured'
              ? tChrome('panel.outputPreview.inspectResolutionUnmeasured')
              : tChrome('panel.outputPreview.inspectResolutionNone')}
        </div>
        {state === 'measured' && object.resolution !== null && (
          <div className="text-xs text-neutral-500 tabular-nums">
            {tChrome('panel.outputPreview.inspectResolutionAxes', {
              x: object.resolution.dpiX,
              y: object.resolution.dpiY,
              width: object.resolution.width,
              height: object.resolution.height,
            })}
          </div>
        )}
        {object.nested && object.form !== '' && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.outputPreview.inspectInsideForm', { name: object.form })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Plates, ink coverage and soft proofing are all one render device. */}
      <GsRequiredNotice capability={gs} testId="output-preview-gs" />
      <IccLicenceNotice state={icc} testId="output-preview-icc" />
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
        <label className="flex flex-col gap-1 text-sm text-neutral-300">
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {tChrome('panel.outputPreview.simulation')}
          </span>
          <select
            data-testid="output-preview-simulation"
            className="px-1 py-1 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            value={simulationSource}
            onChange={(e) => chooseSource(e.target.value as SimulationSource)}
          >
            <option value="none">{tChrome('panel.outputPreview.simulationNone')}</option>
            {simulationProfiles.document.present && (
              <option value="document">
                {tChrome('panel.outputPreview.simulationDocument')}
              </option>
            )}
            {simulationProfiles.bundled.present && (
              <option value="bundled">
                {tChrome('panel.outputPreview.simulationBundled')}
              </option>
            )}
            <option value="file">{tChrome('panel.outputPreview.simulationFile')}</option>
          </select>
        </label>

        {/* The installed set is offered BY NAME: a proof against an unnamed
            press is a picture nobody can check. */}
        {simulationSource === 'bundled' && simulationProfiles.bundled.names.length > 0 && (
          <select
            data-testid="output-preview-press"
            aria-label={tChrome('panel.outputPreview.simulationPressAria')}
            className="px-1 py-1 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            value={simulationPress}
            onChange={(e) => setSimulationPress(e.target.value)}
          >
            <option value="">
              {tChrome('panel.outputPreview.simulationPressDefault', {
                name: simulationProfiles.bundled.default,
              })}
            </option>
            {simulationProfiles.bundled.names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}

        {proofing && simulation !== null && (
          <div className="text-xs text-neutral-400" data-testid="output-preview-simulation-using">
            {tChrome('panel.outputPreview.simulationUsing', { name: simulation.name })}
          </div>
        )}
        {simulation !== null && simulation.refusal !== '' && (
          <div className="text-xs text-amber-400" data-testid="output-preview-simulation-off">
            {tChrome('panel.outputPreview.simulationOff', {
              reason: localizeEngineMessage(simulation.refusal),
            })}
          </div>
        )}
        {proofing && simulation !== null && simulation.assumed.length > 0 && (
          <div
            className="text-xs text-neutral-500"
            data-testid="output-preview-simulation-assumed"
          >
            {tChrome('panel.outputPreview.simulationAssumed', {
              spaces: simulation.assumed.join(', '),
            })}
          </div>
        )}
        {proofing && !complete && (
          <div
            className="text-xs text-amber-400"
            data-testid="output-preview-simulation-caveat"
          >
            {tChrome('panel.outputPreview.simulationCaveat')}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            data-testid="output-preview-paper-white"
            checked={usedPaperWhite}
            disabled={!proofing}
            onChange={(e) => setPaperWhite(e.target.checked)}
          />
          {tChrome('panel.outputPreview.paperWhite')}
        </label>
        <label
          className="flex items-center gap-2 text-sm text-neutral-300"
          title={blackInkForced ? tChrome('panel.outputPreview.blackInkForced') : undefined}
        >
          <input
            type="checkbox"
            data-testid="output-preview-black-ink"
            checked={usedBlackInk}
            disabled={!proofing || blackInkForced}
            onChange={(e) => setBlackInk(e.target.checked)}
          />
          {tChrome('panel.outputPreview.blackInk')}
        </label>
        {blackInkForced && (
          <div
            className="text-xs text-neutral-500"
            data-testid="output-preview-black-ink-forced"
          >
            {tChrome('panel.outputPreview.blackInkForced')}
          </div>
        )}

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

      {/* The answer to "what is THIS", so it sits above the page-wide figures
          rather than below them. */}
      <div className="flex flex-col gap-2" data-testid="output-preview-inspect">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          {tChrome('panel.outputPreview.inspect')}
        </div>
        {inspectBusy && (
          <div className="text-xs text-neutral-500" data-testid="output-preview-inspect-busy">
            {tChrome('panel.outputPreview.inspectBusy')}
          </div>
        )}
        {inspectError !== '' && (
          <div className="text-xs text-amber-400" data-testid="output-preview-inspect-error">
            {tChrome('panel.outputPreview.inspectFailed', {
              reason: localizeEngineMessage(inspectError),
            })}
          </div>
        )}
        {inspection === null && !inspectBusy && inspectError === '' && (
          <div className="text-xs text-neutral-500" data-testid="output-preview-inspect-hint">
            {tChrome('panel.outputPreview.inspectHint')}
          </div>
        )}
        {/* A readout describes the composite it was measured against, so it
            is withheld while the page is re-rastering rather than left
            standing beside a picture it no longer describes. */}
        {inspection !== null && inspectIsAvailable(busy, stats !== null) && (
          <div className="flex flex-col gap-1">
            {/* The ink is the PIXEL's. It is stated once, ABOVE the stack and
                inside no object: where inks overprint the sheet carries more
                than any one object laid down, so attributing it to the top
                object would be a claim about the wrong thing. */}
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              {tChrome('panel.outputPreview.inspectInk')}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5" data-testid="output-preview-inspect-ink">
              {inspection.ink.plates.map((plate) => (
                <span
                  key={plate.name}
                  className="text-xs text-neutral-300 tabular-nums"
                  data-testid={`output-preview-inspect-ink-${inkSlug(plate.name)}`}
                >
                  {tChrome('panel.outputPreview.inspectInkValue', {
                    name: plate.name,
                    pct: plate.pct.toFixed(1),
                  })}
                </span>
              ))}
            </div>
            <div
              className="text-xs text-neutral-300 tabular-nums"
              data-testid="output-preview-inspect-ink-total"
            >
              {tChrome('panel.outputPreview.inspectInkTotal', {
                pct: inspection.ink.total.toFixed(1),
              })}
            </div>
            <div className="text-xs text-neutral-500">
              {tChrome('panel.outputPreview.inspectInkNote')}
            </div>
            {inspectInkIsAFloor(inspection, complete) && (
              <div
                className="text-xs text-amber-400"
                data-testid="output-preview-inspect-caveat"
              >
                {tChrome('panel.outputPreview.inspectInkCaveat')}
              </div>
            )}
            {inspection.objects.length === 0 ? (
              <div
                className="text-xs text-neutral-400 mt-1"
                data-testid="output-preview-inspect-nothing"
              >
                {tChrome('panel.outputPreview.inspectNothing')}
              </div>
            ) : (
              <>
                {inspection.ambiguous && (
                  <div
                    className="text-xs text-amber-400 mt-1"
                    data-testid="output-preview-inspect-ambiguous"
                  >
                    {tChrome('panel.outputPreview.inspectAmbiguous')}
                  </div>
                )}
                {inspectedObject(inspection.objects[0], true)}
                {inspection.objects.length > 1 && (
                  <div className="text-xs uppercase tracking-wide text-neutral-500 mt-1">
                    {tChrome('panel.outputPreview.inspectUnder')}
                  </div>
                )}
                {inspection.objects.slice(1).map((object) => inspectedObject(object, false))}
              </>
            )}
            {inspection.unknown.length > 0 && (
              <div
                className="text-xs text-amber-400"
                data-testid="output-preview-inspect-unknown-page"
              >
                {tChrome('panel.outputPreview.inspectUnknownPage', {
                  reasons: inspection.unknown.map(localizeEngineMessage).join(' '),
                })}
              </div>
            )}
          </div>
        )}
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
