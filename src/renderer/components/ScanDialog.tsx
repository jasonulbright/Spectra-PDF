import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { useEngine } from '../hooks/useEngine';
import { useOperationQueue } from '../hooks/useOperationQueue';
import { app, batch, dialog, scanner } from '../lib/tauri-bridge';
import { tChrome, type UiKey } from '../i18n';
import { formatBytes } from '../lib/format-bytes';
import { loadDocument } from '../lib/pdfRenderer';
import { extractPageText } from '../search/extract';
import { displayRectToPdf } from '../lib/pdfx-build';
import { recognizePage } from '../lib/ocr-recognize';
import { ghostscriptPath, tesseractPath } from '../lib/ocr-recognize';
import { DEFAULT_OCR_LANGUAGE, OCR_LANGUAGES } from '../ocr/languages';
import { tOcrLanguage } from '../i18n';
import { TEST_HARNESS_ENABLED, registerScan } from '../testHarness';
import {
  MAX_PREVIEW_BYTES,
  PAPER_SIZES,
  defaultScanOutputName,
  initialColorMode,
  initialDpi,
  initialValue,
  isInterpolated,
  liveScratches,
  maxPages,
  numericControl,
  offersAllPages,
  pagesFromResult,
  refusalKey,
  refusalText,
  removePage,
  reportFor,
  sourceOptions,
  toScanSettings,
  type ColorMode,
  type PaperSize,
  type ScanEvent,
  type ScanPage,
  type ScanSourceOption,
  type ScannerCapabilities,
  type ScannerDevice,
} from '../lib/scan';

// Scan: acquire pages from a WIA device, then hand them to machinery that
// already exists — `create_pdf`'s DPI-honest image door for a new document,
// the byte-only import machinery for an append.
//
// Every control here is DERIVED from the device's own capability report
// (`lib/scan.ts`). Nothing has a default list: a device that reports three
// resolutions gets three, a device that reports a range gets the range's own
// steps, and a device that reports no brightness gets no brightness slider.
//
// The engine calls are callRaw: the staged pages and the assembled output are
// EXTERNAL files, never a workspace working copy, so the commit gate must not
// run and must not side-effect-commit unrelated pending page edits. The
// operation QUEUE is a different thing and this does belong in it, so the
// calls are wrapped in `track`.

/** Where the last-used device id is remembered. Dropped by the device layer
 * when it no longer enumerates (the phantom-default rule), so a scanner that
 * went away cannot preselect itself. */
const LAST_DEVICE_KEY = 'spectra-scan-device';

type Phase = 'looking' | 'empty' | 'setup' | 'scanning' | 'finishing';

interface Progress {
  message: string;
}

