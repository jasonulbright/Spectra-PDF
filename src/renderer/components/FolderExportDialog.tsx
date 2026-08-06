import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../hooks/useEngine';
import { FolderRow, RunningView, SweepShell } from './FolderSweepUi';
import { useSweepFolders } from '../hooks/useSweepFolders';
import { useSweepLog } from '../hooks/useSweepLog';
import { dialog, app } from '../lib/tauri-bridge';
import { ensureGsPath } from '../panels/SettingsPanel';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import { TEST_HARNESS_ENABLED, registerFolderExport } from '../testHarness';
import {
  DEFAULT_IMAGE_DPI,
  DEFAULT_JPEG_QUALITY,
  EXPORT_FORMATS,
  EXPORT_TARGETS,
  type ExportFormat,
  type ExportOptionValues,
} from '../lib/export-targets';
import {
  runFolderExport,
  summarize,
  type ExportProgress,
  type FolderExportReport,
} from '../lib/folder-export';
import { createFolderExportIo } from '../lib/folder-export-io';
import { folderExportLogFileName, formatFolderExportLog } from '../lib/folder-export-log';

// Tools ▸ Export a Folder…: the folder scope of File ▸ Export.
//
// Needs NO open document, and never opens one: sources are read by path, so no
// workspace entry exists for any of them. The engine is reached through
// `callRaw` for the reason batch OCR does — the commit gate exists to make the
// engine read bytes matching a document on screen, and there is none here.
//
// There is no review phase and no in-place mode, and neither is an omission.
// The sibling sweeps review candidate rows a person must accept before anything
// is written; an export produces nothing to accept. And an in-place export would
// replace a PDF with a document of another kind under a name that still claims
// `.pdf` — a destroyed source, not an edit.

const DPIS = [72, 96, 150, 300, 600];

type Phase = 'setup' | 'running' | 'done';

const FORMAT_KEY = {
  docx: 'dialog.folderExport.fmt.docx',
  rtf: 'dialog.folderExport.fmt.rtf',
  odt: 'dialog.folderExport.fmt.odt',
  html: 'dialog.folderExport.fmt.html',
  xhtml: 'dialog.folderExport.fmt.xhtml',
  txt: 'dialog.folderExport.fmt.txt',
  xlsx: 'dialog.folderExport.fmt.xlsx',
  pptx: 'dialog.folderExport.fmt.pptx',
  png: 'dialog.folderExport.fmt.png',
  jpeg: 'dialog.folderExport.fmt.jpeg',
  tiff: 'dialog.folderExport.fmt.tiff',
} as const satisfies Record<ExportFormat, string>;

const LAYOUTS = [
  { value: 'reading', key: 'dialog.exportDoc.layout.reading' },
  { value: 'layout', key: 'dialog.exportDoc.layout.layout' },
] as const;

const SHEET_PER = [
  { value: 'table', key: 'dialog.exportDoc.sheetPer.table' },
  { value: 'page', key: 'dialog.exportDoc.sheetPer.page' },
] as const;

const SLIDE_SIZES = [
  { value: 'page', key: 'dialog.exportDoc.slideSize.page' },
  { value: '16:9', key: 'dialog.exportDoc.slideSize.wide' },
  { value: '4:3', key: 'dialog.exportDoc.slideSize.standard' },
] as const;

export interface FolderExportDialogProps {
  onClose: () => void;
}

