// Recognize Music: the Audiveris answer the renderer holds, the gates that
// read it, and the request the panel and the guided step build.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  status: vi.fn(),
  setPath: vi.fn(),
  recheck: vi.fn(),
  openReleases: vi.fn(),
  openProject: vi.fn(),
}));

vi.mock('../src/renderer/lib/tauri-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/lib/tauri-bridge')>()),
  audiveris: bridge,
}));

import {
  AUDIVERIS_MINIMUM_VERSION,
  audiverisBlocked,
  audiverisOriginKey,
  audiverisReady,
  audiverisStateKey,
  audiverisStatus,
  ensureAudiverisStatus,
  normalizeAudiverisStatus,
  openAudiverisSetup,
  pinAudiverisStatus,
  recheckAudiverisStatus,
  registerAudiverisSetupOpener,
  resetAudiverisStatus,
  setAudiverisPath,
  takeAudiverisFocusRequest,
  type AudiverisStatus,
} from '../src/renderer/lib/audiveris-status';
import type { AudiverisStatusAnswer } from '../src/renderer/lib/tauri-bridge';
import { COMMANDS, commandAwaitsProgram, commandPrerequisite } from '../src/renderer/commands/registry';
import { OPERATIONS, OPERATION_TITLES } from '../src/renderer/commands/operations';
import { toolById, toolForOp } from '../src/renderer/commands/tools';
import type { AppCommandHandlers, CommandContext } from '../src/renderer/commands/types';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile, PageRef } from '../src/renderer/state/types';
import {
  STEP_CATALOG,
  audiverisBlocker,
  buildStepParams,
  engineMethodFor,
  newStep,
  stepConfigCue,
  stepConfigProblem,
  stepDefFor,
  validateAction,
  validateRunValues,
  type GuidedAction,
} from '../src/renderer/lib/guided-actions';
import {
  OMR_DPI_MAX,
  OMR_DPI_MIN,
  defaultScorePath,
  dpiInRange,
  fileStem,
  OPEN_PROJECT_REFUSALS,
  failureLog,
  openProjectRefusalKey,
  attachedScore,
  existingOutputs,
  unrestoredOutputs,
  readAttachAnswer,
  readPrepareAnswer,
  readPublishAnswer,
  readRunAnswer,
  type RecognizeMusicRequest,
  ocrLangParam,
  ocrLanguageSpec,
  parentFolder,
  splitScoreDestination,
} from '../src/renderer/lib/recognize-music';
import { EngineError } from '../src/renderer/lib/engine-messages';
import { ENGINE_LOCK_TABLE, lockKeysFor } from '../src/renderer/lib/engine-lock';
import {
  confirmPublish,
  documentRevision,
  dropPending,
  guidedRecognitionRequest,
  runUnattendedRecognition,
  sameRevision,
  startRecognition,
  type RecognizeMusicIo,
} from '../src/renderer/lib/recognize-music-flow';
import { FRIENDLY_NAMES, describeOperation, isTrackableMethod } from '../src/renderer/hooks/useOperationQueue';
import { OP_EDIT_CLASS } from '../src/renderer/lib/op-edit-class';
import { PERMISSION_NAMES, parseDocumentSecurity } from '../src/renderer/lib/document-permissions';
import { tChrome, type UiKey } from '../src/renderer/i18n';

const READY: AudiverisStatusAnswer = {
  kind: 'ready',
  path: 'C:\\Program Files\\Audiveris\\Audiveris.exe',
  launcher: 'exe',
  version: '5.11.0',
  source: 'registry',
  ocrLanguages: ['eng', 'deu'],
  detail: null,
};

const ABSENT: AudiverisStatusAnswer = {
  kind: 'not-configured',
  path: null,
  launcher: null,
  version: null,
  source: null,
  ocrLanguages: [],
  detail: null,
};

const settled = (answer: AudiverisStatusAnswer): AudiverisStatus => ({ ...answer, pending: false });

beforeEach(() => {
  resetAudiverisStatus();
  for (const fn of Object.values(bridge)) fn.mockReset();
});

afterEach(() => {
  resetAudiverisStatus();
});

describe('the Audiveris answer', () => {
  it('reads every field of the Rust answer', () => {
    expect(normalizeAudiverisStatus(READY)).toEqual(settled(READY));
  });

  it('reads a state it cannot name as a failed probe', () => {
    expect(normalizeAudiverisStatus({ ...ABSENT, kind: 'something-new' })?.kind).toBe('probe-failed');
  });

  it('drops malformed fields instead of trusting them', () => {
    const read = normalizeAudiverisStatus({
      kind: 'ready',
      path: '',
      launcher: 'docker',
      version: 42,
      source: 'guess',
      ocrLanguages: ['eng', 'eng', '', 7],
      detail: '',
    });
    expect(read).toEqual({
      kind: 'ready',
      path: null,
      launcher: null,
      version: null,
      source: null,
      ocrLanguages: ['eng'],
      detail: null,
      pending: false,
    });
  });

  it('is not an answer when the IPC returned no object', () => {
    expect(normalizeAudiverisStatus(null)).toBeNull();
    expect(normalizeAudiverisStatus('ready')).toBeNull();
    expect(normalizeAudiverisStatus([READY])).toBeNull();
  });
});

