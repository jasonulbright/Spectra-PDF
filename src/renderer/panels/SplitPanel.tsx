import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import { TEST_HARNESS_ENABLED, registerSplit } from '../testHarness';
import { useOwnedDocumentRun } from '../hooks/useOwnedDocumentRun';
import { runCommitGate } from '../lib/commit-gate';
import { useReadAppState } from '../state/AppStateProvider';
import type { OpenFile } from '../state/types';
import { splitBookmarkCount } from '../lib/split-bookmarks';

type SplitMode = 'ranges' | 'every_n' | 'size' | 'bookmarks';
type SplitDestination = { output: string } | { output_dir: string };

const MODES: readonly SplitMode[] = ['ranges', 'every_n', 'size', 'bookmarks'];

export function SplitPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, state } = useActiveFile();
  const readState = useReadAppState();
  const { call, saveFile } = useEngine();
  const [mode, setMode] = useState<SplitMode>('ranges');
  const [ranges, setRanges] = useState('');
  const [everyN, setEveryN] = useState(10);
  const [maxMb, setMaxMb] = useState(5);
  const [outline, setOutline] = useState<{ file: OpenFile; count: number | null; error: string } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const beginRun = useOwnedDocumentRun(activeFile);
  useEffect(() => { setStatus(''); }, [activeFile?.workingPath, activeFile?.buffer]);

  const dirty = !!activeFile && state.pageDirtyPaths.includes(activeFile.path);
  const outlineCurrent = !dirty && outline?.file.path === activeFile?.path
    && outline?.file.workingPath === activeFile?.workingPath && outline?.file.buffer === activeFile?.buffer;
  const topLevel = outlineCurrent ? outline?.count ?? null : null;
  const outlineError = outlineCurrent ? outline?.error ?? '' : '';
  // Bookmark mode's refusal is knowable before the run, so it is reported
  // before the run: the count of top-level entries the split would use.
  useEffect(() => {
    let live = true;
    if (mode !== 'bookmarks' || !activeFile) return;
    const file = activeFile;
    setOutline(null);
    const current = () => {
      const now = readState(), next = now.files.get(file.path);
      return live && now.activeFileId === file.path && next?.workingPath === file.workingPath
        && next?.buffer === file.buffer && !now.pageDirtyPaths.includes(file.path);
    };
    const assertCurrent = () => { if (!current()) throw new Error(tChrome('app.history.changed')); };
    void call('get_outline', { file: file.workingPath }, { assertCurrent })
      .then((r) => {
        if (!current()) return;
        const count = splitBookmarkCount(r, file.pageCount);
        setOutline({ file, count, error: count === null ? tChrome('panel.split.bookmarkUnavailable') : '' });
      })
      .catch((error: unknown) => {
        if (current()) setOutline({ file, count: null, error: tChrome('panel.common.error', {
          message: error instanceof Error ? error.message : String(error),
        }) });
      });
    return () => {
      live = false;
    };
  }, [mode, activeFile, dirty, call, readState]);

  const performSplit = useCallback(async (choose: () => Promise<SplitDestination | null>) => {
    const run = beginRun();
    if (!run) return;
    setBusy(true);
    setStatus(tChrome('panel.split.splitting'));
    try {
      await run.prepare(runCommitGate);
      const destination = await choose();
      if (!destination) { if (run.visible()) setStatus(''); return; }
      run.assertCurrent();
      const r = await call('split', {
        file: run.source.workingPath,
        ...destination,
        mode,
        ...(mode === 'ranges' ? { ranges } : {}),
        ...(mode === 'every_n' ? { every_n: everyN } : {}),
        ...(mode === 'size' ? { max_mb: maxMb } : {}),
      }, { assertCurrent: run.assertCurrent });
      if (!run.visible()) return;
      const parts = (r as unknown as { parts: number }).parts;
      const over = (r as unknown as { oversize: unknown[] }).oversize ?? [];
      const retained = (r as unknown as { retained_files?: string[] }).retained_files ?? [];
      setStatus(
        (mode === 'ranges'
          ? tChrome('panel.split.done', { count: r.pages_extracted })
          : tChromeCount('panel.split.doneParts', parts, { pages: r.pages_extracted }) +
            (over.length > 0 ? ' ' + tChromeCount('panel.split.oversize', over.length) : '')) +
          (retained.length ? ' ' + tChrome('panel.split.retainedFiles', { paths: retained.join('; ') }) : ''),
      );
    } catch (e: unknown) {
      if (run.visible()) setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      run.finish();
      setBusy(false);
    }
  }, [beginRun, mode, ranges, everyN, maxMb, call]);

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
    await performSplit(async () => {
      if (mode === 'ranges') {
        const output = await saveFile(`split_${ranges.replace(/,/g, '_')}.pdf`);
        return output ? { output } : null;
      }
      const output_dir = await dialog.pickFolder(tChrome('panel.split.pickFolder'));
      return output_dir ? { output_dir } : null;
    });
  }, [activeFile, mode, ranges, everyN, maxMb, saveFile, performSplit]);

  // Directory-oriented harness callers retain their contract, through the
  // same source ownership and dispatch path as the picker-facing handler.
  const harnessRef = useRef({ performSplit, setMode });
  harnessRef.current = { performSplit, setMode };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerSplit({
      run: (output) => harnessRef.current.performSplit(async () => ({ output_dir: output })),
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
          {outlineError || (topLevel === null
            ? tChrome('panel.split.bookmarkCounting')
            : topLevel === 0
              ? tChrome('panel.split.bookmarkNone')
              : tChromeCount('panel.split.bookmarkCount', topLevel))}
        </p>
      )}
      <button data-testid="split-run" onClick={handleSplit} disabled={disabled} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium">
        {busy ? tChrome('panel.split.splitting') : tChrome('panel.split.split')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
