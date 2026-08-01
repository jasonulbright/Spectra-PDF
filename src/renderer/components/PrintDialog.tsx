import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { app, batch, type PrinterCapabilities } from '../lib/tauri-bridge';
import { useAppModal } from '../hooks/useAppModal';
import { runCommitGate } from '../lib/commit-gate';
import { ensureGsPath } from '../panels/SettingsPanel';
import {
  buildPrintParams,
  copiesError,
  defaultPrintOptions,
  pageRangeError,
  posterOverlapError,
  posterScaleError,
  scaleError,
  IMAGE_DPI_CHOICES,
  MAX_COPIES,
  type AnnotsMode,
  type BookletBinding,
  type BookletSubset,
  type ColorMode,
  type DuplexMode,
  type FitMode,
  type NupOrder,
  type OrientationMode,
  type PageSubset,
  type PrintLayout,
} from '../lib/print-params';

// File ▸ Print… (Ctrl+P) — M-P § 3.4, widened to the O2 option surface:
// subsets/reverse/collate, duplex, paper, orientation, color, comments
// modes, print-as-image, and the layout modes (multiple, booklet, poster,
// custom scale). Complete without a preview — O3 remains its own register
// row; the dialog is a finished feature without one, as many shipping PDF
// tools' are.
//
// The job itself is the engine's `print` (bundled Ghostscript mswinpr2,
// arm's-length subprocess like compress/grayscale). `call` is trackable, so
// the commit gate flushes pending page edits before gs reads the working
// copy — what prints is what the page counter says, not the stale bytes.
//
// Driver capabilities (paper list, duplexer, color) come from the
// printer_capabilities command per selected printer; controls a driver
// cannot honor are not offered (duplex on a simplex printer), and the
// layout modes resolve their sheet geometry from the same report. Paper
// TRAY selection is deliberately absent: gs's mswinpr2 hard-forces
// automatic source selection (§ I O2's recorded residual).

export interface PrintDialogProps {
  onClose: () => void;
}

type Opts = ReturnType<typeof defaultPrintOptions>;

const selectCls =
  'w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm';
const inputCls =
  'px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm disabled:opacity-50';
const labelCls = 'block text-sm text-neutral-400 mb-1';

const PREVIEW_MAX = 8;