describe('the store', () => {
  it('starts pending, which blocks nothing and enables nothing', () => {
    const status = audiverisStatus();
    expect(status.pending).toBe(true);
    expect(audiverisBlocked(status)).toBe(false);
    expect(audiverisReady(status)).toBe(false);
    expect(audiverisStateKey(status)).toBeNull();
  });

  it('reads Rust once per session', async () => {
    bridge.status.mockResolvedValue(ABSENT);
    await Promise.all([ensureAudiverisStatus(), ensureAudiverisStatus()]);
    await ensureAudiverisStatus();
    expect(bridge.status).toHaveBeenCalledTimes(1);
    expect(audiverisBlocked()).toBe(true);
    expect(audiverisStateKey()).toBe('panel.common.audiverisRequired');
  });

  it('retries a failed read once and takes the second answer', async () => {
    bridge.status.mockRejectedValueOnce(new Error('ipc down')).mockResolvedValueOnce(READY);
    await ensureAudiverisStatus();
    expect(audiverisReady()).toBe(true);
    expect(bridge.status).toHaveBeenCalledTimes(2);
  });

  it('settles to not-configured with the failure as detail after two failed reads', async () => {
    bridge.status.mockRejectedValueOnce(new Error('ipc down')).mockResolvedValueOnce('garbage');
    const status = await ensureAudiverisStatus();
    expect(bridge.status).toHaveBeenCalledTimes(2);
    expect(status.pending).toBe(false);
    expect(status.kind).toBe('not-configured');
    expect(status.detail).toBe('audiveris_status returned no status');
    expect(audiverisBlocked()).toBe(true);
  });

  it('reads Rust again on the next ask after two failed reads, and caches a real answer', async () => {
    bridge.status.mockRejectedValueOnce(new Error('ipc down')).mockRejectedValueOnce(new Error('ipc down'));
    await ensureAudiverisStatus();
    expect(audiverisStatus().detail).toBe('ipc down');
    bridge.status.mockResolvedValueOnce(READY);
    await Promise.all([ensureAudiverisStatus(), ensureAudiverisStatus()]);
    expect(bridge.status).toHaveBeenCalledTimes(3);
    expect(audiverisReady()).toBe(true);
    await ensureAudiverisStatus();
    expect(bridge.status).toHaveBeenCalledTimes(3);
  });

  it('a pin clears the failed-read state, so a later real answer is cached', async () => {
    bridge.status.mockRejectedValue(new Error('ipc down'));
    await ensureAudiverisStatus();
    pinAudiverisStatus(ABSENT);
    pinAudiverisStatus(null);
    bridge.status.mockReset();
    bridge.status.mockResolvedValue(ABSENT);
    await ensureAudiverisStatus();
    await ensureAudiverisStatus();
    expect(bridge.status).toHaveBeenCalledTimes(1);
  });

  it('never publishes a slow read over a pin that landed after it started', async () => {
    let answer!: (value: unknown) => void;
    bridge.status.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const slow = ensureAudiverisStatus();
    pinAudiverisStatus(ABSENT);
    answer(READY);
    await slow;
    expect(audiverisReady()).toBe(false);
    expect(audiverisStatus().kind).toBe('not-configured');
  });

  it('never publishes a slow read over a newer recheck', async () => {
    let answer!: (value: unknown) => void;
    bridge.status.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const slow = ensureAudiverisStatus();
    bridge.recheck.mockResolvedValueOnce(ABSENT);
    const newer = recheckAudiverisStatus();
    await newer;
    answer(READY);
    await slow;
    expect(audiverisStatus().kind).toBe('not-configured');
    expect(audiverisStatus().pending).toBe(false);
  });

  it('publishes a recheck to every subscriber', async () => {
    bridge.status.mockResolvedValue(ABSENT);
    await ensureAudiverisStatus();
    bridge.recheck.mockResolvedValue(READY);
    const seen: boolean[] = [];
    const { subscribeAudiverisStatus } = await import('../src/renderer/lib/audiveris-status');
    const stop = subscribeAudiverisStatus(() => seen.push(audiverisReady()));
    await recheckAudiverisStatus();
    stop();
    expect(seen).toEqual([true]);
  });

  it('reads the status when a recheck answers nothing readable', async () => {
    bridge.recheck.mockResolvedValue(undefined);
    bridge.status.mockResolvedValue(READY);
    expect(audiverisReady(await recheckAudiverisStatus())).toBe(true);
  });

  it('reports a recheck that fails as a failed probe, not as pending', async () => {
    bridge.recheck.mockRejectedValue(new Error('gone'));
    const status = await recheckAudiverisStatus();
    expect(status.pending).toBe(false);
    expect(status.kind).toBe('probe-failed');
    expect(audiverisStateKey(status)).toBe('panel.common.audiverisProbeFailed');
  });

  it('publishes the probe Rust answers when a path is chosen, with no second probe', async () => {
    bridge.setPath.mockResolvedValue({ ...READY, source: 'preferences' });
    const status = await setAudiverisPath('D:/Tools/Audiveris.exe');
    expect(bridge.setPath).toHaveBeenCalledWith('D:/Tools/Audiveris.exe');
    expect(bridge.recheck).not.toHaveBeenCalled();
    expect(audiverisOriginKey(status)).toBe('panel.settings.audiverisChosen');
    expect(audiverisStatus()).toEqual(status);
  });

  it('shows a chosen path that fails its probe as the refusal of that path', async () => {
    bridge.setPath.mockResolvedValue({ ...ABSENT, kind: 'probe-failed', source: 'preferences', detail: 'exit 1' });
    const status = await setAudiverisPath('D:/uninstall.exe');
    expect(audiverisStateKey(status)).toBe('panel.common.audiverisProbeFailed');
    expect(status.detail).toBe('exit 1');
    expect(audiverisOriginKey(status)).toBe('panel.settings.audiverisChosen');
  });

  it('publishes what Rust resolves when storing the path fails', async () => {
    bridge.setPath.mockRejectedValue(new Error('settings folder is read-only'));
    bridge.status.mockResolvedValue({ ...READY, source: 'preferences' });
    const status = await setAudiverisPath('D:/Tools/Audiveris.exe');
    expect(audiverisReady(status)).toBe(true);
    bridge.status.mockReset();
    bridge.status.mockRejectedValue(new Error('ipc down'));
    expect((await setAudiverisPath('D:/Tools/Audiveris.exe')).kind).toBe('probe-failed');
  });

  it('reads the status when choosing a path answers nothing readable', async () => {
    bridge.setPath.mockResolvedValue(undefined);
    bridge.status.mockResolvedValue({ ...READY, source: 'preferences' });
    expect(audiverisReady(await setAudiverisPath('D:/Tools/Audiveris.exe'))).toBe(true);
  });

  it('holds a pinned answer against every read', async () => {
    pinAudiverisStatus(ABSENT);
    bridge.status.mockResolvedValue(READY);
    bridge.recheck.mockResolvedValue(READY);
    await ensureAudiverisStatus();
    await recheckAudiverisStatus();
    expect(audiverisBlocked()).toBe(true);
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.recheck).not.toHaveBeenCalled();
    pinAudiverisStatus(null);
    expect(audiverisStatus().pending).toBe(true);
  });
});