export function FolderExportDialog({ onClose }: FolderExportDialogProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { callRaw } = useEngine();

  const [phase, setPhase] = useState<Phase>('setup');
  const {
    source,
    dest,
    setDest,
    selectSource,
    entries,
    skippedDirs,
    scanning,
    conflict,
    identityConflict,
    error,
    setError,
  } = useSweepFolders();

  const [format, setFormat] = useState<ExportFormat>('docx');
  const [pages, setPages] = useState('');
  const [layout, setLayout] = useState('reading');
  const [pageBreaks, setPageBreaks] = useState(false);
  const [sheetPer, setSheetPer] = useState('table');
  const [includeUntabled, setIncludeUntabled] = useState(false);
  const [slideSize, setSlideSize] = useState('page');
  const [dpi, setDpi] = useState(DEFAULT_IMAGE_DPI);
  const [gray, setGray] = useState(false);
  const [quality, setQuality] = useState(DEFAULT_JPEG_QUALITY);

  const [report, setReport] = useState<FolderExportReport | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const { logPath, logError, write: writeSweepLog, reset: resetLog } = useSweepLog();

  const cancelledRef = useRef(false);
  const phaseRef = useRef<Phase>('setup');
  phaseRef.current = phase;

  // Each phase renders as its own subtree, so a transition unmounts the node
  // holding focus and the keydown trap (attached to the shell) stops seeing
  // events. Re-anchor on each phase's primary control.
  const sourceBtnRef = useRef<HTMLButtonElement>(null);
  const stopBtnRef = useRef<HTMLButtonElement>(null);
  const doneCloseBtnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (phase === 'running') stopBtnRef.current?.focus();
    else if (phase === 'done') doneCloseBtnRef.current?.focus();
    else sourceBtnRef.current?.focus();
  }, [phase]);

  const target = EXPORT_TARGETS[format];
  const isImage = target.door === 'export_images';

  const values: ExportOptionValues = useMemo(
    () => ({ pages, layout, pageBreaks, sheetPer, includeUntabled, slideSize, dpi, gray, quality }),
    [pages, layout, pageBreaks, sheetPer, includeUntabled, slideSize, dpi, gray, quality],
  );

  // One readable line for the log: what the run was configured to do, so a
  // reader can tell two runs over the same folder apart.
  const optionLabel = useMemo(() => {
    const parts: string[] = [];
    if (pages.trim()) parts.push(`pages ${pages.trim()}`);
    if (format === 'txt') {
      parts.push(layout);
      if (pageBreaks) parts.push('page breaks');
    } else if (format === 'xlsx') {
      parts.push(`sheet per ${sheetPer}`);
      if (includeUntabled) parts.push('untabled text included');
    } else if (format === 'pptx') {
      parts.push(`slide size ${slideSize}`);
    } else if (isImage) {
      parts.push(`${dpi} dpi`);
      if (gray) parts.push('grayscale');
      if (format === 'jpeg') parts.push(`quality ${quality}`);
    }
    return parts.join(' · ');
  }, [
    format, isImage, pages, layout, pageBreaks, sheetPer, includeUntabled, slideSize,
    dpi, gray, quality,
  ]);

  const ready =
    phase === 'setup' &&
    !scanning &&
    source !== null &&
    dest !== null &&
    !conflict &&
    entries !== null &&
    entries.length > 0;

  const run = useCallback(async (): Promise<void> => {
    if (!entries || entries.length === 0 || source === null || dest === null) return;
    setPhase('running');
    setError(null);
    setProgress(null);
    setStopping(false);
    resetLog();
    cancelledRef.current = false;
    const startedAt = new Date();
    let rep: FolderExportReport | null = null;
    let fatal: string | undefined;
    try {
      const io = createFolderExportIo(callRaw, {
        soffice: await app.getSofficePath(),
        ghostscript: await ensureGsPath(),
      });
      rep = await runFolderExport(entries, skippedDirs, io, {
        destRoot: dest,
        format,
        values,
        onProgress: setProgress,
        isCancelled: () => cancelledRef.current,
      });
      setReport(rep);
    } catch (e: unknown) {
      // The driver isolates per-file failures, so reaching here is structural
      // (the engine died). The log is written anyway: a run that failed part
      // way through is exactly the one whose partial record is needed.
      fatal = e instanceof Error ? e.message : String(e);
      setError(fatal);
    }
    await writeSweepLog(
      folderExportLogFileName(startedAt),
      formatFolderExportLog({
        startedAt,
        finishedAt: new Date(),
        sourceRoot: source,
        destRoot: dest,
        format,
        optionLabel,
        report: rep ?? { cancelled: false, results: [], skippedDirs },
        ...(fatal ? { fatalError: fatal } : {}),
      }),
    );
    setPhase(fatal ? 'setup' : 'done');
  }, [
    entries, source, dest, skippedDirs, format, values, optionLabel,
    callRaw, setError, resetLog, writeSweepLog,
  ]);

  const stop = useCallback((): void => {
    setStopping(true);
    cancelledRef.current = true;
  }, []);

  const runAnother = useCallback((): void => {
    setReport(null);
    setProgress(null);
    setStopping(false);
    resetLog();
    setPhase('setup');
  }, [resetLog]);

  // Test harness: the native folder pickers cannot be WebDriver-driven, so the
  // harness injects paths into the same selectSource/setDest flow the buttons
  // run, then drives the same run the button calls.
  const harnessDeps = { selectSource, setDest, setFormat, run };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  const stateRef = useRef({ entries, report, logPath });
  stateRef.current = { entries, report, logPath };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerFolderExport({
      setSource: (path) => harnessRef.current.selectSource(path),
      setDest: (path) => harnessRef.current.setDest(path),
      setFormat: (key) => harnessRef.current.setFormat(key as ExportFormat),
      run: () => harnessRef.current.run(),
      snapshot: () => ({
        phase: phaseRef.current,
        fileCount: stateRef.current.entries?.length ?? null,
        report: stateRef.current.report,
        logPath: stateRef.current.logPath,
      }),
    });
    return () => registerFolderExport(null);
  }, []);

  // While a sweep runs the first close means "stop"; once a stop is pending a
  // second close abandons the run, which is the escape hatch for an engine call
  // that never returns.
  const guardedClose = phase === 'running' ? (stopping ? onClose : stop) : onClose;

  const totals = report ? summarize(report) : null;

  return (
    <SweepShell
      title={tChrome('dialog.folderExport.title')}
      testid="folder-export-dialog"
      closeTestid="folder-export-x"
      onClose={guardedClose}
    >
      {phase === 'setup' && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-neutral-500">{tChrome('dialog.folderExport.blurb')}</p>

          <FolderRow
            label={tChrome('dialog.batch.sourceLabel')}
            testid="folder-export-source"
            value={source}
            buttonRef={sourceBtnRef}
            onPick={() => {
              void (async () => {
                const path = await dialog.pickFolder(tChrome('dialog.folderExport.pickSource'));
                if (path) await selectSource(path);
              })();
            }}
            note={
              scanning
                ? tChrome('dialog.batch.scanning')
                : entries !== null
                  ? tChromeCount('dialog.batch.found', entries.length)
                  : null
            }
          />

          <FolderRow
            label={tChrome('dialog.batch.destLabel')}
            testid="folder-export-dest"
            value={dest}
            onPick={() => {
              void (async () => {
                const path = await dialog.pickFolder(tChrome('dialog.common.pickDest'));
                if (path) setDest(path);
              })();
            }}
            note={null}
          />
          {conflict && (
            <p className="text-sm text-red-400" data-testid="folder-export-conflict">
              {tChrome(
                identityConflict
                  ? 'dialog.batch.conflictIdentity'
                  : 'dialog.batch.conflictInside',
              )}
            </p>
          )}

          <div>
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="folder-export-format">
              {tChrome('dialog.folderExport.format')}
            </label>
            <select
              id="folder-export-format"
              data-testid="folder-export-format"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {EXPORT_FORMATS.map((key) => (
                <option key={key} value={key}>
                  {tChrome(FORMAT_KEY[key])}
                </option>
              ))}
            </select>
          </div>

          {/* A target that declares no options shows none: the engine refuses
              an option it does not take, so an unasked control here would be a
              control that breaks the run it belongs to. */}
          {target.options.length > 0 && (
            <div>
              <label className="block text-sm text-neutral-400 mb-1" htmlFor="folder-export-pages">
                {tChrome(isImage ? 'dialog.exportImages.pages' : 'dialog.exportDoc.pages')}
              </label>
              <input
                id="folder-export-pages"
                data-testid="folder-export-pages"
                type="text"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                placeholder={tChrome('dialog.exportDoc.pagesPlaceholder')}
                spellCheck={false}
                value={pages}
                onChange={(e) => setPages(e.target.value)}
              />
            </div>
          )}

          {format === 'txt' && (
            <>
              <div>
                <label
                  className="block text-sm text-neutral-400 mb-1"
                  htmlFor="folder-export-layout"
                >
                  {tChrome('dialog.exportDoc.layout')}
                </label>
                <select
                  id="folder-export-layout"
                  data-testid="folder-export-layout"
                  className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  value={layout}
                  onChange={(e) => setLayout(e.target.value)}
                >
                  {LAYOUTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {tChrome(option.key)}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  data-testid="folder-export-page-breaks"
                  checked={pageBreaks}
                  onChange={(e) => setPageBreaks(e.target.checked)}
                />
                {tChrome('dialog.exportDoc.pageBreaks')}
              </label>
            </>
          )}

          {format === 'xlsx' && (
            <>
              <div>
                <label
                  className="block text-sm text-neutral-400 mb-1"
                  htmlFor="folder-export-sheet-per"
                >
                  {tChrome('dialog.exportDoc.sheetPer')}
                </label>
                <select
                  id="folder-export-sheet-per"
                  data-testid="folder-export-sheet-per"
                  className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  value={sheetPer}
                  onChange={(e) => setSheetPer(e.target.value)}
                >
                  {SHEET_PER.map((option) => (
                    <option key={option.value} value={option.value}>
                      {tChrome(option.key)}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  data-testid="folder-export-include-untabled"
                  checked={includeUntabled}
                  onChange={(e) => setIncludeUntabled(e.target.checked)}
                />
                {tChrome('dialog.exportDoc.includeUntabled')}
              </label>
            </>
          )}

          {format === 'pptx' && (
            <div>
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="folder-export-slide-size"
              >
                {tChrome('dialog.exportDoc.slideSize')}
              </label>
              <select
                id="folder-export-slide-size"
                data-testid="folder-export-slide-size"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={slideSize}
                onChange={(e) => setSlideSize(e.target.value)}
              >
                {SLIDE_SIZES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {tChrome(option.key)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {isImage && (
            <>
              <div>
                <label className="block text-sm text-neutral-400 mb-1" htmlFor="folder-export-dpi">
                  {tChrome('dialog.exportImages.resolution')}
                </label>
                <select
                  id="folder-export-dpi"
                  data-testid="folder-export-dpi"
                  className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  value={dpi}
                  onChange={(e) => setDpi(Number(e.target.value))}
                >
                  {DPIS.map((d) => (
                    <option key={d} value={d}>
                      {tChrome('dialog.exportImages.dpiOption', { dpi: tNumber(d) })}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  data-testid="folder-export-gray"
                  checked={gray}
                  onChange={(e) => setGray(e.target.checked)}
                />
                {tChrome('dialog.exportImages.grayscale')}
              </label>
              {format === 'jpeg' && (
                <div>
                  <label
                    className="block text-sm text-neutral-400 mb-1"
                    htmlFor="folder-export-quality"
                  >
                    {tChrome('dialog.folderExport.quality')}
                  </label>
                  <input
                    id="folder-export-quality"
                    data-testid="folder-export-quality"
                    type="number"
                    min={1}
                    max={100}
                    className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                  />
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void run()}
              data-testid="folder-export-run"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
            >
              {tChrome('dialog.folderExport.run')}
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <RunningView
          label={
            progress
              ? tChrome('dialog.folderExport.progress', {
                  index: progress.fileIndex + 1,
                  count: progress.fileCount,
                  rel: progress.rel,
                })
              : tChrome('dialog.batch.progressStarting')
          }
          fileIndex={progress?.fileIndex ?? null}
          fileCount={progress?.fileCount ?? 0}
          stopping={stopping}
          onStop={stop}
          buttonRef={stopBtnRef}
          testid="folder-export-running"
          stopTestid="folder-export-stop"
        />
      )}

      {phase === 'done' && report && totals && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-200" data-testid="folder-export-summary">
            {report.cancelled
              ? tChrome('dialog.folderExport.stoppedPrefix', { summary: summaryText(totals) })
              : summaryText(totals)}
          </p>
          {report.cancelled && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.folderExport.cancelledNote')}
            </p>
          )}

          <div className="max-h-[45vh] overflow-auto text-xs text-neutral-400 flex flex-col gap-0.5">
            {/* Refusals first: a folder run's one unreadable file is the row a
                reader is looking for, and it is never silence. */}
            {report.results
              .filter((r) => r.status === 'skipped')
              .map((r) => (
                <div key={r.rel} className="text-amber-400 truncate">
                  {tChrome('dialog.folderExport.fileSkipped', {
                    rel: r.rel,
                    reason: r.reason ?? '',
                  })}
                </div>
              ))}
            {report.results
              .filter((r) => r.status === 'exported')
              .map((r) => (
                <div key={r.rel} className="truncate">
                  {tChrome('dialog.folderExport.rowWritten', { rel: r.rel, out: r.out ?? '' })}
                </div>
              ))}
          </div>

          {report.skippedDirs.length > 0 && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.batch.unreadableDirs', { dirs: report.skippedDirs.join(', ') })}
            </p>
          )}
          {logPath && (
            <p className="text-xs text-neutral-500">
              {tChrome('dialog.batch.logWritten', { path: logPath })}
            </p>
          )}
          {logError && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.batch.logError', { message: logError })}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={runAnother}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
            >
              {tChrome('dialog.folderExport.again')}
            </button>
            <button
              type="button"
              ref={doneCloseBtnRef}
              onClick={onClose}
              data-testid="folder-export-close"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
            >
              {tChrome('dialog.common.close')}
            </button>
          </div>
        </div>
      )}
    </SweepShell>
  );
}

function summaryText(totals: ReturnType<typeof summarize>): string {
  return [
    tChrome('dialog.folderExport.sumExported', { count: totals.exported }),
    tChrome('dialog.folderExport.sumSkipped', { count: totals.skipped }),
  ].join(' · ');
}
