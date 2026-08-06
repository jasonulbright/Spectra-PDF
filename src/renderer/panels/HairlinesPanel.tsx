import React, { useCallback, useEffect, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import {
  DEFAULT_REPLACEMENT_PT,
  DEFAULT_THRESHOLD_PT,
  type HairlineReport,
  boundsProblem,
  unreadablePages,
  widthSummary,
} from '../lib/hairlines';

/** A threshold is typed digit by digit and each measurement walks every page,
 *  so the automatic re-measure waits for the typing to stop. */
const MEASURE_DEBOUNCE_MS = 400;

export function HairlinesPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_PT);
  const [replacement, setReplacement] = useState(DEFAULT_REPLACEMENT_PT);
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [report, setReport] = useState<HairlineReport | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const workingPath = activeFile?.workingPath ?? null;
  const filePath = activeFile?.path ?? null;
  const buffer = activeFile?.buffer ?? null;
  const problem = boundsProblem(threshold, replacement);

  const measure = useCallback(async () => {
    if (!workingPath) return;
    setBusy(true);
    try {
      const res = await call('list_hairlines', {
        file: workingPath,
        threshold_pt: threshold,
        include_annotations: includeAnnotations,
      });
      setReport(res as unknown as HairlineReport);
      setStatus('');
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', {
        message: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusy(false);
    }
  }, [workingPath, call, threshold, includeAnnotations]);

  // The count is measured whenever the document or the threshold changes, so
  // the panel states how many strokes at what widths BEFORE anything is
  // rewritten — a fix whose first evidence is the changed file is a fix the
  // user cannot judge. The measurement walks every page's vectors, so a
  // threshold typed digit by digit is DEBOUNCED rather than run per keystroke.
  useEffect(() => {
    if (!workingPath) {
      setReport(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await call('list_hairlines', {
            file: workingPath,
            threshold_pt: threshold,
            include_annotations: includeAnnotations,
          });
          if (!cancelled) setReport(res as unknown as HairlineReport);
        } catch (e: unknown) {
          if (!cancelled) {
            setStatus(tChrome('panel.common.error', {
              message: e instanceof Error ? e.message : String(e),
            }));
          }
        }
      })();
    }, MEASURE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workingPath, buffer, call, threshold, includeAnnotations]);

  const applyFix = useCallback(async () => {
    if (!filePath || problem) return;
    setBusy(true);
    setStatus(tChrome('panel.hairlines.fixing'));
    try {
      await performOperation(filePath, 'fix_hairlines', {
        threshold_pt: threshold,
        replacement_pt: replacement,
        include_annotations: includeAnnotations,
      });
      setStatus(tChrome('panel.hairlines.fixed', { width: replacement }));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', {
        message: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusy(false);
    }
  }, [filePath, performOperation, threshold, replacement, includeAnnotations, problem]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.hairlines.open')} />;
  }

  const widths = widthSummary(report);
  const unreadable = unreadablePages(report);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.hairlines.blurb')}</p>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.hairlines.threshold')}
          <input
            type="number"
            data-testid="hairlines-threshold"
            className="w-20 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={0.01}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          {tChrome('panel.hairlines.replacement')}
          <input
            type="number"
            data-testid="hairlines-replacement"
            className="w-20 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
            min={0.01}
            step={0.05}
            value={replacement}
            onChange={(e) => setReplacement(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            data-testid="hairlines-annotations"
            checked={includeAnnotations}
            onChange={(e) => setIncludeAnnotations(e.target.checked)}
          />
          {tChrome('panel.hairlines.annotations')}
        </label>
      </div>

      {problem === 'threshold' && (
        <div className="text-xs text-amber-400" data-testid="hairlines-bad-threshold">
          {tChrome('panel.hairlines.thresholdProblem')}
        </div>
      )}
      {problem === 'replacement' && (
        <div className="text-xs text-amber-400" data-testid="hairlines-bad-replacement">
          {tChrome('panel.hairlines.replacementProblem')}
        </div>
      )}

      <div className="flex flex-col gap-1" data-testid="hairlines-report">
        <div className="text-sm text-neutral-200" data-testid="hairlines-count">
          {tChrome('panel.hairlines.count', {
            count: report?.count ?? 0,
            strokes: report?.stroke_count ?? 0,
            annotations: report?.annotation_count ?? 0,
          })}
        </div>
        {widths.map((row) => (
          <div
            key={row.effective_pt}
            data-testid={`hairlines-width-${String(row.effective_pt).replace('.', '-')}`}
            className="text-xs text-neutral-400"
          >
            {tChrome('panel.hairlines.widthRow', {
              width: row.effective_pt,
              count: row.count,
            })}
          </div>
        ))}
        {unreadable.length > 0 && (
          <div className="text-xs text-amber-400" data-testid="hairlines-unreadable">
            {tChrome('panel.hairlines.unreadable', { pages: unreadable.join(', ') })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          data-testid="hairlines-measure"
          disabled={busy}
          onClick={() => void measure()}
          className="px-3 py-1.5 text-sm bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.hairlines.measure')}
        </button>
        <button
          data-testid="hairlines-fix"
          disabled={busy || problem !== null || (report?.count ?? 0) === 0}
          onClick={() => void applyFix()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
        >
          {tChrome('panel.hairlines.fix')}
        </button>
      </div>

      <StatusBar message={status} busy={busy} />
    </div>
  );
}