describe('the explanation and the origin', () => {
  it('names each unusable state with its own message', () => {
    expect(audiverisStateKey(settled({ ...ABSENT, kind: 'not-executable' }))).toBe('panel.common.audiverisNotExecutable');
    expect(audiverisStateKey(settled({ ...ABSENT, kind: 'probe-failed' }))).toBe('panel.common.audiverisProbeFailed');
    expect(audiverisStateKey(settled({ ...ABSENT, kind: 'version-below-minimum' }))).toBe('panel.common.audiverisTooOld');
    expect(audiverisStateKey(settled(ABSENT))).toBe('panel.common.audiverisRequired');
    expect(audiverisStateKey(settled(READY))).toBeNull();
  });

  it('names a path the user chose even when it fails, and nothing else that failed', () => {
    expect(audiverisOriginKey(settled({ ...ABSENT, kind: 'not-executable', source: 'preferences' })))
      .toBe('panel.settings.audiverisChosen');
    expect(audiverisOriginKey(settled({ ...ABSENT, source: 'registry' }))).toBeNull();
    expect(audiverisOriginKey(settled(READY))).toBe('panel.settings.audiverisDiscovered');
    expect(audiverisOriginKey(settled({ ...READY, launcher: 'flatpak', path: null, source: 'flatpak' })))
      .toBe('panel.settings.audiverisFlatpak');
  });

  it('opens Preferences once per request and asks the section to come into view once', () => {
    const opened: number[] = [];
    registerAudiverisSetupOpener(() => opened.push(1));
    openAudiverisSetup();
    expect(opened).toEqual([1]);
    expect(takeAudiverisFocusRequest()).toBe(true);
    expect(takeAudiverisFocusRequest()).toBe(false);
  });
});

// ── The command registry ───────────────────────────────────────────────

const PATH = 'C:/scores/song.pdf';

function stateWith(file?: Partial<OpenFile>): AppState {
  const base: OpenFile = {
    path: PATH,
    workingPath: `${PATH}.working`,
    name: 'song.pdf',
    pageCount: 2,
    buffer: [1, 2, 3],
    dirty: false,
    undoStack: [],
    redoStack: [],
    ...file,
  };
  const pages: PageRef[] = [0, 1].map((i) => ({
    id: `${PATH}#p${i}`,
    sourceDocId: PATH,
    sourcePageIndex: i,
    rotation: 0 as const,
    width: 300,
    height: 400,
  }));
  const doc: OpenDocument = { ...base, id: `${PATH}#0`, pages, pageCount: 2 };
  return {
    ...initialState,
    files: new Map([[PATH, base]]),
    activeFileId: PATH,
    workspace: { documents: [doc] },
    ui: { ...initialState.ui, focusedTab: { doc: PATH } },
  };
}

const ctxOf = (state: AppState): CommandContext => ({
  state,
  dispatch: () => {},
  app: {} as AppCommandHandlers,
  canvas: null,
});

const omrEnabled = (state: AppState = stateWith()): boolean =>
  COMMANDS['tools.panel.omr'].when?.(ctxOf(state)) ?? true;

describe('the Recognize Music command', () => {
  it('is an operation of the Scan & OCR tool', () => {
    expect(OPERATIONS).toContain('omr');
    expect(OPERATION_TITLES.omr).toBe('Recognize Music');
    expect(toolForOp('omr')?.id).toBe('ocr');
    expect(toolById('ocr')?.ops).toEqual(['scanenhance', 'omr']);
  });

  it('is not usable while the first answer is pending, and shows no reason yet', () => {
    expect(omrEnabled()).toBe(false);
    expect(commandPrerequisite('tools.panel.omr')).toBeNull();
    expect(commandAwaitsProgram('tools.panel.omr')).toBe(true);
  });

  it('is disabled with the shared reason when Audiveris is absent', () => {
    pinAudiverisStatus(ABSENT);
    expect(omrEnabled()).toBe(false);
    const reason = commandPrerequisite('tools.panel.omr');
    expect(reason?.key).toBe('panel.common.audiverisRequired');
    expect(tChrome(reason!.key as UiKey, reason!.vars)).toBe(
      'This needs Audiveris, which Spectra PDF does not include. Install it, then point Spectra PDF at it in Preferences ▸ Engine.',
    );
  });

  it('names the minimum version when the installed one is too old', () => {
    pinAudiverisStatus({ ...ABSENT, kind: 'version-below-minimum' });
    const reason = commandPrerequisite('tools.panel.omr');
    const text = tChrome(reason!.key as UiKey, reason!.vars);
    expect(text).toContain(AUDIVERIS_MINIMUM_VERSION);
    expect(text).not.toContain('{{');
  });

  it('is enabled when Audiveris is ready', () => {
    pinAudiverisStatus(READY);
    expect(omrEnabled()).toBe(true);
    expect(commandPrerequisite('tools.panel.omr')).toBeNull();
    expect(commandAwaitsProgram('tools.panel.omr')).toBe(false);
  });

  it('is disabled by a document that denies copying, with Audiveris ready', () => {
    pinAudiverisStatus(READY);
    const security = parseDocumentSecurity({
      opener: 'user',
      permissions: Object.fromEntries(PERMISSION_NAMES.map((name) => [name, name !== 'copy'])),
    });
    expect(omrEnabled(stateWith({ security }))).toBe(false);
  });

  it('gates no other command on Audiveris', () => {
    pinAudiverisStatus(ABSENT);
    for (const op of OPERATIONS) {
      if (op === 'omr') continue;
      expect(commandPrerequisite(`tools.panel.${op}`), op).toBeNull();
    }
  });
});

