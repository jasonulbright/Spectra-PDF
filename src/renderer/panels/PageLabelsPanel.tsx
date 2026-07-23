import React, { useState, useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

interface Range {
  start: number; // 1-based first page of the range
  style: string; // D | r | R | a | A | none
  prefix: string;
  startAt: number;
}

const STYLES: { value: string; label: string }[] = [
  { value: 'D', label: '1, 2, 3' },
  { value: 'r', label: 'i, ii, iii' },
  { value: 'R', label: 'I, II, III' },
  { value: 'a', label: 'a, b, c' },
  { value: 'A', label: 'A, B, C' },
  { value: 'none', label: 'None (prefix only)' },
];

const toRoman = (n: number): string => {
  if (n <= 0) return '';
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
};
const toAlpha = (n: number): string => {
  if (n <= 0) return '';
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
};
const fmt = (style: string, n: number): string =>
  style === 'D' ? String(n)
  : style === 'r' ? toRoman(n)
  : style === 'R' ? toRoman(n).toUpperCase()
  : style === 'a' ? toAlpha(n)
  : style === 'A' ? toAlpha(n).toUpperCase()
  : '';

// The visible label for a 1-based page given the ranges (mirrors the engine's
// label_for) — a live preview so the user sees the numbering before applying.
function labelFor(ranges: Range[], page1: number): string {
  const idx = page1 - 1;
  let covering: Range | null = null;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.start - 1 <= idx) covering = r;
    else break;
  }
  if (!covering) return String(page1);
  const number = covering.startAt + (idx - (covering.start - 1));
  return (covering.prefix || '') + fmt(covering.style, number);
}

export function PageLabelsPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [ranges, setRanges] = useState<Range[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!buffer || !workingPath) return;
    call('get_page_labels', { file: workingPath })
      .then((res) => {
        if (cancelled) return;
        const raw = (res as unknown as { ranges: { start: number; style: string; prefix: string; start_at: number }[] }).ranges ?? [];
        setRanges(raw.map((r) => ({ start: r.start + 1, style: r.style, prefix: r.prefix, startAt: r.start_at })));
      })
      .catch(() => {
        if (!cancelled) setRanges([]);
      });
    return () => { cancelled = true; };
  }, [buffer, workingPath, call]);

  const addRange = useCallback(() => {
    setRanges((prev) => {
      const nextStart = prev.length === 0 ? 1 : Math.min((activeFile?.pageCount ?? 1), Math.max(...prev.map((r) => r.start)) + 1);
      return [...prev, { start: nextStart, style: 'D', prefix: '', startAt: 1 }];
    });
  }, [activeFile]);

  const updateRange = useCallback((i: number, patch: Partial<Range>) => {
    setRanges((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }, []);
  const removeRange = useCallback((i: number) => {
    setRanges((prev) => prev.filter((_, j) => j !== i));
  }, []);

  const handleApply = useCallback(async () => {
    if (!activeFile) return;
    // Distinct 1-based starts within range.
    const starts = new Set(ranges.map((r) => r.start));
    if (starts.size !== ranges.length) {
      setStatus('Two ranges start on the same page — each start must be unique');
      return;
    }
    setBusy(true);
    setStatus('Applying…');
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('set_page_labels', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        ranges: ranges.map((r) => ({ start: r.start - 1, style: r.style, prefix: r.prefix, start_at: r.startAt })),
      });
      const buf = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer: buf, snapshotPath });
      setStatus(ranges.length === 0 ? 'Page labels removed' : `Applied ${ranges.length} label range${ranges.length === 1 ? '' : 's'}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, ranges, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to set page number labels" />;

  const total = activeFile.pageCount;
  const previewPages = Array.from({ length: Math.min(total, 8) }, (_, i) => i + 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span> ({total} pages)
      </div>
      <p className="text-xs text-neutral-500">
        Number pages independently of their order — front matter as “i, ii, iii”, the body as “1, 2, 3”. Each range
        starts on a page and runs until the next range. No ranges = plain physical numbers.
      </p>

      <div className="flex flex-col gap-2">
        {ranges.map((r, i) => (
          <div key={i} className="flex items-end gap-2 flex-wrap" data-testid="pagelabel-range">
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">From page</label>
              <input
                data-testid={`pagelabel-start-${i}`}
                type="number"
                min={1}
                max={total}
                value={r.start}
                onChange={(e) => updateRange(i, { start: Number(e.target.value) })}
                className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">Style</label>
              <select
                data-testid={`pagelabel-style-${i}`}
                value={r.style}
                onChange={(e) => updateRange(i, { style: e.target.value })}
                className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              >
                {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">Prefix</label>
              <input
                type="text"
                value={r.prefix}
                onChange={(e) => updateRange(i, { prefix: e.target.value })}
                className="w-24 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] text-neutral-500 mb-0.5">Start at</label>
              <input
                type="number"
                min={1}
                value={r.startAt}
                onChange={(e) => updateRange(i, { startAt: Number(e.target.value) })}
                className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
              />
            </div>
            <button
              data-testid={`pagelabel-remove-${i}`}
              onClick={() => removeRange(i)}
              className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          data-testid="pagelabel-add"
          onClick={addRange}
          className="self-start px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700"
        >
          + Add range
        </button>
      </div>

      <div className="text-xs text-neutral-500">
        Preview:{' '}
        <span className="text-neutral-300" data-testid="pagelabel-preview">
          {previewPages.map((p) => labelFor(ranges, p)).join(', ')}
          {total > previewPages.length ? ', …' : ''}
        </span>
      </div>

      <button
        data-testid="pagelabel-apply"
        onClick={handleApply}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? 'Applying…' : 'Apply'}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
