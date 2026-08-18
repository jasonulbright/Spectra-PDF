import React, { useEffect, useRef, useState } from 'react';
import { useEngine } from '../hooks/useEngine';
import { useAppModal } from '../hooks/useAppModal';
import { app, dialog, batch } from '../lib/tauri-bridge';
import { recognizePage, tesseractPath, ghostscriptPath } from '../lib/ocr-recognize';
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
import { claimOutputRoot } from '../lib/output-root-claim';
import { formatBatchLog, batchLogFileName } from '../lib/batch-log';
import { getSettings } from '../lib/app-settings';
import {
  normalizeMrcPreset,
  type MrcPreset,
  type MrcReport,
} from '../lib/mrc-presets';
import {
  loadBatchOcrPresets,
  presetNameProblem,
  removePreset,
  renamePreset,
  saveBatchOcrPresets,
  upsertPreset,
  type BatchOcrPreset,
  type BatchOcrSettings,
} from '../lib/batch-ocr-presets';
import type { ScanEnhanceReport } from '../lib/scan-enhance';
import { TEST_HARNESS_ENABLED, registerBatchOcr } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber, tOcrLanguage } from '../i18n';

// Tools ▸ Batch OCR Folder…:
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
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { callRaw } = useEngine();

  const [phase, setPhase] = useState<Phase>('setup');
  const [source, setSource] = useState<string | null>(null);
  const [dest, setDest] = useState<string | null>(null);
  const [entries, setEntries] = useState<BatchPdfEntry[] | null>(null);
  const [skippedDirs, setSkippedDirs] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [langs, setLangs] = useState<string[]>([DEFAULT_OCR_LANGUAGE]);
  // Every one of these is OFF until the user acts:
  // they invert the standing guarantee that a batch never modifies the source
  // tree, so "off by default" is the feature, not a timidity.
  const [movedRoot, setMovedRoot] = useState<string | null>(null);
  const [errorRoot, setErrorRoot] = useState<string | null>(null);
  const [repairDamaged, setRepairDamaged] = useState(false);
  const [replaceRepaired, setReplaceRepaired] = useState(false);
  // In-place batch mode: REPLACE each original with its searchable
  // version. Inverts the no-source-mutation guarantee harder than the filing
  // options, so it is off by default, retires the destination/moved-root
  // machinery while on, and takes a two-step confirm. Runs as ONE engine
  // call (the guided-folder-run precedent) — the live per-file progress
  // driver stays mirror-only, and there is no mid-run stop.
  const [inPlace, setInPlace] = useState(false);
  const [confirmInPlace, setConfirmInPlace] = useState(false);
  // MRC-compress each processed file after recognition. Off by
  // default like every other option here — it rewrites the page images, which
  // is more than "make this searchable" promises on its own.
  const [mrc, setMrc] = useState(false);
  const [mrcPreset, setMrcPreset] = useState<MrcPreset>(() =>
    normalizeMrcPreset(getSettings().mrcPreset),
  );
  const [mrcVerify, setMrcVerify] = useState(false);
  const [enhance, setEnhance] = useState(false);
  const [enhanceOrientation, setEnhanceOrientation] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  // Stop feedback must be STATE (it drives paint); the ref twin below is what
  // the driver's isCancelled() polls — a ref mutation alone never re-renders,
  // so a ref-driven button label was a button that ignored the click
  // (regression).
  const [stopping, setStopping] = useState(false);

  // Named presets. The library is read once at mount and every mutation goes
  // through `persist`, so the store and what is on screen cannot disagree.
  const [presets, setPresets] = useState<BatchOcrPreset[]>(() => loadBatchOcrPresets());
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetProblem, setPresetProblem] = useState<string | null>(null);
  const [confirmDeletePreset, setConfirmDeletePreset] = useState(false);

  const persist = (next: BatchOcrPreset[]): void => {
    setPresets(next);
    saveBatchOcrPresets(next);
  };

  /** Everything the dialog is set to, as the stored shape. */
  const currentSettings = (): BatchOcrSettings => ({
    source: source ?? '',
    dest: dest ?? '',
    langs,
    inPlace,
    movedRoot: movedRoot ?? '',
    errorRoot: errorRoot ?? '',
    repairDamaged,
    replaceRepairedOriginals: repairDamaged && replaceRepaired,
    mrc,
    mrcPreset,
    mrcVerifyText: mrcVerify,
    enhance,
    enhanceOrientation,
  });

  // Applying a preset re-enumerates the source rather than trusting a stored
  // count: the tree the preset names may have changed since it was saved, and
  // Start reads the enumeration, not the path.
  const applyPreset = async (id: string): Promise<void> => {
    setPresetId(id);
    setConfirmDeletePreset(false);
    setPresetProblem(null);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const s = preset.settings;
    setPresetName(preset.name);
    setInPlace(s.inPlace);
    setConfirmInPlace(false);
    setDest(s.dest === '' ? null : s.dest);
    setLangs(s.langs);
    setMovedRoot(s.movedRoot === '' ? null : s.movedRoot);
    setErrorRoot(s.errorRoot === '' ? null : s.errorRoot);
    setRepairDamaged(s.repairDamaged);
    setReplaceRepaired(s.replaceRepairedOriginals);
    setMrc(s.mrc);
    setMrcPreset(s.mrcPreset);
    setMrcVerify(s.mrcVerifyText);
    setEnhance(s.enhance);
    setEnhanceOrientation(s.enhanceOrientation);
    if (s.source === '') {
      setSource(null);
      setEntries(null);
      setSkippedDirs([]);
    } else {
      await selectSource(s.source);
    }
  };

  const savePreset = (): void => {
    const problem = presetNameProblem(presetName, presets, presetId || undefined);
    if (problem) {
      setPresetProblem(tChrome(`dialog.batch.presetProblem.${problem}` as never));
      return;
    }
    const next = upsertPreset(presets, presetName, currentSettings(), presetId || undefined);
    persist(next);
    const saved = next.find((p) => p.name === presetName.trim());
    setPresetId(saved?.id ?? '');
    setPresetProblem(null);
  };

  // Rename is NOT "save under a new name": it leaves the stored settings
  // exactly as they are, so correcting a typo cannot silently capture whatever
  // the dialog happens to be set to at that moment.
  const renameSelectedPreset = (): void => {
    const problem = presetNameProblem(presetName, presets, presetId);
    if (problem) {
      setPresetProblem(tChrome(`dialog.batch.presetProblem.${problem}` as never));
      return;
    }
    persist(renamePreset(presets, presetId, presetName));
    setPresetProblem(null);
  };

  const deletePreset = (): void => {
    persist(removePreset(presets, presetId));
    setPresetId('');
    setPresetName('');
    setConfirmDeletePreset(false);
    setPresetProblem(null);
  };

  const cancelledRef = useRef(false);
  const cancelOcrRef = useRef<(() => void) | null>(null);
  const phaseRef = useRef<Phase>('setup');
  phaseRef.current = phase;

  // The three phases render as mutually exclusive subtrees, so a transition
  // unmounts the node holding focus and Chromium drops focus to <body> —
  // OUTSIDE the shell the Tab trap listens on (useAppModal attaches to the
  // shell element; keydowns from body never reach it). Re-anchor focus on
  // each phase's primary control (regression; the sibling dialogs dodge
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
  // (regression). Only the latest request may touch state.
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
    const path = await dialog.pickFolder(tChrome('dialog.batch.pickSource'));
    if (path) await selectSource(path);
  };

  const pickDest = async (): Promise<void> => {
    const path = await dialog.pickFolder(tChrome('dialog.common.pickDest'));
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
      return tChrome('dialog.batch.conflictInSource');
    }
    if (dest !== null && destConflictsWithSource(dest, root)) {
      return tChrome('dialog.batch.conflictInDest');
    }
    return null;
  };
  const movedConflict = rootConflict(movedRoot);
  const errorConflict = rootConflict(errorRoot);

  const canStart =
    phase === 'setup' &&
    !scanning &&
    source !== null &&
    (inPlace || (dest !== null && !conflict && movedConflict === null)) &&
    errorConflict === null &&
    entries !== null &&
    entries.length > 0;

  // Where this run's log landed, shown on the report. Null when logging is
  // off, or when the write itself failed — a log that could not be written is
  // said so on screen rather than silently assumed (the report is the only
  // other record, and it is about to be dismissed).
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  // Writing is best-effort by design: a failed log must
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

  // The in-place run: ONE engine RPC over the whole tree (engine batch_ocr
  // with in_place=True — per-file staging, verify-read, atomic swap). The
  // engine writes its own run log; the GUI writeLog is skipped so the run is
  // not logged twice.
  const startInPlace = async (): Promise<void> => {
    if (!canStart || !source) return;
    setConfirmInPlace(false);
    setPhase('running');
    setError(null);
    setProgress(null);
    setStopping(false);
    setLogPath(null);
    setLogError(null);
    try {
      const settings = getSettings();
      const logDir = settings.batchLogEnabled ? await batch.logDir(settings.batchLogDir) : '';
      if (settings.batchLogEnabled && settings.batchLogRetentionDays > 0) {
        await batch.pruneLogs(settings.batchLogRetentionDays, settings.batchLogDir).catch(() => 0);
      }
      const rep = (await callRaw('batch_ocr', {
        source,
        dest: '',
        lang: toTesseractLang(langs),
        tesseract_path: await tesseractPath(),
        gs_path: await ghostscriptPath(),
        error_root: errorRoot ?? '',
        repair_damaged: repairDamaged,
        replace_repaired_originals: repairDamaged && replaceRepaired,
        log_dir: logDir,
        in_place: true,
        mrc,
        mrc_preset: mrcPreset,
        mrc_verify_text: mrcVerify,
        enhance,
        enhance_orientation: enhanceOrientation,
        font_dir: await app.getEditFontPath(),
      })) as unknown as BatchReport & { logPath?: string };
      setReport(rep);
      setLogPath(rep.logPath ?? null);
      setPhase('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('setup');
    }
  };

  const start = async (): Promise<void> => {
    if (!canStart || !source || !dest || !entries) return;
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
        // The mirror OUTPUT is the input here, which is what makes the
        // recognize-then-MRC order structural. `callRaw` for the same reason
        // every other engine call in this dialog uses it: batch lives outside
        // the workspace, so the commit gate must not run.
        compressMrc: async (path, preset, verifyText) =>
          (await callRaw('compress', {
            file: path,
            output: path,
            quality: 'mrc',
            mrc_preset: preset,
            mrc_verify_text: verifyText,
            mrc_lang: lang,
            gs_path: await ghostscriptPath(),
            tesseract_path: await tesseractPath(),
            font_dir: await app.getEditFontPath(),
          })) as unknown as MrcReport,
        // Runs BEFORE the source is read, which is what makes the
        // enhance-then-recognise order structural. `callRaw` for the same
        // reason every other engine call in this dialog uses it: batch lives
        // outside the workspace, so the commit gate must not run.
        enhanceScan: async (src, out, orientation) =>
          (await callRaw('enhance_scan', {
            file: src,
            output: out,
            orientation,
            gs_path: await ghostscriptPath(),
            tesseract_path: await tesseractPath(),
          })) as unknown as ScanEnhanceReport,
      });
      const rep = await runBatchOcr(entries, dest, skippedDirs, io, {
        onProgress: setProgress,
        isCancelled: () => cancelledRef.current,
        ...(mrc ? { mrc: { preset: mrcPreset, verifyText: mrcVerify } } : {}),
        ...(enhance ? { enhance: { orientation: enhanceOrientation } } : {}),
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
      await root.release();
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
  // re-picking both folders (regression dead end).
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
  // (regression). The abandoned run settles in the background: its state
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
  // recognizable text — the mixed-file honesty note (regression).
  const notedOcr = report?.results.filter((r) => r.status === 'ocr' && r.reason) ?? [];
  const notedMrc = report?.results.filter((r) => r.mrc) ?? [];
  const notedEnhance = report?.results.filter((r) => r.enhance) ?? [];

  return (
    <Shell onClose={guardedClose}>
      {phase === 'setup' && (
        <div className="flex flex-col gap-4">
          {/* Named presets. This dialog holds fourteen independent settings
              and none of them used to survive closing it, so a folder someone
              processes every week was retyped every week. Deliberately at the
              TOP: recalling one rewrites every control below. */}
          <div
            className="rounded border border-neutral-800 bg-neutral-950/40 px-3 py-2 flex flex-col gap-2"
            data-testid="batch-ocr-presets"
          >
            <label className="flex items-center gap-2 text-sm">
              <span className="text-neutral-400 shrink-0">
                {tChrome('dialog.batch.presetLabel')}
              </span>
              <select
                data-testid="batch-ocr-preset-select"
                aria-label={tChrome('dialog.batch.presetLabel')}
                value={presetId}
                onChange={(e) => void applyPreset(e.target.value)}
                className="flex-1 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              >
                <option value="">{tChrome('dialog.batch.presetNone')}</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <input
                data-testid="batch-ocr-preset-name"
                aria-label={tChrome('dialog.batch.presetNameLabel')}
                value={presetName}
                placeholder={tChrome('dialog.batch.presetNamePlaceholder')}
                onChange={(e) => {
                  setPresetName(e.target.value);
                  setPresetProblem(null);
                }}
                className="flex-1 min-w-0 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
              />
              <button
                data-testid="batch-ocr-preset-save"
                onClick={savePreset}
                className="px-2.5 py-1 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium shrink-0"
              >
                {tChrome('dialog.batch.presetSave')}
              </button>
              {presetId !== '' && (
                <button
                  data-testid="batch-ocr-preset-rename"
                  onClick={renameSelectedPreset}
                  className="px-2.5 py-1 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium shrink-0"
                >
                  {tChrome('dialog.batch.presetRename')}
                </button>
              )}
              {presetId !== '' &&
                (confirmDeletePreset ? (
                  <>
                    <button
                      data-testid="batch-ocr-preset-delete-confirm"
                      onClick={deletePreset}
                      className="px-2.5 py-1 text-xs bg-red-700/80 hover:bg-red-600 text-white rounded font-medium shrink-0"
                    >
                      {tChrome('dialog.common.delete')}
                    </button>
                    <button
                      onClick={() => setConfirmDeletePreset(false)}
                      className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
                    >
                      {tChrome('dialog.common.keep')}
                    </button>
                  </>
                ) : (
                  <button
                    data-testid="batch-ocr-preset-delete"
                    onClick={() => setConfirmDeletePreset(true)}
                    className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400 shrink-0"
                  >
                    {tChrome('dialog.common.delete')}
                  </button>
                ))}
            </div>
            {presetProblem !== null ? (
              <p className="text-xs text-red-400" data-testid="batch-ocr-preset-problem">
                {presetProblem}
              </p>
            ) : (
              <p className="text-xs text-neutral-500">
                {tChrome('dialog.batch.presetNote', {
                  schedule: tChrome('dialog.schedule.title'),
                })}
              </p>
            )}
          </div>
          <FolderRow
            label={tChrome('dialog.batch.sourceLabel')}
            testid="batch-ocr-source"
            value={source}
            onPick={() => void pickSource()}
            buttonRef={sourceBtnRef}
            note={
              scanning
                ? tChrome('dialog.batch.scanning')
                : entries !== null
                  ? tChromeCount('dialog.batch.found', entries.length)
                  : null
            }
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              data-testid="batch-inplace"
              checked={inPlace}
              onChange={() => {
                const next = !inPlace;
                setInPlace(next);
                setConfirmInPlace(false);
                if (next) {
                  setDest(null);
                  setMovedRoot(null);
                }
              }}
              className="rounded bg-neutral-900 border-neutral-600"
            />
            <span className="text-sm text-neutral-300">
              {tChrome('dialog.batch.inPlace')}
            </span>
          </label>
          {inPlace ? (
            <p className="text-xs text-amber-400" data-testid="batch-inplace-note">
              {tChrome('dialog.batch.inPlaceNote')}
            </p>
          ) : (
            <FolderRow
              label={tChrome('dialog.batch.destLabel')}
              testid="batch-ocr-dest"
              value={dest}
              onPick={() => void pickDest()}
              note={null}
            />
          )}
          {conflict && (
            <p className="text-sm text-red-400" data-testid="batch-ocr-conflict">
              {tChrome(
                identityConflict
                  ? 'dialog.batch.conflictIdentity'
                  : 'dialog.batch.conflictInside',
              )}
            </p>
          )}
          <div>
            <label className="block text-sm text-neutral-400 mb-1">
              {/* One whole label: where the summary sits in the phrase is
                  a property of the language, not of the styling. */}
              {tChrome('dialog.batch.languages', { summary: describeLanguages(langs) })}
            </label>
            {/* A checkbox list, not a 47-entry <select multiple>: ctrl-clicking
                to build a set is a UI most people lose a selection to. */}
            <div
              data-testid="batch-ocr-lang"
              role="group"
              aria-label={tChrome('dialog.batch.languagesAria')}
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
                  <span className="text-neutral-300">{tOcrLanguage(l.code)}</span>
                </label>
              ))}
            </div>
            {langs.length > 1 && (
              <p className="text-xs text-neutral-500 mt-1" data-testid="batch-ocr-lang-note">
                {tChrome('dialog.batch.multiLangNote')}
              </p>
            )}
          </div>
          <p className="text-xs text-neutral-500">
            {tChrome('dialog.batch.blurb')}
          </p>

          {/* (second comment): "a batch option that could just
              compress automatically". The user with a folder of smartphone
              scans is standing in THIS dialog, so the option lives here — and
              it runs AFTER recognition, which is structural rather than
              documented: the file MRC reads is the recognised output. */}
          {/* Enhancement is the MRC option's mirror image and sits directly
              above it, in run order: it runs BEFORE recognition because it
              improves what will be read, where MRC runs after because it
              replaces what was read. */}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="batch-enhance"
                checked={enhance}
                onChange={() => setEnhance(!enhance)}
                className="rounded bg-neutral-900 border-neutral-600"
              />
              <span className="text-sm text-neutral-300">{tChrome('dialog.batch.enhance')}</span>
            </label>
            {enhance && (
              <div className="flex flex-col gap-2 ps-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="batch-enhance-orientation"
                    checked={enhanceOrientation}
                    onChange={() => setEnhanceOrientation(!enhanceOrientation)}
                    className="rounded bg-neutral-900 border-neutral-600"
                  />
                  <span className="text-sm text-neutral-300">
                    {tChrome('dialog.batch.enhanceOrientation')}
                  </span>
                </label>
                <p className="text-xs text-neutral-500">{tChrome('dialog.batch.enhanceNote')}</p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="batch-mrc"
                checked={mrc}
                onChange={() => setMrc(!mrc)}
                className="rounded bg-neutral-900 border-neutral-600"
              />
              <span className="text-sm text-neutral-300">{tChrome('dialog.batch.mrc')}</span>
            </label>
            {mrc && (
              <div className="flex flex-col gap-2 ps-6">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-neutral-400">{tChrome('dialog.batch.mrcPreset')}</span>
                  <select
                    data-testid="batch-mrc-preset"
                    aria-label={tChrome('dialog.batch.mrcPreset')}
                    value={mrcPreset}
                    onChange={(e) => setMrcPreset(normalizeMrcPreset(e.target.value))}
                    className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  >
                    <option value="archival">{tChrome('panel.compress.mrcPresetArchival')}</option>
                    <option value="balanced">{tChrome('panel.compress.mrcPresetBalanced')}</option>
                    <option value="smallest">{tChrome('panel.compress.mrcPresetSmallest')}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="batch-mrc-verify"
                    checked={mrcVerify}
                    onChange={() => setMrcVerify(!mrcVerify)}
                    className="rounded bg-neutral-900 border-neutral-600"
                  />
                  <span className="text-sm text-neutral-300">{tChrome('dialog.batch.mrcVerify')}</span>
                </label>
                <p className="text-xs text-neutral-500">{tChrome('dialog.batch.mrcNote')}</p>
              </div>
            )}
          </div>

          {/* Requests 2 and 3. Presented as one clearly-fenced section because
              everything in it BREAKS the promise stated directly above it —
              that the source folder is never modified. Nothing here is on
              until a folder is chosen or a box is ticked. */}
          <details className="rounded border border-neutral-800 bg-neutral-950/40" data-testid="batch-ocr-filing">
            <summary className="px-3 py-2 text-sm text-neutral-300 cursor-pointer select-none">
              {tChrome('dialog.batch.filingSection')}
            </summary>
            <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
              <p className="text-xs text-amber-400/90">
                {tChrome('dialog.batch.filingWarning')}
              </p>
              {!inPlace && (
                <OptionalFolderRow
                  label={tChrome('dialog.batch.movedLabel')}
                  testid="batch-ocr-moved"
                  value={movedRoot}
                  conflict={movedConflict}
                  onPick={async () => {
                    const path = await dialog.pickFolder(tChrome('dialog.common.pickProcessed'));
                    if (path) setMovedRoot(path);
                  }}
                  onClear={() => setMovedRoot(null)}
                  note={tChrome('dialog.batch.movedNote')}
                />
              )}
              <OptionalFolderRow
                label={tChrome('dialog.batch.errorsLabel')}
                testid="batch-ocr-errors"
                value={errorRoot}
                conflict={errorConflict}
                onPick={async () => {
                  const path = await dialog.pickFolder(tChrome('dialog.batch.pickErrors'));
                  if (path) setErrorRoot(path);
                }}
                onClear={() => setErrorRoot(null)}
                note={tChrome('dialog.batch.errorsNote')}
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
                  {tChrome('dialog.batch.repair')}
                  <span className="block text-xs text-neutral-500">
                    {tChrome('dialog.batch.repairNote')}
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
                  {tChrome('dialog.batch.replaceRepaired')}
                  <span className="block text-xs text-neutral-500">
                    {tChrome('dialog.batch.replaceRepairedNote')}
                  </span>
                </span>
              </label>
            </div>
          </details>
          {skippedDirs.length > 0 && (
            <p className="text-xs text-amber-400" data-testid="batch-ocr-skipped-dirs">
              {tChromeCount('dialog.batch.skippedDirs', skippedDirs.length, {
                dirs: skippedDirs.join('; '),
              })}
            </p>
          )}
          {entries !== null && entries.length === 0 && (
            <p className="text-sm text-neutral-400" data-testid="batch-ocr-empty">
              {tChrome('dialog.batch.empty')}
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
              {tChrome('dialog.common.cancel')}
            </button>
            {inPlace && confirmInPlace ? (
              <>
                <span className="text-xs text-amber-400 self-center" data-testid="batch-inplace-warning">
                  {tChrome('dialog.batch.inPlaceConfirm')}
                </span>
                <button
                  data-testid="batch-inplace-keep"
                  onClick={() => setConfirmInPlace(false)}
                  className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
                >
                  {tChrome('dialog.common.keep')}
                </button>
                <button
                  data-testid="batch-inplace-replace"
                  onClick={() => void startInPlace()}
                  className="px-3 py-1.5 text-xs text-white bg-red-700/90 hover:bg-red-600 rounded font-medium"
                >
                  {tChrome('dialog.batch.replaceOriginals')}
                </button>
              </>
            ) : (
              <button
                data-testid="batch-ocr-start"
                disabled={!canStart}
                onClick={() => (inPlace ? setConfirmInPlace(true) : void start())}
                className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              >
                {tChrome('dialog.batch.start')}
              </button>
            )}
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
              disabled={stopping || inPlace}
              title={inPlace ? tChrome('dialog.batch.noStopInPlace') : undefined}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium disabled:opacity-50"
            >
              {tChrome(stopping ? 'dialog.batch.stopping' : 'dialog.batch.stop')}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && report && summary && (
        <div className="flex flex-col gap-3" data-testid="batch-ocr-done">
          <p className="text-sm" data-testid="batch-ocr-summary">
            {/* Each segment is a WHOLE message; only the ' · ' separator is
                assembled. "already searchable" must not absorb the
                OCR-ran-but-found-nothing copies (regression mislabel) —
                those carry a reason and get their own segment. */}
            {(() => {
              const parts = [
                tChrome('dialog.batch.sumOcrd', { count: tNumber(summary.ocrd) }),
                tChrome('dialog.batch.sumCopied', {
                  count: tNumber(summary.copied - notedCopies.length),
                }),
                ...(notedCopies.length > 0
                  ? [tChrome('dialog.batch.sumNoText', { count: tNumber(notedCopies.length) })]
                  : []),
                tChrome('dialog.batch.sumSkipped', { count: tNumber(summary.skipped) }),
              ].join(' · ');
              return report.cancelled
                ? tChrome('dialog.batch.stoppedPrefix', { summary: parts })
                : parts;
            })()}
          </p>
          {report.cancelled && (
            <p className="text-xs text-neutral-500">
              {tChrome('dialog.batch.cancelledNote')}
            </p>
          )}
          {(movedCount > 0 || repairedCount > 0) && (
            <p className="text-xs text-neutral-400" data-testid="batch-ocr-moved-summary">
              {[
                ...(movedCount > 0
                  ? [tChromeCount('dialog.batch.movedCount', movedCount)]
                  : []),
                ...(repairedCount > 0
                  ? [tChrome('dialog.batch.repairedCount', { count: tNumber(repairedCount) })]
                  : []),
              ].join(' · ')}
            </p>
          )}
          {moveFailures.length > 0 && (
            <div
              className="border border-amber-500/40 rounded p-2 max-h-32 overflow-y-auto"
              data-testid="batch-ocr-move-failures"
            >
              <p className="text-xs text-amber-400 mb-1">
                {tChromeCount('dialog.batch.moveFailures', moveFailures.length)}
              </p>
              {moveFailures.map((r) => (
                <p key={r.rel} className="text-xs text-amber-400/90">
                  {tChrome('dialog.batch.rowReason', { rel: r.rel, reason: r.moveError ?? '' })}
                </p>
              ))}
            </div>
          )}
          {skippedResults.length > 0 && (
            <div className="max-h-40 overflow-y-auto border border-neutral-800 rounded p-2">
              {skippedResults.map((r) => (
                <p key={r.rel} className="text-xs text-amber-400">
                  {tChrome('dialog.batch.rowReason', { rel: r.rel, reason: r.reason ?? '' })}
                </p>
              ))}
            </div>
          )}
          {notedCopies.length > 0 && (
            <div className="max-h-24 overflow-y-auto border border-neutral-800 rounded p-2">
              {notedCopies.map((r) => (
                <p key={r.rel} className="text-xs text-neutral-400">
                  {tChrome('dialog.batch.rowCopied', { rel: r.rel, reason: r.reason ?? '' })}
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
                  {tChrome('dialog.batch.rowPartial', { rel: r.rel, reason: r.reason ?? '' })}
                </p>
              ))}
            </div>
          )}
          {/* What MRC did to each file, or why it did nothing. A run the
              user asked to compress must say what it compressed — a silent
              no-op on a folder of non-scans would read as a saving that never
              happened. */}
          {notedEnhance.length > 0 && (
            <div
              className="max-h-24 overflow-y-auto border border-neutral-800 rounded p-2"
              data-testid="batch-ocr-enhance-notes"
            >
              {notedEnhance.map((r) => (
                <p key={r.rel} className="text-xs text-neutral-400">
                  {tChrome('dialog.batch.rowEnhance', { rel: r.rel, note: r.enhance ?? '' })}
                </p>
              ))}
            </div>
          )}
          {notedMrc.length > 0 && (
            <div
              className="max-h-24 overflow-y-auto border border-neutral-800 rounded p-2"
              data-testid="batch-ocr-mrc-notes"
            >
              {notedMrc.map((r) => (
                <p key={r.rel} className="text-xs text-neutral-400">
                  {tChrome('dialog.batch.rowMrc', { rel: r.rel, note: r.mrc ?? '' })}
                </p>
              ))}
            </div>
          )}
          {report.skippedDirs.length > 0 && (
            <p className="text-xs text-amber-400">
              {tChrome('dialog.batch.unreadableDirs', { dirs: report.skippedDirs.join('; ') })}
            </p>
          )}
          {logPath && (
            <p className="text-xs text-neutral-500" data-testid="batch-ocr-log-path">
              {tChrome('dialog.batch.logWritten', { path: logPath })}{' '}
              <button
                data-testid="batch-ocr-log-open"
                onClick={() => void batch.openLogFolder(getSettings().batchLogDir).catch(() => {})}
                className="underline hover:text-neutral-300"
              >
                {tChrome('dialog.batch.openFolder')}
              </button>
            </p>
          )}
          {logError && (
            <p className="text-xs text-amber-400" data-testid="batch-ocr-log-error">
              {tChrome('dialog.batch.logError', { message: logError })}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              data-testid="batch-ocr-again"
              onClick={runAnother}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              {tChrome('dialog.batch.again')}
            </button>
            <button
              ref={doneCloseBtnRef}
              data-testid="batch-ocr-close"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
            >
              {tChrome('dialog.common.close')}
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
        {tChrome('dialog.batch.progressStopping')}
      </p>
    );
  }
  if (!progress) {
    return (
      <p className="text-sm text-neutral-400" data-testid="batch-ocr-progress" aria-live="polite">
        {tChrome('dialog.batch.progressStarting')}
      </p>
    );
  }
  const { fileIndex, fileCount, rel, phase, page, pageCount } = progress;
  const verb =
    phase === 'recognizing'
      ? tChrome('dialog.batch.verbRecognizing', {
          page: tNumber(page ?? 0),
          pageCount: tNumber(pageCount ?? 0),
        })
      : phase === 'copying'
        ? tChrome('dialog.batch.verbCopying')
        : phase === 'writing'
          ? tChrome('dialog.batch.verbWriting')
          : phase === 'compressing'
            ? tChrome('dialog.batch.verbCompressing')
            : phase === 'scanning'
              ? tChrome('dialog.batch.verbScanning')
              : tChrome('dialog.batch.verbLoading');
  return (
    <p className="text-sm text-neutral-300" data-testid="batch-ocr-progress" aria-live="polite">
      {/* One whole narration — the file name and the verb used to sit in
          their own coloured spans, which fixed the clause order. */}
      {tChrome('dialog.batch.progress', {
        index: tNumber(fileIndex + 1),
        count: tNumber(fileCount),
        rel,
        verb,
      })}
    </p>
  );
}

function ProgressBar({ progress }: { progress: BatchProgress | null }): React.JSX.Element {
  // Interpolate WITHIN the current file — a whole-file numerator pins a
  // single-file batch at 0% for its entire (possibly minutes-long) run
  // (regression). Recognition advances page/pageCount; the write/copy
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
          {tChrome('dialog.common.choose')}
        </button>
        <span
          data-testid={testid}
          className="text-sm text-neutral-300 truncate"
          title={value ?? undefined}
        >
          {value ?? tChrome('dialog.batch.noFolder')}
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
          {tChrome('dialog.common.choose')}
        </button>
        <span data-testid={testid} className="text-sm text-neutral-300 truncate" title={value ?? undefined}>
          {value ?? tChrome('dialog.batch.notMoving')}
        </span>
        {value !== null && (
          <button
            data-testid={`${testid}-clear`}
            onClick={onClear}
            className="px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300 shrink-0"
          >
            {tChrome('dialog.common.clear')}
          </button>
        )}
      </div>
      {conflict !== null ? (
        <p className="text-xs text-red-400 mt-1" data-testid={`${testid}-conflict`}>
          {conflict}
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
        aria-label={tChrome('dialog.batch.title')}
        data-testid="batch-ocr-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[560px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.batch.title')}</h3>
          <button
            data-testid="batch-ocr-x"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