describe('the engine request', () => {
  it('locks the document only to read it and to attach to it', () => {
    expect(ENGINE_LOCK_TABLE.recognize_music).toBeUndefined();
    expect(lockKeysFor('recognize_music_prepare', { file: 'a.pdf', pages: 'all', attach: true })).toEqual([
      { key: 'a.pdf', mode: 'shared' },
    ]);
    expect(lockKeysFor('recognize_music_run', { token: 't', dpi: 300, ocr_lang: '', keep_project: false })).toEqual([]);
    expect(lockKeysFor('recognize_music_publish', { token: 't', output_dir: 'C:/out' })).toEqual([
      { key: 'C:/out', mode: 'exclusive' },
    ]);
    expect(lockKeysFor('recognize_music_attach', { file: 'w.pdf', output: 's.pdf', score_path: 'C:/out/a.mxl' })).toEqual([
      { key: 's.pdf', mode: 'exclusive' },
      { key: 'w.pdf', mode: 'exclusive' },
    ]);
    expect(lockKeysFor('recognize_music_discard', { token: 't' })).toEqual([]);
  });

  it('puts the run and the attach in the queue, and keeps the short steps out of it', () => {
    expect(FRIENDLY_NAMES.recognize_music_run).toBe('Recognize Music');
    expect(FRIENDLY_NAMES.recognize_music_attach).toBe('Attach Score');
    expect(describeOperation('recognize_music_run', { file: 'C:/s/song.pdf', pages: [1, 2] }).pages).toBe('1,2');
    for (const step of ['prepare', 'publish', 'discard']) {
      expect(isTrackableMethod(`recognize_music_${step}`), step).toBe(false);
    }
    expect(isTrackableMethod('recognize_music_run')).toBe(true);
  });

  it('takes the signed-document decision as a structural edit when it attaches', () => {
    expect(OP_EDIT_CLASS.recognize_music_attach).toBe('structural');
  });

  it('defaults the score beside the source, named after it', () => {
    expect(defaultScorePath('C:\\scores\\Song Book.pdf', 'mxl')).toBe('C:\\scores\\Song Book.mxl');
    expect(defaultScorePath('/home/a/song.v2.pdf', 'musicxml')).toBe('/home/a/song.v2.musicxml');
    expect(defaultScorePath('song.pdf', 'mxl')).toBe('song.mxl');
    expect(parentFolder('C:\\scores\\song.pdf')).toBe('C:\\scores');
    expect(fileStem('C:\\scores\\.hidden')).toBe('.hidden');
  });

  it('splits a picked path into the folder and the base name the engine extends', () => {
    expect(splitScoreDestination('C:\\scores\\song.mxl')).toEqual({ outputDir: 'C:\\scores', baseName: 'song' });
    expect(splitScoreDestination('/a/song.MusicXML')).toEqual({ outputDir: '/a', baseName: 'song' });
    expect(splitScoreDestination('/a/song.v2')).toEqual({ outputDir: '/a', baseName: 'song.v2' });
  });

  it('keeps the separator of a root folder', () => {
    expect(splitScoreDestination('D:\\score.mxl')).toEqual({ outputDir: 'D:\\', baseName: 'score' });
    expect(splitScoreDestination('D:/score.mxl')).toEqual({ outputDir: 'D:/', baseName: 'score' });
    expect(splitScoreDestination('/score.mxl')).toEqual({ outputDir: '/', baseName: 'score' });
    expect(splitScoreDestination('score.mxl')).toEqual({ outputDir: '', baseName: 'score' });
    expect(parentFolder('D:\\song.pdf')).toBe('D:\\');
    expect(parentFolder('/song.pdf')).toBe('/');
    expect(parentFolder('\\\\server\\share\\song.pdf')).toBe('\\\\server\\share');
  });

  it('joins the chosen OCR languages in the installed order', () => {
    expect(ocrLanguageSpec(['eng', 'deu', 'fra'], new Set(['fra', 'eng']))).toBe('eng+fra');
    expect(ocrLanguageSpec(['eng'], new Set())).toBe('');
    expect(ocrLanguageSpec([], new Set(['eng']))).toBe('');
  });

  it('accepts only whole resolutions in the recognizer range', () => {
    expect(dpiInRange(OMR_DPI_MIN)).toBe(true);
    expect(dpiInRange(OMR_DPI_MAX)).toBe(true);
    expect(dpiInRange(OMR_DPI_MIN - 1)).toBe(false);
    expect(dpiInRange(OMR_DPI_MAX + 1)).toBe(false);
    expect(dpiInRange(300.5)).toBe(false);
    expect(dpiInRange(Number.NaN)).toBe(false);
  });

  it('reads the answer of each step and refuses one that is not the answer of that step', () => {
    expect(readPrepareAnswer({ token: 't1', pageCount: 3, pages: [3, 1] })).toEqual({ token: 't1', pageCount: 3, pages: [1, 3] });
    expect(readPrepareAnswer({ pageCount: 3 })).toBeNull();
    expect(readRunAnswer({
      token: 't1',
      movements: [{ index: 1, pages: [1], name: '.mvt1' }, { index: 2, pages: [3], name: '.mvt2' }],
      project: true,
      skippedPages: [2, 2],
      log: '',
    })).toEqual({
      token: 't1',
      movements: [{ index: 1, pages: [1], name: '.mvt1' }, { index: 2, pages: [3], name: '.mvt2' }],
      project: true,
      skippedPages: [2],
      log: null,
    });
    expect(readRunAnswer({ token: 't1', movements: [] })).toBeNull();
    // One movement carries the empty suffix name.
    expect(readRunAnswer({
      token: 't1', movements: [{ index: 1, pages: [1, 2], name: '' }], project: false, skippedPages: [], log: null,
    })?.movements).toEqual([{ index: 1, pages: [1, 2], name: '' }]);
    expect(readRunAnswer({ token: 't1', movements: [{ index: 1, pages: [1] }] })).toBeNull();
    expect(readPublishAnswer({
      files: [{ path: 'C:/s/song.mvt1.mxl', movement: 1 }, { path: '' }],
      project: 'C:/s/song.omr',
      projectId: 'p-7',
    })).toEqual({ files: [{ path: 'C:/s/song.mvt1.mxl', movement: 1 }], project: 'C:/s/song.omr', projectId: 'p-7' });
    expect(readPublishAnswer({ files: [] })).toBeNull();
    expect(readAttachAnswer({ structureTies: { tied: [1], untied: [3, 2, 2], tagged: true } })).toEqual({ untiedPages: [2, 3] });
    expect(readAttachAnswer({ structureTies: { tied: [], untied: [1], tagged: false } })).toEqual({ untiedPages: [] });
    expect(attachedScore([{ path: 'b.mvt2.mxl', movement: 2 }, { path: 'b.mvt1.mxl', movement: 1 }])).toBe('b.mvt1.mxl');
    expect(attachedScore([{ path: 'b.mxl', movement: null }])).toBe('b.mxl');
  });

  it('lists every existing output from the refusal, structured data first', () => {
    const refusal = 'These files already exist: song.mvt1.mxl, song.mvt2.mxl, song.omr. '
      + 'Choose another name or confirm the overwrite';
    expect(existingOutputs(new EngineError(refusal))).toEqual(['song.mvt1.mxl', 'song.mvt2.mxl', 'song.omr']);
    expect(existingOutputs(new EngineError(refusal, { names: ['a, b.mxl', 'a, b.omr'] }))).toEqual(['a, b.mxl', 'a, b.omr']);
    expect(existingOutputs(new Error(refusal))).toBeNull();
    expect(existingOutputs(new EngineError('Audiveris produced no readable score for the selected pages'))).toBeNull();
  });
});

