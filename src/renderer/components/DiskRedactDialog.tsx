import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEngine } from '../hooks/useEngine';
import { FolderRow, RunningView, SweepShell } from './FolderSweepUi';
import { useSweepFolders } from '../hooks/useSweepFolders';
import { useSweepLog } from '../hooks/useSweepLog';
import { dialog, app } from '../lib/tauri-bridge';
import { FindModeToggles } from '../search/FindModeToggles';
import { RedactionPropertiesFields } from './RedactionPropertiesFields';
import { tChrome, tChromeCount } from '../i18n';
import { TEST_HARNESS_ENABLED, registerDiskRedact } from '../testHarness';
import type { SearchOptions } from '../search/normalize';
import {
  EXPAND_MODES,
  PATTERN_IDS,
  groupByPage,
  groupState,
  hitKey,
  parseWordList,
  requestIsEmpty,
  toggleGroup,
  toggleOne,
  type ExpandMode,
  type PatternId,
  type SearchRequest,
} from '../lib/search-redact';
import {
  fileIsEligible,
  ineligibleReason,
  runDiskApply,
  runDiskSearch,
  selectableKeys,
  summarize,
  type DiskPhase,
  type DiskProgress,
  type DiskRedactReport,
  type DiskSearchReport,
  type DiskSearchResult,
  type SignedNote,
} from '../lib/disk-redact';
import { createDiskRedactIo } from '../lib/disk-redact-io';
import { claimOutputRoot } from '../lib/output-root-claim';
import { diskRedactLogFileName, formatDiskRedactLog } from '../lib/disk-redact-log';

// Tools ▸ Search & Redact Folder…: the disk scope of Search & Redact.
//
// Needs NO open document, and never opens one: sources are read by path, so
// no workspace entry exists for any of them. The engine is reached through
// `callRaw` for the reason batch OCR does — the commit gate exists to make
// the engine read bytes matching a document on screen, and there is none here.
//
// The panel's scope stops at the open documents deliberately: it renders
// nothing without an active file, its rects become marks through the canvas's
// own conversion, and its rows jump the camera to a page. None of that exists
// for a folder, which is why this is a dialog with its own phases rather than
// a third option on the panel's scope menu.

const MAX_HITS = 50000;

type Phase = 'setup' | 'searching' | 'review' | 'applying' | 'done';

const APPLY_VERB_KEY = {
  redacting: 'dialog.diskRedact.verbRedacting',
  marking: 'dialog.diskRedact.verbMarking',
  copying: 'dialog.diskRedact.verbCopying',
  skipping: 'dialog.diskRedact.verbSkipping',
  // The apply sweep never reports this phase; the search sweep's own label
  // does not take a verb.
  searching: 'dialog.diskRedact.verbRedacting',
} as const satisfies Record<DiskPhase, string>;

const SIGNED_REASON_KEY = {
  signed: 'dialog.diskRedact.reasonSigned',
  'certified-no-changes': 'dialog.diskRedact.reasonCertifiedNone',
  'certified-form-fill': 'dialog.diskRedact.reasonCertifiedFormFill',
  'certified-annotate': 'dialog.diskRedact.reasonCertifiedAnnotate',
  'certified-unknown': 'dialog.diskRedact.reasonCertifiedUnknown',
} as const satisfies Record<SignedNote['reason'], string>;

export interface DiskRedactDialogProps {
  onClose: () => void;
}

