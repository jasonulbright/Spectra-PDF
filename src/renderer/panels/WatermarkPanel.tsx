import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { file, app, dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { TEST_HARNESS_ENABLED, registerWatermark } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount } from '../i18n';
import {
  resolvedColumns,
  writingParams,
  type WatermarkSource,
  type WatermarkWriting,
} from '../lib/watermark-writing';

// Muted set for stamp text — full-strength annotation colors read as marker
// ink, not a watermark.
const WATERMARK_COLORS = ['#808080', '#e0393e', '#2f6fed', '#2fbf71'];

const POSITIONS = [
  'center',
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export function WatermarkPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles, dispatch } = useActiveFile();
  const { call } = useEngine();
  const [source, setSource] = useState<WatermarkSource>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [imagePath, setImagePath] = useState('');
  const [pdfPath, setPdfPath] = useState('');
  const [pdfPage, setPdfPage] = useState(1);
  const [opacity, setOpacity] = useState(0.15);
  const [angle, setAngle] = useState(45);
  const [color, setColor] = useState(WATERMARK_COLORS[0]);
  const [layer, setLayer] = useState<'over' | 'under'>('over');
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>('center');
  const [margin, setMargin] = useState(36);
  const [tile, setTile] = useState(false);
  const [tileGap, setTileGap] = useState(24);
  const [pageInput, setPageInput] = useState('all');
  // Writing mode, and the column direction the engine RESOLVED for it —
  // derived from the text rather than requested, so it is shown only once a
  // stamp has actually been laid down and is cleared the moment any input it
  // was derived from changes.
  const [writing, setWriting] = useState<WatermarkWriting>('horizontal');
  const [columns, setColumns] = useState<'rtl' | 'ltr' | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setColumns(null);
  }, [text, source, writing]);

  const pickImage = useCallback(async () => {
    const picked = await dialog.pickWatermarkImage();
    if (picked) setImagePath(picked);
  }, []);

  const pickPdf = useCallback(async () => {
    const picked = await dialog.pickWatermarkPdf();
    if (picked) setPdfPath(picked);
  }, []);

  const handleApply = useCallback(async () => {
    if (!activeFile) return;
    if (source === 'text' && !text.trim()) {
      setStatus(tChrome('panel.watermark.emptyText'));
      return;
    }
    if (source === 'image' && !imagePath.trim()) {
      setStatus(tChrome('panel.watermark.noImage'));
      return;
    }
    if (source === 'pdf' && !pdfPath.trim()) {
      setStatus(tChrome('panel.watermark.noPdf'));
      return;
    }
    const pages =
      pageInput.trim().toLowerCase() === 'all'
        ? undefined
        : pageInput.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    // An empty parse must never reach the engine: pages [] means "zero
    // pages" there, and quietly stamping nothing (or, worse, everything)
    // on a typo helps no one.
    if (pages && pages.length === 0) {
      setStatus(tChrome('panel.watermark.badPages'));
      return;
    }
    setBusy(true);
    setStatus(tChrome('panel.watermark.applying'));
    try {
      // Same whole-file-op shape as RotatePanel: snapshot first (runs the
      // commit gate), engine writes the working copy in place, UPDATE_FILE
      // reloads and pushes the snapshot onto the undo chain.
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      const result = await call('watermark', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        // Exactly one source reaches the engine; the others stay empty, which
        // is how the engine's own one-source refusal is expressed.
        text: source === 'text' ? text.trim() : '',
        image: source === 'image' ? imagePath.trim() : '',
        pdf_source: source === 'pdf' ? pdfPath.trim() : '',
        pdf_page: pdfPage,
        opacity,
        angle,
        color,
        layer,
        scale,
        position,
        margin,
        tile,
        tile_gap: tileGap,
        // The bundled fonts dir lets the engine embed a Unicode font for
        // non-Latin-1 stamps instead of rendering "?" (CJK still refuses — the
        // fallback-face boundary — with a surfaced error).
        font_dir: await app.getEditFontPath(),
        ...(pages ? { pages } : {}),
        ...writingParams(source, writing),
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      const info = await call('get_page_count', { file: activeFile.workingPath });
      dispatch({ type: 'UPDATE_FILE', path: activeFile.path, pageCount: info.pages, buffer, snapshotPath });
      const count = (result as unknown as { pages_watermarked: number }).pages_watermarked;
      const frames = (result as unknown as { image_frames: number }).image_frames ?? 0;
      setColumns(resolvedColumns((result as unknown as { writing_mode?: unknown }).writing_mode));
      setStatus(
        tChromeCount('panel.watermark.done', count) +
          (frames > 1 ? ' ' + tChromeCount('panel.watermark.usedFirstFrame', frames) : ''),
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
      setStatus(tChrome('panel.common.error', { message: msg }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, source, text, imagePath, pdfPath, pdfPage, opacity, angle, color, layer, scale, position, margin, tile, tileGap, pageInput, writing, call, dispatch]);

  // The pickers are native and undrivable, so e2e injects the chosen path
  // through the panel's OWN setter — the state an injected run reaches is the
  // state a clicked one reaches (the compress-panel precedent).
  const harnessRef = useRef({ setSource, setPdfPath, setPdfPage });
  harnessRef.current = { setSource, setPdfPath, setPdfPage };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerWatermark({
      setPdfSource: (path, page) => {
        harnessRef.current.setSource('pdf');
        harnessRef.current.setPdfPath(path);
        harnessRef.current.setPdfPage(page);
      },
    });
    return () => registerWatermark(null);
  }, []);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.watermark.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="watermark-source">{tChrome('panel.watermark.source')}</label>
        <select
          id="watermark-source"
          data-testid="watermark-source"
          value={source}
          onChange={(e) => setSource(e.target.value as WatermarkSource)}
          className="w-48 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="text">{tChrome('panel.watermark.sourceText')}</option>
          <option value="image">{tChrome('panel.watermark.sourceImage')}</option>
          <option value="pdf">{tChrome('panel.watermark.sourcePdf')}</option>
        </select>
      </div>
      {source === 'text' ? (
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.text')}</label>
          <input
            data-testid="watermark-text"
            aria-label={tChrome('panel.watermark.textAria')}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-64 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-neutral-500 mt-1">
            {tChrome(
              writing === 'vertical'
                ? 'panel.watermark.scriptsNoteVertical'
                : 'panel.watermark.scriptsNote',
            )}
          </p>
        </div>
      ) : source === 'image' ? (
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.imageLabel')}</label>
          <div className="flex items-center gap-2">
            <button
              data-testid="watermark-pick-image"
              onClick={pickImage}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-sm"
            >
              {tChrome('panel.watermark.chooseImage')}
            </button>
            <span data-testid="watermark-image-name" className="text-sm text-neutral-300 truncate max-w-xs">
              {imagePath ? imagePath.replace(/^.*[\\/]/, '') : tChrome('panel.watermark.noImageChosen')}
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">{tChrome('panel.watermark.imageNote')}</p>
        </div>
      ) : (
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.pdfLabel')}</label>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              data-testid="watermark-pick-pdf"
              onClick={pickPdf}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-sm"
            >
              {tChrome('panel.watermark.choosePdf')}
            </button>
            <span data-testid="watermark-pdf-name" className="text-sm text-neutral-300 truncate max-w-xs">
              {pdfPath ? pdfPath.replace(/^.*[\\/]/, '') : tChrome('panel.watermark.noPdfChosen')}
            </span>
            <label className="text-sm text-neutral-400 flex items-center gap-2" htmlFor="watermark-pdf-page">
              {tChrome('panel.watermark.pdfPage')}
              <input
                id="watermark-pdf-page"
                data-testid="watermark-pdf-page"
                type="number"
                min={1}
                step={1}
                value={pdfPage}
                onChange={(e) => setPdfPage(Number(e.target.value))}
                className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
              />
            </label>
          </div>
          <p className="text-xs text-neutral-500 mt-1">{tChrome('panel.watermark.pdfNote')}</p>
        </div>
      )}
      <div className="flex gap-6 items-end flex-wrap">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.opacity', { pct: Math.round(opacity * 100) })}</label>
          <input
            data-testid="watermark-opacity"
            aria-label={tChrome('panel.watermark.opacityAria')}
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="w-40"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.angle')}</label>
          <input
            data-testid="watermark-angle"
            aria-label={tChrome('panel.watermark.angleAria')}
            type="number"
            min={-180}
            max={180}
            value={angle}
            onChange={(e) => setAngle(Number(e.target.value))}
            className="w-20 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        {source === 'text' && (
          <div>
            <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.color')}</label>
            <div className="flex items-center gap-1.5 py-1.5">
              {WATERMARK_COLORS.map((c) => (
                <button
                  key={c}
                  title={c}
                  onClick={() => setColor(c)}
                  className={'color-swatch w-5 h-5 rounded-full' + (color === c ? ' is-selected' : '')}
                  style={{
                    backgroundColor: c,
                    outline: color === c ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
                    outlineOffset: 1,
                  }}
                />
              ))}
            </div>
          </div>
        )}
        {source === 'text' && (
          <div>
            <label
              className="block text-sm text-neutral-400 mb-1"
              htmlFor="watermark-writing-mode"
              title={tChrome('panel.watermark.writingModeTitle')}
            >
              {tChrome('panel.watermark.writingMode')}
            </label>
            <div className="flex items-center gap-2">
              <select
                id="watermark-writing-mode"
                data-testid="watermark-writing-mode"
                value={writing}
                title={tChrome('panel.watermark.writingModeTitle')}
                onChange={(e) => setWriting(e.target.value as WatermarkWriting)}
                className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              >
                <option value="horizontal">{tChrome('panel.watermark.writingMode.horizontal')}</option>
                <option value="vertical">{tChrome('panel.watermark.writingMode.vertical')}</option>
              </select>
              {writing === 'vertical' && columns && (
                <span data-testid="watermark-columns" className="text-xs text-neutral-500">
                  {tChrome(
                    columns === 'ltr'
                      ? 'panel.watermark.columnsLtr'
                      : 'panel.watermark.columnsRtl',
                  )}
                </span>
              )}
            </div>
          </div>
        )}
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.placement')}</label>
          <select
            aria-label={tChrome('panel.watermark.placement')}
            data-testid="watermark-layer"
            value={layer}
            onChange={(e) => setLayer(e.target.value as 'over' | 'under')}
            className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
          >
            <option value="over">{tChrome('panel.watermark.over')}</option>
            <option value="under">{tChrome('panel.watermark.under')}</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.watermark.pagesLabel')}</label>
          <input
            data-testid="watermark-pages"
            aria-label={tChrome('panel.watermark.pagesAria')}
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            className="w-40 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <div className="flex gap-6 items-end flex-wrap">
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="watermark-scale">{tChrome('panel.watermark.scale')}</label>
          <input
            id="watermark-scale"
            data-testid="watermark-scale"
            type="number"
            min={0.05}
            max={4}
            step={0.05}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="watermark-position">{tChrome('panel.watermark.position')}</label>
          <select
            id="watermark-position"
            data-testid="watermark-position"
            value={position}
            disabled={tile}
            onChange={(e) => setPosition(e.target.value as (typeof POSITIONS)[number])}
            className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm disabled:opacity-50"
          >
            {POSITIONS.map((p) => (
              <option key={p} value={p}>{tChrome(`panel.watermark.position.${p}` as 'panel.watermark.position.center')}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="watermark-margin">{tChrome('panel.watermark.margin')}</label>
          <input
            id="watermark-margin"
            data-testid="watermark-margin"
            type="number"
            min={0}
            step={6}
            value={margin}
            disabled={tile || position === 'center'}
            onChange={(e) => setMargin(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm disabled:opacity-50 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm text-neutral-400 py-1.5">
            <input
              data-testid="watermark-tile"
              type="checkbox"
              checked={tile}
              onChange={(e) => setTile(e.target.checked)}
            />
            {tChrome('panel.watermark.tile')}
          </label>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="watermark-tile-gap">{tChrome('panel.watermark.tileGap')}</label>
          <input
            id="watermark-tile-gap"
            data-testid="watermark-tile-gap"
            type="number"
            min={0}
            step={4}
            value={tileGap}
            disabled={!tile}
            onChange={(e) => setTileGap(Number(e.target.value))}
            className="w-24 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm disabled:opacity-50 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>
      <button
        data-testid="watermark-apply"
        onClick={handleApply}
        disabled={busy}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
      >
        {busy ? tChrome('panel.watermark.applyingBtn') : tChrome('panel.watermark.apply')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
