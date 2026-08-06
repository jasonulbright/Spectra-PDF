import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../hooks/useEngine';
import { dialog, app } from '../lib/tauri-bridge';
import { FolderRow, RunningView, SweepShell } from './FolderSweepUi';
import { useSweepFolders } from '../hooks/useSweepFolders';
import { useSweepLog } from '../hooks/useSweepLog';
import { tChrome, tChromeCount, tOcrLanguage } from '../i18n';
import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import { toTesseractLang, describeLanguages } from '../ocr/language-selection';
import { ghostscriptPath, tesseractPath } from '../lib/ocr-recognize';
import { TEST_HARNESS_ENABLED, registerFormPrep } from '../testHarness';
import {
  candidateKey,
  kindCounts,
  runPrepApply,
  runPrepDetect,
  selectableKeys,
  summarize,
  type PrepDetectReport,
  type PrepDetection,
  type PrepPhase,
  type PrepProgress,
  type PrepReport,
  type ScanMode,
} from '../lib/folder-prep';
import { fileIsEligible, ineligibleReason, type SignedNote } from '../lib/folder-sweep';
import { createFolderPrepIo } from '../lib/folder-prep-io';
import { formatPrepLog, prepLogFileName } from '../lib/folder-prep-log';

// Tools ▸ Prepare Forms in a Folder…: the folder scope of Prepare Form.
//
// Needs NO open document, and never opens one to work: sources are read by
// path, so no workspace entry exists for any of them. The engine is reached
// through `callRaw` for the reason batch OCR does.
//
// GEOMETRY is not edited here. Reviewing a candidate on the page — dragging
// its rectangle, retyping it against what the page shows — is the open
// document's flow and it exists; each file's row hands the document to it
// rather than growing a second review surface for the same candidates.

const SCAN_MODES: readonly ScanMode[] = ['auto', 'never', 'always'];

const SCAN_LABEL_KEY = {
  auto: 'dialog.formPrep.scanAuto',
  never: 'dialog.formPrep.scanNever',
  always: 'dialog.formPrep.scanAlways',
} as const satisfies Record<ScanMode, string>;

const APPLY_VERB_KEY = {
  preparing: 'dialog.formPrep.verbPreparing',
  copying: 'dialog.formPrep.verbCopying',
  skipping: 'dialog.formPrep.verbSkipping',
  // The apply sweep never reports this phase; the detect sweep's own label
  // does not take a verb.
  detecting: 'dialog.formPrep.verbPreparing',
} as const satisfies Record<PrepPhase, string>;

const SIGNED_REASON_KEY = {
  signed: 'dialog.formPrep.reasonSigned',
  'certified-no-changes': 'dialog.formPrep.reasonCertifiedNone',
  'certified-form-fill': 'dialog.formPrep.reasonCertifiedFormFill',
  'certified-annotate': 'dialog.formPrep.reasonCertifiedAnnotate',
  'certified-unknown': 'dialog.formPrep.reasonCertifiedUnknown',
} as const satisfies Record<SignedNote['reason'], string>;

const KIND_KEY: Record<string, Parameters<typeof tChrome>[0]> = {
  text: 'dialog.formPrep.kindText',
  checkbox: 'dialog.formPrep.kindCheckbox',
  radio: 'dialog.formPrep.kindRadio',
  signature: 'dialog.formPrep.kindSignature',
};

/** A kind the review does not have a word for is shown as the detector named
 * it, never dropped. */
function kindLabel(kind: string): string {
  const key = KIND_KEY[kind];
  return key ? tChrome(key) : kind;
}

type Phase = 'setup' | 'detecting' | 'review' | 'applying' | 'done';

export interface FolderFormPrepDialogProps {
  onClose: () => void;
  /** Hand one file to the open-document flow: it opens in the workspace with
   * Prepare Form, where its candidates are reviewable on the page. */
  onReviewInApp: (path: string) => void;
}

