import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../hooks/useEngine';
import { FolderRow, RunningView, SweepShell } from './FolderSweepUi';
import { useSweepLog } from '../hooks/useSweepLog';
import { dialog, app, batch } from '../lib/tauri-bridge';
import { destConflictsWithSource } from '../lib/batch-ocr';
import { gsBlocked, gsPathIfAvailable } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from './GsRequiredNotice';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import { TEST_HARNESS_ENABLED, registerFolderCreatePdf } from '../testHarness';
import { PAGE_SIZES, ORIENTATIONS, QUALITY_PRESETS } from '../lib/create-pdf';
import {
  folderLabel,
  runFolderCreatePdf,
  summarize,
  type FolderCreatePdfReport,
  type FolderListing,
  type FolderProgress,
} from '../lib/folder-create-pdf';
import { createFolderCreatePdfIo, listSourceFolders } from '../lib/folder-create-pdf-io';
import { claimOutputRoot } from '../lib/output-root-claim';
import {
  folderCreatePdfLogFileName,
  formatFolderCreatePdfLog,
} from '../lib/folder-create-pdf-log';

// Tools ▸ One PDF per Folder…: the folder scope of Create PDF.
//
// Create PDF assembles ONE document from an ordered list; the batch arm makes
// one document per source FILE. Neither is what a flatbed produces — a folder
// per document, a file per page — so this walks a tree and assembles each
// directory's files, in page-number order, into one PDF at that folder's own
// place in a mirrored destination.
//
// It lives in the folder-sweep family rather than as a mode of the Create PDF
// dialog because the two have incompatible output models: that dialog builds
// ONE file from a list the user orders by hand, and this produces many from a
// walk. What they share — the door, the accepted set, the page-size handling —
// is shared as code, not as a dialog.
//
// Needs NO open document, and never opens one: sources are read by path, so no
// workspace entry exists for any of them. The engine is reached through
// `callRaw` for the reason batch OCR does.

type Phase = 'setup' | 'running' | 'done';

// The page-size, orientation and quality vocabularies are Create PDF's own —
// same door, same choices, so the same catalog keys rather than a second set
// that could be worded differently.
const PAGE_SIZE_KEY = {
  auto: 'dialog.createPdf.pageSize.auto',
  first: 'dialog.createPdf.pageSize.first',
  letter: 'dialog.createPdf.pageSize.letter',
  legal: 'dialog.createPdf.pageSize.legal',
  tabloid: 'dialog.createPdf.pageSize.tabloid',
  a3: 'dialog.createPdf.pageSize.a3',
  a4: 'dialog.createPdf.pageSize.a4',
  a5: 'dialog.createPdf.pageSize.a5',
} as const;

const ORIENTATION_KEY = {
  auto: 'dialog.createPdf.orientation.auto',
  portrait: 'dialog.createPdf.orientation.portrait',
  landscape: 'dialog.createPdf.orientation.landscape',
} as const;

const QUALITY_KEY = {
  screen: 'dialog.createPdf.preset.screen',
  ebook: 'dialog.createPdf.preset.ebook',
  printer: 'dialog.createPdf.preset.printer',
  prepress: 'dialog.createPdf.preset.prepress',
  default: 'dialog.createPdf.preset.default',
} as const;

export interface FolderCreatePdfDialogProps {
  onClose: () => void;
}