export function DiskRedactDialog({ onClose }: DiskRedactDialogProps): React.JSX.Element {
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

  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>({});
  const [wordList, setWordList] = useState('');
  const [showWordList, setShowWordList] = useState(false);
  const [patterns, setPatterns] = useState<Set<PatternId>>(new Set());
  const [expand, setExpand] = useState<ExpandMode>('match');
  const [showProperties, setShowProperties] = useState(false);

  // Both invert a default that protects the user's files, so both are off
  // until the user acts: in place rewrites originals, and including signed
  // documents destroys signatures the run cannot put back.
  const [inPlace, setInPlace] = useState(false);
  const [confirmInPlace, setConfirmInPlace] = useState(false);
  const [marksOnly, setMarksOnly] = useState(false);
  const [includeSigned, setIncludeSigned] = useState(false);

  const [searchReport, setSearchReport] = useState<DiskSearchReport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<DiskRedactReport | null>(null);
  const [progress, setProgress] = useState<DiskProgress | null>(null);
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
    if (phase === 'searching' || phase === 'applying') stopBtnRef.current?.focus();
    else if (phase === 'review') applyBtnRef.current?.focus();
    else if (phase === 'done') doneCloseBtnRef.current?.focus();
    else sourceBtnRef.current?.focus();
  }, [phase]);

  const buildRequest = useCallback(
    (text: string): SearchRequest => ({
      query: text,
      terms: parseWordList(wordList),
      patterns: [...patterns],
      options,
      expand,
      pages: null,
      maxHits: MAX_HITS,
    }),
    [wordList, patterns, options, expand],
  );
  const request = useMemo(() => buildRequest(query), [buildRequest, query]);

  const foldersReady =
    phase === 'setup' &&
    !scanning &&
    source !== null &&
    (inPlace || (dest !== null && !conflict)) &&
    entries !== null &&
    entries.length > 0;
  const canSearch = foldersReady && !requestIsEmpty(request);

  const searchLabel = useMemo(() => {
    const parts: string[] = [];
    if (request.query.trim()) parts.push(request.query.trim());
    if (request.terms.length > 0) parts.push(`${request.terms.length} word-list terms`);
    if (request.patterns.length > 0) parts.push(request.patterns.join(', '));
    return parts.join(' · ');
  }, [request]);

  const writeLog = useCallback(
    async (startedAt: Date, rep: DiskRedactReport, fatalError?: string): Promise<void> => {
      await writeSweepLog(
        diskRedactLogFileName(startedAt),
        formatDiskRedactLog({
          startedAt,
          finishedAt: new Date(),
          sourceRoot: source ?? '',
          destRoot: inPlace ? '' : (dest ?? ''),
          searchLabel,
          marksOnly,
          includeSigned,
          report: rep,
          ...(fatalError ? { fatalError } : {}),
        }),
      );
    },
    [source, dest, inPlace, searchLabel, marksOnly, includeSigned, writeSweepLog],
  );

  const makeIo = useCallback(
    async () => createDiskRedactIo(callRaw, await app.getEditFontPath()),
    [callRaw],
  );

  // The query may arrive WITH the call rather than from state: a caller that
  // sets the field and starts the search in one go would otherwise run the
  // previous render's (empty) request, since a state update is not visible to
  // the closure that scheduled it.
  const runSearch = useCallback(async (queryOverride?: string): Promise<void> => {
    const active = queryOverride === undefined ? request : buildRequest(queryOverride);
    if (!foldersReady || !entries || requestIsEmpty(active)) return;
    setPhase('searching');
    setError(null);
    setProgress(null);
    setStopping(false);
    setSelected(new Set());
    cancelledRef.current = false;
    try {
      const io = await makeIo();
      const found = await runDiskSearch(entries, skippedDirs, active, marksOnly, io, {
        onProgress: setProgress,
        isCancelled: () => cancelledRef.current,
      });
      setSearchReport(found);
      // NOTHING is checked by default. A destructive tool does not pre-consent
      // on the user's behalf, and a folder sweep is the case where that would
      // matter most.
      setPhase('review');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('setup');
    }
  }, [foldersReady, entries, skippedDirs, request, buildRequest, marksOnly, makeIo]);

  const filesWithHits = useMemo(
    () => searchReport?.files.filter((f) => f.hits.length > 0) ?? [],
    [searchReport],
  );
  const skippedFiles = useMemo(
    () =>
      searchReport?.files.filter(
        (f) => ineligibleReason(f, includeSigned) !== null,
      ) ?? [],
    [searchReport, includeSigned],
  );
  const allKeys = useMemo(
    () => selectableKeys(filesWithHits, includeSigned),
    [filesWithHits, includeSigned],
  );

  const apply = useCallback(async (): Promise<void> => {
    if (!searchReport || selected.size === 0) return;
    // An in-place run has no output tree to own; a mirrored one does, and two
    // windows writing the same tree overwrite each other file by file.
    const root = await claimOutputRoot(inPlace ? '' : (dest ?? ''));
    if (!root.granted) {
      setError(root.message);
      return;
    }
    setPhase('applying');
    setError(null);
    setProgress(null);
    setStopping(false);
    resetLog();
    cancelledRef.current = false;
    const startedAt = new Date();
    try {
      const io = await makeIo();
      const rep = await runDiskApply(searchReport.files, selected, io, {
        destRoot: inPlace ? '' : (dest ?? ''),
        marksOnly,
        includeSigned,
        onProgress: setProgress,
        isCancelled: () => cancelledRef.current,
      });
      rep.skippedDirs = searchReport.skippedDirs;
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
        { cancelled: false, results: [], skippedDirs: searchReport.skippedDirs },
        message,
      );
      setPhase('review');
    } finally {
      await root.release();
    }
  }, [searchReport, selected, inPlace, dest, marksOnly, includeSigned, makeIo, writeLog, resetLog]);

  const stop = useCallback((): void => {
    setStopping(true);
    cancelledRef.current = true;
  }, []);

  const runAnother = useCallback((): void => {
    setReport(null);
    setSearchReport(null);
    setSelected(new Set());
    setProgress(null);
    setStopping(false);
    resetLog();
    setPhase('setup');
  }, [resetLog]);

  // Test harness: the native folder pickers cannot be WebDriver-driven, so
  // the harness injects paths into the same selectSource/setDest flow the
  // buttons run, then drives the same search/apply the buttons call.
  const harnessDeps = { selectSource, setDest, setQuery, runSearch, apply, setSelected };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  const stateRef = useRef({ entries, searchReport, report, logPath, allKeys });
  stateRef.current = { entries, searchReport, report, logPath, allKeys };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerDiskRedact({
      setSource: (path) => harnessRef.current.selectSource(path),
      setDest: (path) => harnessRef.current.setDest(path),
      setQuery: (text) => harnessRef.current.setQuery(text),
      // The query rides WITH the call: a caller that sets the field and starts
      // the search in one round trip has not re-rendered in between.
      search: (text) => harnessRef.current.runSearch(text),
      check: (keys) => harnessRef.current.setSelected(new Set(keys)),
      apply: () => harnessRef.current.apply(),
      snapshot: () => ({
        phase: phaseRef.current,
        fileCount: stateRef.current.entries?.length ?? null,
        hitKeys: stateRef.current.allKeys,
        files:
          stateRef.current.searchReport?.files.map((f) => ({
            rel: f.rel,
            hits: f.hits.length,
            skipReason: f.skipReason,
          })) ?? null,
        report: stateRef.current.report,
        logPath: stateRef.current.logPath,
      }),
    });
    return () => registerDiskRedact(null);
  }, []);

  // While a sweep runs the first close means "stop"; once a stop is pending a
  // second close abandons the run, which is the escape hatch for an engine
  // call that never returns.
  const running = phase === 'searching' || phase === 'applying';
  const guardedClose = running ? (stopping ? onClose : stop) : onClose;

  const totals = report ? summarize(report) : null;

  return (
    <SweepShell
      title={tChrome('dialog.diskRedact.title')}
      testid="disk-redact-dialog"
      closeTestid="disk-redact-x"
      onClose={guardedClose}
    >
      {phase === 'setup' && (
        <div className="flex flex-col gap-4">
          <FolderRow
            label={tChrome('dialog.batch.sourceLabel')}
            testid="disk-redact-source"
            value={source}
            buttonRef={sourceBtnRef}
            onPick={() => {
              void (async () => {
                const path = await dialog.pickFolder(tChrome('dialog.diskRedact.pickSource'));
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
              data-testid="disk-redact-inplace"
              checked={inPlace}
              onChange={() => {
                const next = !inPlace;
                setInPlace(next);
                setConfirmInPlace(false);
                if (next) setDest(null);
              }}
              className="rounded bg-neutral-900 border-neutral-600"
            />
            <span className="text-sm text-neutral-300">{tChrome('dialog.diskRedact.inPlace')}</span>
          </label>
          {inPlace ? (
            <p className="text-xs text-amber-400" data-testid="disk-redact-inplace-note">
              {tChrome('dialog.diskRedact.inPlaceNote')}
            </p>
          ) : (
            <FolderRow
              label={tChrome('dialog.batch.destLabel')}
              testid="disk-redact-dest"
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
            <p className="text-sm text-red-400" data-testid="disk-redact-conflict">
              {tChrome(
                identityConflict
                  ? 'dialog.batch.conflictIdentity'
                  : 'dialog.batch.conflictInside',
              )}
            </p>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tChrome('panel.searchRedact.queryPlaceholder')}
              aria-label={tChrome('panel.searchRedact.queryAria')}
              data-testid="disk-redact-query"
              className="flex-1 min-w-0 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
            <FindModeToggles
              options={options}
              onToggle={(key) => setOptions((prev) => ({ ...prev, [key]: !prev[key] }))}
              testIdPrefix="disk-redact-mode"
            />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowWordList((v) => !v)}
              data-testid="disk-redact-wordlist-toggle"
              aria-expanded={showWordList}
              className="text-sm text-neutral-300 hover:text-white"
            >
              <span aria-hidden="true">{showWordList ? '▾' : '▸'}</span>{' '}
              {tChrome('panel.searchRedact.wordList')}
            </button>
            {showWordList && (
              <textarea
                value={wordList}
                onChange={(e) => setWordList(e.target.value)}
                rows={3}
                placeholder={tChrome('panel.searchRedact.wordListPlaceholder')}
                aria-label={tChrome('panel.searchRedact.wordListAria')}
                data-testid="disk-redact-wordlist"
                className="mt-1 w-full px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm font-mono resize-y"
              />
            )}
          </div>

          <fieldset className="border border-neutral-700 rounded p-2">
            <legend className="text-xs text-neutral-400 px-1">
              {tChrome('panel.searchRedact.patterns')}
            </legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {PATTERN_IDS.map((id) => (
                <label key={id} className="flex items-center gap-1.5 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    checked={patterns.has(id)}
                    onChange={() =>
                      setPatterns((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                    data-testid={`disk-redact-pattern-${id}`}
                  />
                  {tChrome(`panel.searchRedact.pattern.${id}` as Parameters<typeof tChrome>[0])}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="border border-neutral-700 rounded p-2">
            <legend className="text-xs text-neutral-400 px-1">
              {tChrome('panel.searchRedact.expand')}
            </legend>
            <div className="flex flex-col gap-1">
              {EXPAND_MODES.map((mode) => (
                <label key={mode} className="flex items-center gap-1.5 text-sm text-neutral-300">
                  <input
                    type="radio"
                    name="disk-redact-expand"
                    checked={expand === mode}
                    onChange={() => setExpand(mode)}
                    data-testid={`disk-redact-expand-${mode}`}
                  />
                  {tChrome(`panel.searchRedact.expand.${mode}` as Parameters<typeof tChrome>[0])}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="border border-neutral-700 rounded p-2">
            <legend className="text-xs text-neutral-400 px-1">
              {tChrome('dialog.diskRedact.mode')}
            </legend>
            <div className="flex flex-col gap-1">
              <label className="flex items-start gap-1.5 text-sm text-neutral-300">
                <input
                  type="radio"
                  name="disk-redact-write"
                  checked={!marksOnly}
                  onChange={() => setMarksOnly(false)}
                  data-testid="disk-redact-mode-apply"
                  className="mt-1"
                />
                <span>
                  {tChrome('dialog.diskRedact.modeApply')}
                  <span className="block text-xs text-neutral-500">
                    {tChrome('dialog.diskRedact.modeApplyHint')}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-1.5 text-sm text-neutral-300">
                <input
                  type="radio"
                  name="disk-redact-write"
                  checked={marksOnly}
                  onChange={() => setMarksOnly(true)}
                  data-testid="disk-redact-mode-marks"
                  className="mt-1"
                />
                <span>
                  {tChrome('dialog.diskRedact.modeMarks')}
                  <span className="block text-xs text-neutral-500">
                    {tChrome('dialog.diskRedact.modeMarksHint')}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSigned}
                onChange={() => setIncludeSigned((v) => !v)}
                data-testid="disk-redact-include-signed"
                className="rounded bg-neutral-900 border-neutral-600"
              />
              <span className="text-sm text-neutral-300">
                {tChrome('dialog.diskRedact.includeSigned')}
              </span>
            </label>
            <p className="text-xs text-neutral-500 mt-1">
              {tChrome('dialog.diskRedact.includeSignedNote')}
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowProperties((v) => !v)}
              data-testid="disk-redact-properties-toggle"
              aria-expanded={showProperties}
              className="text-sm text-neutral-300 hover:text-white"
            >
              <span aria-hidden="true">{showProperties ? '▾' : '▸'}</span>{' '}
              {tChrome('panel.searchRedact.properties')}
            </button>
            {/* The same persisted record the canvas band and the panel read:
                a code chosen anywhere is on the folder run too. */}
            {showProperties && <RedactionPropertiesFields />}
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            {inPlace && !confirmInPlace ? (
              <button
                type="button"
                disabled={!canSearch}
                onClick={() => setConfirmInPlace(true)}
                data-testid="disk-redact-inplace-confirm"
                className="px-4 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-60 rounded text-sm font-medium"
              >
                {tChrome('dialog.diskRedact.inPlaceConfirm')}
              </button>
            ) : (
              <button
                type="button"
                disabled={!canSearch}
                onClick={() => void runSearch()}
                data-testid="disk-redact-search"
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
              >
                {tChrome('dialog.diskRedact.search')}
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'searching' && (
        <RunningView
          label={
            progress
              ? tChrome('dialog.diskRedact.searchProgress', {
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
          testid="disk-redact-searching"
          stopTestid="disk-redact-stop"
        />
      )}

      {phase === 'applying' && (
        <RunningView
          label={
            progress
              ? tChrome('dialog.diskRedact.applyProgress', {
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
          testid="disk-redact-applying"
          stopTestid="disk-redact-stop"
        />
      )}

      {phase === 'review' && searchReport && (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-neutral-300">
            {tChromeCount('dialog.diskRedact.found', filesWithHits.length)}
            {' · '}
            {tChromeCount(
              'dialog.diskRedact.hits',
              filesWithHits.reduce((sum, f) => sum + f.hits.length, 0),
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set(allKeys))}
              data-testid="disk-redact-check-all"
              className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
            >
              {tChrome('dialog.diskRedact.checkAll')}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
            >
              {tChrome('dialog.diskRedact.uncheckAll')}
            </button>
          </div>

          <div
            className="flex-1 min-h-0 max-h-[45vh] overflow-auto"
            data-testid="disk-redact-results"
          >
            {filesWithHits.map((file) => (
              <FileGroup
                key={file.abs}
                file={file}
                includeSigned={includeSigned}
                selected={selected}
                onToggleGroup={(keys) => setSelected((prev) => toggleGroup(keys, prev))}
                onToggleOne={(key) => setSelected((prev) => toggleOne(key, prev))}
              />
            ))}
            {filesWithHits.length === 0 && (
              <p className="text-sm text-neutral-500" data-testid="disk-redact-none">
                {tChrome('dialog.diskRedact.noHits')}
              </p>
            )}
          </div>

          {skippedFiles.length > 0 && (
            <div className="text-xs text-amber-400" data-testid="disk-redact-skipped">
              {skippedFiles.map((file) => (
                <div key={file.abs} className="truncate">
                  {tChrome('dialog.diskRedact.fileSkipped', {
                    rel: file.rel,
                    reason:
                      file.skipReason ??
                      (file.signed
                        ? tChrome(SIGNED_REASON_KEY[file.signed.reason])
                        : ''),
                  })}
                </div>
              ))}
            </div>
          )}

          {/* An invalid regex is REPORTED by the engine rather than raised, so
              without this a bad pattern reads as "nothing matched" — the one
              wrong answer a search tool must not give. */}
          {searchReport.files.find((f) => f.error) && (
            <p className="text-sm text-red-400" data-testid="disk-redact-search-error">
              {searchReport.files.find((f) => f.error)?.error}
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={runAnother}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
            >
              {tChrome('dialog.diskRedact.backToSetup')}
            </button>
            <button
              type="button"
              ref={applyBtnRef}
              disabled={selected.size === 0}
              onClick={() => void apply()}
              data-testid="disk-redact-apply"
              className="text-sm danger-action"
            >
              {tChromeCount(
                marksOnly ? 'dialog.diskRedact.applyMarks' : 'dialog.diskRedact.apply',
                selected.size,
              )}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && report && totals && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-200" data-testid="disk-redact-summary">
            {report.cancelled
              ? tChrome('dialog.diskRedact.stoppedPrefix', {
                  summary: summaryText(totals),
                })
              : summaryText(totals)}
          </p>
          {report.cancelled && (
            <p className="text-xs text-amber-400">{tChrome('dialog.diskRedact.cancelledNote')}</p>
          )}
          <p className="text-xs text-neutral-400">
            {tChromeCount('dialog.diskRedact.sumRegions', totals.regions)}
          </p>

          <div className="max-h-[40vh] overflow-auto text-xs text-neutral-400 flex flex-col gap-0.5">
            {report.results
              .filter((r) => r.status === 'skipped')
              .map((r) => (
                <div key={r.rel} className="text-amber-400 truncate">
                  {tChrome('dialog.diskRedact.fileSkipped', {
                    rel: r.rel,
                    reason: r.reason ?? '',
                  })}
                </div>
              ))}
            {report.results
              .filter((r) => r.regions !== undefined)
              .map((r) => (
                <div key={r.rel} className="truncate">
                  {tChrome('dialog.diskRedact.rowWritten', {
                    rel: r.rel,
                    regions: tChromeCount('dialog.diskRedact.sumRegions', r.regions ?? 0),
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
              {tChrome('dialog.diskRedact.again')}
            </button>
            <button
              type="button"
              ref={doneCloseBtnRef}
              onClick={onClose}
              data-testid="disk-redact-close"
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
    tChrome('dialog.diskRedact.sumRedacted', { count: totals.redacted }),
    tChrome('dialog.diskRedact.sumMarked', { count: totals.marked }),
    tChrome('dialog.diskRedact.sumCopied', { count: totals.copied }),
    tChrome('dialog.diskRedact.sumUnchanged', { count: totals.unchanged }),
    tChrome('dialog.diskRedact.sumSkipped', { count: totals.skipped }),
  ].join(' · ');
}

function FileGroup({
  file,
  includeSigned,
  selected,
  onToggleGroup,
  onToggleOne,
}: {
  file: DiskSearchResult;
  includeSigned: boolean;
  selected: ReadonlySet<string>;
  onToggleGroup: (keys: string[]) => void;
  onToggleOne: (key: string) => void;
}): React.JSX.Element {
  const eligible = fileIsEligible(file, includeSigned);
  const keys = eligible ? file.hits.map((hit) => hitKey(file.abs, hit)) : [];
  const state = groupState(keys, selected);
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
          onChange={() => onToggleGroup(keys)}
          data-testid={`disk-redact-file-check-${file.rel}`}
        />
        <span className="truncate" title={file.abs}>
          {file.rel}
        </span>
        <span className="text-xs text-neutral-500">
          {tChromeCount('dialog.diskRedact.hits', file.hits.length)}
        </span>
      </div>
      {file.pagesWithoutText.length > 0 && (
        <div className="text-xs text-amber-400 mb-1">
          {tChromeCount('panel.searchRedact.pagesWithoutText', file.pagesWithoutText.length)}
        </div>
      )}
      {groupByPage(file.hits).map((group) => (
        <div key={group.page} className="mb-1">
          <div className="text-xs text-neutral-500 ps-4">
            {tChrome('panel.searchRedact.page', { page: group.page })}
          </div>
          {group.hits.map((hit) => {
            const key = hitKey(file.abs, hit);
            return (
              <label
                key={key}
                className="flex items-start gap-1.5 ps-6 py-0.5 text-sm hover:bg-neutral-800 rounded"
              >
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  disabled={!eligible}
                  onChange={() => onToggleOne(key)}
                  data-testid={`disk-redact-hit-${file.rel}-${hit.page}-${hit.index}`}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="text-neutral-200">{hit.text}</span>
                  <span className="block text-xs text-neutral-500 truncate">{hit.context}</span>
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
