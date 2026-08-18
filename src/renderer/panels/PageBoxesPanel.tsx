import React, { useState, useCallback, useEffect } from 'react';
import { consumeDrawnCrop, subscribeDrawnCrop, type DrawnCrop } from '../lib/crop-draw';
import {
  parsePageScope,
  summarizeContentCrop,
  type ContentCropResult,
  type ContentCropSummary,
} from '../lib/content-crop';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { ensureGsPath } from './SettingsPanel';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { PageRangeField } from '../components/PageRangeField';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import type { PanelKey } from '../i18n-panels';

const BOXES: { value: string; label: PanelKey }[] = [
  { value: 'crop', label: 'panel.pageBoxes.crop' },
  { value: 'bleed', label: 'panel.pageBoxes.bleed' },
  { value: 'trim', label: 'panel.pageBoxes.trim' },
  { value: 'art', label: 'panel.pageBoxes.art' },
];

export function PageBoxesPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const [box, setBox] = useState('crop');
  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(0);
  const [left, setLeft] = useState(0);
  const [right, setRight] = useState(0);
  const [pageInput, setPageInput] = useState('all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [margin, setMargin] = useState(0);
  const [autoPreview, setAutoPreview] = useState<ContentCropSummary | null>(null);

  // A crop dragged on the page lands in these fields. The panel still
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
      setStatus(tChrome('panel.pageBoxes.cropDrawn', { page: c.page }));
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
      setStatus(tChrome('panel.pageBoxes.enterMargin'));
      return;
    }
    const scope = parsePageScope(pageInput);
    if ('error' in scope) {
      setStatus(tChrome('panel.pageBoxes.badPages'));
      return;
    }
    const pages = scope.pages;
    setBusy(true);
    setStatus(tChrome('panel.pageBoxes.applying'));
    try {
      const result = await performOperation(activeFile.path, 'set_page_boxes', {
        box,
        top,
        bottom,
        left,
        right,
        ...(pages ? { pages } : {}),
      });
      if (result === EDIT_DECLINED) {
        setStatus('');
        return;
      }
      const res = result as unknown as { changed: number; skipped: { page: number; reason: string }[] };
      const skipped = res.skipped?.length ?? 0;
      setStatus(
        tChrome(res.changed === 1 ? 'panel.pageBoxes.updated_one' : 'panel.pageBoxes.updated_other', {
          count: res.changed,
          skipped: skipped > 0 ? tChrome('panel.pageBoxes.skippedSuffix', { count: skipped }) : '',
        }),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(tChrome('panel.common.error', { message: msg }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, box, top, bottom, left, right, pageInput, performOperation]);

  // Auto crop: measure first, commit second — the same call with `preview`
  // flipped, so the number the reader is shown is the number that lands.
  const runAuto = useCallback(
    async (preview: boolean) => {
      if (!activeFile) return;
      const scope = parsePageScope(pageInput);
      if ('error' in scope) {
        setStatus(tChrome('panel.pageBoxes.badPages'));
        return;
      }
      setBusy(true);
      setStatus(tChrome(preview ? 'panel.pageBoxes.autoScanning' : 'panel.pageBoxes.applying'));
      try {
        const params = {
          box,
          margin,
          preview,
          // Only reached for a scan whose codestream this runtime cannot
          // decode, but the crop must not silently measure that page as blank
          // for want of a renderer.
          gs_path: await ensureGsPath(),
          ...(scope.pages ? { pages: scope.pages } : {}),
        };
        // Preview MEASURES and writes nothing (`preview` suppresses the save
        // engine-side), so it stays a plain read; the commit arm is an
        // in-place rewrite and takes the funnel's signed-document decision.
        let result: ContentCropResult;
        if (preview) {
          result = (await call('content_crop', {
            file: activeFile.workingPath,
            output: activeFile.workingPath,
            ...params,
          })) as unknown as ContentCropResult;
        } else {
          const answer = await performOperation(activeFile.path, 'content_crop', params);
          if (answer === EDIT_DECLINED) {
            setStatus('');
            return;
          }
          result = answer as unknown as ContentCropResult;
        }
        const summary = summarizeContentCrop(result);
        if (preview) setAutoPreview(summary);
        else setAutoPreview(null);
        setStatus(
          tChrome(preview ? 'panel.pageBoxes.autoFound' : 'panel.pageBoxes.autoApplied', {
            count: summary.cropped,
            unchanged: summary.unchanged,
            skipped: summary.skipped,
            points: summary.largestTrim,
          }),
        );
      } catch (e: unknown) {
        setAutoPreview(null);
        const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
        setStatus(tChrome('panel.common.error', { message: msg }));
      } finally {
        setBusy(false);
      }
    },
    [activeFile, box, margin, pageInput, call, performOperation],
  );

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.pageBoxes.open')} />;

  const edge = (label: string, value: number, set: (n: number) => void, testId: string) => (
    <div>
      <label className="block text-sm text-neutral-400 mb-1">{label}</label>
      {/* aria-label carries the same text: the visual label above is not
          programmatically associated (no id/htmlFor in this factory). */}
      <input
        data-testid={testId}
        aria-label={tChrome('panel.pageBoxes.edgeInset', { edge: label })}
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
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})
      </div>
      <p className="text-xs text-neutral-500">
        {tChrome('panel.pageBoxes.blurb')}
      </p>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.pageBoxes.box')}</label>
        <select
          data-testid="pagebox-box"
          aria-label={tChrome('panel.pageBoxes.boxAria')}
          value={box}
          onChange={(e) => setBox(e.target.value)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          {BOXES.map((b) => (
            <option key={b.value} value={b.value}>
              {tChrome(b.label)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-4 flex-wrap">
        {edge(tChrome('panel.pageBoxes.top'), top, setTop, 'pagebox-top')}
        {edge(tChrome('panel.pageBoxes.bottom'), bottom, setBottom, 'pagebox-bottom')}
        {edge(tChrome('panel.pageBoxes.left'), left, setLeft, 'pagebox-left')}
        {edge(tChrome('panel.pageBoxes.right'), right, setRight, 'pagebox-right')}
        <PageRangeField
          value={pageInput}
          onChange={setPageInput}
          label="panel.pageBoxes.pagesLabel"
          ariaLabel="panel.pageBoxes.pagesAria"
          testIdPrefix="pagebox"
          className="w-32 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
      <button
        data-testid="pagebox-apply"
        onClick={handleApply}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? tChrome('panel.pageBoxes.applying') : tChrome('panel.pageBoxes.apply')}
      </button>

      <div className="flex flex-col gap-2 pt-3 border-t border-neutral-800">
        <div className="text-sm text-neutral-200">{tChrome('panel.pageBoxes.autoTitle')}</div>
        <p className="text-xs text-neutral-500">{tChrome('panel.pageBoxes.autoBlurb')}</p>
        <div className="flex gap-4 flex-wrap items-end">
          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="pagebox-margin">
              {tChrome('panel.pageBoxes.autoMargin')}
            </label>
            <input
              id="pagebox-margin"
              data-testid="pagebox-margin"
              type="number"
              min={0}
              value={margin}
              onChange={(e) => setMargin(Math.max(0, Number(e.target.value)))}
              className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            data-testid="pagebox-auto-preview"
            onClick={() => void runAuto(true)}
            disabled={busy}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded text-sm font-medium"
          >
            {tChrome('panel.pageBoxes.autoPreview')}
          </button>
          <button
            data-testid="pagebox-auto-apply"
            onClick={() => void runAuto(false)}
            disabled={busy || autoPreview === null || autoPreview.cropped === 0}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
          >
            {tChrome('panel.pageBoxes.autoApply')}
          </button>
        </div>
        {autoPreview && (
          <div className="text-xs text-neutral-400" data-testid="pagebox-auto-summary">
            {tChrome('panel.pageBoxes.autoSummary', {
              count: autoPreview.cropped,
              unchanged: autoPreview.unchanged,
              skipped: autoPreview.skipped,
              scanned: autoPreview.scanned,
              points: autoPreview.largestTrim,
            })}
          </div>
        )}
      </div>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
