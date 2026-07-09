import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

interface CompareRow {
  type: 'context' | 'add' | 'remove' | 'gap';
  text?: string;
  page?: number;
  count?: number;
}

interface CompareSummary {
  identical: boolean;
  similarity: number;
  lines_added: number;
  lines_removed: number;
  pages_a: number;
  pages_b: number;
  truncated: boolean;
}

interface CompareResult {
  summary: CompareSummary;
  rows: CompareRow[];
}

export function ComparePanel(): React.ReactElement {
  const { activeFile, allFiles, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Candidate B files: every open file except the active one (A).
  const others = useMemo(
    () => allFiles.filter((f) => f.path !== activeFile?.path),
    [allFiles, activeFile?.path],
  );

  // Default / repair the selection as the open set changes.
  useEffect(() => {
    if (others.length === 0) {
      if (targetPath !== null) setTargetPath(null);
    } else if (!targetPath || !others.some((f) => f.path === targetPath)) {
      setTargetPath(others[0].path);
    }
  }, [others, targetPath]);

  // A fresh comparison is stale the moment either side changes.
  useEffect(() => {
    setResult(null);
  }, [activeFile?.path, targetPath]);

  const handleCompare = useCallback(async () => {
    if (!activeFile || !targetPath) return;
    const target = allFiles.find((f) => f.path === targetPath);
    if (!target) return;
    setBusy(true);
    setStatus('Comparing…');
    setResult(null);
    try {
      // Read-only: the engine gate commits pending page edits on both files
      // first, so we compare committed content. No snapshot / UPDATE_FILE.
      const res = (await call('compare_text', {
        file_a: activeFile.workingPath,
        file_b: target.workingPath,
      })) as unknown as CompareResult;
      setResult(res);
      setStatus('');
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, targetPath, allFiles, call]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to compare" />;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="text-sm text-neutral-400 shrink-0">
        Comparing: <span className="text-neutral-200">{activeFile.name}</span> against
      </div>

      {others.length === 0 ? (
        <div className="shrink-0 flex items-center gap-3">
          <span className="text-sm text-neutral-500">Open a second PDF to compare against.</span>
          <button
            data-testid="compare-open-another"
            onClick={openNewFiles}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm font-medium"
          >
            Open another PDF…
          </button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-3 flex-wrap">
          <select
            data-testid="compare-target"
            value={targetPath ?? ''}
            onChange={(e) => setTargetPath(e.target.value)}
            className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm max-w-xs"
          >
            {others.map((f) => (
              <option key={f.path} value={f.path}>
                {f.name}
              </option>
            ))}
          </select>
          <button
            data-testid="compare-run"
            onClick={handleCompare}
            disabled={busy || !targetPath}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
          >
            {busy ? 'Comparing…' : 'Compare'}
          </button>
          <button
            data-testid="compare-open-another"
            onClick={openNewFiles}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm font-medium"
            title="Open another PDF into the workspace"
          >
            Open another…
          </button>
        </div>
      )}

      {result && <CompareSummaryBar summary={result.summary} />}

      {result && !result.summary.identical && (
        <div
          data-testid="compare-rows"
          className="flex-1 min-h-0 overflow-auto rounded border border-neutral-800 bg-neutral-900/50 font-mono text-xs"
        >
          {result.rows.map((row, i) => (
            <DiffRow key={i} row={row} />
          ))}
        </div>
      )}

      <StatusBar message={status} busy={busy} />
    </div>
  );
}

function CompareSummaryBar({ summary }: { summary: CompareSummary }): React.ReactElement {
  if (summary.identical) {
    return (
      <div
        data-testid="compare-summary"
        className="shrink-0 px-3 py-2 bg-green-600/15 border border-green-600/40 rounded text-sm text-green-300"
      >
        The text of these PDFs is identical.
      </div>
    );
  }
  return (
    <div
      data-testid="compare-summary"
      className="shrink-0 flex items-center gap-4 px-3 py-2 bg-neutral-800/60 border border-neutral-700 rounded text-sm"
    >
      <span className="text-neutral-300">{Math.round(summary.similarity * 100)}% similar</span>
      <span className="text-green-400">+{summary.lines_added} added</span>
      <span className="text-red-400">−{summary.lines_removed} removed</span>
      {summary.pages_a !== summary.pages_b && (
        <span className="text-amber-300">
          pages: {summary.pages_a} → {summary.pages_b}
        </span>
      )}
      {summary.truncated && <span className="text-neutral-500">(diff truncated)</span>}
    </div>
  );
}

function DiffRow({ row }: { row: CompareRow }): React.ReactElement {
  if (row.type === 'gap') {
    return (
      <div className="px-3 py-1 text-neutral-600 bg-neutral-800/40 text-center select-none">
        ⋯ {row.count} unchanged {row.count === 1 ? 'line' : 'lines'} ⋯
      </div>
    );
  }
  const cls =
    row.type === 'add'
      ? 'bg-green-600/15 text-green-200'
      : row.type === 'remove'
        ? 'bg-red-600/15 text-red-200'
        : 'text-neutral-400';
  const sign = row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' ';
  return (
    <div className={`flex gap-2 px-3 py-0.5 ${cls}`}>
      <span className="w-8 shrink-0 text-right text-neutral-600 select-none">
        {row.page != null ? `p${row.page}` : ''}
      </span>
      <span className="w-3 shrink-0 select-none">{sign}</span>
      <span className="whitespace-pre-wrap break-words">{row.text}</span>
    </div>
  );
}
