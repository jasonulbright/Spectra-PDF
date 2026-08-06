import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { CountSymbolGlyph } from '../components/CountSymbolGlyph';
import { SymbolPalette, symbolDisplayName } from '../components/SymbolPalette';
import { useTranslation } from 'react-i18next';
import { tChrome, tNumber } from '../i18n';
import {
  COUNT_GROUP_COLORS,
  COUNT_SYMBOLS,
  countMarksOf,
  derivedGroups,
  grandTotal,
  groupTotals,
  LEGEND_TITLE,
  LEGEND_TOTAL_WORD,
  legendLayout,
  legendText,
  mergeGroups,
  nextGroupColor,
  summaryRows,
  uniqueGroupName,
  type CountGroup,
  type CountLegendRow,
} from '../lib/count-marks';
import {
  armCountGroup,
  forgetGroup,
  getTakeoffSettings,
  rememberGroup,
  subscribeTakeoffSettings,
} from '../lib/takeoff-settings';
import type { PageAnnotation } from '../state/types';

// The Count & Takeoff dock panel.
//
// It targets the VISIBLE document through `useActiveFile` (the selectors, never
// `activeFileId` — the ghost rule), and everything it shows is DERIVED: the
// groups come from the document's own marks merged with the ones you have used
// before, and every number is counted on the spot. Nothing here stores a total.
//
// The armed group lives in the `takeoff-settings` module store rather than in
// this component, because the page cell and the secondary toolbar need the same
// answer and sit in a different tree (the snap-settings precedent).

