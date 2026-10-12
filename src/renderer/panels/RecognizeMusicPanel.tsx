import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppState, useReadAppState } from '../state/AppStateProvider';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { useOperationQueue } from '../hooks/useOperationQueue';
import { useOwnedOperationRun } from '../hooks/useOwnedOperationRun';
import { useAudiverisStatus } from '../hooks/useAudiverisStatus';
import { selectedPageNumbers } from '../state/selectors';
import { runCommitGate } from '../lib/commit-gate';
import { EDIT_DECLINED } from '../lib/edit-text';
import { formatPageRange, parsePageRangeField } from '../lib/page-range';
import { audiveris, file as fileIO } from '../lib/tauri-bridge';
import { audiverisBlocked, audiverisReady } from '../lib/audiveris-status';
import {
  DEFAULT_MUSIC_FORMAT,
  MUSIC_FORMATS,
  OMR_DPI_DEFAULT,
  OMR_DPI_MAX,
  OMR_DPI_MIN,
  OMR_DPI_SMALL_NOTATION,
  defaultScorePath,
  dpiInRange,
  openProjectRefusalKey,
  ocrLanguageSpec,
  pathBaseName,
  scoreFileNames,
  splitScoreDestination,
  unrestoredOutputs,
  type UnrestoredOutput,
  type MusicFormat,
  type RecognizeMusicRequest,
  type RecognizeMusicResult,
} from '../lib/recognize-music';
import {
  confirmPublish,
  documentRevision,
  sameRevision,
  startRecognition,
  type DocumentRevision,
  type PendingPublish,
  type RecognizeMusicIo,
  type RecognizeMusicOutcome,
} from '../lib/recognize-music-flow';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { AudiverisRequiredNotice } from '../components/AudiverisRequiredNotice';
import { formattingLocale, tChrome, tOcrLanguage, type UiKey } from '../i18n';
import type { PanelKey } from '../i18n-panels';

const FORMAT_LABELS: Record<MusicFormat, PanelKey> = {
  mxl: 'panel.omr.formatMxl',
  musicxml: 'panel.omr.formatMusicxml',
};

/** A publish waiting for the user to consent to replacing `publish.names`,
 * offered against `revision` of the document at `path`. */
interface PendingConsent {
  publish: PendingPublish;
  path: string;
  revision: DocumentRevision | null;
  /** The revision the stage was prepared from; an attach needs it unchanged. */
  prepared: DocumentRevision | null;
}

/** The document revision a run was prepared from, filled in once prepare
 * answers. */
interface Prepared {
  revision: DocumentRevision | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RecognizeMusicPanel(): React.ReactElement {
  useTranslation();
  const state = useAppState();
  const readState = useReadAppState();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, callRaw, saveFile } = useEngine();
  const { track } = useOperationQueue();
  const { performOperation } = useOperations();
  const beginRun = useOwnedOperationRun(activeFile);
  const audiverisStatus = useAudiverisStatus();
  const blocked = audiverisBlocked(audiverisStatus);
  const ready = audiverisReady(audiverisStatus);

  const [pageInput, setPageInput] = useState(() => {
    const selected = selectedPageNumbers(state);
    return selected.length ? formatPageRange(selected) : 'all';
  });
  const [format, setFormat] = useState<MusicFormat>(DEFAULT_MUSIC_FORMAT);
  const [dpi, setDpi] = useState(String(OMR_DPI_DEFAULT));
  const [languages, setLanguages] = useState<ReadonlySet<string>>(() => new Set());
  const [keepProject, setKeepProject] = useState(false);
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<{ path: string; value: RecognizeMusicResult } | null>(null);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const [failedLog, setFailedLog] = useState<string | null>(null);
  const [unrestored, setUnrestored] = useState<UnrestoredOutput[]>([]);
  const abort = useRef<AbortController | null>(null);
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const mounted = useRef(true);

  const discard = useCallback((token: string) => {
    void callRaw('recognize_music_discard', { token }).catch(() => {});
  }, [callRaw]);

  /** Drop the waiting publish and its stage. */
  const dropConsent = useCallback((reason: PanelKey | null) => {
    const waiting = consentRef.current;
    if (!waiting) return;
    consentRef.current = null;
    setConsent(null);
    discard(waiting.publish.token);
    if (reason) setStatus(tChrome(reason));
  }, [discard]);

