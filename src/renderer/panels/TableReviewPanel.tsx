import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { getCanvasServices } from '../commands/context';
import { dialog } from '../lib/tauri-bridge';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import { exportSummary, type ExportDocumentResult } from '../lib/export-targets';
import {
  acceptedRegions,
  selectionState,
  setAcceptedAll,
  toggleRegion,
  type TableDetectionResult,
  type TableRegion,
} from '../lib/table-review';

// The review surface for table detection.
//
// **Detection produces a SUGGESTION, and nothing is written until the reviewer
// accepts it.** The panel lists what was found and what was not; the canvas
// draws each table as a provisional overlay whose bounds and column boundaries
// can be dragged; "Export to spreadsheet" is the only control here that
// produces a file, and the file it produces is a workbook — never the PDF.
//
// The detection call goes through the GATED `call`: a table's page is a
// position IN THE FILE, and the geometry it reports describes the bytes on
// disk, which agree with what the user is looking at only after pending page
// edits are flushed.

const SHEET_PER = [
  { value: 'table', key: 'dialog.exportDoc.sheetPer.table' },
  { value: 'page', key: 'dialog.exportDoc.sheetPer.page' },
] as const;

type Scope = { kind: 'document' | 'pages'; pages: string };

function parsePages(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let p = Math.min(from, to); p <= Math.max(from, to); p += 1) out.add(p);
      continue;
    }
    const single = Number(part.trim());
    if (Number.isInteger(single) && single > 0) out.add(single);
  }
  return [...out].sort((a, b) => a - b);
}

