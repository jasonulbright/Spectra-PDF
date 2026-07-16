import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath } from './SettingsPanel';
import { getDocumentProxy } from '../lib/pdfDocCache';
import { renderPageToCanvas } from '../lib/pdfRenderer';
import {
  scaleRegionToDisplay,
  listableVisualPages,
  type VisualCompareResult,
  type VisualPagePair,
} from '../lib/visual-compare';
import type { OpenFile } from '../state/types';

interface CompareRow {
  type: 'context' | 'add' | 'remove' | 'gap';
  text?: string;
  page?: number;
  count?: number;
  /** Word-level intra-line segments: [text, changed] pairs (similar replaced
   * lines only — absent rows render whole-line). */
  segments?: [string, boolean][];
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

type CompareMode = 'text' | 'visual';

export function ComparePanel(): React.ReactElement {
  const { activeFile, allFiles, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const [mode, setMode] = useState<CompareMode>('text');
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [visualResult, setVisualResult] = useState<VisualCompareResult | null>(null);
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
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
    setVisualResult(null);
    setSelectedPage(null);
  }, [activeFile?.path, targetPath]);

  const targetFile = useMemo(
    () => allFiles.find((f) => f.path === targetPath) ?? null,
    [allFiles, targetPath],
  );

  const handleCompare = useCallback(async () => {
    if (!activeFile || !targetFile) return;
    setBusy(true);
    setStatus('Comparing…');
    try {
      // Read-only: the engine gate commits pending page edits on both files
      // first, so we compare committed content. No snapshot / UPDATE_FILE.
      if (mode === 'text') {
        setResult(null);
        const res = (await call('compare_text', {
          file_a: activeFile.workingPath,
          file_b: targetFile.workingPath,
        })) as unknown as CompareResult;
        setResult(res);
      } else {
        setVisualResult(null);
        setSelectedPage(null);
        const res = (await call('compare_visual', {
          file_a: activeFile.workingPath,
          file_b: targetFile.workingPath,
          gs_path: await ensureGsPath(),
        })) as unknown as VisualCompareResult;
        setVisualResult(res);
        const first = listableVisualPages(res.pages).find((p) => p.only_in == null);
        if (first) setSelectedPage(first.page);
      }
      setStatus('');
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, targetFile, call, mode]);

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
        <>
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
            <div className="flex rounded overflow-hidden border border-neutral-700" role="tablist">
              {(['text', 'visual'] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  data-testid={`compare-mode-${m}`}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 text-sm font-medium ${
                    mode === m
                      ? 'bg-neutral-600 text-neutral-100'
                      : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                  }`}
                >
                  {m === 'text' ? 'Text' : 'Visual'}
                </button>
              ))}
            </div>
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

          {mode === 'text' && result && <CompareSummaryBar summary={result.summary} />}
          {mode === 'text' && result && !result.summary.identical && (
            <div
              data-testid="compare-rows"
              className="flex-1 min-h-0 overflow-auto rounded border border-neutral-800 bg-neutral-900/50 font-mono text-xs"
            >
              {result.rows.map((row, i) => (
                <DiffRow key={i} row={row} />
              ))}
            </div>
          )}

          {mode === 'visual' && visualResult && (
            <VisualResultView
              result={visualResult}
              fileA={activeFile}
              fileB={targetFile}
              selectedPage={selectedPage}
              onSelectPage={setSelectedPage}
            />
          )}
        </>
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
  const segCls = row.type === 'add' ? 'bg-green-500/40' : 'bg-red-500/40';
  const sign = row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' ';
  return (
    <div className={`flex gap-2 px-3 py-0.5 ${cls}`}>
      <span className="w-8 shrink-0 text-right text-neutral-600 select-none">
        {row.page != null ? `p${row.page}` : ''}
      </span>
      <span className="w-3 shrink-0 select-none">{sign}</span>
      <span className="whitespace-pre-wrap break-words">
        {row.segments
          ? row.segments.map(([text, changed], i) =>
              changed ? (
                <span key={i} className={`${segCls} rounded-sm`}>
                  {text}
                </span>
              ) : (
                <React.Fragment key={i}>{text}</React.Fragment>
              ),
            )
          : row.text}
      </span>
    </div>
  );
}

// ── Visual mode ───────────────────────────────────────────────────────────

function VisualResultView({
  result,
  fileA,
  fileB,
  selectedPage,
  onSelectPage,
}: {
  result: VisualCompareResult;
  fileA: OpenFile;
  fileB: OpenFile | null;
  selectedPage: number | null;
  onSelectPage: (page: number) => void;
}): React.ReactElement {
  const { summary } = result;
  const listable = listableVisualPages(result.pages);
  const selected = result.pages.find((p) => p.page === selectedPage && p.only_in == null) ?? null;

  return (
    <>
      {summary.identical ? (
        <div
          data-testid="compare-visual-summary"
          className="shrink-0 px-3 py-2 bg-green-600/15 border border-green-600/40 rounded text-sm text-green-300"
        >
          These PDFs are visually identical ({summary.pairs_compared}{' '}
          {summary.pairs_compared === 1 ? 'page' : 'pages'} at {summary.dpi} dpi).
        </div>
      ) : (
        <div
          data-testid="compare-visual-summary"
          className="shrink-0 flex items-center gap-4 px-3 py-2 bg-neutral-800/60 border border-neutral-700 rounded text-sm"
        >
          <span className="text-neutral-300">
            {summary.pairs_differing} of {summary.pairs_compared} page{' '}
            {summary.pairs_compared === 1 ? 'pair' : 'pairs'} differ
          </span>
          {summary.pages_a !== summary.pages_b && (
            <span className="text-amber-300">
              pages: {summary.pages_a} → {summary.pages_b}
            </span>
          )}
        </div>
      )}

      {!summary.identical && (
        <div className="flex-1 min-h-0 flex gap-3">
          <div
            data-testid="compare-visual-pairs"
            className="w-44 shrink-0 overflow-auto rounded border border-neutral-800 bg-neutral-900/50 text-sm"
          >
            {listable.map((p) => (
              <VisualPairListItem
                key={`${p.only_in ?? 'pair'}-${p.page}`}
                pair={p}
                selected={p.page === selectedPage && p.only_in == null}
                onSelect={onSelectPage}
              />
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {selected && fileB ? (
              <div className="flex gap-3 items-start">
                <PageWithOverlay file={fileA} label="A" pair={selected} />
                <PageWithOverlay file={fileB} label="B" pair={selected} />
              </div>
            ) : (
              <div className="text-sm text-neutral-500 p-3">
                Select a differing page pair to inspect.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function VisualPairListItem({
  pair,
  selected,
  onSelect,
}: {
  pair: VisualPagePair;
  selected: boolean;
  onSelect: (page: number) => void;
}): React.ReactElement {
  if (pair.only_in != null) {
    return (
      <div className="px-3 py-1.5 text-neutral-500">
        p{pair.page} <span className="text-amber-400">only in {pair.only_in.toUpperCase()}</span>
      </div>
    );
  }
  const pct = ((pair.diff_ratio ?? 0) * 100).toFixed(pair.diff_ratio && pair.diff_ratio < 0.01 ? 2 : 1);
  return (
    <button
      data-testid={`compare-visual-pair-${pair.page}`}
      onClick={() => onSelect(pair.page)}
      className={`w-full text-left px-3 py-1.5 hover:bg-neutral-800 ${
        selected ? 'bg-neutral-700/70 text-neutral-100' : 'text-neutral-300'
      }`}
    >
      p{pair.page} <span className="text-red-400">{pct}% changed</span>
    </button>
  );
}

const PAIR_VIEW_WIDTH = 380;

function PageWithOverlay({
  file,
  label,
  pair,
}: {
  file: OpenFile;
  label: string;
  pair: VisualPagePair;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [display, setDisplay] = useState<{ width: number; widthPts: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setDisplay(null);
    setError('');
    if (!file.buffer) {
      setError('File buffer unavailable.');
      return;
    }
    void getDocumentProxy(file.path, file.buffer)
      .then(async (doc) => {
        const page = await doc.getPage(pair.page);
        const viewport = page.getViewport({ scale: 1 });
        const scale = PAIR_VIEW_WIDTH / viewport.width;
        const canvas = await renderPageToCanvas(doc, pair.page, scale);
        if (cancelled || !hostRef.current) return;
        canvas.style.width = `${canvas.width}px`;
        canvas.style.height = `${canvas.height}px`;
        hostRef.current.innerHTML = '';
        hostRef.current.appendChild(canvas);
        // The canvas represents this page's own width in points; the engine's
        // regions share the same origin/axes, so overlay scaling is pure.
        setDisplay({ width: canvas.width, widthPts: viewport.width });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, file.buffer, pair.page]);

  return (
    <div className="shrink-0">
      <div className="text-xs text-neutral-500 mb-1">
        {label}: {file.name} — p{pair.page}
      </div>
      {error ? (
        <div className="text-xs text-red-400 max-w-[380px]">{error}</div>
      ) : (
        // overflow-hidden clips regions that lie in the compare space's padded
        // band beyond THIS page's extent (pair page sizes can differ) — they
        // must not bleed onto the neighboring canvas.
        <div className="relative inline-block overflow-hidden" data-testid={`compare-visual-page-${label}`}>
          <div ref={hostRef} />
          {display &&
            (pair.regions ?? []).map((region, i) => {
              const r = scaleRegionToDisplay(region, display.widthPts, display.width);
              return (
                <div
                  key={i}
                  className="absolute border-2 border-red-500 bg-red-500/20 pointer-events-none"
                  style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
                />
              );
            })}
        </div>
      )}
    </div>
  );
}