  const path = activeFile?.path ?? null;
  const pathRef = useRef(path);
  pathRef.current = path;
  /** Status text for the run on `sourcePath`, shown only while that document
   * is the one on screen. */
  const sayFor = useCallback((sourcePath: string, text: string) => {
    if (pathRef.current === sourcePath) setStatus(text);
  }, []);
  useEffect(() => {
    setStatus('');
    setFailedLog(null);
    setUnrestored([]);
    dropConsent(null);
  }, [path, dropConsent]);

  useEffect(() => {
    dropConsent(null);
  }, [pageInput, format, dpi, languages, keepProject, attach, dropConsent]);

  // A panel that is gone can neither show a result nor ask for consent: its run
  // stops, and a stage it still holds is discarded.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
      const waiting = consentRef.current;
      if (waiting) discard(waiting.publish.token);
    };
  }, [discard]);

  // A page edit or a whole-file change of the document drops the waiting
  // publish: the names the user would consent to came from the old revision.
  const currentRevision = consent
    ? documentRevision(state.files.get(consent.path), state.pageDirtyPaths)
    : null;
  useEffect(() => {
    if (consent && !sameRevision(consent.revision, currentRevision)) dropConsent('panel.omr.consentDropped');
  }, [consent, currentRevision, dropConsent]);

  const selection = selectedPageNumbers(state);
  const dpiValue = Number(dpi);
  const dpiProblem = !dpiInRange(dpiValue);

  const show = useCallback((outcome: RecognizeMusicOutcome, sourcePath: string, prepared: Prepared) => {
    if (!mounted.current) {
      if (outcome.kind === 'consent') discard(outcome.pending.token);
      return;
    }
    const here = pathRef.current === sourcePath;
    switch (outcome.kind) {
      case 'done':
        setResult({ path: sourcePath, value: outcome.result });
        if (!here) return;
        setFailedLog(null);
        setStatus(outcome.attachError
          ? tChrome('panel.common.error', { message: errorMessage(outcome.attachError) })
          : outcome.attachSkipped === 'declined'
            ? tChrome('panel.omr.attachDeclined')
            : outcome.attachSkipped === 'changed' ? tChrome('panel.omr.attachSkippedChanged') : '');
        return;
      case 'consent':
        if (!here) {
          discard(outcome.pending.token);
          return;
        }
        setConsent({
          publish: outcome.pending,
          path: sourcePath,
          revision: documentRevision(readState().files.get(sourcePath), readState().pageDirtyPaths),
          prepared: prepared.revision,
        });
        setStatus('');
        return;
      case 'stopped':
        if (!here) return;
        setFailedLog(outcome.log);
        setStatus(tChrome('panel.omr.stopped'));
        return;
      case 'failed':
        if (!here) return;
        setFailedLog(outcome.log);
        setUnrestored(unrestoredOutputs(outcome.error));
        setStatus(tChrome('panel.common.error', { message: errorMessage(outcome.error) }));
    }
  }, [discard, readState]);

  /** The four engine steps for the document at `sourcePath`. `prepare` runs
   * once the owned run has committed pending edits; the run itself holds no
   * lock on the document. */
  const ioFor = useCallback((sourcePath: string, prepare: RecognizeMusicIo['prepare'], signal: AbortSignal,
    pages: 'all' | number[], prepared: Prepared): RecognizeMusicIo => ({
    prepare,
    run: (params) => track('recognize_music_run', { file: sourcePath, pages },
      () => callRaw('recognize_music_run', params, { signal })) as Promise<unknown>,
    publish: (params) => call('recognize_music_publish', params),
    attach: async (scorePath) => {
      // The page ties name pages of the prepared revision; on any other
      // revision they would name the wrong pages.
      const now = readState();
      if (!sameRevision(prepared.revision, documentRevision(now.files.get(sourcePath), now.pageDirtyPaths))) {
        return 'changed';
      }
      const owner = beginRun(now.files.get(sourcePath) ?? null);
      if (!owner) throw new Error(tChrome('app.history.changed'));
      try {
        const done = await owner.perform(performOperation, 'recognize_music_attach', { score_path: scorePath }, { signal });
        if (done === EDIT_DECLINED) return 'declined';
        if (done === null) throw new Error(tChrome('refusal.file.noLongerOpen'));
        return done;
      } finally {
        owner.finish();
      }
    },
    discard,
  }), [beginRun, call, callRaw, discard, performOperation, readState, track]);

  const execute = useCallback(async () => {
    if (!activeFile || busy || dpiProblem || !audiverisReady()) return;
    dropConsent(null);
    const run = beginRun();
    if (!run) return;
    const sourcePath = activeFile.path;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setResult(null);
    setFailedLog(null);
    setUnrestored([]);
    const prepared: Prepared = { revision: null };
    try {
      const parsed = parsePageRangeField(pageInput, run.pageCount);
      if ('error' in parsed) throw new Error(tChrome('panel.omr.pagesProblem'));
      const dest = await saveFile(defaultScorePath(sourcePath, format));
      if (!dest) return;
      const { outputDir, baseName } = splitScoreDestination(dest);
      const request: RecognizeMusicRequest = {
        pages: parsed.pages ?? 'all',
        outputDir,
        baseName,
        format,
        keepProject,
        dpi: dpiValue,
        ocrLang: ocrLanguageSpec(audiverisStatus.ocrLanguages, languages),
        attach,
      };
      const prepare: RecognizeMusicIo['prepare'] = async (params) => {
        sayFor(sourcePath, tChrome('panel.omr.preparing'));
        await run.prepareRead(runCommitGate);
        try {
          const answer = await call('recognize_music_prepare', { file: run.source.workingPath, ...params }, {
            assertCurrent: run.assertReadCurrent,
          });
          const now = readState();
          prepared.revision = documentRevision(now.files.get(sourcePath), now.pageDirtyPaths);
          return answer;
        } finally {
          // From here on the document is the user's again.
          run.finish();
          sayFor(sourcePath, tChrome('panel.omr.running'));
        }
      };
      show(await startRecognition(ioFor(sourcePath, prepare, controller.signal, request.pages, prepared), request,
        controller.signal), sourcePath, prepared);
    } catch (error: unknown) {
      if (mounted.current) sayFor(sourcePath, tChrome('panel.common.error', { message: errorMessage(error) }));
    } finally {
      run.finish();
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  }, [activeFile, attach, audiverisStatus.ocrLanguages, beginRun, busy, call, dpiProblem, dpiValue, dropConsent,
    format, ioFor, keepProject, languages, pageInput, readState, saveFile, sayFor, show]);

  const replace = useCallback(async () => {
    const waiting = consentRef.current;
    if (!waiting || busy) return;
    consentRef.current = null;
    setConsent(null);
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(tChrome('panel.omr.publishing'));
    const unused: RecognizeMusicIo['prepare'] = () => Promise.reject(new Error('recognize_music_prepare'));
    const prepared: Prepared = { revision: waiting.prepared };
    try {
      show(await confirmPublish(ioFor(waiting.path, unused, controller.signal, waiting.publish.request.pages, prepared),
        waiting.publish, controller.signal), waiting.path, prepared);
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  }, [busy, ioFor, show]);

  const stop = useCallback(() => {
    abort.current?.abort();
  }, []);

  const toggleLanguage = (code: string): void => {
    setLanguages((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.omr.open')} />;

  const disabled = busy || blocked;
  const shown = result !== null && result.path === path ? result.value : null;
  const names = shown ? scoreFileNames(shown) : [];
  const waiting = consent !== null && consent.path === path ? consent : null;

  return (
    <div className="flex flex-col gap-4" data-testid="omr-panel">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.omr.blurb')}</p>
      <AudiverisRequiredNotice status={audiverisStatus} />

      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="omr-pages">{tChrome('panel.omr.pagesLabel')}</label>
        <div className="flex gap-2 items-center">
          <input
            id="omr-pages"
            data-testid="omr-pages"
            type="text"
            value={pageInput}
            disabled={disabled}
            onChange={(e) => setPageInput(e.target.value)}
            className="w-48 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500 ltr-notation"
          />
          {selection.length > 0 && (
            <button
              type="button"
              data-testid="omr-pages-selection"
              disabled={disabled}
              onClick={() => setPageInput(formatPageRange(selection))}
              className="px-2 py-1.5 rounded text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60"
            >
              {tChrome('panel.omr.useSelection')}
            </button>
          )}
        </div>
        <p className="text-xs text-neutral-500 mt-1">{tChrome('panel.omr.pagesHint')}</p>
      </div>

      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="omr-format">{tChrome('panel.omr.formatLabel')}</label>
        <select
          id="omr-format"
          data-testid="omr-format"
          value={format}
          disabled={disabled}
          onChange={(e) => setFormat(e.target.value as MusicFormat)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          {MUSIC_FORMATS.map((f) => (
            <option key={f.id} value={f.id}>{tChrome(FORMAT_LABELS[f.id])}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="omr-dpi">{tChrome('panel.omr.dpiLabel')}</label>
        <input
          id="omr-dpi"
          data-testid="omr-dpi"
          type="number"
          min={OMR_DPI_MIN}
          max={OMR_DPI_MAX}
          step={10}
          value={dpi}
          disabled={disabled}
          onChange={(e) => setDpi(e.target.value)}
          className="w-28 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        />
        <p className="text-xs text-neutral-500 mt-1">
          {tChrome('panel.omr.dpiHint', { min: OMR_DPI_MIN, max: OMR_DPI_MAX, small: OMR_DPI_SMALL_NOTATION })}
        </p>
        {dpiProblem && (
          <p className="text-xs text-amber-300 mt-1" data-testid="omr-dpi-problem">
            {tChrome('panel.omr.dpiProblem', { min: OMR_DPI_MIN, max: OMR_DPI_MAX })}
          </p>
        )}
      </div>

      <div data-testid="omr-ocr">
        <span className="block text-sm text-neutral-400 mb-1">{tChrome('panel.omr.ocrLabel')}</span>
        {audiverisStatus.ocrLanguages.length === 0 ? (
          !audiverisStatus.pending && !blocked && (
            <p className="text-xs text-neutral-500" data-testid="omr-ocr-none">
              {tChrome('panel.common.audiverisNoOcrLanguages')}
            </p>
          )
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {audiverisStatus.ocrLanguages.map((code) => (
                <label key={code} className="flex items-center gap-2 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    data-testid={`omr-ocr-${code}`}
                    checked={languages.has(code)}
                    disabled={disabled}
                    onChange={() => toggleLanguage(code)}
                    className="rounded bg-neutral-800 border-neutral-700"
                  />
                  {tOcrLanguage(code)}
                </label>
              ))}
            </div>
            <p className="text-xs text-neutral-500 mt-1">{tChrome('panel.omr.ocrHint')}</p>
          </>
        )}
      </div>

      <label className="flex items-start gap-2 text-sm text-neutral-300">
        <input
          type="checkbox"
          data-testid="omr-keep-project"
          checked={keepProject}
          disabled={disabled}
          onChange={() => setKeepProject((v) => !v)}
          className="mt-0.5 rounded bg-neutral-800 border-neutral-700"
        />
        <span>
          {tChrome('panel.omr.keepProject')}
          <span className="block text-xs text-neutral-500">{tChrome('panel.omr.keepProjectHint')}</span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm text-neutral-300">
        <input
          type="checkbox"
          data-testid="omr-attach"
          checked={attach}
          disabled={disabled}
          onChange={() => setAttach((v) => !v)}
          className="mt-0.5 rounded bg-neutral-800 border-neutral-700"
        />
        <span>
          {tChrome('panel.omr.attach')}
          <span className="block text-xs text-neutral-500">{tChrome('panel.omr.attachHint')}</span>
        </span>
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="omr-run"
          disabled={disabled || !ready || dpiProblem}
          onClick={() => void execute()}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium"
        >
          {busy ? tChrome('panel.omr.running') : tChrome('panel.omr.run')}
        </button>
        {busy && (
          <button
            type="button"
            data-testid="omr-stop"
            onClick={stop}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm font-medium"
          >
            {tChrome('panel.omr.stop')}
          </button>
        )}
      </div>

      {waiting && !busy && (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby="omr-consent-title"
          data-testid="omr-consent"
          className="flex flex-col gap-2 px-3 py-2 rounded border border-amber-700/60 bg-amber-900/20 text-sm"
        >
          <p id="omr-consent-title" className="text-amber-100 font-medium">{tChrome('panel.omr.consentTitle')}</p>
          <ul className="list-disc ps-5 text-xs text-amber-200 break-all">
            {waiting.publish.names.map((name) => (
              <li key={name} data-testid="omr-consent-name">{name}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="omr-replace"
              disabled={!ready}
              onClick={() => void replace()}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-xs font-medium"
            >
              {tChrome('panel.omr.replace')}
            </button>
            <button
              type="button"
              data-testid="omr-consent-cancel"
              onClick={() => dropConsent(null)}
              className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs font-medium"
            >
              {tChrome('panel.omr.consentKeep')}
            </button>
          </div>
        </div>
      )}

      {shown && (
        <div className="flex flex-col gap-2 text-sm" data-testid="omr-result">
          <p className="text-neutral-200" data-testid="omr-result-files">
            {tChrome('panel.omr.wrote', { names: new Intl.ListFormat(formattingLocale(), { type: 'conjunction' }).format(names) })}
          </p>
          {shown.project && (
            <p className="text-neutral-400" data-testid="omr-result-project">
              {tChrome('panel.omr.projectKept', { name: pathBaseName(shown.project) })}
            </p>
          )}
          {shown.attached && (
            <p className="text-neutral-400" data-testid="omr-result-attached">{tChrome('panel.omr.attached')}</p>
          )}
          {shown.untiedPages.length > 0 && (
            <p className="text-neutral-400" data-testid="omr-result-untied">
              {tChrome('panel.omr.untied', { pages: formatPageRange(shown.untiedPages) })}
            </p>
          )}
          {shown.skippedPages.length > 0 && (
            <p className="text-neutral-400" data-testid="omr-result-skipped">
              {tChrome('panel.omr.skipped', { pages: formatPageRange(shown.skippedPages) })}
            </p>
          )}
          <p className="text-amber-200 text-xs" data-testid="omr-not-exact" role="note">
            {tChrome('panel.omr.notExact')}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="omr-open-folder"
              onClick={() => void fileIO.reveal(shown.files[0].path).catch(() => {})}
              className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs font-medium"
            >
              {tChrome('panel.omr.openFolder')}
            </button>
            {shown.log && (
              <button
                type="button"
                data-testid="omr-open-log"
                onClick={() => {
                  const log = shown.log;
                  if (log) void fileIO.reveal(log).catch(() => {});
                }}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs font-medium"
              >
                {tChrome('panel.omr.openLog')}
              </button>
            )}
            {shown.projectId && (
              <button
                type="button"
                data-testid="omr-open-audiveris"
                onClick={() => {
                  const projectId = shown.projectId;
                  if (!projectId) return;
                  void audiveris.openProject(projectId).catch((error: unknown) => {
                    const key = openProjectRefusalKey(error);
                    setStatus(tChrome('panel.common.error', {
                      message: key ? tChrome(key as UiKey) : errorMessage(error),
                    }));
                  });
                }}
                className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs font-medium"
              >
                {tChrome('panel.omr.openInAudiveris')}
              </button>
            )}
          </div>
        </div>
      )}
      {unrestored.length > 0 && !busy && (
        <ul className="flex flex-col gap-1 text-xs text-amber-200 break-all" data-testid="omr-unrestored" role="note">
          {unrestored.map((entry) => (
            <li key={entry.target} data-testid="omr-unrestored-target">
              {entry.backup === null
                ? tChrome('panel.omr.unrestoredNew', { target: entry.target })
                : tChrome('panel.omr.unrestored', { target: entry.target, backup: entry.backup })}
            </li>
          ))}
        </ul>
      )}
      {failedLog && !busy && (
        <button
          type="button"
          data-testid="omr-failure-log"
          onClick={() => void fileIO.reveal(failedLog).catch(() => {})}
          className="self-start px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs font-medium"
        >
          {tChrome('panel.omr.openLog')}
        </button>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
