import React, { useEffect, useRef, useState } from 'react';
import { useEngine } from '../hooks/useEngine';
import { useAppModal } from '../hooks/useAppModal';
import { dialog, batch } from '../lib/tauri-bridge';
import { recognizePage } from '../lib/ocr-recognize';
import type { BatchPdfEntry } from '../lib/tauri-bridge';
import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import { toTesseractLang, describeLanguages } from '../ocr/language-selection';
import {
  runBatchOcr,
  destConflictsWithSource,
  summarize,
  type BatchProgress,
  type BatchReport,
} from '../lib/batch-ocr';
import { createBatchIo } from '../lib/batch-ocr-io';
import { formatBatchLog, batchLogFileName } from '../lib/batch-log';
import { getSettings } from '../lib/app-settings';
import { TEST_HARNESS_ENABLED, registerBatchOcr } from '../testHarness';

// Tools ▸ Batch OCR Folder… (Phase 6, docs/architecture/20-phase6-batch-ocr.md):
// mirror a folder tree into searchable PDFs. Needs NO open document — the
// command is always enabled and the dialog owns the whole flow: pick source
// (enumerated immediately, count shown), pick destination (conflict-checked),
// pick language, run with per-file progress and cancel, report at the end.
//
// The run never touches workspace state: sources are read directly, outputs
// are written to the mirror, and the engine is invoked through `callRaw`
// (no commit gate — batch reads ORIGINAL paths, not working copies; gating
// would side-effect-commit unrelated pending page edits — and no operation
// queue: the dialog's own progress is richer than a queue row).

export interface BatchOcrDialogProps {
  onClose: () => void;
}

type Phase = 'setup' | 'running' | 'done';