export function FolderFormPrepDialog({
  onClose,
  onReviewInApp,
}: FolderFormPrepDialogProps): React.JSX.Element {
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

  const [scan, setScan] = useState<ScanMode>('auto');
  const [langs, setLangs] = useState<string[]>([DEFAULT_OCR_LANGUAGE]);

  // Both invert a default that protects the user's files, so both are off
  // until the user acts: in place rewrites originals, and including signed
  // documents destroys signatures the run cannot put back.
  const [inPlace, setInPlace] = useState(false);
  const [confirmInPlace, setConfirmInPlace] = useState(false);
  const [includeSigned, setIncludeSigned] = useState(false);

  const [detectReport, setDetectReport] = useState<PrepDetectReport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<PrepReport | null>(null);
  const [progress, setProgress] = useState<PrepProgress | null>(null);
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
  const applyBtnRef = useRef<HTMLButtonElement>(null);
  const doneCloseBtnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (phase === 'detecting' || phase === 'applying') stopBtnRef.current?.focus();
    else if (phase === 'review') applyBtnRef.current?.focus();
    else if (phase === 'done') doneCloseBtnRef.current?.focus();
    else sourceBtnRef.current?.focus();
  }, [phase]);

  const ready =
    phase === 'setup' &&
    !scanning &&
    source !== null &&
    (inPlace || (dest !== null && !conflict)) &&
    entries !== null &&
    entries.length > 0;

  const scanLabel = useMemo(
    () => `${scan} (${describeLanguages(langs)})`,
    [scan, langs],
  );

  const writeLog = useCallback(
    async (startedAt: Date, rep: PrepReport, fatalError?: string): Promise<void> => {
      await writeSweepLog(
        prepLogFileName(startedAt),
        formatPrepLog({
          startedAt,
          finishedAt: new Date(),
          sourceRoot: source ?? '',
          destRoot: inPlace ? '' : (dest ?? ''),
          scanLabel,
          includeSigned,
          report: rep,
          ...(fatalError ? { fatalError } : {}),
        }),
      );
    },
    [source, dest, inPlace, scanLabel, includeSigned, writeSweepLog],
  );

  const makeIo = useCallback(async () => {
    const [tesseract, ghostscript, fontDir] = await Promise.all([
      tesseractPath(),
      ghostscriptPath(),
      app.getEditFontPath(),
    ]);
    return createFolderPrepIo(callRaw, { tesseract, ghostscript, fontDir });
  }, [callRaw]);

  const detect = useCallback(async (): Promise<void> => {
    if (!ready || !entries) return;
    setPhase('detecting');
    setError(null);
    setProgress(null);
    setStopping(false);
    setSelected(new Set());
    cancelledRef.current = false;
    try {
      const io = await makeIo();
      const found = await runPrepDetect(
        entries,
        skippedDirs,
        { scan, lang: toTesseractLang(langs) },
        io,
        { onProgress: setProgress, isCancelled: () => cancelledRef.current },
      );
      setDetectReport(found);
      // NOTHING is checked by default. A tool that writes to the user's
      // documents does not pre-consent on their behalf.
      setPhase('review');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('setup');
    }
  }, [ready, entries, skippedDirs, scan, langs, makeIo]);

  const filesWithCandidates = useMemo(
    () => detectReport?.files.filter((f) => f.candidates.length > 0) ?? [],
    [detectReport],
  );
  const filesWithout = useMemo(
    () =>
      detectReport?.files.filter(
        (f) => f.candidates.length === 0 && f.skipReason === null,
      ) ?? [],
    [detectReport],
  );
  const skippedFiles = useMemo(
    () => detectReport?.files.filter((f) => ineligibleReason(f, includeSigned) !== null) ?? [],
    [detectReport, includeSigned],
  );
  const allKeys = useMemo(
    () => selectableKeys(filesWithCandidates, includeSigned),
    [filesWithCandidates, includeSigned],
  );

  const apply = useCallback(async (): Promise<void> => {
    if (!detectReport || selected.size === 0) return;
    setPhase('applying');
    setError(null);
    setProgress(null);
    setStopping(false);
    resetLog();
    cancelledRef.current = false;
    const startedAt = new Date();
    try {
      const io = await makeIo();
      const rep = await runPrepApply(detectReport.files, selected, io, {
        destRoot: inPlace ? '' : (dest ?? ''),
        includeSigned,
        onProgress: setProgress,
        isCancelled: () => cancelledRef.current,
      });
      rep.skippedDirs = detectReport.skippedDirs;
      setReport(rep);
      await writeLog(startedAt, rep);
      setPhase('done');
    } catch (e: unknown) {
      // The driver isolates per-file failures, so reaching here is structural
      // (the engine died). The log is written anyway: a run that failed part
      // way through is exactly the one whose partial record is needed.
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      await writeLog(
        startedAt,
        { cancelled: false, results: [], skippedDirs: detectReport.skippedDirs },
        message,
      );
      setPhase('review');
    }
  }, [detectReport, selected, inPlace, dest, includeSigned, makeIo, writeLog, resetLog]);

  const stop = useCallback((): void => {
    setStopping(true);
    cancelledRef.current = true;
  }, []);

  const runAnother = useCallback((): void => {
    setReport(null);
    setDetectReport(null);
    setSelected(new Set());
    setProgress(null);
    setStopping(false);
    resetLog();
    setPhase('setup');
  }, [resetLog]);

  const toggleOne = useCallback((key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleFile = useCallback((keys: string[]): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      const all = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (all) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);

  // The review list names a document the user is about to change by hand, so
  // it cannot stay open behind it: nothing has been written yet, and a stale
  // list offering rows into a changed file is the one thing this must not do.
  const reviewInApp = useCallback(
    (path: string): void => {
      onReviewInApp(path);
      onClose();
    },
    [onReviewInApp, onClose],
  );

  // Test harness: the native folder pickers cannot be WebDriver-driven, so
  // the harness injects paths into the same selectSource/setDest flow the
  // buttons run, then drives the same detect/apply the buttons call.
  const harnessDeps = { selectSource, setDest, detect, apply, setSelected };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  const stateRef = useRef({ entries, detectReport, report, logPath, allKeys });
  stateRef.current = { entries, detectReport, report, logPath, allKeys };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerFormPrep({
      setSource: (path) => harnessRef.current.selectSource(path),
      setDest: (path) => harnessRef.current.setDest(path),
      detect: () => harnessRef.current.detect(),
      check: (keys) => harnessRef.current.setSelected(new Set(keys)),
      apply: () => harnessRef.current.apply(),
      snapshot: () => ({
        phase: phaseRef.current,
        fileCount: stateRef.current.entries?.length ?? null,
        candidateKeys: stateRef.current.allKeys,
        files:
          stateRef.current.detectReport?.files.map((f) => ({
            rel: f.rel,
            candidates: f.candidates.length,
            existingFields: f.existingFields,
            skipReason: f.skipReason,
            names: f.candidates.map((c) => c.name),
          })) ?? null,
        report: stateRef.current.report,
        logPath: stateRef.current.logPath,
      }),
    });
    return () => registerFormPrep(null);
  }, []);

  // While a sweep runs the first close means "stop"; once a stop is pending a
  // second close abandons the run, which is the escape hatch for an engine
  // call that never returns.
  const running = phase === 'detecting' || phase === 'applying';
  const guardedClose = running ? (stopping ? onClose : stop) : onClose;

  const totals = report ? summarize(report) : null;

  return (
    <SweepShell
      title={tChrome('dialog.formPrep.title')}
      testid="form-prep-dialog"
      closeTestid="form-prep-x"
      onClose={guardedClose}
    >
      {phase === 'setup' && (
        <div className="flex flex-col gap-4">
          <FolderRow
            label={tChrome('dialog.batch.sourceLabel')}
            testid="form-prep-source"
            value={source}
            buttonRef={sourceBtnRef}
            onPick={() => {
              void (async () => {
                const path = await dialog.pickFolder(tChrome('dialog.formPrep.pickSource'));
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

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              data-testid="form-prep-inplace"
              checked={inPlace}
              onChange={() => {
                const next = !inPlace;
                setInPlace(next);
                setConfirmInPlace(false);
                if (next) setDest(null);
              }}
              className="rounded bg-neutral-900 border-neutral-600"
            />
            <span className="text-sm text-neutral-300">{tChrome('dialog.formPrep.inPlace')}</span>
          </label>
          {inPlace ? (
            <p className="text-xs text-amber-400" data-testid="form-prep-inplace-note">
              {tChrome('dialog.formPrep.inPlaceNote')}
            </p>
          ) : (
            <FolderRow
              label={tChrome('dialog.batch.destLabel')}
              testid="form-prep-dest"
              value={dest}
              onPick={() => {
                void (async () => {
                  const path = await dialog.pickFolder(tChrome('dialog.common.pickDest'));
                  if (path) setDest(path);
                })();
              }}
              note={null}
            />
          )}
          {conflict && (
            <p className="text-sm text-red-400" data-testid="form-prep-conflict">
              {tChrome(
                identityConflict
                  ? 'dialog.batch.conflictIdentity'
                  : 'dialog.batch.conflictInside',
              )}
            </p>
          )}

          <fieldset className="border border-neutral-700 rounded p-2">
            <legend className="text-xs text-neutral-400 px-1">
              {tChrome('dialog.formPrep.scan')}
            </legend>
            <div className="flex flex-col gap-1">
              {SCAN_MODES.map((mode) => (
                <label key={mode} className="flex items-center gap-1.5 text-sm text-neutral-300">
                  <input
                    type="radio"
                    name="form-prep-scan"
                    checked={scan === mode}
                    onChange={() => setScan(mode)}
                    data-testid={`form-prep-scan-${mode}`}
                  />
                  {tChrome(SCAN_LABEL_KEY[mode])}
                </label>
              ))}
            </div>
          </fieldset>

          {scan !== 'never' && (
            <div>
              <label className="block text-sm text-neutral-400 mb-1">
                {tChrome('dialog.batch.languages', { summary: describeLanguages(langs) })}
              </label>
              <div
                data-testid="form-prep-lang"
                role="group"
                aria-label={tChrome('dialog.batch.languagesAria')}
                className="max-h-44 overflow-y-auto rounded border border-neutral-700 bg-neutral-800 p-2 grid grid-cols-2 gap-x-3 gap-y-1"
              >
                {OCR_LANGUAGES.map((l) => (
                  <label key={l.code} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid={`form-prep-lang-${l.code}`}
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
            </div>
          )}

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSigned}
                onChange={() => setIncludeSigned((v) => !v)}
                data-testid="form-prep-include-signed"
                className="rounded bg-neutral-900 border-neutral-600"
              />
              <span className="text-sm text-neutral-300">
                {tChrome('dialog.formPrep.includeSigned')}
              </span>
            </label>
            <p className="text-xs text-neutral-500 mt-1">
              {tChrome('dialog.formPrep.includeSignedNote')}
            </p>
          </div>

          <p className="text-xs text-neutral-500">{tChrome('dialog.formPrep.blurb')}</p>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            {inPlace && !confirmInPlace ? (
              <button
                type="button"
                disabled={!ready}
                onClick={() => setConfirmInPlace(true)}
                data-testid="form-prep-inplace-confirm"
                className="px-4 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded text-sm font-medium"
              >
                {tChrome('dialog.formPrep.inPlaceConfirm')}
              </button>
            ) : (
              <button
                type="button"
                disabled={!ready}
                onClick={() => void detect()}
                data-testid="form-prep-detect"
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
              >
                {tChrome('dialog.formPrep.detect')}
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'detecting' && (
        <RunningView
          label={
            progress
              ? tChrome('dialog.formPrep.detectProgress', {
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
          testid="form-prep-detecting"
          stopTestid="form-prep-stop"
        />
      )}

      {phase === 'applying' && (
        <RunningView
          label={
            progress
              ? tChrome('dialog.formPrep.applyProgress', {
                  index: progress.fileIndex + 1,
                  count: progress.fileCount,
                  rel: progress.rel,
                  verb: tChrome(APPLY_VERB_KEY[progress.phase]),
                })
              : tChrome('dialog.batch.progressStarting')
          }
          fileIndex={progress?.fileIndex ?? null}
          fileCount={progress?.fileCount ?? 0}
          stopping={stopping}
          onStop={stop}
          buttonRef={stopBtnRef}
          testid="form-prep-applying"
          stopTestid="form-prep-stop"
        />
      )}

      {phase === 'review' && detectReport && (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-neutral-300">
            {tChromeCount('dialog.formPrep.found', filesWithCandidates.length)}
            {' · '}
            {tChromeCount(
              'dialog.formPrep.candidates',
              filesWithCandidates.reduce((sum, f) => sum + f.candidates.length, 0),
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set(allKeys))}
              data-testid="form-prep-check-all"
              className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
            >
              {tChrome('dialog.formPrep.checkAll')}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
            >
              {tChrome('dialog.formPrep.uncheckAll')}
            </button>
          </div>

          <div className="flex-1 min-h-0 max-h-[45vh] overflow-auto" data-testid="form-prep-results">
            {filesWithCandidates.map((file) => (
              <FileGroup
                key={file.abs}
                file={file}
                includeSigned={includeSigned}
                selected={selected}
                onToggleFile={toggleFile}
                onToggleOne={toggleOne}
                onReview={reviewInApp}
              />
            ))}
            {filesWithCandidates.length === 0 && (
              <p className="text-sm text-neutral-500" data-testid="form-prep-none">
                {tChrome('dialog.formPrep.noCandidates')}
              </p>
            )}
          </div>

          {/* A file the detector offered nothing for is a RESULT, not silence:
              an already-prepared form is the ordinary case, and it says so
              with the field count it already carries. */}
          {filesWithout.length > 0 && (
            <div className="text-xs text-neutral-500" data-testid="form-prep-nothing-offered">
              {filesWithout.map((file) => (
                <div key={file.abs} className="truncate">
                  {file.existingFields > 0
                    ? tChrome('dialog.formPrep.alreadyPrepared', {
                        rel: file.rel,
                        count: file.existingFields,
                      })
                    : tChrome('dialog.formPrep.nothingFound', { rel: file.rel })}
                </div>
              ))}
            </div>
          )}

          {skippedFiles.length > 0 && (
            <div className="text-xs text-amber-400" data-testid="form-prep-skipped">
              {skippedFiles.map((file) => (
                <div key={file.abs} className="truncate">
                  {tChrome('dialog.formPrep.fileSkipped', {
                    rel: file.rel,
                    reason:
                      file.skipReason ??
                      (file.signed ? tChrome(SIGNED_REASON_KEY[file.signed.reason]) : ''),
                  })}
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={runAnother}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
            >
              {tChrome('dialog.formPrep.backToSetup')}
            </button>
            <button
              type="button"
              ref={applyBtnRef}
              disabled={selected.size === 0}
              onClick={() => void apply()}
              data-testid="form-prep-apply"
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-sm font-medium"
            >
              {tChromeCount('dialog.formPrep.apply', selected.size)}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && report && totals && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-200" data-testid="form-prep-summary">
            {report.cancelled
              ? tChrome('dialog.formPrep.stoppedPrefix', { summary: summaryText(totals) })
              : summaryText(totals)}
          </p>
          {report.cancelled && (
            <p className="text-xs text-amber-400">{tChrome('dialog.formPrep.cancelledNote')}</p>
          )}
          <p className="text-xs text-neutral-400">
            {tChromeCount('dialog.formPrep.sumFields', totals.fields)}
          </p>

          <div className="max-h-[40vh] overflow-auto text-xs text-neutral-400 flex flex-col gap-0.5">
            {report.results
              .filter((r) => r.status === 'skipped')
              .map((r) => (
                <div key={r.rel} className="text-amber-400 truncate">
                  {tChrome('dialog.formPrep.fileSkipped', {
                    rel: r.rel,
                    reason: r.reason ?? '',
                  })}
                </div>
              ))}
            {report.results
              .filter((r) => r.fields !== undefined)
              .map((r) => (
                <div key={r.rel} className="truncate">
                  {tChrome('dialog.formPrep.rowWritten', {
                    rel: r.rel,
                    fields: tChromeCount('dialog.formPrep.sumFields', r.fields ?? 0),
                  })}
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
              {tChrome('dialog.formPrep.again')}
            </button>
            <button
              type="button"
              ref={doneCloseBtnRef}
              onClick={onClose}
              data-testid="form-prep-close"
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
    tChrome('dialog.formPrep.sumPrepared', { count: totals.prepared }),
    tChrome('dialog.formPrep.sumCopied', { count: totals.copied }),
    tChrome('dialog.formPrep.sumUnchanged', { count: totals.unchanged }),
    tChrome('dialog.formPrep.sumSkipped', { count: totals.skipped }),
  ].join(' · ');
}

function FileGroup({
  file,
  includeSigned,
  selected,
  onToggleFile,
  onToggleOne,
  onReview,
}: {
  file: PrepDetection;
  includeSigned: boolean;
  selected: ReadonlySet<string>;
  onToggleFile: (keys: string[]) => void;
  onToggleOne: (key: string) => void;
  onReview: (path: string) => void;
}): React.JSX.Element {
  const eligible = fileIsEligible(file, includeSigned);
  const keys = eligible ? file.candidates.map((c) => candidateKey(file.abs, c)) : [];
  const checked = keys.filter((key) => selected.has(key)).length;
  const state = checked === 0 ? 'none' : checked === keys.length ? 'all' : 'some';
  const counts = kindCounts(file.candidates);
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 text-sm text-neutral-200 sticky top-0 bg-neutral-900 py-1">
        <input
          type="checkbox"
          checked={state === 'all'}
          ref={(el) => {
            if (el) el.indeterminate = state === 'some';
          }}
          disabled={!eligible}
          onChange={() => onToggleFile(keys)}
          data-testid={`form-prep-file-check-${file.rel}`}
        />
        <span className="truncate" title={file.abs}>
          {file.rel}
        </span>
        <span className="text-xs text-neutral-500">
          {tChromeCount('dialog.formPrep.candidates', file.candidates.length)}
        </span>
        <button
          type="button"
          onClick={() => onReview(file.abs)}
          data-testid={`form-prep-review-${file.rel}`}
          className="ml-auto text-xs underline text-neutral-400 hover:text-neutral-200 shrink-0"
        >
          {tChrome('dialog.formPrep.reviewInApp')}
        </button>
      </div>
      <div className="text-xs text-neutral-500 pl-5">
        {Object.entries(counts)
          .map(([kind, count]) => `${count} × ${kindLabel(kind)}`)
          .join(' · ')}
      </div>
      {file.existingFields > 0 && (
        <div className="text-xs text-neutral-500 pl-5">
          {tChromeCount('dialog.formPrep.existingFields', file.existingFields)}
        </div>
      )}
      {file.truncated && (
        <div className="text-xs text-amber-400 pl-5">{tChrome('dialog.formPrep.truncated')}</div>
      )}
      {file.candidates.map((candidate) => {
        const key = candidateKey(file.abs, candidate);
        return (
          <label
            key={key}
            className="flex items-start gap-1.5 pl-6 py-0.5 text-sm hover:bg-neutral-800 rounded"
          >
            <input
              type="checkbox"
              checked={selected.has(key)}
              disabled={!eligible}
              onChange={() => onToggleOne(key)}
              data-testid={`form-prep-candidate-${file.rel}-${candidate.index}`}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="text-neutral-200">{candidate.name}</span>
              <span className="block text-xs text-neutral-500 truncate">
                {tChrome('dialog.formPrep.candidateNote', {
                  kind: kindLabel(candidate.kind),
                  page: candidate.page,
                  label: candidate.label ?? tChrome('dialog.formPrep.noLabel'),
                })}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