// ── The four-step flow ─────────────────────────────────────────────────

const EXISTS = 'These files already exist: song.mxl, song.omr. Choose another name or confirm the overwrite';

interface FakeOptions {
  prepare?: () => unknown;
  run?: (signal?: AbortSignal) => unknown;
  publish?: (names: string[]) => unknown;
  attach?: () => unknown;
}

function fakeIo(options: FakeOptions = {}) {
  const calls: string[] = [];
  const published: string[][] = [];
  const discarded: string[] = [];
  const io: RecognizeMusicIo = {
    prepare: async () => {
      calls.push('prepare');
      return options.prepare ? options.prepare() : { token: 'tok', pageCount: 2, pages: [1, 2] };
    },
    run: async (_params, signal) => {
      calls.push('run');
      return options.run
        ? options.run(signal)
        : { token: 'tok', movements: [{ index: 1, pages: [1, 2], name: '' }], project: true, skippedPages: [], log: 'L' };
    },
    publish: async (params) => {
      calls.push('publish');
      published.push(params.overwrite_names);
      return options.publish
        ? options.publish(params.overwrite_names)
        : { files: [{ path: 'C:/s/song.mxl', movement: null }], project: 'C:/s/song.omr', projectId: 'p1' };
    },
    attach: async () => {
      calls.push('attach');
      return options.attach ? options.attach() : { structureTies: { tied: [1], untied: [2], tagged: true } };
    },
    discard: (token) => {
      discarded.push(token);
    },
  };
  return { io, calls, published, discarded };
}

const REQUEST: RecognizeMusicRequest = {
  pages: [1, 2],
  outputDir: 'C:/s',
  baseName: 'song',
  format: 'mxl',
  keepProject: true,
  dpi: 300,
  ocrLang: '',
  attach: false,
};

describe('the OCR language the engine is sent', () => {
  it('is null when none is chosen, and the +-joined codes otherwise', () => {
    expect(ocrLangParam('')).toBeNull();
    expect(ocrLangParam('   ')).toBeNull();
    expect(ocrLangParam('eng+deu')).toBe('eng+deu');
    expect(ocrLangParam(ocrLanguageSpec(['eng', 'deu'], new Set()))).toBeNull();
    expect(ocrLangParam(ocrLanguageSpec(['eng', 'deu'], new Set(['deu', 'eng'])))).toBe('eng+deu');
  });

  it('reaches the run as null or as the joined codes', async () => {
    const sent: unknown[] = [];
    const io = fakeIo().io;
    const run = io.run;
    io.run = (params, signal) => {
      sent.push(params.ocr_lang);
      return run(params, signal);
    };
    await startRecognition(io, { ...REQUEST, ocrLang: '' });
    await startRecognition(io, { ...REQUEST, ocrLang: 'eng+deu' });
    expect(sent).toEqual([null, 'eng+deu']);
  });

  it('is null from a guided step with an empty field, and the codes from a filled one', () => {
    expect(buildStepParams(newStep('omr')).ocr_lang).toBeNull();
    const step = newStep('omr');
    step.params.ocr_lang = ' eng+deu ';
    expect(buildStepParams(step).ocr_lang).toBe('eng+deu');
    expect(guidedRecognitionRequest(buildStepParams(newStep('omr')), 'C:/s/a.pdf').request.ocrLang).toBe('');
  });
});