export function PrintDialog({ onClose }: PrintDialogProps): React.JSX.Element {
  const { activeFile } = useActiveFile();
  const { call, callRaw } = useEngine();

  const [printers, setPrinters] = useState<string[] | null>(null);
  const [printerError, setPrinterError] = useState<string | null>(null);
  const [printer, setPrinter] = useState('');
  const [caps, setCaps] = useState<PrinterCapabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);

  const [opts, setOpts] = useState<Opts>(defaultPrintOptions);
  const [copies, setCopies] = useState('1');
  const [scaleText, setScaleText] = useState('100');
  const [posterScaleText, setPosterScaleText] = useState('100');
  const [overlapText, setOverlapText] = useState('0');
  const [rangeMode, setRangeMode] = useState<'all' | 'custom'>('all');
  const [rangeText, setRangeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the gate has run, pageCount may describe bytes the pending page
  // edits are about to rewrite — hold validation until the number is true.
  const [gated, setGated] = useState(false);

  // O3 preview: blob URLs of the PREPARED sheets (the engine runs the real
  // prepass — what shows is what spools). previewDirRef chains engine-side
  // cleanup of the previous render.
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [previewSheets, setPreviewSheets] = useState(0);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewDirRef = useRef<string | null>(null);
  const previewTokenRef = useRef(0);
  const previewUrlsRef = useRef<string[]>([]);

  const set = <K extends keyof Opts>(key: K, value: Opts[K]): void =>
    setOpts((o) => ({ ...o, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // FLUSH FIRST (the PropertiesDialog rule): the page count this dialog
      // validates ranges against — and the bytes gs will read — must include
      // pending page-tier edits. `call('print')` gates again at submit;
      // gating on open makes the NUMBERS right, not just the job.
      try {
        await runCommitGate();
      } catch (e: unknown) {
        if (!cancelled) setError(`Could not apply pending edits: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!cancelled) setGated(true);
      try {
        const list = await app.listPrinters();
        if (cancelled) return;
        setPrinters(list.printers);
        if (list.printers.length > 0) {
          setPrinter(list.default ?? list.printers[0]);
        }
      } catch (e: unknown) {
        if (!cancelled) setPrinterError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Capabilities follow the selected printer; a failed query degrades to
  // the driver-default controls rather than blocking basic printing.
  useEffect(() => {
    if (printer === '') return;
    let cancelled = false;
    setCaps(null);
    setCapsError(null);
    void app.printerCapabilities(printer).then(
      (c) => { if (!cancelled) setCaps(c); },
      (e: unknown) => {
        if (!cancelled) setCapsError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => { cancelled = true; };
  }, [printer]);

  // Portrait sheet size for the layout modes: chosen paper, else the
  // printer's default, else the driver's first paper.
  const sheet = useMemo<{ w: number; h: number } | null>(() => {
    if (!caps || caps.papers.length === 0) return null;
    const pick =
      (opts.paper !== null && caps.papers.find((p) => p.id === opts.paper)) ||
      (caps.default_paper !== null && caps.papers.find((p) => p.id === caps.default_paper)) ||
      caps.papers[0];
    return pick ? { w: pick.width_pt, h: pick.height_pt } : null;
  }, [caps, opts.paper]);

  const workingPath = activeFile?.workingPath ?? null;
  const docPageCount = activeFile?.pageCount ?? 0;

  // O3: re-render the preview (debounced) whenever anything that changes a
  // SHEET changes. The engine runs the real prepass and renders the
  // prepared sheets — preview and job share one pipeline, so they cannot
  // disagree. `callRaw`, deliberately: a read-only render of the working
  // copy whose bytes this dialog already gated on open; the gated `call`
  // would queue a visible operation per keystroke.
  useEffect(() => {
    if (!gated || !workingPath || !sheet) return;
    if (rangeMode === 'custom' &&
        (rangeText.trim() === '' || pageRangeError(rangeText, docPageCount))) return;
    if (opts.fit === 'scale' && scaleError(scaleText)) return;
    if (opts.layout === 'poster' &&
        (posterScaleError(posterScaleText) ||
         posterOverlapError(overlapText, sheet.w, sheet.h))) return;
    const token = ++previewTokenRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        setPreviewBusy(true);
        try {
          const params = buildPrintParams({
            ...opts,
            file: workingPath,
            printer: '',
            gsPath: await ensureGsPath(),
            pages: rangeMode === 'custom' ? rangeText : '',
            copies: 1,
            scalePercent: Number(scaleText.trim()) || 100,
            posterScale: Number(posterScaleText.trim()) || 100,
            posterOverlap: Number(overlapText.trim()) || 0,
            sheetWidth: sheet.w,
            sheetHeight: sheet.h,
          });
          params.sheet_width = sheet.w; // preview needs the medium ALWAYS,
          params.sheet_height = sheet.h; // not only for the layout modes
          params.dpi = 72;
          params.max_pages = PREVIEW_MAX;
          if (previewDirRef.current) params.cleanup_dir = previewDirRef.current;
          const r = (await callRaw('print_preview', params)) as unknown as {
            preview_dir: string;
            pages: string[];
            sheets: number;
            truncated: boolean;
          };
          if (previewTokenRef.current !== token) return; // superseded; the
          // stale dir is caught by the engine's hourly orphan sweep.
          previewDirRef.current = r.preview_dir;
          const buffers = await Promise.all(r.pages.map((p) => batch.readFileBuffer(p)));
          if (previewTokenRef.current !== token) return;
          const urls = buffers.map((b) =>
            URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/png' })));
          for (const u of previewUrlsRef.current) URL.revokeObjectURL(u);
          previewUrlsRef.current = urls;
          setPreviewUrls(urls);
          setPreviewSheets(r.sheets);
          setPreviewTruncated(r.truncated);
          setPreviewIndex((i) => Math.min(i, Math.max(0, urls.length - 1)));
          setPreviewError(null);
        } catch (e: unknown) {
          if (previewTokenRef.current === token) {
            setPreviewError(e instanceof Error ? e.message : String(e));
          }
        } finally {
          if (previewTokenRef.current === token) setPreviewBusy(false);
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [gated, workingPath, docPageCount, sheet, opts, rangeMode, rangeText,
      scaleText, posterScaleText, overlapText, callRaw]);

  // Unmount: revoke the blob URLs and delete the engine-side scratch.
  useEffect(() => {
    return () => {
      for (const u of previewUrlsRef.current) URL.revokeObjectURL(u);
      const dir = previewDirRef.current;
      if (dir) void callRaw('print_preview_cleanup', { directory: dir }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!activeFile) {
    // The command's `when` requires a showable document, but a file can
    // close underneath an open dialog.
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-neutral-400" data-testid="print-no-file">
          No document is open.
        </p>
      </Shell>
    );
  }

  const pageCount = activeFile.pageCount;
  const rangeErr = gated && rangeMode === 'custom' ? pageRangeError(rangeText, pageCount) : null;
  const copiesErr = copiesError(copies);
  const scaleErr = opts.fit === 'scale' ? scaleError(scaleText) : null;
  const posterScaleErr = opts.layout === 'poster' ? posterScaleError(posterScaleText) : null;
  const overlapErr = opts.layout === 'poster'
    ? posterOverlapError(overlapText, sheet?.w ?? null, sheet?.h ?? null)
    : null;
  const needsSheet = opts.layout !== 'single' || opts.fit === 'scale';
  const sheetMissing = needsSheet && sheet === null;
  const noPrinters = printers !== null && printers.length === 0;
  const canPrint =
    !busy && gated && printer !== '' && !rangeErr && !copiesErr && !scaleErr &&
    !posterScaleErr && !overlapErr && !sheetMissing &&
    (rangeMode === 'all' || rangeText.trim() !== '');

  const handlePrint = async (): Promise<void> => {
    if (!canPrint || !activeFile) return;
    setBusy(true);
    setError(null);
    try {
      await call('print', buildPrintParams({
        ...opts,
        file: activeFile.workingPath,
        printer,
        gsPath: await ensureGsPath(),
        pages: rangeMode === 'custom' ? rangeText : '',
        copies: Number(copies.trim()),
        scalePercent: Number(scaleText.trim()),
        posterScale: Number(posterScaleText.trim()),
        posterOverlap: Number(overlapText.trim()),
        sheetWidth: needsSheet ? (sheet?.w ?? null) : null,
        sheetHeight: needsSheet ? (sheet?.h ?? null) : null,
        // Booklet is always duplexed onto landscape sheets; short-edge
        // flipping is what makes consecutive sides face correctly on a
        // portrait-fed duplexer. Overridable via the duplex control.
        duplex: opts.layout === 'booklet' && opts.duplex === 'printer' && caps?.duplex
          ? 'short'
          : opts.duplex,
      }));
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Shell onClose={onClose}>
      <div className="flex gap-5">
      <div className="flex flex-col gap-4 flex-1 min-w-0">
        <div>
          <label className={labelCls} htmlFor="print-printer">Printer</label>
          {printerError ? (
            <p className="text-sm text-red-400" data-testid="print-printer-error">
              Could not list printers: {printerError}
            </p>
          ) : noPrinters ? (
            <p className="text-sm text-neutral-400" data-testid="print-no-printers">
              No printers are installed.
            </p>
          ) : (
            <select
              id="print-printer"
              data-testid="print-printer"
              className={selectCls}
              value={printer}
              disabled={printers === null}
              onChange={(e) => setPrinter(e.target.value)}
            >
              {printers === null && <option value="">Looking for printers…</option>}
              {(printers ?? []).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
          {capsError && (
            <p className="text-xs text-neutral-500 mt-1" data-testid="print-caps-error">
              Printer options unavailable: {capsError}
            </p>
          )}
        </div>

        <fieldset>
          <legend className={labelCls}>Pages</legend>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="print-range"
                data-testid="print-range-all"
                checked={rangeMode === 'all'}
                onChange={() => setRangeMode('all')}
              />
              All ({pageCount} page{pageCount === 1 ? '' : 's'})
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="print-range"
                data-testid="print-range-custom"
                checked={rangeMode === 'custom'}
                onChange={() => setRangeMode('custom')}
              />
              Pages:
            </label>
            <input
              data-testid="print-range-input"
              className={`flex-1 ${inputCls}`}
              placeholder="e.g. 1-3, 5"
              value={rangeText}
              disabled={rangeMode !== 'custom'}
              onFocus={() => setRangeMode('custom')}
              onChange={(e) => setRangeText(e.target.value)}
            />
          </div>
          {rangeErr && (
            <p className="text-xs text-red-400 mt-1" data-testid="print-range-error">{rangeErr}</p>
          )}
          <div className="flex items-center gap-4 mt-2">
            <select
              data-testid="print-subset"
              aria-label="Page subset"
              className={selectCls + ' w-auto'}
              value={opts.subset}
              onChange={(e) => set('subset', e.target.value as PageSubset)}
            >
              <option value="all">All pages in range</option>
              <option value="odd">Odd pages only</option>
              <option value="even">Even pages only</option>
            </select>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid="print-reverse"
                checked={opts.reverse}
                onChange={(e) => set('reverse', e.target.checked)}
              />
              Reverse order
            </label>
          </div>
        </fieldset>

        <div className="flex gap-6 items-start">
          <div>
            <label className={labelCls} htmlFor="print-copies">Copies</label>
            <input
              id="print-copies"
              data-testid="print-copies"
              type="number"
              min={1}
              max={MAX_COPIES}
              className={`w-24 ${inputCls}`}
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
            />
            {copiesErr && (
              <p className="text-xs text-red-400 mt-1" data-testid="print-copies-error">{copiesErr}</p>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-sm mt-6">
            <input
              type="checkbox"
              data-testid="print-collate"
              checked={opts.collate}
              disabled={copies.trim() === '1'}
              onChange={(e) => set('collate', e.target.checked)}
            />
            Collate
          </label>
        </div>

        <fieldset>
          <legend className={labelCls}>Page sizing &amp; layout</legend>
          <div className="flex items-center gap-3 mb-2">
            <select
              data-testid="print-layout"
              aria-label="Layout"
              className={selectCls + ' w-auto'}
              value={opts.layout}
              onChange={(e) => set('layout', e.target.value as PrintLayout)}
            >
              <option value="single">Size</option>
              <option value="nup">Multiple pages per sheet</option>
              <option value="booklet">Booklet</option>
              <option value="poster">Poster (tile large pages)</option>
            </select>
            {sheetMissing && (
              <span className="text-xs text-red-400" data-testid="print-sheet-missing">
                Needs the printer's paper size — options unavailable
              </span>
            )}
          </div>

          {opts.layout === 'single' && (
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="print-fit"
                  data-testid="print-fit-fit"
                  checked={opts.fit === 'fit'}
                  onChange={() => set('fit', 'fit' as FitMode)}
                />
                Fit to paper
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="print-fit"
                  data-testid="print-fit-actual"
                  checked={opts.fit === 'actual'}
                  onChange={() => set('fit', 'actual' as FitMode)}
                />
                Actual size
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="print-fit"
                  data-testid="print-fit-scale"
                  checked={opts.fit === 'scale'}
                  onChange={() => set('fit', 'scale' as FitMode)}
                />
                Custom scale
              </label>
              <input
                data-testid="print-scale-input"
                className={`w-20 ${inputCls}`}
                value={scaleText}
                disabled={opts.fit !== 'scale'}
                onFocus={() => set('fit', 'scale' as FitMode)}
                onChange={(e) => setScaleText(e.target.value)}
              />
              <span className="text-sm text-neutral-400">%</span>
            </div>
          )}
          {scaleErr && (
            <p className="text-xs text-red-400 mt-1" data-testid="print-scale-error">{scaleErr}</p>
          )}

          {opts.layout === 'nup' && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-neutral-400">
                Grid{' '}
                <select
                  data-testid="print-nup-rows"
                  aria-label="Rows per sheet"
                  className={selectCls + ' w-auto inline-block'}
                  value={opts.nupRows}
                  onChange={(e) => set('nupRows', Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                {' × '}
                <select
                  data-testid="print-nup-cols"
                  aria-label="Columns per sheet"
                  className={selectCls + ' w-auto inline-block'}
                  value={opts.nupCols}
                  onChange={(e) => set('nupCols', Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <select
                data-testid="print-nup-order"
                aria-label="Page order"
                className={selectCls + ' w-auto'}
                value={opts.nupOrder}
                onChange={(e) => set('nupOrder', e.target.value as NupOrder)}
              >
                <option value="horizontal">Across, then down</option>
                <option value="horizontal-reversed">Across (right to left)</option>
                <option value="vertical">Down, then across</option>
                <option value="vertical-reversed">Down (right to left)</option>
              </select>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="print-nup-border"
                  checked={opts.nupBorder}
                  onChange={(e) => set('nupBorder', e.target.checked)}
                />
                Page borders
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="print-nup-autorotate"
                  checked={opts.nupAutoRotate}
                  onChange={(e) => set('nupAutoRotate', e.target.checked)}
                />
                Auto-rotate pages
              </label>
            </div>
          )}

          {opts.layout === 'booklet' && (
            <div className="flex flex-wrap items-center gap-3">
              <select
                data-testid="print-booklet-subset"
                aria-label="Booklet sides"
                className={selectCls + ' w-auto'}
                value={opts.bookletSubset}
                onChange={(e) => set('bookletSubset', e.target.value as BookletSubset)}
              >
                <option value="both">Both sides</option>
                <option value="front">Front sides only</option>
                <option value="back">Back sides only</option>
              </select>
              <select
                data-testid="print-booklet-binding"
                aria-label="Binding edge"
                className={selectCls + ' w-auto'}
                value={opts.bookletBinding}
                onChange={(e) => set('bookletBinding', e.target.value as BookletBinding)}
              >
                <option value="left">Left binding</option>
                <option value="right">Right binding</option>
              </select>
              <span className="text-xs text-neutral-500">
                Two pages per landscape sheet, saddle order
              </span>
            </div>
          )}

          {opts.layout === 'poster' && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-neutral-400">
                Tile scale{' '}
                <input
                  data-testid="print-poster-scale"
                  className={`w-20 ${inputCls}`}
                  value={posterScaleText}
                  onChange={(e) => setPosterScaleText(e.target.value)}
                />
                {' '}%
              </label>
              <label className="text-sm text-neutral-400">
                Overlap{' '}
                <input
                  data-testid="print-poster-overlap"
                  className={`w-20 ${inputCls}`}
                  value={overlapText}
                  onChange={(e) => setOverlapText(e.target.value)}
                />
                {' '}pt
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="print-poster-cutmarks"
                  checked={opts.posterCutMarks}
                  onChange={(e) => set('posterCutMarks', e.target.checked)}
                />
                Cut marks
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="print-poster-labels"
                  checked={opts.posterLabels}
                  onChange={(e) => set('posterLabels', e.target.checked)}
                />
                Labels
              </label>
              {(posterScaleErr || overlapErr) && (
                <p className="text-xs text-red-400 w-full" data-testid="print-poster-error">
                  {posterScaleErr ?? overlapErr}
                </p>
              )}
            </div>
          )}
        </fieldset>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <div>
            <label className={labelCls} htmlFor="print-orientation">Orientation</label>
            <select
              id="print-orientation"
              data-testid="print-orientation"
              className={selectCls}
              value={opts.layout === 'booklet' ? 'landscape' : opts.orientation}
              disabled={opts.layout === 'booklet'}
              onChange={(e) => set('orientation', e.target.value as OrientationMode)}
            >
              <option value="auto">Auto</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="print-paper">Paper size</label>
            <select
              id="print-paper"
              data-testid="print-paper"
              className={selectCls}
              value={opts.paper ?? ''}
              disabled={!caps || caps.papers.length === 0}
              onChange={(e) =>
                set('paper', e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Printer default</option>
              {(caps?.papers ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          {caps?.duplex && (
            <div>
              <label className={labelCls} htmlFor="print-duplex">Two-sided</label>
              <select
                id="print-duplex"
                data-testid="print-duplex"
                className={selectCls}
                value={opts.duplex}
                onChange={(e) => set('duplex', e.target.value as DuplexMode)}
              >
                <option value="printer">Printer default</option>
                <option value="simplex">One side only</option>
                <option value="long">Flip on long edge</option>
                <option value="short">Flip on short edge</option>
              </select>
            </div>
          )}
          {caps?.color !== false ? (
            <div>
              <label className={labelCls} htmlFor="print-color">Color</label>
              <select
                id="print-color"
                data-testid="print-color"
                className={selectCls}
                value={opts.color}
                onChange={(e) => set('color', e.target.value as ColorMode)}
              >
                <option value="printer">Printer default</option>
                <option value="color">Color</option>
                <option value="gray">Grayscale</option>
              </select>
            </div>
          ) : (
            <div>
              <label className={labelCls}>Color</label>
              <p className="text-sm text-neutral-500 py-1.5" data-testid="print-mono-note">
                Black &amp; white printer
              </p>
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="print-annots">Comments &amp; forms</label>
            <select
              id="print-annots"
              data-testid="print-annots"
              className={selectCls}
              value={opts.annots}
              onChange={(e) => set('annots', e.target.value as AnnotsMode)}
            >
              <option value="all">Document and markups</option>
              <option value="document">Document only</option>
              <option value="stamps">Document and stamps</option>
            </select>
          </div>
          <div className="flex items-end gap-3 pb-1">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid="print-as-image"
                checked={opts.asImage}
                onChange={(e) => set('asImage', e.target.checked)}
              />
              Print as image
            </label>
            {opts.asImage && (
              <select
                data-testid="print-image-dpi"
                aria-label="Rasterization resolution"
                className={selectCls + ' w-auto'}
                value={opts.imageDpi}
                onChange={(e) => set('imageDpi', Number(e.target.value))}
              >
                {IMAGE_DPI_CHOICES.map((d) => (
                  <option key={d} value={d}>{d} dpi</option>
                ))}
              </select>
            )}
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400" data-testid="print-error">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            data-testid="print-cancel"
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
          >
            Cancel
          </button>
          <button
            data-testid="print-submit"
            disabled={!canPrint}
            onClick={() => void handlePrint()}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
          >
            {busy ? 'Printing…' : 'Print'}
          </button>
        </div>
      </div>

      <div className="w-64 shrink-0 flex flex-col gap-2" data-testid="print-preview">
        <span className="text-sm text-neutral-400">
          Preview{previewBusy ? '…' : ''}
        </span>
        <div className="flex-1 min-h-[280px] bg-neutral-950 border border-neutral-800 rounded flex items-center justify-center overflow-hidden">
          {previewUrls.length > 0 ? (
            <img
              data-testid="print-preview-img"
              src={previewUrls[Math.min(previewIndex, previewUrls.length - 1)]}
              alt={`Print preview, sheet ${previewIndex + 1}`}
              className="max-w-full max-h-[380px] object-contain shadow"
            />
          ) : (
            <span className="text-xs text-neutral-600 px-3 text-center" data-testid="print-preview-empty">
              {sheet ? (previewBusy ? 'Rendering…' : 'No preview') : 'Preview needs printer paper info'}
            </span>
          )}
        </div>
        {previewError && (
          <p className="text-xs text-red-400" data-testid="print-preview-error">{previewError}</p>
        )}
        <div className="flex items-center justify-between">
          <button
            data-testid="print-preview-prev"
            disabled={previewIndex <= 0}
            onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded disabled:opacity-40"
          >
            ‹
          </button>
          <span className="text-xs text-neutral-400" data-testid="print-preview-count">
            {previewUrls.length > 0
              ? `Sheet ${previewIndex + 1} of ${previewSheets}${previewTruncated ? ` (first ${previewUrls.length} shown)` : ''}`
              : '—'}
          </span>
          <button
            data-testid="print-preview-next"
            disabled={previewIndex >= previewUrls.length - 1}
            onClick={() => setPreviewIndex((i) => Math.min(previewUrls.length - 1, i + 1))}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  const shellRef = useAppModal(onClose);
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Print"
        data-testid="print-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[960px] max-w-[96vw] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">Print</h3>
          <button
            data-testid="print-close"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            Close
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
