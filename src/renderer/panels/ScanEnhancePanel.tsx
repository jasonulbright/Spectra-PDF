import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppStateProvider';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import { ghostscriptPath, tesseractPath } from '../lib/ocr-recognize';
import {
  DEFAULT_SCAN_ENHANCE,
  previewCounts,
  refusedRows,
  scopeParam,
  settingsProblem,
  uncertainOrientation,
  worstSkew,
  type ScanAnalysis,
  type ScanEnhanceSettings,
  type ScanScope,
} from '../lib/scan-enhance';

/** A measurement decodes and segments every page in scope, so a setting typed
 *  digit by digit waits for the typing to stop (the hairlines precedent). */
const MEASURE_DEBOUNCE_MS = 500;

// The Scan Enhancement pane, and the first op the Scan & OCR tool has owned.
//
// Shape: measure, state what each correction WOULD do, then apply — the
// hairlines panel's contract, for the same reason. Enhancement is lossy raster
// surgery, so a run whose first evidence is the changed file is a run the user
// cannot judge.
//
// The default scope is THIS PAGE, not the document. A measurement decodes the
// scan, segments it and asks Tesseract for an orientation reading, which is
// seconds per page; defaulting to the whole document would make opening the
// pane a minutes-long stall on a long scan.

export function ScanEnhancePanel(): React.ReactElement {
  useTranslation();
  const state = useAppState();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();

  const [settings, setSettings] = useState<ScanEnhanceSettings>(DEFAULT_SCAN_ENHANCE);
  const [scope, setScope] = useState<ScanScope['kind']>('page');
  const [report, setReport] = useState<ScanAnalysis | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const workingPath = activeFile?.workingPath ?? null;
  const filePath = activeFile?.path ?? null;
  const buffer = activeFile?.buffer ?? null;
  const problem = settingsProblem(settings);

  // The page the reader is on, 1-based, resolved the way every other panel
  // resolves it: through the workspace documents that share the visible file's
  // path, never a canvas ref (the Takeoff legend precedent).
  const currentPage = useMemo(() => {
    const docs = state.workspace.documents.filter((d) => d.path === activeFile?.path);
    for (const doc of docs) {
      const index = doc.pages.findIndex((p) => p.id === state.ui.currentPageId);
      if (index >= 0) return index + 1;
    }
    return 1;
  }, [state.workspace.documents, state.ui.currentPageId, activeFile?.path]);

  const params = useMemo(() => {
    const target: ScanScope =
      scope === 'document' ? { kind: 'document' } : { kind: 'page', page: currentPage };
    return { pages: scopeParam(target), ...settings };
  }, [scope, currentPage, settings]);

  const counts = useMemo(() => previewCounts(report), [report]);

  // The vendored binaries travel with EVERY call, not only when orientation
  // detection is on: Tesseract is what reads the orientation and Ghostscript
  // is the fallback decoder for a codestream this build cannot open, and a
  // request without them refuses by name rather than quietly doing less.
  const toolPaths = useCallback(
    async () => {
      const [tesseract, gs] = await Promise.all([tesseractPath(), ghostscriptPath()]);
      return { tesseract_path: tesseract, gs_path: gs };
    },
    [],
  );

  const measure = useCallback(async () => {
    if (!workingPath || problem) return;
    setBusy(true);
    setStatus(tChrome('panel.scanEnhance.measuring'));
    try {
      const res = await call('analyze_scan', {
        file: workingPath,
        ...params,
        ...(await toolPaths()),
      });
      setReport(res as unknown as ScanAnalysis);
      setStatus('');
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [workingPath, call, params, problem, toolPaths]);

  // Measured whenever the document, the scope or a setting changes, so the
  // panel states what each correction would do BEFORE anything is rewritten.
  useEffect(() => {
    if (!workingPath || problem) {
      setReport(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await call('analyze_scan', {
            file: workingPath,
            ...params,
            ...(await toolPaths()),
          });
          if (!cancelled) setReport(res as unknown as ScanAnalysis);
        } catch (e: unknown) {
          if (!cancelled) {
            setStatus(
              tChrome('panel.common.error', {
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        }
      })();
    }, MEASURE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workingPath, buffer, call, params, problem, toolPaths]);

  const apply = useCallback(async () => {
    if (!filePath || problem) return;
    setBusy(true);
    setStatus(tChrome('panel.scanEnhance.applying'));
    try {
      // The standard snapshot(gate) → engine → reload → UPDATE_FILE flow, so
      // the whole enhancement is ONE undo step.
      await performOperation(filePath, 'enhance_scan', {
        ...params,
        ...(await toolPaths()),
      });
      setStatus(tChrome('panel.scanEnhance.applied', { count: counts.changing }));
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [filePath, performOperation, params, problem, counts.changing, toolPaths]);

  const skew = worstSkew(report);
  const uncertain = uncertainOrientation(report, settings.osd_confidence);
  const refused = refusedRows(report);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.scanEnhance.open')} />;
  }

  const set = <K extends keyof ScanEnhanceSettings>(key: K, value: ScanEnhanceSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.scanEnhance.blurb')}</p>

      <label className="flex items-center gap-2 text-xs text-neutral-500">
        {tChrome('panel.scanEnhance.scopeLabel')}
        <select
          data-testid="scanenhance-scope"
          className="px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
          value={scope}
          onChange={(e) => setScope(e.target.value === 'document' ? 'document' : 'page')}
        >
          <option value="page">{tChrome('panel.scanEnhance.scopePage')}</option>
          <option value="document">{tChrome('panel.scanEnhance.scopeDocument')}</option>
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            data-testid="scanenhance-deskew"
            checked={settings.deskew}
            onChange={(e) => set('deskew', e.target.checked)}
          />
          {tChrome('panel.scanEnhance.deskew')}
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            data-testid="scanenhance-despeckle"
            checked={settings.despeckle}
            onChange={(e) => set('despeckle', e.target.checked)}
          />
          {tChrome('panel.scanEnhance.despeckle')}
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            data-testid="scanenhance-background"
            checked={settings.background}
            onChange={(e) => set('background', e.target.checked)}
          />
          {tChrome('panel.scanEnhance.background')}
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            data-testid="scanenhance-orientation"
            checked={settings.orientation}
            onChange={(e) => set('orientation', e.target.checked)}
          />
          {tChrome('panel.scanEnhance.orientation')}
        </label>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.scanEnhance.maxSkew')}
          <input
            type="number"
            data-testid="scanenhance-maxskew"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={0.1}
            max={45}
            step={0.5}
            value={settings.max_skew_deg}
            onChange={(e) => set('max_skew_deg', Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.scanEnhance.speckSize')}
          <input
            type="number"
            data-testid="scanenhance-specksize"
            className="w-20 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={0.001}
            max={0.05}
            step={0.002}
            value={settings.speck_size_in}
            onChange={(e) => set('speck_size_in', Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.scanEnhance.strength')}
          <input
            type="number"
            data-testid="scanenhance-strength"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={0}
            max={1}
            step={0.05}
            value={settings.background_strength}
            onChange={(e) => set('background_strength', Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.scanEnhance.confidence')}
          <input
            type="number"
            data-testid="scanenhance-confidence"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={0}
            step={0.5}
            value={settings.osd_confidence}
            onChange={(e) => set('osd_confidence', Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.scanEnhance.quality')}
          <input
            type="number"
            data-testid="scanenhance-quality"
            className="w-16 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={1}
            max={100}
            step={1}
            value={settings.jpeg_quality}
            onChange={(e) => set('jpeg_quality', Number(e.target.value))}
          />
        </label>
      </div>

      {problem !== null && (
        <div className="text-xs text-amber-400" data-testid={`scanenhance-bad-${problem}`}>
          {tChrome(`panel.scanEnhance.${problem}Problem` as 'panel.scanEnhance.nothingProblem')}
        </div>
      )}

      <div className="flex flex-col gap-1" data-testid="scanenhance-report">
        <div className="text-sm text-neutral-200" data-testid="scanenhance-scans">
          {counts.scans === 0
            ? tChrome('panel.scanEnhance.noScans')
            : tChromeCount('panel.scanEnhance.scanCount', counts.scans)}
        </div>
        {counts.scans > 0 && (
          <div className="text-xs text-neutral-400" data-testid="scanenhance-changing">
            {counts.changing === 0
              ? tChrome('panel.scanEnhance.nothingToDo')
              : tChrome('panel.scanEnhance.changing', { count: counts.changing })}
          </div>
        )}
        {counts.deskew > 0 && skew !== null && (
          <div className="text-xs text-neutral-400" data-testid="scanenhance-deskew-row">
            {tChrome('panel.scanEnhance.deskewRow', {
              count: counts.deskew,
              angle: skew.toFixed(2),
            })}
          </div>
        )}
        {counts.despeckle > 0 && (
          <div className="text-xs text-neutral-400" data-testid="scanenhance-despeckle-row">
            {tChrome('panel.scanEnhance.despeckleRow', {
              count: counts.despeckle,
              specks: counts.specks,
            })}
          </div>
        )}
        {counts.whiten > 0 && (
          <div className="text-xs text-neutral-400" data-testid="scanenhance-whiten-row">
            {tChrome('panel.scanEnhance.whitenRow', { count: counts.whiten })}
          </div>
        )}
        {counts.rotate > 0 && (
          <div className="text-xs text-neutral-400" data-testid="scanenhance-rotate-row">
            {tChrome('panel.scanEnhance.rotateRow', { count: counts.rotate })}
          </div>
        )}
        {uncertain.length > 0 && (
          <div className="text-xs text-amber-400" data-testid="scanenhance-uncertain">
            {tChrome('panel.scanEnhance.uncertain', {
              pages: uncertain.map((r) => r.page).join(', '),
            })}
          </div>
        )}
        {refused.length > 0 && (
          <div className="text-xs text-neutral-500" data-testid="scanenhance-refused">
            {tChrome('panel.scanEnhance.refused', {
              pages: refused.map((r) => r.page).join(', '),
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          data-testid="scanenhance-measure"
          disabled={busy || problem !== null}
          onClick={() => void measure()}
          className="px-3 py-1.5 text-sm bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.scanEnhance.measure')}
        </button>
        <button
          data-testid="scanenhance-apply"
          disabled={busy || problem !== null || counts.changing === 0}
          onClick={() => void apply()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
        >
          {tChrome('panel.scanEnhance.apply')}
        </button>
      </div>

      <StatusBar message={status} busy={busy} />
    </div>
  );
}