describe('the recognition flow', () => {
  it('runs prepare, run and publish in order, then discards the stage', async () => {
    const { io, calls, published, discarded } = fakeIo();
    const outcome = await startRecognition(io, REQUEST);
    expect(calls).toEqual(['prepare', 'run', 'publish']);
    expect(published).toEqual([[]]);
    expect(discarded).toEqual(['tok']);
    expect(outcome).toEqual({
      kind: 'done',
      result: {
        files: [{ path: 'C:/s/song.mxl', movement: null }],
        project: 'C:/s/song.omr',
        projectId: 'p1',
        attached: false,
        skippedPages: [],
        log: 'L',
        untiedPages: [],
      },
      attachError: null,
      attachSkipped: null,
    });
  });

  it('attaches the first score as a fourth step when asked', async () => {
    const { io, calls } = fakeIo();
    const outcome = await startRecognition(io, { ...REQUEST, attach: true });
    expect(calls).toEqual(['prepare', 'run', 'publish', 'attach']);
    expect(outcome.kind === 'done' && outcome.result.attached).toBe(true);
    expect(outcome.kind === 'done' && outcome.result.untiedPages).toEqual([2]);
  });

  it('keeps the written scores when the attach fails or is declined', async () => {
    const failed = await startRecognition(fakeIo({ attach: () => { throw new Error('no'); } }).io, { ...REQUEST, attach: true });
    expect(failed.kind === 'done' && failed.result.files.length).toBe(1);
    expect(failed.kind === 'done' && failed.attachError).toBeInstanceOf(Error);
    const declined = await startRecognition(fakeIo({ attach: () => 'declined' }).io, { ...REQUEST, attach: true });
    expect(declined.kind === 'done' && declined.attachSkipped).toBe('declined');
    expect(declined.kind === 'done' && declined.result.attached).toBe(false);
    const changed = await startRecognition(fakeIo({ attach: () => 'changed' }).io, { ...REQUEST, attach: true });
    expect(changed.kind === 'done' && changed.attachSkipped).toBe('changed');
    expect(changed.kind === 'done' && changed.result.attached).toBe(false);
    expect(changed.kind === 'done' && changed.result.files.length).toBe(1);
  });

  it('asks consent for exactly the listed names and keeps the stage', async () => {
    const { io, discarded } = fakeIo({ publish: (names) => {
      if (names.length === 0) throw new EngineError(EXISTS);
      return { files: [{ path: 'C:/s/song.mxl', movement: null }], project: 'C:/s/song.omr', projectId: 'p1' };
    } });
    const first = await startRecognition(io, REQUEST);
    expect(first.kind).toBe('consent');
    if (first.kind !== 'consent') return;
    expect(first.pending.names).toEqual(['song.mxl', 'song.omr']);
    expect(discarded).toEqual([]);
  });

  it('publishes again with the consented names, without running again', async () => {
    const { io, calls, published, discarded } = fakeIo({ publish: (names) => {
      if (names.length === 0) throw new EngineError(EXISTS);
      return { files: [{ path: 'C:/s/song.mxl', movement: null }], project: 'C:/s/song.omr', projectId: 'p1' };
    } });
    const first = await startRecognition(io, REQUEST);
    if (first.kind !== 'consent') throw new Error('no consent');
    const second = await confirmPublish(io, first.pending);
    expect(second.kind).toBe('done');
    expect(calls).toEqual(['prepare', 'run', 'publish', 'publish']);
    expect(published).toEqual([[], ['song.mxl', 'song.omr']]);
    expect(discarded).toEqual(['tok']);
  });

  it('asks again when the second publish finds names it was not shown', async () => {
    const { io } = fakeIo({ publish: (names) => {
      if (names.length === 0) throw new EngineError(EXISTS);
      throw new EngineError('These files already exist: song.mvt2.mxl. Choose another name or confirm the overwrite');
    } });
    const first = await startRecognition(io, REQUEST);
    if (first.kind !== 'consent') throw new Error('no consent');
    const second = await confirmPublish(io, first.pending);
    expect(second.kind === 'consent' && second.pending.names).toEqual(['song.mvt2.mxl']);
  });

  it('discards the stage when the consent is dropped', async () => {
    const { io, discarded } = fakeIo({ publish: () => { throw new EngineError(EXISTS); } });
    const first = await startRecognition(io, REQUEST);
    if (first.kind !== 'consent') throw new Error('no consent');
    dropPending(io, first.pending);
    expect(discarded).toEqual(['tok']);
  });

  it('discards the stage on a failed run and offers its log', async () => {
    const { io, calls, discarded } = fakeIo({ run: () => {
      throw new EngineError('Music recognition failed: Audiveris exited with status 1', { log: 'C:/t/x.log' });
    } });
    const outcome = await startRecognition(io, REQUEST);
    expect(calls).toEqual(['prepare', 'run']);
    expect(discarded).toEqual(['tok']);
    expect(outcome.kind === 'failed' && outcome.log).toBe('C:/t/x.log');
  });

  it('discards the stage on a failed publish other than the listing', async () => {
    const { io, discarded } = fakeIo({ publish: () => { throw new Error('disk full'); } });
    const outcome = await startRecognition(io, REQUEST);
    expect(outcome.kind).toBe('failed');
    expect(discarded).toEqual(['tok']);
  });

  it('has nothing to discard when prepare fails', async () => {
    const { io, calls, discarded } = fakeIo({ prepare: () => { throw new Error('copy denied'); } });
    expect((await startRecognition(io, REQUEST)).kind).toBe('failed');
    expect(calls).toEqual(['prepare']);
    expect(discarded).toEqual([]);
  });

  it('stops after prepare, discarding the stage before any run', async () => {
    const controller = new AbortController();
    const { io, calls, discarded } = fakeIo({ prepare: () => {
      controller.abort();
      return { token: 'tok', pageCount: 2, pages: [1, 2] };
    } });
    expect(await startRecognition(io, REQUEST, controller.signal)).toEqual({ kind: 'stopped', log: null });
    expect(calls).toEqual(['prepare']);
    expect(discarded).toEqual(['tok']);
  });

  it('stops during the run, passing the signal and discarding the stage', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const { io, calls, discarded } = fakeIo({ run: (signal) => {
      seen = signal;
      controller.abort();
      throw new EngineError('cancelled', { log: 'C:/t/stop.log' });
    } });
    expect(await startRecognition(io, REQUEST, controller.signal)).toEqual({ kind: 'stopped', log: 'C:/t/stop.log' });
    expect(seen).toBe(controller.signal);
    expect(calls).toEqual(['prepare', 'run']);
    expect(discarded).toEqual(['tok']);
  });

  it('stops after a finished run without publishing', async () => {
    const controller = new AbortController();
    const { io, calls, discarded } = fakeIo({ run: () => {
      controller.abort();
      return { token: 'tok', movements: [{ index: 1, pages: [1], name: '' }], project: false, skippedPages: [], log: 'L' };
    } });
    expect(await startRecognition(io, REQUEST, controller.signal)).toEqual({ kind: 'stopped', log: 'L' });
    expect(calls).toEqual(['prepare', 'run']);
    expect(discarded).toEqual(['tok']);
  });

  it('keeps published files and skips the attach when stopped during publish', async () => {
    const controller = new AbortController();
    const { io, calls } = fakeIo({ publish: () => {
      controller.abort();
      return { files: [{ path: 'C:/s/song.mxl', movement: null }], project: null, projectId: null };
    } });
    const outcome = await startRecognition(io, { ...REQUEST, attach: true }, controller.signal);
    expect(outcome.kind === 'done' && outcome.result.files.length).toBe(1);
    expect(calls).toEqual(['prepare', 'run', 'publish']);
  });

  it('a consent offered against one revision is void after a page edit', () => {
    const file = {
      path: 'C:/s/song.pdf', workingPath: 'w', name: 'song.pdf', pageCount: 2, buffer: [1], dirty: false,
      undoStack: [], redoStack: [], editRevision: 3,
    };
    const offered = documentRevision(file, []);
    expect(sameRevision(offered, documentRevision(file, []))).toBe(true);
    expect(sameRevision(offered, documentRevision(file, ['C:/s/song.pdf']))).toBe(false);
    expect(sameRevision(offered, documentRevision({ ...file, editRevision: 4 }, []))).toBe(false);
    expect(sameRevision(offered, documentRevision({ ...file, buffer: [2] }, []))).toBe(false);
    expect(sameRevision(offered, documentRevision({ ...file, undoStack: [{} as never] }, []))).toBe(false);
    expect(sameRevision(offered, documentRevision(undefined, []))).toBe(false);
  });

  it('runs the guided step unattended, replacing only listed names and only with consent', async () => {
    const refusing = fakeIo({ publish: () => { throw new EngineError(EXISTS); } });
    await expect(runUnattendedRecognition(refusing.io, REQUEST, false)).rejects.toBeInstanceOf(EngineError);
    expect(refusing.discarded).toEqual(['tok']);
    const consenting = fakeIo({ publish: (names) => {
      if (names.length === 0) throw new EngineError(EXISTS);
      return { files: [{ path: 'C:/s/song.mxl', movement: null }], project: null, projectId: null };
    } });
    const result = await runUnattendedRecognition(consenting.io, REQUEST, true);
    expect(result.files.length).toBe(1);
    expect(consenting.published).toEqual([[], ['song.mxl', 'song.omr']]);
  });

  it('maps the guided step parameters to a request beside the document', () => {
    expect(guidedRecognitionRequest(buildStepParams(newStep('omr')), 'C:\\s\\song.pdf')).toEqual({
      request: {
        pages: 'all', outputDir: 'C:\\s', baseName: 'song', format: 'mxl', keepProject: false,
        dpi: 300, ocrLang: '', attach: false,
      },
      replaceExisting: false,
    });
  });
});