export function ScanDialog({
  mode,
  onClose,
  onCreated,
  onAppend,
}: {
  /** `append` lands the pages in the open document at the insertion anchor;
   * `new` writes a file and opens it through the ordinary funnel. */
  mode: 'new' | 'append';
  onClose: () => void;
  onCreated: (path: string) => Promise<void>;
  /** Absent when nothing can be appended to, which is what makes the append
   * button's absence a fact rather than a disabled control. */
  onAppend: ((path: string) => Promise<void>) | null;
}): React.JSX.Element {
  useTranslation();
  const { callRaw } = useEngine();
  const { track } = useOperationQueue();

  const [phase, setPhase] = useState<Phase>('looking');
  const [devices, setDevices] = useState<ScannerDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ScannerCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [adjusted, setAdjusted] = useState<{ property: string; requested: number; actual: number | null }[]>([]);
  const [sizeWarning, setSizeWarning] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [scanDpi, setScanDpi] = useState<number | null>(null);

  // Form state, all of it seeded from the capability report.
  const [optionId, setOptionId] = useState<ScanSourceOption['id'] | null>(null);
  const [dpi, setDpi] = useState<number | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode | null>(null);
  const [paper, setPaper] = useState<PaperSize>('auto');
  const [allPages, setAllPages] = useState(true);
  const [pageCount, setPageCount] = useState(1);
  const [brightness, setBrightness] = useState<number | null>(null);
  const [contrast, setContrast] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [enhance, setEnhance] = useState(false);
  const [ocr, setOcr] = useState(false);
  const [lang, setLang] = useState(DEFAULT_OCR_LANGUAGE);

  const options = useMemo(
    () => (capabilities ? sourceOptions(capabilities) : []),
    [capabilities],
  );
  const option = useMemo(
    () => options.find((o) => o.id === optionId) ?? options[0] ?? null,
    [options, optionId],
  );
  const report = useMemo(
    () => (capabilities ? reportFor(capabilities, option) : null),
    [capabilities, option],
  );
  const dpiControl = useMemo(
    () => numericControl(report?.resolution ?? { kind: 'absent' }),
    [report],
  );
  const brightnessControl = useMemo(
    () => numericControl(report?.brightness ?? { kind: 'absent' }),
    [report],
  );
  const contrastControl = useMemo(
    () => numericControl(report?.contrast ?? { kind: 'absent' }),
    [report],
  );
  const canAskForAllPages = offersAllPages(option, report?.pages ?? { kind: 'absent' });
  const pageLimit = maxPages(report?.pages ?? { kind: 'absent' });

  const busy = phase === 'scanning' || phase === 'finishing';

  // ── Device enumeration ───────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setPhase('looking');
    setError(null);
    try {
      const list = await scanner.listScanners(localStorage.getItem(LAST_DEVICE_KEY));
      setDevices(list.scanners);
      if (list.scanners.length === 0) {
        setDeviceId(null);
        setCapabilities(null);
        setPhase('empty');
        return;
      }
      setDeviceId(list.default ?? list.scanners[0].id);
      setPhase('setup');
    } catch (e) {
      setDevices([]);
      setCapabilities(null);
      setError(refusalMessage(e));
      setPhase('empty');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Capability report ────────────────────────────────────────────────
  useEffect(() => {
    if (!deviceId) return;
    let live = true;
    setCapabilities(null);
    setError(null);
    void (async () => {
      try {
        const caps = await scanner.scannerCapabilities(deviceId);
        if (!live) return;
        localStorage.setItem(LAST_DEVICE_KEY, deviceId);
        setCapabilities(caps);
      } catch (e) {
        if (!live) return;
        setError(refusalMessage(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [deviceId]);

  // Seed every control from the report the moment it lands. A device with no
  // brightness property leaves brightness null, which is what keeps the
  // slider off the screen AND out of the written settings.
  useEffect(() => {
    if (!report) return;
    setOptionId((prev) => (options.some((o) => o.id === prev) ? prev : (options[0]?.id ?? null)));
    setDpi(initialDpi(numericControl(report.resolution)));
    setColorMode(initialColorMode(report.color_modes));
    setBrightness(initialValue(numericControl(report.brightness)));
    setContrast(initialValue(numericControl(report.contrast)));
  }, [report, options]);

  // "Every page in the feeder" cannot be the standing default on a source
  // that cannot be asked for it — a flatbed asked for zero pages scans
  // nothing.
  useEffect(() => {
    if (!canAskForAllPages) setAllPages(false);
  }, [canAskForAllPages]);

  // ── The run ──────────────────────────────────────────────────────────
  const runScan = useCallback(async () => {
    if (!deviceId || !capabilities) return;
    setPhase('scanning');
    setError(null);
    setCancelled(false);
    setStopping(false);
    setSizeWarning(null);
    setProgress(null);
    try {
      const settings = toScanSettings({
        option,
        dpi,
        colorMode,
        paper,
        allPages,
        pageCount,
        brightness,
        contrast,
      });
      const result = await scanner.scanAcquire(deviceId, settings, (event: ScanEvent) => {
        switch (event.kind) {
          case 'warming':
            setProgress({ message: tChrome('dialog.scan.warming') });
            break;
          case 'pageStarted':
            setProgress({
              message: tChrome('dialog.scan.pageStarted', { index: event.index + 1 }),
            });
            break;
          case 'progress':
            setProgress({
              message: tChrome('dialog.scan.pageProgress', {
                index: event.index + 1,
                percent: event.percent,
              }),
            });
            break;
          case 'pageFinished':
            break;
          case 'deviceStatus':
            setProgress({ message: tChrome('dialog.scan.deviceStatus', { code: event.code }) });
            break;
          case 'sizeWarning':
            setSizeWarning(event.bytes);
            break;
        }
      });
      setPages((prev) => [...prev, ...pagesFromResult(result)]);
      setCancelled(result.cancelled);
      setAdjusted(result.adjusted);
      setScanDpi(result.dpi);
    } catch (e) {
      setError(refusalMessage(e));
    } finally {
      setProgress(null);
      setStopping(false);
      setPhase('setup');
    }
  }, [
    deviceId,
    capabilities,
    option,
    dpi,
    colorMode,
    paper,
    allPages,
    pageCount,
    brightness,
    contrast,
  ]);

  const stop = useCallback(() => {
    if (!deviceId) return;
    setStopping(true);
    void scanner.scanCancel(deviceId);
  }, [deviceId]);

  // ── Finishing ────────────────────────────────────────────────────────
  /** Recognise every page that has no text layer and write one. The same
   * recogniser and the same `apply_ocr_layer` call the workspace's own
   * "Make searchable" uses; a document with no recognisable text is left
   * alone rather than rewritten. */
  const makeSearchable = useCallback(
    async (path: string) => {
      const bytes = await batch.readFileBuffer(path);
      const proxy = await loadDocument(bytes);
      try {
        const payload: { page: number; words: { text: string; rect: [number, number, number, number] }[] }[] = [];
        for (let i = 0; i < proxy.numPages; i += 1) {
          if (!(await extractPageText(proxy, i)).needsOcr) continue;
          const recognized = await recognizePage(callRaw, path, i, lang);
          const page = await proxy.getPage(i + 1);
          const [vx0, vy0, vx1, vy1] = page.view;
          const box = { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 };
          const words = recognized.words
            .filter((w) => w.text.trim().length > 0)
            .map((w) => ({ text: w.text, rect: displayRectToPdf(w, box, page.rotate) }));
          if (words.length > 0) payload.push({ page: i + 1, words });
        }
        if (payload.length === 0) return;
        await track('apply_ocr_layer', { file: path }, () =>
          callRaw('apply_ocr_layer', { file: path, output: path, pages: payload }),
        );
      } finally {
        await proxy.loadingTask.destroy().catch(() => {});
      }
    },
    [callRaw, lang, track],
  );

  const assemble = useCallback(
    async (output: string): Promise<string | null> => {
      setPhase('finishing');
      setError(null);
      try {
        setProgress({ message: tChrome('dialog.scan.building') });
        const [gsPath, sofficePath] = await Promise.all([app.getGsPath(), app.getSofficePath()]);
        await track('create_pdf', { file: output }, () =>
          callRaw('create_pdf', {
            sources: pages.map((p) => ({ path: p.path })),
            output,
            page_size: 'auto',
            orientation: 'auto',
            margin_pt: 0,
            // The resolution the device REPORTED BACK, not the one asked for:
            // a driver that clamped the request, or wrote no resolution into
            // the image header at all, still produces correctly sized pages.
            image_dpi_default: scanDpi ?? dpi ?? 300,
            gs_path: gsPath,
            soffice_path: sofficePath,
          }),
        );
        // Enhance BEFORE recognising, always: OCR over an unstraightened page
        // is the defect the enhancement exists to fix, and doing it the other
        // way would bake a worse text layer into the document at the one
        // moment the whole pipeline is ours.
        if (enhance) {
          setProgress({ message: tChrome('dialog.scan.enhancing') });
          const [gs, tess] = await Promise.all([ghostscriptPath(), tesseractPath()]);
          await track('enhance_scan', { file: output }, () =>
            callRaw('enhance_scan', {
              file: output,
              output,
              orientation: true,
              gs_path: gs,
              tesseract_path: tess,
            }),
          );
        }
        if (ocr) {
          setProgress({ message: tChrome('dialog.scan.recognizing') });
          await makeSearchable(output);
        }
        return output;
      } catch (e) {
        setError(refusalMessage(e));
        return null;
      } finally {
        setProgress(null);
        setPhase('setup');
      }
    },
    [pages, scanDpi, dpi, enhance, ocr, callRaw, track, makeSearchable],
  );

  const discardScratches = useCallback(async (staged: readonly ScanPage[]) => {
    for (const scratch of liveScratches(staged)) {
      await scanner.scanDiscard(scratch).catch(() => {});
    }
  }, []);

  const saveAsPdf = useCallback(async () => {
    if (pages.length === 0) return;
    const output = await dialog.saveFile({ defaultPath: defaultScanOutputName() });
    if (!output) return;
    const built = await assemble(output);
    if (!built) return;
    const staged = pages;
    setPages([]);
    await discardScratches(staged);
    await onCreated(built);
    onClose();
  }, [pages, assemble, discardScratches, onCreated, onClose]);

  const appendToDocument = useCallback(async () => {
    if (pages.length === 0 || !onAppend) return;
    // Assembled into the scan's own scratch folder, which is swept with the
    // rest of the run: the import machinery reads the bytes and the file has
    // no life after that.
    const scratch = pages[pages.length - 1].scratch;
    const sep = scratch.includes('\\') ? '\\' : '/';
    const built = await assemble(`${scratch}${sep}scan.pdf`);
    if (!built) return;
    const staged = pages;
    setPages([]);
    await onAppend(built);
    await discardScratches(staged);
    onClose();
  }, [pages, onAppend, assemble, discardScratches, onClose]);

  const chooseDifferent = useCallback(async () => {
    try {
      const chosen = await scanner.scannerSelectDialog();
      if (!chosen) return;
      // The picked id flows through the ORDINARY capability path — the system
      // picker is a door, not a second route.
      setDevices((prev) =>
        prev.some((d) => d.id === chosen) ? prev : [...prev, { id: chosen, name: chosen }],
      );
      setDeviceId(chosen);
      setPhase('setup');
    } catch (e) {
      setError(refusalMessage(e));
    }
  }, []);

  // ── Teardown ─────────────────────────────────────────────────────────
  // WIA holds a device lock while an item on it lives; a dialog that closes
  // without releasing it makes every other imaging application on the machine
  // wait out the idle timeout.
  const teardown = useRef({ deviceId, pages });
  teardown.current = { deviceId, pages };
  useEffect(
    () => () => {
      const { deviceId: id, pages: staged } = teardown.current;
      if (id) void scanner.scannerClose(id).catch(() => {});
      for (const scratch of liveScratches(staged)) {
        void scanner.scanDiscard(scratch).catch(() => {});
      }
    },
    [],
  );

  const guardedClose = busy ? () => {} : onClose;

  // ── Harness ──────────────────────────────────────────────────────────
  // The device layer needs a scanner and the destination pickers are native,
  // so e2e injects both and drives the REAL assembly, the REAL create_pdf and
  // the REAL import.
  const harnessDeps = {
    setCapabilities,
    setDeviceId,
    setPages,
    setPhase,
    assemble,
    saveAsPdf,
    appendToDocument,
    runScan,
  };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  const stateRef = useRef({ options, option, dpiControl, report, pages, phase, error, capabilities });
  stateRef.current = { options, option, dpiControl, report, pages, phase, error, capabilities };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerScan({
      injectDevice: (caps, staged) => {
        harnessRef.current.setCapabilities(caps as ScannerCapabilities);
        harnessRef.current.setDeviceId((caps as ScannerCapabilities).device_id);
        harnessRef.current.setPhase('setup');
        if (staged) {
          harnessRef.current.setPages(
            staged.map((path, i) => ({ id: `h${i}`, path, scratch: '' })),
          );
        }
      },
      setSource: (id) => setOptionId(id as ScanSourceOption['id']),
      setDpi: (value) => setDpi(value),
      setColorMode: (value) => setColorMode(value as ColorMode),
      setPaper: (value) => setPaper(value as PaperSize),
      setPostOptions: (opts) => {
        if (opts.enhance !== undefined) setEnhance(opts.enhance);
        if (opts.ocr !== undefined) setOcr(opts.ocr);
      },
      removePage: (id) => setPages((prev) => removePage(prev, id)),
      saveAs: async (output) => {
        const built = await harnessRef.current.assemble(output);
        if (!built) return null;
        const staged = stateRef.current.pages;
        harnessRef.current.setPages([]);
        await discardScratches(staged);
        await onCreated(built);
        onClose();
        return built;
      },
      append: async (output) => {
        const built = await harnessRef.current.assemble(output);
        if (!built || !onAppend) return null;
        const staged = stateRef.current.pages;
        harnessRef.current.setPages([]);
        await onAppend(built);
        await discardScratches(staged);
        onClose();
        return built;
      },
      snapshot: () => {
        const s = stateRef.current;
        return {
          phase: s.phase,
          deviceName: s.capabilities?.device_name ?? null,
          sources: s.options.map((o) => o.id),
          source: s.option?.id ?? null,
          dpiControl: s.dpiControl,
          colorModes: s.report?.color_modes ?? [],
          brightness: numericControl(s.report?.brightness ?? { kind: 'absent' }).kind,
          pageIds: s.pages.map((p) => p.id),
          pagePaths: s.pages.map((p) => p.path),
          error: s.error,
        };
      },
    });
    return () => registerScan(null);
  }, [discardScratches, onCreated, onAppend, onClose]);

  // ── Render ───────────────────────────────────────────────────────────
  const title = mode === 'append' ? 'dialog.scan.titleAppend' : 'dialog.scan.title';
  return (
    <Shell onClose={guardedClose} titleKey={title}>
      <div className="flex flex-col gap-4 px-5 py-4">
        {phase === 'looking' && (
          <p className="text-xs text-neutral-400" data-testid="scan-looking">
            {tChrome('dialog.scan.looking')}
          </p>
        )}

        {phase === 'empty' && (
          <div className="flex flex-col gap-2" data-testid="scan-empty">
            <p className="text-sm text-neutral-200">{tChrome('dialog.scan.noneTitle')}</p>
            <p className="text-xs text-neutral-400">{tChrome('dialog.scan.noneHint')}</p>
          </div>
        )}

        {phase !== 'empty' && phase !== 'looking' && (
          <>
            <div>
              <label className="block text-xs text-neutral-400 mb-1" htmlFor="scan-device">
                {tChrome('dialog.scan.scanner')}
              </label>
              <select
                id="scan-device"
                data-testid="scan-device"
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                value={deviceId ?? ''}
                disabled={busy}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            {!capabilities && !error && (
              <p className="text-xs text-neutral-400" data-testid="scan-reading">
                {tChrome('dialog.scan.reading')}
              </p>
            )}

            {capabilities && report && (
              <>
                {options.length > 1 && (
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1" htmlFor="scan-source">
                      {tChrome('dialog.scan.source')}
                    </label>
                    <select
                      id="scan-source"
                      data-testid="scan-source"
                      className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                      value={option?.id ?? ''}
                      disabled={busy}
                      onChange={(e) => setOptionId(e.target.value as ScanSourceOption['id'])}
                    >
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {tChrome(SOURCE_LABEL_KEYS[o.id])}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {report.color_modes.length > 0 && (
                  <fieldset data-testid="scan-color">
                    <legend className="block text-xs text-neutral-400 mb-1">
                      {tChrome('dialog.scan.color')}
                    </legend>
                    <div className="flex flex-wrap gap-3">
                      {report.color_modes.map((m) => (
                        <label key={m} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="radio"
                            name="scan-color"
                            data-testid={`scan-color-${m}`}
                            checked={colorMode === m}
                            disabled={busy}
                            onChange={() => setColorMode(m)}
                          />
                          {tChrome(COLOR_LABEL_KEYS[m])}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                <div className="grid grid-cols-2 gap-2">
                  {dpiControl.kind !== 'absent' && (
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1" htmlFor="scan-dpi">
                        {tChrome('dialog.scan.resolution')}
                      </label>
                      {dpiControl.kind === 'choice' ? (
                        <select
                          id="scan-dpi"
                          data-testid="scan-dpi"
                          className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                          value={dpi ?? ''}
                          disabled={busy}
                          onChange={(e) => setDpi(Number(e.target.value))}
                        >
                          {dpiControl.values.map((v) => (
                            <option key={v} value={v}>
                              {tChrome(
                                isInterpolated(v, report.optical_resolution)
                                  ? 'dialog.scan.dpiInterpolated'
                                  : 'dialog.scan.dpi',
                                { dpi: v },
                              )}
                            </option>
                          ))}
                        </select>
                      ) : dpiControl.kind === 'number' ? (
                        <input
                          id="scan-dpi"
                          data-testid="scan-dpi"
                          type="number"
                          min={dpiControl.min}
                          max={dpiControl.max}
                          step={dpiControl.step}
                          className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                          value={dpi ?? dpiControl.min}
                          disabled={busy}
                          onChange={(e) => setDpi(Number(e.target.value))}
                        />
                      ) : (
                        <p className="text-xs text-neutral-300 py-1.5" data-testid="scan-dpi-fixed">
                          {tChrome('dialog.scan.dpi', { dpi: dpiControl.value })}
                        </p>
                      )}
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1" htmlFor="scan-paper">
                      {tChrome('dialog.scan.paper')}
                    </label>
                    <select
                      id="scan-paper"
                      data-testid="scan-paper"
                      className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                      value={paper}
                      disabled={busy}
                      onChange={(e) => setPaper(e.target.value as PaperSize)}
                    >
                      {PAPER_SIZES.map((p) => (
                        <option key={p} value={p}>
                          {tChrome(PAPER_LABEL_KEYS[p])}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {report.optical_resolution !== null &&
                  isInterpolated(dpi, report.optical_resolution) && (
                    <p className="text-xs text-amber-400" data-testid="scan-optical-note">
                      {tChrome('dialog.scan.opticalNote', { dpi: report.optical_resolution })}
                    </p>
                  )}

                {option?.feeds && (
                  <fieldset data-testid="scan-pages">
                    <legend className="block text-xs text-neutral-400 mb-1">
                      {tChrome('dialog.scan.pages')}
                    </legend>
                    <div className="flex flex-wrap items-center gap-3">
                      {canAskForAllPages && (
                        <label className="flex items-center gap-1.5 text-xs">
                          <input
                            type="radio"
                            name="scan-pages"
                            data-testid="scan-pages-all"
                            checked={allPages}
                            disabled={busy}
                            onChange={() => setAllPages(true)}
                          />
                          {tChrome('dialog.scan.pagesAll')}
                        </label>
                      )}
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="radio"
                          name="scan-pages"
                          data-testid="scan-pages-limit"
                          checked={!allPages}
                          disabled={busy}
                          onChange={() => setAllPages(false)}
                        />
                        {tChrome('dialog.scan.pagesCount')}
                      </label>
                      <input
                        type="number"
                        data-testid="scan-page-count"
                        min={1}
                        {...(pageLimit && pageLimit > 0 ? { max: pageLimit } : {})}
                        className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
                        value={pageCount}
                        disabled={busy || allPages}
                        onChange={(e) => setPageCount(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </div>
                  </fieldset>
                )}

                {(brightnessControl.kind === 'number' || contrastControl.kind === 'number') && (
                  <div>
                    <button
                      type="button"
                      data-testid="scan-advanced-toggle"
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                      aria-expanded={showAdvanced}
                      onClick={() => setShowAdvanced((v) => !v)}
                    >
                      {tChrome('dialog.scan.advanced')}
                    </button>
                    {showAdvanced && (
                      <div className="flex flex-col gap-2 mt-2" data-testid="scan-advanced">
                        {brightnessControl.kind === 'number' && (
                          <label className="flex items-center gap-2 text-xs">
                            <span className="w-20 text-neutral-400">
                              {tChrome('dialog.scan.brightness')}
                            </span>
                            <input
                              type="range"
                              data-testid="scan-brightness"
                              min={brightnessControl.min}
                              max={brightnessControl.max}
                              step={brightnessControl.step}
                              value={brightness ?? 0}
                              disabled={busy}
                              onChange={(e) => setBrightness(Number(e.target.value))}
                            />
                            <span className="tabular-nums text-neutral-300">{brightness}</span>
                          </label>
                        )}
                        {contrastControl.kind === 'number' && (
                          <label className="flex items-center gap-2 text-xs">
                            <span className="w-20 text-neutral-400">
                              {tChrome('dialog.scan.contrast')}
                            </span>
                            <input
                              type="range"
                              data-testid="scan-contrast"
                              min={contrastControl.min}
                              max={contrastControl.max}
                              step={contrastControl.step}
                              value={contrast ?? 0}
                              disabled={busy}
                              onChange={(e) => setContrast(Number(e.target.value))}
                            />
                            <span className="tabular-nums text-neutral-300">{contrast}</span>
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      data-testid="scan-enhance"
                      checked={enhance}
                      disabled={busy}
                      onChange={(e) => setEnhance(e.target.checked)}
                    />
                    {tChrome('dialog.scan.enhance')}
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      data-testid="scan-ocr"
                      checked={ocr}
                      disabled={busy}
                      onChange={(e) => setOcr(e.target.checked)}
                    />
                    {tChrome('dialog.scan.ocr')}
                  </label>
                  {ocr && (
                    <select
                      data-testid="scan-ocr-language"
                      className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                      value={lang}
                      disabled={busy}
                      onChange={(e) => setLang(e.target.value)}
                    >
                      {OCR_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {tOcrLanguage(l.code)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {progress && (
          <p className="text-xs text-neutral-300" data-testid="scan-progress" aria-live="polite">
            {progress.message}
          </p>
        )}

        {sizeWarning !== null && (
          <p className="text-xs text-amber-400" data-testid="scan-size-warning">
            {tChrome('dialog.scan.sizeWarning', { size: formatBytes(sizeWarning) })}
          </p>
        )}

        {adjusted.length > 0 && (
          <div className="text-xs text-amber-400" data-testid="scan-adjusted">
            <p>{tChrome('dialog.scan.adjustedTitle')}</p>
            {adjusted.map((a) => (
              <p key={`${a.property}-${a.requested}`}>
                {a.actual === null
                  ? tChrome('dialog.scan.adjustedRefused', {
                      property: a.property,
                      requested: a.requested,
                    })
                  : tChrome('dialog.scan.adjustedRow', {
                      property: a.property,
                      requested: a.requested,
                      actual: a.actual,
                    })}
              </p>
            ))}
          </div>
        )}

        {cancelled && (
          <p className="text-xs text-neutral-300" data-testid="scan-cancelled">
            {tChrome('dialog.scan.cancelledNote')}
          </p>
        )}

        {error && (
          <p className="text-sm text-red-400" data-testid="scan-error" aria-live="polite">
            {error}
          </p>
        )}

        {pages.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="scan-review">
            <p className="text-xs text-neutral-300" data-testid="scan-page-count-label">
              {tChrome('dialog.scan.acquired', { pages: pages.length })}
            </p>
            <ul
              className="flex flex-wrap gap-2 max-h-56 overflow-y-auto"
              data-testid="scan-page-list"
              aria-label={tChrome('dialog.scan.title')}
            >
              {pages.map((page, index) => (
                <li
                  key={page.id}
                  data-testid="scan-page"
                  data-page-id={page.id}
                  className="relative w-24 border border-neutral-800 rounded p-1 flex flex-col items-center gap-1"
                >
                  <PagePreview path={page.path} />
                  <span className="text-[10px] text-neutral-400">
                    {tChrome('dialog.scan.pageLabel', { index: index + 1 })}
                  </span>
                  <button
                    type="button"
                    data-testid="scan-page-remove"
                    aria-label={tChrome('dialog.scan.removePage')}
                    className="absolute top-0 end-0 px-1 text-neutral-400 hover:text-red-400"
                    disabled={busy}
                    onClick={() => setPages((prev) => removePage(prev, page.id))}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1 flex-wrap">
          {phase === 'empty' && (
            <button
              type="button"
              data-testid="scan-refresh"
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
              onClick={() => void refresh()}
            >
              {tChrome('dialog.scan.refresh')}
            </button>
          )}
          <button
            type="button"
            data-testid="scan-choose-device"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            disabled={busy}
            onClick={() => void chooseDifferent()}
          >
            {tChrome('dialog.scan.chooseDifferent')}
          </button>
          {phase === 'scanning' ? (
            <button
              type="button"
              data-testid="scan-stop"
              className="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded font-medium"
              disabled={stopping}
              onClick={stop}
            >
              {tChrome(stopping ? 'dialog.scan.stopping' : 'dialog.scan.stop')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="scan-start"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              disabled={busy || !capabilities}
              onClick={() => void runScan()}
            >
              {tChrome(pages.length > 0 ? 'dialog.scan.scanMore' : 'dialog.scan.scan')}
            </button>
          )}
          {pages.length > 0 && mode === 'append' && onAppend && (
            <button
              type="button"
              data-testid="scan-append"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              disabled={busy}
              onClick={() => void appendToDocument()}
            >
              {tChrome('dialog.scan.appendToDocument')}
            </button>
          )}
          {pages.length > 0 && (
            <button
              type="button"
              data-testid="scan-save"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              disabled={busy}
              onClick={() => void saveAsPdf()}
            >
              {tChrome('dialog.scan.saveAsPdf')}
            </button>
          )}
          <button
            type="button"
            data-testid="scan-close"
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            onClick={onClose}
            disabled={busy}
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
      </div>
    </Shell>
  );
}

const SOURCE_LABEL_KEYS: Record<ScanSourceOption['id'], UiKey> = {
  flatbed: 'dialog.scan.sourceFlatbed',
  feeder: 'dialog.scan.sourceFeeder',
  duplex: 'dialog.scan.sourceDuplex',
};

const COLOR_LABEL_KEYS: Record<ColorMode, UiKey> = {
  black_and_white: 'dialog.scan.colorBlackAndWhite',
  grayscale: 'dialog.scan.colorGrayscale',
  color: 'dialog.scan.colorColor',
  auto: 'dialog.scan.colorAuto',
};

const PAPER_LABEL_KEYS: Record<PaperSize, UiKey> = {
  auto: 'dialog.scan.paperAuto',
  letter: 'dialog.scan.paperLetter',
  legal: 'dialog.scan.paperLegal',
  tabloid: 'dialog.scan.paperTabloid',
  a3: 'dialog.scan.paperA3',
  a4: 'dialog.scan.paperA4',
  a5: 'dialog.scan.paperA5',
};

/** A refusal's own catalog sentence where the catalog names its key, and its
 * English otherwise. A bare `String(e)` on a structured refusal yields
 * "[object Object]". */
function refusalMessage(value: unknown): string {
  const key = refusalKey(value);
  return key ? tChrome(key as UiKey) : refusalText(value);
}

/**
 * One staged page's preview.
 *
 * Read into the webview as a blob, which is why it is size-capped: a preview
 * is worth a few megabytes and is not worth the 400 MB an uncompressed
 * 600-dpi colour A3 page weighs. Over the cap the card says so rather than
 * hanging.
 */
function PagePreview({ path }: { path: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const bytes = await batch.readFileBuffer(path);
        if (!live) return;
        if (bytes.byteLength > MAX_PREVIEW_BYTES) {
          setTooLarge(true);
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
        setUrl(objectUrl);
      } catch {
        if (live) setTooLarge(true);
      }
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  if (tooLarge) {
    return (
      <span className="text-[10px] text-neutral-500 text-center" data-testid="scan-page-nopreview">
        {tChrome('dialog.scan.noPreview')}
      </span>
    );
  }
  return url ? (
    <img src={url} alt="" data-testid="scan-page-preview" className="max-h-20 object-contain" />
  ) : (
    <span className="h-20" />
  );
}

function Shell({
  children,
  onClose,
  titleKey,
}: {
  children: React.ReactNode;
  onClose: () => void;
  titleKey: string;
}): React.JSX.Element {
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
        aria-label={tChrome(titleKey as UiKey)}
        data-testid="scan-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[560px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome(titleKey as UiKey)}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}
