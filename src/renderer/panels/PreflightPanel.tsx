import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';

interface Check {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}
interface Report {
  checks: Check[];
  passed: number;
  warnings: number;
  failed: number;
  total: number;
  images: number;
  color_families: string[];
}

const ICON: Record<Check['status'], { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: '#2fbf71' },
  warn: { glyph: '!', color: '#fbbf24' },
  fail: { glyph: '✕', color: '#f87171' },
};

export function PreflightPanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  const run = useCallback(async () => {
    if (!workingPath) return;
    setBusy(true);
    setStatus(tChrome('panel.preflight.analysing'));
    try {
      const res = await call('preflight', { file: workingPath });
      setReport(res as unknown as Report);
      setStatus('');
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [workingPath, call]);

  useEffect(() => {
    if (!buffer || !workingPath) {
      setReport(null);
      return;
    }
    void run();
  }, [buffer, workingPath, run]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.preflight.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-400">
          {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <button
          data-testid="preflight-recheck"
          onClick={() => void run()}
          disabled={busy}
          className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.preflight.rerun')}
        </button>
      </div>

      {report && (
        <div className="text-sm text-neutral-300" data-testid="preflight-summary">
          {report.failed === 0 && report.warnings === 0 ? (
            <span className="text-green-400">{tChrome('panel.preflight.allPassed', { count: report.total })}</span>
          ) : (
            <>
              <span className="text-green-400">{tChrome('panel.preflight.passed', { count: report.passed })}</span>
              {report.warnings > 0 && (
                <>, <span className="text-amber-400">{tChrome('panel.preflight.toReview', { count: report.warnings })}</span></>
              )}
              {report.failed > 0 && (
                <>, <span className="text-red-400">{tChrome('panel.preflight.failed', { count: report.failed })}</span></>
              )}
              {' '}{tChrome('panel.preflight.ofTotal', { count: report.total })}
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="preflight-list">
        {report?.checks.map((c) => (
          <div key={c.id} data-testid={`preflight-check-${c.id}`} className="flex items-start gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded">
            <span aria-hidden style={{ color: ICON[c.status].color }} className="font-bold w-4 text-center shrink-0">
              {ICON[c.status].glyph}
            </span>
            <div className="min-w-0">
              <div className="text-sm text-neutral-200">{c.label}</div>
              <div className="text-xs text-neutral-500">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>

      {report && (
        <div className="text-xs text-neutral-500">
          {tChromeCount('panel.preflight.images', report.images)}
          {report.color_families.length > 0 &&
            tChrome('panel.preflight.colour', { families: report.color_families.join(', ') })}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