export function TakeoffPanel(): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const takeoff = useSyncExternalStore(
    subscribeTakeoffSettings,
    getTakeoffSettings,
    getTakeoffSettings,
  );
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  // Every page of every document that shares the visible file's path — the
  // same containment rule the Comments panel uses.
  const docs = useMemo(
    () => state.workspace.documents.filter((d) => d.path === activeFile?.path),
    [state.workspace.documents, activeFile?.path],
  );
  const pageAnnotations = useMemo<PageAnnotation[][]>(
    () => docs.flatMap((d) => d.pages.map((p) => p.annotations ?? [])),
    [docs],
  );
  const marks = useMemo(() => pageAnnotations.flatMap((a) => countMarksOf(a)), [pageAnnotations]);
  const rows = useMemo(() => summaryRows(pageAnnotations), [pageAnnotations]);
  const totals = useMemo(() => groupTotals(rows), [rows]);
  const total = grandTotal(rows);
  const groups = useMemo(
    () => mergeGroups(derivedGroups(marks), takeoff.groups),
    [marks, takeoff.groups],
  );
  const armed = groups.find((g) => g.name === takeoff.armed) ?? null;

  const countOf = useCallback(
    (name: string) => totals.find((t) => t.group === name)?.count ?? 0,
    [totals],
  );

  const addGroup = useCallback(() => {
    const name = uniqueGroupName(tChrome('panel.takeoff.newGroupName'), groups);
    const group: CountGroup = {
      name,
      color: nextGroupColor(groups),
      symbol: COUNT_SYMBOLS[groups.length % COUNT_SYMBOLS.length].id,
    };
    rememberGroup(group);
    armCountGroup(group);
    setEditing(name);
  }, [groups]);

  /** Edit a remembered group. A group the FILE carries is renamed/recoloured
   * by editing its marks, not here — so the controls act on the store and the
   * marks already placed keep the look they were placed with. */
  const updateGroup = useCallback(
    (group: CountGroup, patch: Partial<CountGroup>) => {
      const next = { ...group, ...patch };
      if (patch.name !== undefined && !patch.name.trim()) return;
      if (patch.name !== undefined && patch.name !== group.name) {
        forgetGroup(group.name);
      }
      rememberGroup(next);
      armCountGroup(next);
    },
    [],
  );

  /** Place the legend on the page the reader is on (or the first page).
   *
   * The rows are a SNAPSHOT: what the legend says is what the counts were when
   * it was placed. Re-place it when they change — the same contract a stamp
   * has, and the reason nothing re-derives it at commit time. */
  const placeLegend = useCallback(() => {
    const doc =
      docs.find((d) => d.pages.some((p) => p.id === state.ui.currentPageId)) ?? docs[0];
    if (!doc) return;
    const page =
      doc.pages.find((p) => p.id === state.ui.currentPageId) ?? doc.pages[0];
    if (!page) return;
    const legendRows: CountLegendRow[] = totals.map((t) => ({
      symbol: t.symbol,
      group: t.group,
      color: t.color,
      count: t.count,
    }));
    if (legendRows.length === 0) {
      setStatus(tChrome('panel.takeoff.nothingToLegend'));
      return;
    }
    // Written INTO the document, so English by rule (the measure.ts
    // format-string precedent) — unlike the panel's own Total line below,
    // which is chrome and localizes.
    const title = LEGEND_TITLE;
    const totalWord = LEGEND_TOTAL_WORD;
    const layout = legendLayout(legendRows, title);
    // The DISPLAYED page size in PDF points — axes swap at 90/270, exactly as
    // every other placement computes it.
    const swapped = page.rotation === 90 || page.rotation === 270;
    const dispW = swapped ? page.height : page.width;
    const dispH = swapped ? page.width : page.height;
    const w = Math.min(0.9, layout.widthPt / dispW);
    const h = Math.min(0.9, layout.heightPt / dispH);
    dispatch({
      type: 'ADD_ANNOTATION',
      docId: doc.id,
      pageId: page.id,
      annotation: {
        id: crypto.randomUUID(),
        kind: 'countlegend',
        x: Math.max(0, 1 - w - 0.04),
        y: 0.04,
        w,
        h,
        color: armed?.color ?? COUNT_GROUP_COLORS[0],
        note: legendText(legendRows, title, totalWord),
        legendRows,
        legendTitle: title,
        legendTotalWord: totalWord,
      },
    });
    setStatus(tChrome('panel.takeoff.legendPlaced'));
  }, [docs, state.ui.currentPageId, totals, armed, dispatch]);

  /** CSV export. The engine reads the FILE, so the gated `call` flushes the
   * pending marks first — the same gate-flushed read the XFDF export uses,
   * which is what makes the exported numbers match the ones on screen. */
  const exportCsv = useCallback(async () => {
    if (!activeFile) return;
    const output = await dialog.saveFile({
      defaultPath: activeFile.name.replace(/\.pdf$/i, '') + '-takeoff.csv',
    });
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('panel.takeoff.exporting'));
    try {
      const res = (await call('export_count_summary', {
        file: activeFile.workingPath,
        output,
      })) as unknown as { total: number; groups: number };
      setStatus(
        tChrome('panel.takeoff.exported', {
          total: tNumber(res.total),
          groups: tNumber(res.groups),
        }),
      );
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, call]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.takeoff.open')} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-300">{tChrome('panel.takeoff.groups')}</span>
        <button
          type="button"
          data-testid="takeoff-add-group"
          onClick={addGroup}
          className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
        >
          {tChrome('panel.takeoff.addGroup')}
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="takeoff-empty">
          {tChrome('panel.takeoff.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="takeoff-groups" role="list">
          {groups.map((g) => (
            <div
              key={g.name}
              role="listitem"
              data-testid={`takeoff-group-${g.name}`}
              className={
                'px-2 py-1.5 rounded border ' +
                (armed?.name === g.name
                  ? 'bg-neutral-700/70 border-neutral-500'
                  : 'bg-neutral-800/60 border-neutral-800')
              }
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`takeoff-arm-${g.name}`}
                  aria-pressed={armed?.name === g.name}
                  title={tChrome('panel.takeoff.armTitle')}
                  onClick={() => armCountGroup(g)}
                  className="flex items-center gap-2 flex-1 text-start"
                >
                  <CountSymbolGlyph symbol={g.symbol} color={g.color} />
                  <span className="text-sm text-neutral-100 truncate">{g.name}</span>
                  <span
                    className="ms-auto text-sm tabular-nums text-neutral-300"
                    data-testid={`takeoff-count-${g.name}`}
                  >
                    {tNumber(countOf(g.name))}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid={`takeoff-edit-${g.name}`}
                  onClick={() => setEditing(editing === g.name ? null : g.name)}
                  className="text-xs px-1.5 py-0.5 rounded text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
                >
                  {tChrome('panel.takeoff.edit')}
                </button>
              </div>

              {editing === g.name && (
                <div className="mt-1 flex flex-col gap-1">
                  <input
                    data-testid={`takeoff-name-${g.name}`}
                    aria-label={tChrome('panel.takeoff.nameAria')}
                    defaultValue={g.name}
                    onBlur={(ev) => {
                      const value = ev.target.value.trim();
                      if (value && value !== g.name) {
                        updateGroup(g, { name: value });
                        setEditing(value);
                      }
                    }}
                    className="w-full text-sm bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100"
                  />
                  <div className="flex items-center gap-1 flex-wrap">
                    {COUNT_GROUP_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={tChrome('panel.takeoff.colorAria', { color: c })}
                        onClick={() => updateGroup(g, { color: c })}
                        className="w-4 h-4 rounded-sm border border-black/30"
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                  {/* The marker comes from the whole symbol
                      REGISTRY — the built-in markers, the built-in AEC set and
                      every imported one — through the same palette the stamp
                      picker places from. One registry, two consumers. */}
                  <div className="text-xs text-neutral-400">{tChrome('panel.takeoff.marker')}</div>
                  <SymbolPalette
                    mode="pick"
                    idPrefix="takeoff-symbol"
                    compact
                    color={g.color}
                    selectedId={g.symbol}
                    onPick={(hit) => updateGroup(g, { symbol: hit.symbol.id })}
                  />
                  <button
                    type="button"
                    data-testid={`takeoff-forget-${g.name}`}
                    onClick={() => {
                      forgetGroup(g.name);
                      setEditing(null);
                    }}
                    title={tChrome('panel.takeoff.forgetTitle')}
                    className="self-start text-xs px-1.5 py-0.5 rounded text-neutral-400 hover:bg-red-600 hover:text-white"
                  >
                    {tChrome('panel.takeoff.forget')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-sm text-neutral-300" data-testid="takeoff-total">
        {tChrome('panel.takeoff.total')}: <span className="tabular-nums">{tNumber(total)}</span>
      </div>

      {rows.length > 0 && (
        <div className="max-h-48 overflow-y-auto" data-testid="takeoff-rows">
          <table className="w-full text-xs text-neutral-300">
            <thead className="text-neutral-500">
              <tr>
                <th className="text-start font-normal">{tChrome('panel.takeoff.colGroup')}</th>
                <th className="text-start font-normal">{tChrome('panel.takeoff.colPage')}</th>
                <th className="text-end font-normal">{tChrome('panel.takeoff.colCount')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.group}-${r.page}`}>
                  <td className="truncate">{r.group}</td>
                  <td className="tabular-nums">{tNumber(r.page)}</td>
                  <td className="text-end tabular-nums">{tNumber(r.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          data-testid="takeoff-place-legend"
          onClick={placeLegend}
          disabled={busy}
          title={tChrome('panel.takeoff.legendHint')}
          className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm"
        >
          {tChrome('panel.takeoff.placeLegend')}
        </button>
        <button
          type="button"
          data-testid="takeoff-export-csv"
          onClick={() => void exportCsv()}
          disabled={busy}
          title={tChrome('panel.takeoff.exportHint')}
          className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm"
        >
          {tChrome('panel.takeoff.exportCsv')}
        </button>
      </div>
      {/* The symbol library. It lives here because the dock has
          the room for set management (import / export / remove), and the same
          palette is what the stamp picker places from: one registry, two
          consumers. Dragging a symbol onto the page places it; clicking one
          makes it the ARMED group's marker. */}
      <div className="flex flex-col gap-1 border-t border-neutral-800 pt-2">
        <span className="text-sm text-neutral-300">{tChrome('panel.symbols.title')}</span>
        <p className="text-xs text-neutral-500">{tChrome('panel.symbols.hint')}</p>
        <SymbolPalette
          mode="place"
          manage
          idPrefix="symbol"
          color={armed?.color ?? COUNT_GROUP_COLORS[0]}
          selectedId={armed?.symbol}
          onPick={(hit) => {
            if (!armed) {
              setStatus(tChrome('panel.symbols.noArmedGroup'));
              return;
            }
            updateGroup(armed, { symbol: hit.symbol.id });
            setStatus(
              tChrome('panel.symbols.markerSet', {
                group: armed.name,
                name: symbolDisplayName(hit.set, hit.symbol),
              }),
            );
          }}
        />
      </div>

      {status && <div className="text-xs text-neutral-400" data-testid="takeoff-status">{status}</div>}
    </div>
  );
}
