import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import { TEST_HARNESS_ENABLED, registerSplit } from '../testHarness';

type SplitMode = 'ranges' | 'every_n' | 'size' | 'bookmarks';

const MODES: readonly SplitMode[] = ['ranges', 'every_n', 'size', 'bookmarks'];

interface OutlineNode {
  title: string;
  page: number | null;
  children?: OutlineNode[];
}

export function SplitPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [mode, setMode] = useState<SplitMode>('ranges');
  const [ranges, setRanges] = useState('');
  const [everyN, setEveryN] = useState(10);
  const [maxMb, setMaxMb] = useState(5);
  const [topLevel, setTopLevel] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const path = activeFile?.workingPath;
  // Bookmark mode's refusal is knowable before the run, so it is reported
  // before the run: the count of top-level entries the split would use.
  useEffect(() => {
    let live = true;
    if (mode !== 'bookmarks' || !path) {
      setTopLevel(null);
      return;
    }
    void call('get_outline', { file: path })
      .then((r) => {
        if (!live) return;
        const items = (r as unknown as { outline?: OutlineNode[] }).outline ?? [];
        setTopLevel(items.filter((i) => typeof i.page === 'number').length);
      })
      .catch(() => {
        if (live) setTopLevel(0);
      });
    return () => {
      live = false;
    };
  }, [mode, path, call]);

  const performSplit = useCallback(async (outputDir: string) => {
    if (!activeFile) return;
    setBusy(true);
    setStatus(tChrome('panel.split.splitting'));
    try {
      const r = await call('split', {
        file: activeFile.workingPath,
        output_dir: outputDir,
        mode,
        ...(mode === 'ranges' ? { ranges } : {}),
        ...(mode === 'every_n' ? { every_n: everyN } : {}),
        ...(mode === 'size' ? { max_mb: maxMb } : {}),
      });
      const parts = (r as unknown as { parts: number }).parts;
      const over = (r as unknown as { oversize: unknown[] }).oversize ?? [];
      setStatus(
        mode === 'ranges'
          ? tChrome('panel.split.done', { count: r.pages_extracted })
          : tChromeCount('panel.split.doneParts', parts, { pages: r.pages_extracted }) +
            (over.length > 0 ? ' ' + tChromeCount('panel.split.oversize', over.length) : ''),
      );
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, mode, ranges, everyN, maxMb, call]);

  const handleSplit = useCallback(async () => {
    if (!activeFile) return;
    if (mode === 'ranges' && !ranges.trim()) {
      setStatus(tChrome('panel.split.enterRanges'));
      return;
    }
    if (mode === 'every_n' && !(everyN >= 1)) {
      setStatus(tChrome('panel.split.badEveryN'));
      return;
    }
    if (mode === 'size' && !(maxMb > 0)) {
      setStatus(tChrome('panel.split.badSize'));
      return;
    }
    // Range mode keeps its save-file flow (one output, named by the caller);
    // every other mode writes N files, so it picks a FOLDER.
    let outputDir: string;
    if (mode === 'ranges') {
      const output = await saveFile(`split_${ranges.replace(/,/g, '_')}.pdf`);
      if (!output) return;
      outputDir = output.replace(/[^\\/]+$/, '');
    } else {
      const picked = await dialog.pickFolder(tChrome('panel.split.pickFolder'));
      if (!picked) return;
      outputDir = picked;
    }
    await performSplit(outputDir);
  }, [activeFile, mode, ranges, everyN, maxMb, saveFile, performSplit]);

  // Both destination pickers are native and undrivable, so e2e injects the
  // folder and the panel's OWN state drives everything else — the same shape
  // the compress bridge uses, and for the same reason.
  const harnessRef = useRef({ performSplit, setMode });
  harnessRef.current = { performSplit, setMode };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerSplit({
      run: (output) => harnessRef.current.performSplit(output),
      setMode: (value) => harnessRef.current.setMode(value as SplitMode),
    });
    return () => registerSplit(null);
  }, []);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.split.open')} />;

  const disabled =
    busy ||
    (mode === 'ranges' && !ranges.trim()) ||
    (mode === 'bookmarks' && topLevel === 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="split-mode">{tChrome('panel.split.modeLabel')}</label>
        <select
          id="split-mode"
          data-testid="split-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as SplitMode)}
          className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          {MODES.map((m) => (
            <option key={m} value={m}>{tChrome(`panel.split.mode.${m}` as 'panel.split.mode.ranges')}</option>
          ))}
        </select>
      </div>
      {mode === 'ranges' && (
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="split-ranges">{tChrome('panel.split.rangesLabel')}</label>
          <input id="split-ranges" data-testid="split-ranges" type="text" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-5,10-15"
            className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
      )}
      {mode === 'every_n' && (
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="split-every-n">{tChrome('panel.split.everyNLabel')}</label>
          <input id="split-every-n" data-testid="split-every-n" type="number" min={1} value={everyN} onChange={(e) => setEveryN(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
      )}
      {mode === 'size' && (
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="split-max-mb">{tChrome('panel.split.maxMbLabel')}</label>
          <input id="split-max-mb" data-testid="split-max-mb" type="number" min={0.1} step={0.1} value={maxMb} onChange={(e) => setMaxMb(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500" />
          <p className="text-xs text-neutral-500 mt-1">{tChrome('panel.split.maxMbHint')}</p>
        </div>
      )}
      {mode === 'bookmarks' && (
        <p className="text-xs text-neutral-500" data-testid="split-bookmark-note">
          {topLevel === null
            ? tChrome('panel.split.bookmarkCounting')
            : topLevel === 0
              ? tChrome('panel.split.bookmarkNone')
              : tChromeCount('panel.split.bookmarkCount', topLevel)}
        </p>
      )}
      <button data-testid="split-run" onClick={handleSplit} disabled={disabled} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.split.splitting') : tChrome('panel.split.split')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