describe('failures the panel explains', () => {
  it('names each target a failed rollback left, with its backup or as new', () => {
    const error = new EngineError('rollback failed', {
      landed: ['C:/s/song.mvt1.mxl'],
      unrestored: { 'C:/s/song.mvt1.mxl': 'C:/s/song.mvt1.mxl.bak-1', 'C:/s/song.mvt2.mxl': '' },
    });
    const listed = unrestoredOutputs(error);
    expect(listed).toEqual([
      { target: 'C:/s/song.mvt1.mxl', backup: 'C:/s/song.mvt1.mxl.bak-1' },
      { target: 'C:/s/song.mvt2.mxl', backup: null },
    ]);
    expect(tChrome('panel.omr.unrestored', { target: listed[0].target, backup: listed[0].backup! })).toBe(
      'Not restored: C:/s/song.mvt1.mxl (its previous content is in C:/s/song.mvt1.mxl.bak-1)',
    );
    expect(tChrome('panel.omr.unrestoredNew', { target: listed[1].target })).toBe(
      'Not removed: C:/s/song.mvt2.mxl (it did not exist before this run)',
    );
  });

  it('names nothing for an error without unrestored targets', () => {
    expect(unrestoredOutputs(new EngineError('x', { landed: ['a'] }))).toEqual([]);
    expect(unrestoredOutputs(new EngineError('x', { unrestored: { a: 7, '': 'b' } }))).toEqual([]);
    expect(unrestoredOutputs(new EngineError('x'))).toEqual([]);
    expect(unrestoredOutputs(new Error('x'))).toEqual([]);
  });

  it('keeps the unrestored list on the failed outcome of the flow', async () => {
    const error = new EngineError('rollback failed', { unrestored: { 'C:/s/song.mxl': '' } });
    const { io, discarded } = fakeIo({ publish: () => { throw error; } });
    const outcome = await startRecognition(io, REQUEST);
    expect(outcome.kind === 'failed' && unrestoredOutputs(outcome.error)).toEqual([{ target: 'C:/s/song.mxl', backup: null }]);
    expect(discarded).toEqual(['tok']);
  });

  it('offers the log a failed run names in its error data', () => {
    expect(failureLog(new EngineError('Music recognition failed: Audiveris exited with status 1', {
      log: 'C:/t/omr-logs/song.log',
    }))).toBe('C:/t/omr-logs/song.log');
    expect(failureLog(new EngineError('Music recognition failed: Audiveris exited with status 1'))).toBeNull();
    expect(failureLog(new EngineError('x', { log: 7 }))).toBeNull();
    expect(failureLog(new Error('x'))).toBeNull();
  });

  it('maps every open-project refusal key to its message and passes others through', () => {
    for (const [code, key] of Object.entries(OPEN_PROJECT_REFUSALS)) {
      expect(openProjectRefusalKey(code)).toBe(key);
      expect(tChrome(key as UiKey)).not.toBe(key);
    }
    expect(openProjectRefusalKey('omr.openProjectNoAudiveris')).toBe('panel.omr.openProjectNoAudiveris');
    expect(openProjectRefusalKey(new Error('omr.openProjectNotProject'))).toBe('panel.omr.openProjectNotProject');
    expect(openProjectRefusalKey('omr.openProjectPathUnreadable')).toBe('panel.omr.openProjectPathUnreadable');
    expect(openProjectRefusalKey('something else')).toBeNull();
    expect(openProjectRefusalKey('toString')).toBeNull();
  });
});