export function BatchOcrDialog({ onClose }: BatchOcrDialogProps): React.JSX.Element {
  const { callRaw } = useEngine();

  const [phase, setPhase] = useState<Phase>('setup');
  const [source, setSource] = useState<string | null>(null);
  const [dest, setDest] = useState<string | null>(null);
  const [entries, setEntries] = useState<BatchPdfEntry[] | null>(null);
  const [skippedDirs, setSkippedDirs] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [langs, setLangs] = useState<string[]>([DEFAULT_OCR_LANGUAGE]);
  // Issue #1 requests 2 and 3. Every one of these is OFF until the user acts:
  // they invert the standing guarantee that a batch never modifies the source
  // tree, so "off by default" is the feature, not a timidity.
  const [movedRoot, setMovedRoot] = useState<string | null>(null);
  const [errorRoot, setErrorRoot] = useState<string | null>(null);
  const [repairDamaged, setRepairDamaged] = useState(false);
  const [replaceRepaired, setReplaceRepaired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  // Stop feedback must be STATE (it drives paint); the ref twin below is what
  // the driver's isCancelled() polls — a ref mutation alone never re-renders,
  // so a ref-driven button label was a button that ignored the click
  // (review-caught).
  const [stopping, setStopping] = useState(false);

  const cancelledRef = useRef(false);
  const cancelOcrRef = useRef<(() => void) | null>(null);
  const phaseRef = useRef<Phase>('setup');
  phaseRef.current = phase;

  // The three phases render as mutually exclusive subtrees, so a transition
  // unmounts the node holding focus and Chromium drops focus to <body> —
  // OUTSIDE the shell the Tab trap listens on (useAppModal attaches to the
  // shell element; keydowns from body never reach it). Re-anchor focus on
  // each phase's primary control (review-caught; the sibling dialogs dodge
  // this structurally by toggling props on persistent nodes).
  const stopBtnRef = useRef<HTMLButtonElement>(null);
  const doneCloseBtnRef = useRef<HTMLButtonElement>(null);
  const sourceBtnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      // Initial mount: useAppModal focuses the shell itself.
      mountedRef.current = true;
      return;
    }
    if (phase === 'running') stopBtnRef.current?.focus();
    else if (phase === 'done') doneCloseBtnRef.current?.focus();
    else sourceBtnRef.current?.focus();
  }, [phase]);

  // Monotonic token: re-picking the source mid-scan starts a second
  // enumeration, and without this a SLOW first response landing last would
  // overwrite the displayed folder's listing with another folder's files —
  // and Start would then run against a list the conflict check never saw
  // (review-caught). Only the latest request may touch state.
  const scanTokenRef = useRef(0);
  const selectSource = async (path: string): Promise<void> => {
    const token = ++scanTokenRef.current;
    setError(null);
    setSource(path);
    setEntries(null);
    setSkippedDirs([]);
    setScanning(true);
    try {
      const listing = await batch.listPdfsRecursive(path);
      if (scanTokenRef.current !== token) return; // stale response — drop
      setEntries(listing.files);
      setSkippedDirs(listing.skippedDirs);
    } catch (e: unknown) {
      if (scanTokenRef.current !== token) return; // stale failure — drop
      setSource(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (scanTokenRef.current === token) setScanning(false);
    }
  };

  const pickSource = async (): Promise<void> => {
    const path = await dialog.pickFolder('Choose the folder to make searchable');
    if (path) await selectSource(path);
  };

  const pickDest = async (): Promise<void> => {
    const path = await dialog.pickFolder('Choose the destination folder');
    if (path) setDest(path);
  };

  // Two-layer conflict guard: the string check catches the everyday case
  // synchronously; the filesystem identity check (volume serial + file
  // index) catches aliased spellings of one physical folder — UNC vs mapped
  // drive letter — that no string comparison can see. Per-file refusals in
  // the Rust copy and the engine's samefile branch remain the hard floor
  // for geometries neither root check covers.
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

  // The moved/error roots get STRING-level refusals only, and that is the
  // proportionate answer rather than a shortcut: the aliased-path hazard the
  // source/destination pair needs an identity check for is a hazard because a
  // COPY overwrites. A move never does — `move_file_creating_dirs` suffixes a
  // collision and refuses a same-file move outright — so the worst an unseen
  // alias can do here is put a file somewhere surprising, not destroy one.
  // Inside the SOURCE is refused because it makes the enumerated tree
  // self-referential (the next run re-processes what this one filed away);
  // inside the DESTINATION is refused because originals would interleave with
  // the searchable copies they correspond to.
  const rootConflict = (root: string | null): string | null => {
    if (root === null) return null;
    if (source !== null && destConflictsWithSource(source, root)) {
      return 'inside the source folder — the next run would process these files again';
    }
    if (dest !== null && destConflictsWithSource(dest, root)) {
      return 'inside the destination folder — originals would be mixed in with the searchable copies';
    }
    return null;
  };
  const movedConflict = rootConflict(movedRoot);
  const errorConflict = rootConflict(errorRoot);

  const canStart =
    phase === 'setup' &&
    !scanning &&
    source !== null &&
    dest !== null &&
    !conflict &&
    movedConflict === null &&
    errorConflict === null &&
    entries !== null &&
    entries.length > 0;

  // Where this run's log landed, shown on the report. Null when logging is
  // off, or when the write itself failed — a log that could not be written is
  // said so on screen rather than silently assumed (the report is the only
  // other record, and it is about to be dismissed).
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  // Issue #1 request 4. Writing is best-effort by design: a failed log must
  // never turn a completed batch into a failed one — the files are already
  // mirrored, and the run's value does not depend on its paperwork.
  const writeLog = async (
    startedAt: Date,
    rep: BatchReport,
    src: string,
    dst: string,
    fatalError?: string,
  ): Promise<void> => {
    const settings = getSettings();
    if (!settings.batchLogEnabled) return;
    try {
      const path = await batch.writeLog(
        batchLogFileName(startedAt),
        formatBatchLog({
          startedAt,
          finishedAt: new Date(),
          sourceRoot: src,
          destRoot: dst,
          lang: toTesseractLang(langs),
          langLabel: describeLanguages(langs),
          report: rep,
          filing: {
            ...(movedRoot ? { movedRoot } : {}),
            ...(errorRoot ? { errorRoot } : {}),
            repairDamaged,
            replaceRepairedOriginals: repairDamaged && replaceRepaired,
          },
          ...(fatalError ? { fatalError } : {}),
        }),
        settings.batchLogDir,
      );
      setLogPath(path);
      setLogError(null);
      // Sweep AFTER writing, so the run that fails to write still prunes, and
      // so a retention of N never deletes the log just created. Same folder
      // the write used — pruning the DEFAULT folder while writing to a
      // configured one would let logs accumulate forever in the place the
      // user actually looks.
      await batch.pruneLogs(settings.batchLogRetentionDays, settings.batchLogDir).catch(() => {});
    } catch (e: unknown) {
      setLogPath(null);
      setLogError(e instanceof Error ? e.message : String(e));
    }
  };

  const start = async (): Promise<void> => {
    if (!canStart || !source || !dest || !entries) return;
    setPhase('running');
    setError(null);
    setProgress(null);
    setStopping(false);
    setLogPath(null);
    setLogError(null);
    cancelledRef.current = false;
    const startedAt = new Date();
    // Recognition is a subprocess in the ENGINE now, so there is no worker to
    // construct (and no `new Worker` that could throw synchronously and strand
    // the dialog in an unclosable modal — the review finding that shaped this
    // block). Cancellation is the driver's `isCancelled` poll: an in-flight
    // engine call finishes, then the loop stops.
    const lang = toTesseractLang(langs);
    try {
      cancelOcrRef.current = null;
      const io = createBatchIo({
        applyOcrLayer: async (src, out, pages) => {
          await callRaw('apply_ocr_layer', { file: src, output: out, pages });
        },
        repair: async (src, out) => {
          await callRaw('repair', { file: src, output: out });
        },
        recognize: (path, pageIndex) => recognizePage(callRaw, path, pageIndex, lang),
      });
      const rep = await runBatchOcr(entries, dest, skippedDirs, io, {
        onProgress: setProgress,
        isCancelled: () => cancelledRef.current,
        // All four default to off. Batch OCR's standing guarantee is that it
        // does not modify the source tree; these are the opt-ins that invert
        // it, and nothing turns them on but the user.
        ...(movedRoot ? { movedRoot } : {}),
        ...(errorRoot ? { errorRoot } : {}),
        repairDamaged,
        replaceRepairedOriginals: repairDamaged && replaceRepaired,
      });
      setReport(rep);
      await writeLog(startedAt, rep, source, dest);
      setPhase('done');
    } catch (e: unknown) {
      // The driver isolates per-file failures; reaching here means something
      // structural (e.g. the engine died). Back to setup with the reason — and
      // a log anyway: a run that died half way through is precisely the one
      // whose partial results the user needs a record of.
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      await writeLog(
        startedAt,
        { cancelled: false, results: [], skippedDirs },
        source,
        dest,
        message,
      );
      setPhase('setup');
    } finally {
      cancelOcrRef.current = null;
    }
  };

  const cancel = (): void => {
    setStopping(true);
    cancelledRef.current = true;
    cancelOcrRef.current?.();
  };

  // Run-again from the report: source/dest/language/entries are all still
  // valid (the run never mutates the source tree), so only the run state
  // resets. Without this, a second batch meant reopening from the menu and
  // re-picking both folders (review-caught dead end).
  const runAnother = (): void => {
    setReport(null);
    setProgress(null);
    setStopping(false);
    setLogPath(null);
    setLogError(null);
    setPhase('setup');
  };

  // Test harness: the native folder pickers cannot be WebDriver-driven, so
  // the harness injects paths into the SAME selectSource/setDest/start flow
  // the buttons run (14-ocr-find/signing precedent). Registered once; every
  // read goes through refs so the snapshot stays fresh without
  // re-registration.
  const harnessDeps = { selectSource, setDest, setMovedRoot, setErrorRoot, start };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const reportRef = useRef(report);
  reportRef.current = report;
  const logPathRef = useRef(logPath);
  logPathRef.current = logPath;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerBatchOcr({
      setSource: (path) => harnessRef.current.selectSource(path),
      setDest: (path) => harnessRef.current.setDest(path),
      setFiling: (filing) => {
        if (filing.movedRoot !== undefined) harnessRef.current.setMovedRoot(filing.movedRoot);
        if (filing.errorRoot !== undefined) harnessRef.current.setErrorRoot(filing.errorRoot);
      },
      start: () => harnessRef.current.start(),
      snapshot: () => ({
        phase: phaseRef.current,
        fileCount: entriesRef.current?.length ?? null,
        report: reportRef.current,
        logPath: logPathRef.current,
      }),
    });
    return () => registerBatchOcr(null);
  }, []);

  // While running, the first close attempt means "cancel"; once a stop is
  // already pending, a SECOND close attempt falls through to a real close —
  // the escape hatch for a wedged engine call that would otherwise make the
  // modal unclosable, since nothing can abort an in-flight sidecar write
  // (review-caught). The abandoned run settles in the background: its state
  // updates land on an unmounted component (safe no-ops) and the finally
  // still disposes the worker.
  const guardedClose = phase === 'running' ? (stopping ? onClose : cancel) : onClose;

  const summary = report ? summarize(report) : null;
  const skippedResults = report?.results.filter((r) => r.status === 'skipped') ?? [];
  const movedCount = report?.results.filter((r) => r.movedTo).length ?? 0;
  const repairedCount = report?.results.filter((r) => r.repaired).length ?? 0;
  // A move the user asked for that did not happen. Surfaced at the TOP of the
  // report rather than folded into a list, because it is the only outcome here
  // where the user's own folders are not in the state they asked for.
  const moveFailures = report?.results.filter((r) => r.moveError) ?? [];
  const notedCopies = report?.results.filter((r) => r.status === 'copied' && r.reason) ?? [];
  // 'ocr' rows carry a reason too when SOME scanned pages had no
  // recognizable text — the mixed-file honesty note (review-caught).
  const notedOcr = report?.results.filter((r) => r.status === 'ocr' && r.reason) ?? [];

  return (
    <Shell onClose={guardedClose}>
      {phase === 'setup' && (
        <div className="flex flex-col gap-4">
          <FolderRow
            label="Source folder"
            testid="batch-ocr-source"
            value={source}
            onPick={() => void pickSource()}
            buttonRef={sourceBtnRef}
            note={
              scanning
                ? 'Scanning folder…'
                : entries !== null
                  ? `${entries.length} PDF${entries.length === 1 ? '' : 's'} found`
                  : null
            }
          />
          <FolderRow
            label="Destination folder"
            testid="batch-ocr-dest"
            value={dest}
            onPick={() => void pickDest()}
            note={null}
          />
          {conflict && (
            <p className="text-sm text-red-400" data-testid="batch-ocr-conflict">
              {identityConflict
                ? 'These are the same folder (reached by two different paths) — choose a separate destination for the searchable copies.'
                : 'The destination must be outside the source folder — choose a separate folder for the searchable copies.'}
            </p>
          )}
          <div>
            <label className="block text-sm text-neutral-400 mb-1">
              Recognition languages
              <span className="text-neutral-500"> — {describeLanguages(langs)}</span>
            </label>
            {/* A checkbox list, not a 47-entry <select multiple>: ctrl-clicking
                to build a set is a UI most people lose a selection to. */}
            <div
              data-testid="batch-ocr-lang"
              role="group"
              aria-label="Recognition languages"
              className="max-h-44 overflow-y-auto rounded border border-neutral-700 bg-neutral-800 p-2 grid grid-cols-2 gap-x-3 gap-y-1"
            >
              {OCR_LANGUAGES.map((l) => (
                <label key={l.code} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid={`batch-ocr-lang-${l.code}`}
                    checked={langs.includes(l.code)}
                    onChange={() =>
                      setLangs((prev) =>
                        prev.includes(l.code)
                          ? prev.filter((c) => c !== l.code)
                          : [...prev, l.code],
                      )
                    }
                    className="rounded bg-neutral-900 border-neutral-600"
                  />
                  <span className="text-neutral-300">{l.label}</span>
                </label>
              ))}
            </div>
            {langs.length > 1 && (
              <p className="text-xs text-neutral-500 mt-1" data-testid="batch-ocr-lang-note">
                Several languages are recognized together, which is slower — and on a page
                that is only one of them, the single right language is usually more accurate.
                This is not automatic detection.
              </p>
            )}
          </div>
          <p className="text-xs text-neutral-500">
            Every PDF in the source folder is mirrored into the destination:
            scanned pages gain an invisible searchable text layer; already-searchable
            files are copied unchanged. Existing destination files with the same
            names are overwritten.
          </p>

          {/* Requests 2 and 3. Presented as one clearly-fenced section because
              everything in it BREAKS the promise stated directly above it —
              that the source folder is never modified. Nothing here is on
              until a folder is chosen or a box is ticked. */}
          <details className="rounded border border-neutral-800 bg-neutral-950/40" data-testid="batch-ocr-filing">
            <summary className="px-3 py-2 text-sm text-neutral-300 cursor-pointer select-none">
              File the originals after processing
              <span className="text-neutral-500"> — optional; moves your own files</span>
            </summary>
            <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
              <p className="text-xs text-amber-400/90">
                Everything below MOVES files out of your source folder. Left alone, the
                source folder is never modified — that is the default.
              </p>
              <OptionalFolderRow
                label="Move processed originals to"
                testid="batch-ocr-moved"
                value={movedRoot}
                conflict={movedConflict}
                onPick={async () => {
                  const path = await dialog.pickFolder('Choose where processed originals go');
                  if (path) setMovedRoot(path);
                }}
                onClear={() => setMovedRoot(null)}
                note="Only after the searchable copy has been read back and verified. The folder structure is preserved, and a name that already exists is never overwritten."
              />
              <OptionalFolderRow
                label="Move failed originals to"
                testid="batch-ocr-errors"
                value={errorRoot}
                conflict={errorConflict}
                onPick={async () => {
                  const path = await dialog.pickFolder('Choose where files that could not be processed go');
                  if (path) setErrorRoot(path);
                }}
                onClear={() => setErrorRoot(null)}
                note="Password-protected and damaged files, so what is left behind in the source folder is what succeeded."
              />
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="batch-ocr-repair"
                  checked={repairDamaged}
                  onChange={() => setRepairDamaged((v) => !v)}
                  className="mt-0.5 rounded bg-neutral-900 border-neutral-600"
                />
                <span className="text-sm text-neutral-300">
                  Try to repair damaged files
                  <span className="block text-xs text-neutral-500">
                    A file that will not open is rewritten (annotations, bookmarks and
                    metadata are kept) and processed if that works. Password-protected
                    files are not repairable and are left alone.
                  </span>
                </span>
              </label>
              <label
                className={`flex items-start gap-2 ${repairDamaged ? 'cursor-pointer' : 'opacity-50'}`}
              >
                <input
                  type="checkbox"
                  data-testid="batch-ocr-replace-repaired"
                  checked={repairDamaged && replaceRepaired}
                  disabled={!repairDamaged}
                  onChange={() => setReplaceRepaired((v) => !v)}
                  className="mt-0.5 rounded bg-neutral-900 border-neutral-600"
                />
                <span className="text-sm text-neutral-300">
                  Replace the damaged original with the repaired file
                  <span className="block text-xs text-neutral-500">
                    Writes the repaired file back over the original — the repaired
                    document, not the searchable copy.
                  </span>
                </span>
              </label>
            </div>
          </details>
          {skippedDirs.length > 0 && (
            <p className="text-xs text-amber-400" data-testid="batch-ocr-skipped-dirs">
              Could not read {skippedDirs.length} subfolder{skippedDirs.length === 1 ? '' : 's'} (it
              will be missing from the mirror): {skippedDirs.join('; ')}
            </p>
          )}
          {entries !== null && entries.length === 0 && (
            <p className="text-sm text-neutral-400" data-testid="batch-ocr-empty">
              No PDF files found in this folder.
            </p>
          )}
          {error && (
            <p className="text-sm text-red-400" data-testid="batch-ocr-error">{error}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              data-testid="batch-ocr-cancel"
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              Cancel
            </button>
            <button
              data-testid="batch-ocr-start"
              disabled={!canStart}
              onClick={() => void start()}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              Start
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="flex flex-col gap-4" data-testid="batch-ocr-running">
          <ProgressLine progress={progress} stopping={stopping} />
          <ProgressBar progress={progress} />
          <div className="flex justify-end pt-1">
            <button
              ref={stopBtnRef}
              data-testid="batch-ocr-stop"
              onClick={cancel}
              disabled={stopping}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && report && summary && (
        <div className="flex flex-col gap-3" data-testid="batch-ocr-done">
          <p className="text-sm" data-testid="batch-ocr-summary">
            {report.cancelled ? 'Stopped. ' : ''}
            {/* "already searchable" must not absorb the OCR-ran-but-found-
                nothing copies (review-caught mislabel) — those carry a
                reason and get their own segment. */}
            {[
              `${summary.ocrd} made searchable`,
              `${summary.copied - notedCopies.length} copied (already searchable)`,
              ...(notedCopies.length > 0
                ? [`${notedCopies.length} copied (no text recognized)`]
                : []),
              `${summary.skipped} skipped`,
            ].join(' · ')}
          </p>
          {report.cancelled && (
            <p className="text-xs text-neutral-500">
              Files finished before the stop remain in the destination.
            </p>
          )}
          {(movedCount > 0 || repairedCount > 0) && (
            <p className="text-xs text-neutral-400" data-testid="batch-ocr-moved-summary">
              {[
                ...(movedCount > 0 ? [`${movedCount} original${movedCount === 1 ? '' : 's'} moved`] : []),
                ...(repairedCount > 0 ? [`${repairedCount} repaired`] : []),
              ].join(' · ')}
            </p>
          )}
          {moveFailures.length > 0 && (
            <div
              className="border border-amber-500/40 rounded p-2 max-h-32 overflow-y-auto"
              data-testid="batch-ocr-move-failures"
            >
              <p className="text-xs text-amber-400 mb-1">
                {moveFailures.length} original{moveFailures.length === 1 ? ' is' : 's are'} still in
                the source folder:
              </p>
              {moveFailures.map((r) => (
                <p key={r.rel} className="text-xs text-amber-400/90">
                  {r.rel} — {r.moveError}
                </p>
              ))}
            </div>
          )}
          {skippedResults.length > 0 && (
            <div className="max-h-40 overflow-y-auto border border-neutral-800 rounded p-2">
              {skippedResults.map((r) => (
                <p key={r.rel} className="text-xs text-amber-400">
                  {r.rel} — {r.reason}
                </p>
              ))}
            </div>
          )}
          {notedCopies.length > 0 && (
            <div className="max-h-24 overflow-y-auto border border-neutral-800 rounded p-2">
              {notedCopies.map((r) => (
                <p key={r.rel} className="text-xs text-neutral-400">
                  {r.rel} — copied ({r.reason})
                </p>
              ))}
            </div>
          )}
          {notedOcr.length > 0 && (
            <div
              className="max-h-24 overflow-y-auto border border-neutral-800 rounded p-2"
              data-testid="batch-ocr-partial-notes"
            >
              {notedOcr.map((r) => (
                <p key={r.rel} className="text-xs text-neutral-400">
                  {r.rel} — made searchable, but {r.reason}
                </p>
              ))}
            </div>
          )}
          {report.skippedDirs.length > 0 && (
            <p className="text-xs text-amber-400">
              Unreadable subfolders (missing from the mirror): {report.skippedDirs.join('; ')}
            </p>
          )}
          {logPath && (
            <p className="text-xs text-neutral-500" data-testid="batch-ocr-log-path">
              Log written:{' '}
              <span className="text-neutral-400" title={logPath}>
                {logPath}
              </span>{' '}
              <button
                data-testid="batch-ocr-log-open"
                onClick={() => void batch.openLogFolder(getSettings().batchLogDir).catch(() => {})}
                className="underline hover:text-neutral-300"
              >
                Open folder
              </button>
            </p>
          )}
          {logError && (
            <p className="text-xs text-amber-400" data-testid="batch-ocr-log-error">
              The run finished, but its log could not be written: {logError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              data-testid="batch-ocr-again"
              onClick={runAnother}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              Run another
            </button>
            <button
              ref={doneCloseBtnRef}
              data-testid="batch-ocr-close"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}

function ProgressLine({
  progress,
  stopping,
}: {
  progress: BatchProgress | null;
  stopping: boolean;
}): React.JSX.Element {
  // aria-live: this narration increments for minutes across many files —
  // the FindBar/SearchPanel precedent for exactly this shape (a count that
  // updates during an async scan) is polite live announcement.
  if (stopping) {
    return (
      <p className="text-sm text-neutral-300" data-testid="batch-ocr-progress" aria-live="polite">
        Stopping — finishing the current file… (Close again to abandon the run.)
      </p>
    );
  }
  if (!progress) {
    return (
      <p className="text-sm text-neutral-400" data-testid="batch-ocr-progress" aria-live="polite">
        Starting…
      </p>
    );
  }
  const { fileIndex, fileCount, rel, phase, page, pageCount } = progress;
  const verb =
    phase === 'recognizing'
      ? `recognizing page ${page ?? 0} of ${pageCount ?? 0}`
      : phase === 'copying'
        ? 'copying'
        : phase === 'writing'
          ? 'writing searchable copy'
          : phase === 'scanning'
            ? 'checking pages'
            : 'loading';
  return (
    <p className="text-sm text-neutral-300" data-testid="batch-ocr-progress" aria-live="polite">
      File {fileIndex + 1} of {fileCount}: <span className="text-neutral-100">{rel}</span>
      <span className="text-neutral-400"> — {verb}</span>
    </p>
  );
}

function ProgressBar({ progress }: { progress: BatchProgress | null }): React.JSX.Element {
  // Interpolate WITHIN the current file — a whole-file numerator pins a
  // single-file batch at 0% for its entire (possibly minutes-long) run
  // (review-caught). Recognition advances page/pageCount; the write/copy
  // phases count the file as done.
  let intra = 0;
  if (progress) {
    if (progress.phase === 'writing' || progress.phase === 'copying') intra = 1;
    else if (progress.phase === 'recognizing' && progress.pageCount)
      intra = (progress.page ?? 0) / progress.pageCount;
  }
  const fraction = progress
    ? (progress.fileIndex + intra) / Math.max(1, progress.fileCount)
    : 0;
  return (
    <div className="h-1.5 bg-neutral-800 rounded overflow-hidden">
      <div
        className="h-full bg-blue-600 transition-all"
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </div>
  );
}

function FolderRow({
  label,
  testid,
  value,
  onPick,
  note,
  buttonRef,
}: {
  label: string;
  testid: string;
  value: string | null;
  onPick: () => void;
  note: string | null;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <div>
      <span className="block text-sm text-neutral-400 mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <button
          ref={buttonRef}
          data-testid={`${testid}-pick`}
          onClick={onPick}
          className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium shrink-0"
        >
          Choose…
        </button>
        <span
          data-testid={testid}
          className="text-sm text-neutral-300 truncate"
          title={value ?? undefined}
        >
          {value ?? 'No folder chosen'}
        </span>
      </div>
      {note && <p className="text-xs text-neutral-500 mt-1">{note}</p>}
    </div>
  );
}

/** A folder row that can be UNSET — the moved/error roots, whose "not chosen"
 * state is the default and has to stay one click away. */
function OptionalFolderRow({
  label,
  testid,
  value,
  conflict,
  onPick,
  onClear,
  note,
}: {
  label: string;
  testid: string;
  value: string | null;
  conflict: string | null;
  onPick: () => void;
  onClear: () => void;
  note: string;
}): React.JSX.Element {
  return (
    <div>
      <span className="block text-sm text-neutral-400 mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <button
          data-testid={`${testid}-pick`}
          onClick={onPick}
          className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium shrink-0"
        >
          Choose…
        </button>
        <span data-testid={testid} className="text-sm text-neutral-300 truncate" title={value ?? undefined}>
          {value ?? 'Not moving them (default)'}
        </span>
        {value !== null && (
          <button
            data-testid={`${testid}-clear`}
            onClick={onClear}
            className="px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300 shrink-0"
          >
            Clear
          </button>
        )}
      </div>
      {conflict !== null ? (
        <p className="text-xs text-red-400 mt-1" data-testid={`${testid}-conflict`}>
          That folder is {conflict}.
        </p>
      ) : (
        <p className="text-xs text-neutral-500 mt-1">{note}</p>
      )}
    </div>
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
        aria-label="Batch OCR Folder"
        data-testid="batch-ocr-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[560px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">Batch OCR Folder</h3>
          <button
            data-testid="batch-ocr-x"
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