export function FolderCreatePdfDialog({
  onClose,
}: FolderCreatePdfDialogProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { callRaw } = useEngine();

  const [phase, setPhase] = useState<Phase>('setup');
  const [source, setSource] = useState<string | null>(null);
  const [dest, setDest] = useState<string | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sources, setSources] = useState('images');
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [pageSize, setPageSize] = useState('auto');
  const [orientation, setOrientation] = useState('auto');
  const [marginPt, setMarginPt] = useState(0);
  const [imageDpi, setImageDpi] = useState(200);
  const [distillPreset, setDistillPreset] = useState('printer');
  const gs = useGsCapability();

  const [report, setReport] = useState<FolderCreatePdfReport | null>(null);
  const [progress, setProgress] = useState<FolderProgress | null>(null);
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

  // Monotonic token: re-picking the source (or changing what a folder
  // contributes) starts a second enumeration, and a slow first response
  // landing last would otherwise show one folder's groups under another
  // folder's name.
  const scanTokenRef = useRef(0);
  const enumerate = useCallback(
    async (path: string, set: string, subfolders: boolean): Promise<void> => {
      const token = ++scanTokenRef.current;
      setError(null);
      setSource(path);
      setListing(null);
      setScanning(true);
      try {
        const found = await listSourceFolders(callRaw, path, {
          sources: set,
          includeSubfolders: subfolders,
        });
        if (scanTokenRef.current !== token) return;
        setListing(found);
      } catch (e: unknown) {
        if (scanTokenRef.current !== token) return;
        setSource(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (scanTokenRef.current === token) setScanning(false);
      }
    },
    [callRaw],
  );

  const selectSource = useCallback(
    (path: string) => enumerate(path, sources, includeSubfolders),
    [enumerate, sources, includeSubfolders],
  );

  // Two-layer conflict guard, the batch one: the string check catches the
  // everyday case synchronously; the identity check catches aliased spellings
  // of one physical folder that no string comparison sees. Its own copy rather
  // than `useSweepFolders`' because this dialog's enumeration is the engine's
  // folder walk, not the Rust PDF walk that hook performs.
  const [identityConflict, setIdentityConflict] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (source === null || dest === null || destConflictsWithSource(source, dest)) {
      setIdentityConflict(false);
      return;
    }
    void batch
      .pathsSameFile(source, dest)
      .then((same) => {
        if (!cancelled) setIdentityConflict(same);
      })
      .catch(() => {
        if (!cancelled) setIdentityConflict(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, dest]);

  const conflict =
    (source !== null && dest !== null && destConflictsWithSource(source, dest)) ||
    identityConflict;

  const groups = listing?.groups ?? null;
  const totalFiles = useMemo(
    () => (groups ?? []).reduce((sum, g) => sum + g.count, 0),
    [groups],
  );

  // One readable line for the log: what the run was configured to do, so a
  // reader can tell two runs over the same folder apart.
  const optionLabel = useMemo(() => {
    const parts = [sources === 'images' ? 'pictures only' : 'every accepted kind'];
    if (!includeSubfolders) parts.push('top level only');
    if (pageSize !== 'auto') parts.push(`page size ${pageSize}`);
    if (orientation !== 'auto') parts.push(orientation);
    if (marginPt > 0) parts.push(`margin ${marginPt}pt`);
    parts.push(`${imageDpi} dpi`);
    return parts.join(' · ');
  }, [sources, includeSubfolders, pageSize, orientation, marginPt, imageDpi]);

  const ready =
    phase === 'setup' &&
    !scanning &&
    source !== null &&
    dest !== null &&
    !conflict &&
    groups !== null &&
    groups.length > 0;

  const run = useCallback(async (): Promise<void> => {
    if (!listing || listing.groups.length === 0 || source === null || dest === null) return;
    // Two windows sweeping into one output tree overwrite each other file by
    // file, and neither the commit gate nor the per-file lock spans windows.
    const root = await claimOutputRoot(dest);
    if (!root.granted) {
      setError(root.message);
      return;
    }
    setPhase('running');
    setError(null);
    setProgress(null);
    setStopping(false);
    resetLog();
    cancelledRef.current = false;
    const startedAt = new Date();
    let rep: FolderCreatePdfReport | null = null;
    let fatal: string | undefined;
    try {
      const io = createFolderCreatePdfIo(
        callRaw,
        // Images and Office documents build with no interpreter; a
        // PostScript source in the walk is refused BY NAME, per document, by
        // the engine that reaches it.
        { ghostscript: await gsPathIfAvailable(), soffice: await app.getSofficePath() },
        { pageSize, orientation, marginPt, imageDpi, distillPreset },
      );
      rep = await runFolderCreatePdf(listing, io, {
        destRoot: dest,
        onProgress: setProgress,
        isCancelled: () => cancelledRef.current,
      });
      setReport(rep);
    } catch (e: unknown) {
      // The driver isolates per-folder failures, so reaching here is
      // structural (the engine died). The log is written anyway: a run that
      // failed part way through is exactly the one whose partial record is
      // needed.
      fatal = e instanceof Error ? e.message : String(e);
      setError(fatal);
    }
    await writeSweepLog(
      folderCreatePdfLogFileName(startedAt),
      formatFolderCreatePdfLog({
        startedAt,
        finishedAt: new Date(),
        sourceRoot: source,
        destRoot: dest,
        optionLabel,
        report: rep ?? { cancelled: false, results: [], skippedDirs: listing.skippedDirs },
        ...(fatal ? { fatalError: fatal } : {}),
      }),
    );
    setPhase(fatal ? 'setup' : 'done');
    await root.release();
  }, [
    listing, source, dest, pageSize, orientation, marginPt, imageDpi, distillPreset,
    optionLabel, callRaw, resetLog, writeSweepLog,
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
  const harnessDeps = { selectSource, setDest, run };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  const stateRef = useRef({ listing, report, logPath });
  stateRef.current = { listing, report, logPath };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerFolderCreatePdf({
      setSource: (path) => harnessRef.current.selectSource(path),
      setDest: (path) => harnessRef.current.setDest(path),
      run: () => harnessRef.current.run(),
      snapshot: () => ({
        phase: phaseRef.current,
        folderCount: stateRef.current.listing?.groups.length ?? null,
        report: stateRef.current.report,
        logPath: stateRef.current.logPath,
      }),
    });
    return () => registerFolderCreatePdf(null);
  }, []);

  // While a sweep runs the first close means "stop"; once a stop is pending a
  // second close abandons the run, which is the escape hatch for an engine
  // call that never returns.
  const guardedClose = phase === 'running' ? (stopping ? onClose : stop) : onClose;

  const totals = report ? summarize(report) : null;

  return (
    <SweepShell
      title={tChrome('dialog.folderCreatePdf.title')}
      testid="folder-create-pdf-dialog"
      closeTestid="folder-create-pdf-x"
      onClose={guardedClose}
    >
      {phase === 'setup' && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-neutral-500">{tChrome('dialog.folderCreatePdf.blurb')}</p>

          <FolderRow
            label={tChrome('dialog.batch.sourceLabel')}
            testid="folder-create-pdf-source"
            value={source}
            buttonRef={sourceBtnRef}
            onPick={() => {
              void (async () => {
                const path = await dialog.pickFolder(
                  tChrome('dialog.folderCreatePdf.pickSource'),
                );
                if (path) await selectSource(path);
              })();
            }}
            note={
              scanning
                ? tChrome('dialog.batch.scanning')
                : groups !== null
                  ? tChrome('dialog.folderCreatePdf.found', {
                      folders: tNumber(groups.length),
                      files: tChromeCount('dialog.exportImages.fileCount', totalFiles),
                    })
                  : null
            }
          />

          <FolderRow
            label={tChrome('dialog.batch.destLabel')}
            testid="folder-create-pdf-dest"
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
            <p className="text-sm text-red-400" data-testid="folder-create-pdf-conflict">
              {tChrome(
                identityConflict
                  ? 'dialog.batch.conflictIdentity'
                  : 'dialog.batch.conflictInside',
              )}
            </p>
          )}

          <div>
            <label
              className="block text-sm text-neutral-400 mb-1"
              htmlFor="folder-create-pdf-sources"
            >
              {tChrome('dialog.folderCreatePdf.sources')}
            </label>
            <select
              id="folder-create-pdf-sources"
              data-testid="folder-create-pdf-sources"
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={sources}
              onChange={(e) => {
                const next = e.target.value;
                setSources(next);
                // The choice changes what the walk FINDS, so the listing on
                // screen has to be the one the run will use.
                if (source !== null) void enumerate(source, next, includeSubfolders);
              }}
            >
              <option value="images">{tChrome('dialog.folderCreatePdf.sourcesImages')}</option>
              <option value="all">{tChrome('dialog.folderCreatePdf.sourcesAll')}</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid="folder-create-pdf-subfolders"
              checked={includeSubfolders}
              onChange={(e) => {
                const next = e.target.checked;
                setIncludeSubfolders(next);
                if (source !== null) void enumerate(source, sources, next);
              }}
            />
            {tChrome('dialog.folderCreatePdf.subfolders')}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="folder-create-pdf-page-size"
              >
                {tChrome('dialog.createPdf.pageSize')}
              </label>
              <select
                id="folder-create-pdf-page-size"
                data-testid="folder-create-pdf-page-size"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={pageSize}
                onChange={(e) => setPageSize(e.target.value)}
              >
                {PAGE_SIZES.map((key) => (
                  <option key={key} value={key}>
                    {tChrome(PAGE_SIZE_KEY[key])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="folder-create-pdf-orientation"
              >
                {tChrome('dialog.createPdf.orientation')}
              </label>
              <select
                id="folder-create-pdf-orientation"
                data-testid="folder-create-pdf-orientation"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={orientation}
                onChange={(e) => setOrientation(e.target.value)}
              >
                {ORIENTATIONS.map((key) => (
                  <option key={key} value={key}>
                    {tChrome(ORIENTATION_KEY[key])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="folder-create-pdf-margin"
              >
                {tChrome('dialog.createPdf.margin')}
              </label>
              <input
                id="folder-create-pdf-margin"
                data-testid="folder-create-pdf-margin"
                type="number"
                min={0}
                max={288}
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={marginPt}
                onChange={(e) => setMarginPt(Number(e.target.value))}
              />
            </div>
            <div>
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="folder-create-pdf-dpi"
              >
                {tChrome('dialog.folderCreatePdf.imageDpi')}
              </label>
              <input
                id="folder-create-pdf-dpi"
                data-testid="folder-create-pdf-dpi"
                type="number"
                min={1}
                max={2400}
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={imageDpi}
                onChange={(e) => setImageDpi(Number(e.target.value))}
              />
            </div>
          </div>

          {/* The quality preset is a `distill` parameter and means nothing for
              a picture — offered only when the walk can pick up PostScript at
              all, which is the `all` source set. */}
          {sources === 'all' && gsBlocked(gs) && (
            <GsRequiredNotice capability={gs} testId="folder-create-pdf-gs" />
          )}
          {sources === 'all' && !gsBlocked(gs) && (
            <div>
              <label
                className="block text-sm text-neutral-400 mb-1"
                htmlFor="folder-create-pdf-quality"
              >
                {tChrome('dialog.createPdf.quality')}
              </label>
              <select
                id="folder-create-pdf-quality"
                data-testid="folder-create-pdf-quality"
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={distillPreset}
                onChange={(e) => setDistillPreset(e.target.value)}
              >
                {QUALITY_PRESETS.map((key) => (
                  <option key={key} value={key}>
                    {tChrome(QUALITY_KEY[key])}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* The listing IS the run: the folders in the order they will be
              built, each with what it holds. A preview drawn from a second
              walk could disagree with the one that runs. */}
          {groups !== null && groups.length > 0 && (
            <div
              className="max-h-40 overflow-auto text-xs text-neutral-400 flex flex-col gap-0.5 border border-neutral-800 rounded p-2"
              data-testid="folder-create-pdf-preview"
            >
              {groups.map((g) => (
                <div key={g.output} className="truncate">
                  {tChrome('dialog.folderCreatePdf.previewRow', {
                    folder: folderLabel(g),
                    output: g.output,
                    files: tChromeCount('dialog.exportImages.fileCount', g.count),
                  })}
                </div>
              ))}
            </div>
          )}
          {groups !== null && groups.length === 0 && (
            <p className="text-sm text-neutral-400" data-testid="folder-create-pdf-empty">
              {tChrome('dialog.folderCreatePdf.empty')}
            </p>
          )}
          {listing !== null && listing.skippedDirs.length > 0 && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.batch.unreadableDirs', { dirs: listing.skippedDirs.join('; ') })}
            </p>
          )}

          {error && <p className="text-sm text-red-400" data-testid="folder-create-pdf-error">{error}</p>}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void run()}
              data-testid="folder-create-pdf-run"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
            >
              {tChrome('dialog.folderCreatePdf.run')}
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <RunningView
          label={
            progress
              ? tChrome('dialog.folderCreatePdf.progress', {
                  index: progress.folderIndex + 1,
                  count: progress.folderCount,
                  output: progress.output,
                })
              : tChrome('dialog.batch.progressStarting')
          }
          fileIndex={progress?.folderIndex ?? null}
          fileCount={progress?.folderCount ?? 0}
          stopping={stopping}
          onStop={stop}
          buttonRef={stopBtnRef}
          testid="folder-create-pdf-running"
          stopTestid="folder-create-pdf-stop"
        />
      )}

      {phase === 'done' && report && totals && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-200" data-testid="folder-create-pdf-summary">
            {report.cancelled
              ? tChrome('dialog.folderCreatePdf.stoppedPrefix', { summary: summaryText(totals) })
              : summaryText(totals)}
          </p>
          {report.cancelled && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.folderCreatePdf.cancelledNote')}
            </p>
          )}

          <div className="max-h-[45vh] overflow-auto text-xs text-neutral-400 flex flex-col gap-0.5">
            {/* Failures first: a run's one folder that produced nothing is the
                row a reader is looking for, and it is never silence. */}
            {report.results
              .filter((r) => r.status === 'failed')
              .map((r) => (
                <div key={r.output} className="text-amber-400 truncate">
                  {tChrome('dialog.folderCreatePdf.rowFailed', {
                    folder: folderLabel(r),
                    reason: r.reason ?? '',
                  })}
                </div>
              ))}
            {report.results
              .filter((r) => r.status === 'built')
              .map((r) => (
                <div key={r.output}>
                  <div className="truncate">
                    {tChrome('dialog.folderCreatePdf.rowBuilt', {
                      output: r.output,
                      files: tChromeCount('dialog.exportImages.fileCount', r.files),
                      pages: tChromeCount('panel.common.pageCount', r.pages ?? 0),
                    })}
                  </div>
                  {/* A member the builder could not read. The document was
                      still written, so this is the only place it is said. */}
                  {(r.warnings ?? []).map((w) => (
                    <div key={w} className="ps-4 text-amber-400 truncate">
                      {w}
                    </div>
                  ))}
                </div>
              ))}
          </div>

          {report.skippedDirs.length > 0 && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.batch.unreadableDirs', { dirs: report.skippedDirs.join('; ') })}
            </p>
          )}
          {logPath && (
            <p className="text-xs text-neutral-500" data-testid="folder-create-pdf-log-path">
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
              {tChrome('dialog.folderCreatePdf.again')}
            </button>
            <button
              type="button"
              ref={doneCloseBtnRef}
              onClick={onClose}
              data-testid="folder-create-pdf-close"
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
    tChrome('dialog.folderCreatePdf.sumBuilt', { count: tNumber(totals.built) }),
    tChrome('dialog.folderCreatePdf.sumFailed', { count: tNumber(totals.failed) }),
    tChrome('dialog.folderCreatePdf.sumPages', {
      pages: tChromeCount('panel.common.pageCount', totals.pages),
    }),
  ].join(' · ');
}