describe('the guided step', () => {
  const action = (ops: string[]): GuidedAction => ({
    id: 'a',
    name: 'Scores',
    steps: ops.map((op) => newStep(op as never)),
  });

  it('runs the recognize_music door and writes beside the document', () => {
    const def = stepDefFor('omr');
    expect(STEP_CATALOG).toContain(def);
    expect(engineMethodFor('omr')).toBe('recognize_music_prepare');
    expect(def.besideOutput).toBe(true);
    expect(def.needsAudiveris).toBe(true);
    expect(def.terminalOutput).toBeUndefined();
  });

  it('emits typed parameters and clamps the resolution', () => {
    expect(buildStepParams(newStep('omr'))).toEqual({
      pages: 'all',
      format: 'mxl',
      dpi: 300,
      ocr_lang: null,
      keep_project: false,
      overwrite: false,
    });
    const step = newStep('omr');
    step.params = { pages: '1-3,5', format: 'musicxml', dpi: 900, ocr_lang: ' eng+deu ', keep_project: 'yes', overwrite: 'yes' };
    expect(buildStepParams(step)).toEqual({
      pages: [1, 2, 3, 5],
      format: 'musicxml',
      dpi: OMR_DPI_MAX,
      ocr_lang: 'eng+deu',
      keep_project: true,
      overwrite: true,
    });
  });

  it('refuses at plan time, naming the step, when Audiveris is absent', () => {
    const text = audiverisBlocker(action(['compress', 'omr']), true);
    expect(text).toBe(
      'Recognize Music needs Audiveris, which Spectra PDF does not include. Install it, then point Spectra PDF at it in Preferences ▸ Engine, or take that step out of this action.',
    );
  });

  it('refuses a page field it cannot read instead of widening it to every page', () => {
    const bad = action(['omr']);
    bad.steps[0].params.pages = '1-x';
    expect(stepConfigProblem(bad.steps[0])).toEqual({ kind: 'invalidParam', param: 'pages' });
    expect(stepConfigCue(bad.steps[0])).toBe('This step cannot read Pages. A list such as 1-3,5 — or all.');
    expect(validateAction(bad)).toBe('Step 1 (Recognize Music): Pages cannot be read. A list such as 1-3,5 — or all.');
    const asked = action(['omr']);
    asked.steps[0].ask = ['pages'];
    expect(stepConfigProblem(asked.steps[0])).toBeNull();
    expect(validateRunValues(asked.steps[0], { pages: '3-1' })).toBe(
      'Recognize Music: Pages cannot be read. A list such as 1-3,5 — or all.',
    );
    expect(validateRunValues(asked.steps[0], { pages: 'all' })).toBeNull();
    const good = action(['omr']);
    good.steps[0].params.pages = '2-4';
    expect(validateAction(good)).toBeNull();
  });

  it('refuses nothing when Audiveris is usable or no step needs it', () => {
    expect(audiverisBlocker(action(['compress', 'omr']), false)).toBeNull();
    expect(audiverisBlocker(action(['compress', 'ocr_file']), true)).toBeNull();
  });
});
