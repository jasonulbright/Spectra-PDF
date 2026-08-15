import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

type Verdict = 'pass' | 'fail' | 'warn' | 'needs_review' | 'not_applicable';

interface Check {
  id: string;
  label: string;
  status: Verdict;
  detail: string;
}
interface Summary {
  passed: number;
  failed: number;
  warnings: number;
  needs_review: number;
  not_applicable: number;
  applicable: number;
  total: number;
}
interface Report {
  checks: Check[];
  summary: Summary;
}

// A needs-review row shows neither a tick nor a cross: it has not been
// decided, and borrowing either glyph is the claim the checker refuses to
// make. A not-applicable row is muted — it is excluded from the pass tally,
// so showing it as a pass would earn a score the document did not.
const ICON: Record<Verdict, { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: '#2fbf71' },
  warn: { glyph: '!', color: '#fbbf24' },
  fail: { glyph: '✕', color: '#f87171' },
  needs_review: { glyph: '?', color: '#a78bfa' },
  not_applicable: { glyph: '–', color: '#6b7280' },
};

export function AccessibilityPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
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
    setStatus(tChrome('panel.a11y.checking'));
    try {
      const res = await call('check_accessibility', { file: workingPath });
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

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.a11y.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-400">
          {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <button
          data-testid="a11y-recheck"
          onClick={() => void run()}
          disabled={busy}
          className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.a11y.recheck')}
        </button>
      </div>

      {report && (
        <div className="text-sm text-neutral-300" data-testid="a11y-summary">
          {/* "All passed" is claimed only when nothing is outstanding AND
              nothing was skipped: a document whose table checks did not apply
              has not passed 32 of 32, and saying so is the exact wrongness
              this checker exists to end. */}
          {report.summary.failed === 0 &&
          report.summary.warnings === 0 &&
          report.summary.needs_review === 0 &&
          report.summary.not_applicable === 0 ? (
            <span className="text-green-400">{tChrome('panel.a11y.allPassed', { count: report.summary.total })}</span>
          ) : (
            <>
              <span className="text-green-400">{tChrome('panel.a11y.passed', { count: report.summary.passed })}</span>
              {report.summary.warnings + report.summary.needs_review > 0 && (
                <>, <span className="text-amber-400">{tChrome('panel.a11y.toReview', { count: report.summary.warnings + report.summary.needs_review })}</span></>
              )}
              {report.summary.failed > 0 && (
                <>, <span className="text-red-400">{tChrome('panel.a11y.failed', { count: report.summary.failed })}</span></>
              )}
              {' '}{tChrome('panel.a11y.ofTotal', { count: report.summary.applicable })}
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="a11y-list">
        {report?.checks.map((c) => (
          <div key={c.id} data-testid={`a11y-check-${c.id}`} className="flex items-start gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded">
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
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