export function TableReviewPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const state = useAppState();
  const dispatch = useAppDispatch();

  const [regions, setRegions] = useState<TableRegion[]>([]);
  const [result, setResult] = useState<TableDetectionResult | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: 'document', pages: '' });
  const [sheetPer, setSheetPer] = useState('table');
  const [includeUntabled, setIncludeUntabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState<string[]>([]);

  const path = activeFile?.path ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const armed = state.ui.tool === 'tablereview';

  // The canvas owns the region set; this mirrors it so a bounds drag or a
  // boundary nudge on the page shows here too.
  const sync = useCallback(() => {
    const services = getCanvasServices();
    setRegions(services ? services.tableReview.list() : []);
  }, []);

  useEffect(() => {
    sync();
    const services = getCanvasServices();
    if (!services) return;
    return services.tableReview.subscribe(sync);
  }, [sync]);

  useEffect(() => {
    // A different document is a different set of tables; the previous one's
    // regions name areas that are not on screen.
    setRegions([]);
    setResult(null);
    setStatus('');
    setSummary([]);
    setError(null);
    getCanvasServices()?.tableReview.clear();
  }, [path]);

  const publish = useCallback((next: TableRegion[]) => {
    setRegions(next);
    getCanvasServices()?.tableReview.update(next);
  }, []);

  const detect = useCallback(async () => {
    if (!workingPath || !path) return;
    setBusy(true);
    setError(null);
    setStatus('');
    setSummary([]);
    try {
      const pages = scope.kind === 'document' ? 'all' : parsePages(scope.pages);
      if (scope.kind === 'pages' && (pages as number[]).length === 0) {
        setError(tChrome('panel.tableReview.noPages'));
        return;
      }
      const detection = (await call('detect_tables', {
        file: workingPath,
        pages,
      })) as unknown as TableDetectionResult;
      setResult(detection);
      const services = getCanvasServices();
      if (!services) {
        setError(tChrome('panel.tableReview.noCanvas'));
        return;
      }
      const { shown } = await services.tableReview.publish(path, detection);
      // Arming AFTER the publish: a mode with nothing to draw is a mode that
      // looks broken.
      if (shown > 0) dispatch({ type: 'UI_SET_TOOL', tool: 'tablereview' });
      setStatus(
        shown === 0
          ? tChrome('panel.tableReview.foundNone')
          : tChromeCount('panel.tableReview.found', shown),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [call, dispatch, path, scope, workingPath]);

  const runExport = useCallback(async () => {
    const chosen = acceptedRegions(regions);
    if (chosen.length === 0 || !activeFile) return;
    const base = activeFile.name.replace(/\.pdf$/i, '');
    const out = await dialog.saveFile({ defaultPath: `${base}.xlsx` });
    if (!out) return;
    setExporting(true);
    setError(null);
    setSummary([]);
    try {
      const services = getCanvasServices();
      if (!services) {
        setError(tChrome('panel.tableReview.noCanvas'));
        return;
      }
      const written = (await services.tableReview.exportTo(out, {
        sheetPer,
        includeUntabled,
      })) as ExportDocumentResult;
      setSummary(exportSummary('xlsx', written));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [activeFile, includeUntabled, regions, sheetPer]);

  const pages = useMemo(
    () => [...new Set(regions.map((r) => r.page))].sort((a, b) => a - b),
    [regions],
  );
  const state3 = selectionState(regions);
  const acceptedCount = regions.filter((r) => r.accepted).length;

  if (!activeFile) {
    return <NoFileOpen message={tChrome('panel.tableReview.open')} onOpen={openNewFiles} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="table-review-panel">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      <p className="text-xs text-neutral-400">{tChrome('panel.tableReview.blurb')}</p>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-neutral-400" htmlFor="table-review-scope">
          {tChrome('panel.tableReview.scope')}
        </label>
        <select
          id="table-review-scope"
          data-testid="table-review-scope"
          className="bg-neutral-800 text-sm rounded px-2 py-1"
          value={scope.kind}
          onChange={(e) => setScope({ ...scope, kind: e.target.value as Scope['kind'] })}
        >
          <option value="document">{tChrome('panel.tableReview.scopeDocument')}</option>
          <option value="pages">{tChrome('panel.tableReview.scopePages')}</option>
        </select>
        {scope.kind === 'pages' && (
          <input
            className="bg-neutral-800 text-sm rounded px-2 py-1"
            data-testid="table-review-pages"
            aria-label={tChrome('panel.tableReview.pagesAria')}
            placeholder={tChrome('panel.tableReview.pagesPlaceholder')}
            value={scope.pages}
            onChange={(e) => setScope({ ...scope, pages: e.target.value })}
          />
        )}
      </div>

      <button
        type="button"
        data-testid="table-review-detect"
        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
        disabled={busy}
        onClick={() => void detect()}
      >
        {busy ? tChrome('panel.tableReview.detecting') : tChrome('panel.tableReview.detect')}
      </button>

      {status && (
        <p className="text-xs text-neutral-300" data-testid="table-review-status" aria-live="polite">
          {status}
        </p>
      )}

      {regions.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              data-testid="table-review-accept-all"
              className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
              onClick={() => publish(setAcceptedAll(regions, state3 !== 'all'))}
            >
              {state3 === 'all'
                ? tChrome('panel.tableReview.acceptNone')
                : tChrome('panel.tableReview.acceptAll')}
            </button>
            <span className="text-neutral-400" data-testid="table-review-accepted-count">
              {tChromeCount('panel.tableReview.accepted', acceptedCount)}
            </span>
          </div>

          {pages.map((page) => (
            <div key={page} className="flex flex-col gap-1">
              <div className="text-xs text-neutral-500">
                {tChrome('panel.tableReview.pageHead', { page: tNumber(page) })}
              </div>
              {regions
                .filter((r) => r.page === page)
                .map((region) => (
                  <div
                    key={region.id}
                    className="flex items-center gap-2 text-sm"
                    data-testid={`table-review-row-${region.id}`}
                  >
                    <input
                      type="checkbox"
                      data-testid={`table-review-check-${region.id}`}
                      aria-label={tChrome('panel.tableReview.acceptAria')}
                      checked={region.accepted}
                      onChange={() => publish(toggleRegion(regions, region.id))}
                    />
                    <button
                      type="button"
                      className="flex-1 text-start hover:underline"
                      onClick={() => getCanvasServices()?.tableReview.focus(region.id)}
                    >
                      {region.caption ?? tChrome('canvas.tableReview.untitled')}
                    </button>
                    <span className="text-xs text-neutral-500">
                      {tChrome('panel.tableReview.shape', {
                        rows: tNumber(region.rows.length),
                        columns: tNumber(region.columns.length),
                        cells: tNumber(region.cells),
                      })}
                    </span>
                  </div>
                ))}
            </div>
          ))}

          {!armed && (
            <button
              type="button"
              data-testid="table-review-show"
              className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-xs"
              onClick={() => dispatch({ type: 'UI_SET_TOOL', tool: 'tablereview' })}
            >
              {tChrome('panel.tableReview.show')}
            </button>
          )}
        </>
      )}

      {result && (
        <div className="flex flex-col gap-1 text-xs text-neutral-400">
          {result.regions.length > 0 && (
            <p>{tChrome('panel.tableReview.adjustHint')}</p>
          )}
          {Object.keys(result.untabled).length > 0 && (
            <p data-testid="table-review-untabled">
              {tChromeCount(
                'panel.tableReview.untabled',
                Object.values(result.untabled).reduce((n, lines) => n + lines.length, 0),
              )}
            </p>
          )}
          {result.vertical_writing_runs > 0 && (
            <p>{tChromeCount('panel.tableReview.verticalRuns', result.vertical_writing_runs)}</p>
          )}
        </div>
      )}

      {regions.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
          <label className="text-xs text-neutral-400" htmlFor="table-review-sheet-per">
            {tChrome('dialog.exportDoc.sheetPer')}
          </label>
          <select
            id="table-review-sheet-per"
            data-testid="table-review-sheet-per"
            className="bg-neutral-800 text-sm rounded px-2 py-1"
            value={sheetPer}
            disabled={exporting}
            onChange={(e) => setSheetPer(e.target.value)}
          >
            {SHEET_PER.map((option) => (
              <option key={option.value} value={option.value}>
                {tChrome(option.key)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid="table-review-include-untabled"
              checked={includeUntabled}
              disabled={exporting}
              onChange={(e) => setIncludeUntabled(e.target.checked)}
            />
            {tChrome('dialog.exportDoc.includeUntabled')}
          </label>
          <button
            type="button"
            data-testid="table-review-export"
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
            disabled={exporting || acceptedCount === 0}
            onClick={() => void runExport()}
          >
            {exporting
              ? tChrome('panel.tableReview.exporting')
              : tChrome('panel.tableReview.export')}
          </button>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-400" data-testid="table-review-error" aria-live="polite">
          {error}
        </p>
      )}
      {summary.length > 0 && (
        <div className="text-sm break-all" data-testid="table-review-done" aria-live="polite">
          {summary.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
