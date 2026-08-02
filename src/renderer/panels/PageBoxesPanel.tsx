import React, { useState, useCallback, useEffect } from 'react';
import { consumeDrawnCrop, subscribeDrawnCrop, type DrawnCrop } from '../lib/crop-draw';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';

const BOXES: { value: string; label: string }[] = [
  { value: 'crop', label: 'Crop box (visible page)' },
  { value: 'bleed', label: 'Bleed box' },
  { value: 'trim', label: 'Trim box' },
  { value: 'art', label: 'Art box' },
];

export function PageBoxesPanel(): React.ReactElement {
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [box, setBox] = useState('crop');
  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(0);
  const [left, setLeft] = useState(0);
  const [right, setRight] = useState(0);
  const [pageInput, setPageInput] = useState('all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // P5b: a crop dragged on the page lands in these fields. The panel still
  // owns the commit — drawing fills the form, Apply is what changes the file,
  // so a drawn crop and a typed one go through the identical call and a
  // mis-drag costs a redraw rather than an undo.
  const activePath = activeFile?.path;
  useEffect(() => {
    if (!activePath) return;
    const apply = (c: DrawnCrop): void => {
      // A publish from a document the user has since switched away from must
      // not fill the fields of the one they are looking at now.
      if (c.path !== activePath) return;
      setTop(c.top);
      setBottom(c.bottom);
      setLeft(c.left);
      setRight(c.right);
      // The band was drawn on ONE page — scope to it rather than silently
      // widening the crop to every page in the file.
      setPageInput(String(c.page));
      setStatus(`Crop drawn on page ${c.page} — review the margins, then Apply`);
    };
    const pending = consumeDrawnCrop();
    if (pending) apply(pending);
    return subscribeDrawnCrop((c) => {
      consumeDrawnCrop();
      apply(c);
    });
  }, [activePath]);

  const handleApply = useCallback(async () => {
    if (!activeFile) return;
    if (!top && !bottom && !left && !right) {
      setStatus('Enter a margin to trim on at least one edge');
      return;
    }
    const trimmed = pageInput.trim().toLowerCase();
    let pages: number[] | undefined;
    if (trimmed !== 'all') {
      pages = trimmed.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (pages.length === 0) {
        setStatus('Error: pages must be e.g. 1,3,5 or all');
        return;
      }
    }
    setBusy(true);
    setStatus('Applying…');
    try {
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const result = await call('set_page_boxes', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        box,
        top,
        bottom,
        left,
        right,
        ...(pages ? { pages } : {}),
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      const res = result as unknown as { changed: number; skipped: { page: number; reason: string }[] };
      const skipped = res.skipped?.length ?? 0;
      setStatus(
        `Updated ${res.changed} page${res.changed === 1 ? '' : 's'}` +
          (skipped > 0 ? ` — ${skipped} skipped (box would be degenerate)` : ''),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [activeFile, box, top, bottom, left, right, pageInput, call, dispatch]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message="Open a PDF to crop pages or edit page boxes" />;

  const edge = (label: string, value: number, set: (n: number) => void, testId: string) => (
    <div>
      <label className="block text-sm text-neutral-400 mb-1">{label}</label>
      <input
        data-testid={testId}
        type="number"
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        Working on: <span className="text-neutral-200">{activeFile.name}</span> ({activeFile.pageCount} pages)
      </div>
      <p className="text-xs text-neutral-500">
        Drag a rectangle on the page to set the area to keep, or trim points from each edge of the chosen box
        below. Cropping only hides content — nothing is deleted, and the crop can never fall outside the media
        box.
      </p>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">Box</label>
        <select
          data-testid="pagebox-box"
          value={box}
          onChange={(e) => setBox(e.target.value)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          {BOXES.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-4 flex-wrap">
        {edge('Top', top, setTop, 'pagebox-top')}
        {edge('Bottom', bottom, setBottom, 'pagebox-bottom')}
        {edge('Left', left, setLeft, 'pagebox-left')}
        {edge('Right', right, setRight, 'pagebox-right')}
        <div>
          <label className="block text-sm text-neutral-400 mb-1">Pages (e.g. 1,3,5 or all)</label>
          <input
            data-testid="pagebox-pages"
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            className="w-32 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <button
        data-testid="pagebox-apply"
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
