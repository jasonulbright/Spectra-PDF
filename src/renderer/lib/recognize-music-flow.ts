// Recognize Music as four engine steps: prepare the selected pages into a
// private stage, run Audiveris on the stage, publish the scores beside the
// document, attach the first score. Only prepare reads the document and only
// attach writes it, so neither the document lock nor the window's job process
// is held while Audiveris runs.
//
// The stage outlives a publish refusal, so consenting to replace the listed
// files publishes again without running Audiveris again. Every other end of a
// prepared run discards the stage.

import {
  attachedScore,
  fileStem,
  ocrLangParam,
  parentFolder,
  existingOutputs,
  failureLog,
  readAttachAnswer,
  readPrepareAnswer,
  readPublishAnswer,
  readRunAnswer,
  type MusicFormat,
  type RecognizeMusicRequest,
  type RecognizeMusicResult,
  type RunAnswer,
} from './recognize-music';
import type { OpenFile, PdfBuffer } from '../state/types';

/** The engine side of one recognition. The panel and the guided runner each
 * supply their own: which call path takes which lock is theirs to decide. */
export interface RecognizeMusicIo {
  prepare(params: { pages: 'all' | number[]; attach: boolean }): Promise<unknown>;
  run(params: { token: string; dpi: number; ocr_lang: string | null; keep_project: boolean }, signal?: AbortSignal): Promise<unknown>;
  publish(params: {
    token: string;
    output_dir: string;
    base_name: string;
    format: string;
    keep_project: boolean;
    overwrite_names: string[];
  }): Promise<unknown>;
  /** Resolves `'declined'` when the signed-document decision stopped it, and
   * `'changed'` when the document is no longer the revision that was
   * prepared: the page ties would address other pages. */
  attach(scorePath: string, signal?: AbortSignal): Promise<unknown>;
  /** Fire-and-forget; a failure to discard is the engine's to log. */
  discard(token: string): void;
}

/** A publish the engine refused because these files exist. The stage is kept;
 * `names` is the exact set the user is asked to replace. */
export interface PendingPublish {
  token: string;
  names: string[];
  request: RecognizeMusicRequest;
  run: RunAnswer;
  /** The refusal itself, for a caller that cannot ask. */
  error: unknown;
}

/** Why a requested attach did not happen, or null. */
export type AttachSkip = 'declined' | 'changed' | null;

export type RecognizeMusicOutcome =
  | { kind: 'done'; result: RecognizeMusicResult; attachError: unknown | null; attachSkipped: AttachSkip }
  | { kind: 'consent'; pending: PendingPublish }
  | { kind: 'stopped'; log: string | null }
  | { kind: 'failed'; error: unknown; log: string | null };

const unverified = (step: string): Error => new Error(`recognize_music_${step} returned no answer`);

/** Prepare, run and publish one request; attach when it asks to. */
export async function startRecognition(
  io: RecognizeMusicIo,
  request: RecognizeMusicRequest,
  signal?: AbortSignal,
): Promise<RecognizeMusicOutcome> {
  let token: string;
  try {
    const prepared = readPrepareAnswer(await io.prepare({ pages: request.pages, attach: request.attach }));
    if (!prepared) throw unverified('prepare');
    token = prepared.token;
  } catch (error) {
    return signal?.aborted ? { kind: 'stopped', log: null } : { kind: 'failed', error, log: failureLog(error) };
  }
  if (signal?.aborted) {
    io.discard(token);
    return { kind: 'stopped', log: null };
  }
  let run: RunAnswer;
  try {
    const answer = readRunAnswer(await io.run({
      token,
      dpi: request.dpi,
      ocr_lang: ocrLangParam(request.ocrLang),
      keep_project: request.keepProject,
    }, signal));
    if (!answer) throw unverified('run');
    run = answer;
  } catch (error) {
    io.discard(token);
    return signal?.aborted
      ? { kind: 'stopped', log: failureLog(error) }
      : { kind: 'failed', error, log: failureLog(error) };
  }
  if (signal?.aborted) {
    io.discard(token);
    return { kind: 'stopped', log: run.log };
  }
  return publishAndAttach(io, token, request, run, [], signal);
}

/** Replace exactly the names the user was shown, from the kept stage. */
export function confirmPublish(
  io: RecognizeMusicIo,
  pending: PendingPublish,
  signal?: AbortSignal,
): Promise<RecognizeMusicOutcome> {
  return publishAndAttach(io, pending.token, pending.request, pending.run, pending.names, signal);
}

/** The user declined, changed the form, or the document changed. */
export function dropPending(io: RecognizeMusicIo, pending: PendingPublish): void {
  io.discard(pending.token);
}

async function publishAndAttach(
  io: RecognizeMusicIo,
  token: string,
  request: RecognizeMusicRequest,
  run: RunAnswer,
  overwriteNames: string[],
  signal?: AbortSignal,
): Promise<RecognizeMusicOutcome> {
  if (signal?.aborted) {
    io.discard(token);
    return { kind: 'stopped', log: run.log };
  }
  let published: NonNullable<ReturnType<typeof readPublishAnswer>>;
  try {
    const answer = readPublishAnswer(await io.publish({
      token,
      output_dir: request.outputDir,
      base_name: request.baseName,
      format: request.format,
      keep_project: request.keepProject,
      overwrite_names: overwriteNames,
    }));
    if (!answer) throw unverified('publish');
    published = answer;
  } catch (error) {
    const names = existingOutputs(error);
    if (names !== null) return { kind: 'consent', pending: { token, names, request, run, error } };
    io.discard(token);
    return { kind: 'failed', error, log: failureLog(error) ?? run.log };
  }
  io.discard(token);
  const result: RecognizeMusicResult = {
    files: published.files,
    project: published.project,
    projectId: published.projectId,
    attached: false,
    skippedPages: run.skippedPages,
    log: run.log,
    untiedPages: [],
  };
  const score = attachedScore(published.files);
  if (!request.attach || signal?.aborted || score === null) {
    return { kind: 'done', result, attachError: null, attachSkipped: null };
  }
  try {
    const answer = await io.attach(score, signal);
    if (answer === 'declined' || answer === 'changed') {
      return { kind: 'done', result, attachError: null, attachSkipped: answer };
    }
    return {
      kind: 'done',
      result: { ...result, attached: true, untiedPages: readAttachAnswer(answer).untiedPages },
      attachError: null,
      attachSkipped: null,
    };
  } catch (error) {
    return { kind: 'done', result, attachError: error, attachSkipped: null };
  }
}

/** The document revision a pending publish was offered against. A page edit
 * or a whole-file change replaces at least one of these. */
export interface DocumentRevision {
  buffer: PdfBuffer | null;
  editRevision: number;
  pageDirty: boolean;
  undoDepth: number;
}

export function documentRevision(file: OpenFile | null | undefined, pageDirtyPaths: readonly string[]): DocumentRevision | null {
  if (!file) return null;
  return {
    buffer: file.buffer ?? null,
    editRevision: file.editRevision ?? 0,
    pageDirty: pageDirtyPaths.includes(file.path),
    undoDepth: file.undoStack.length,
  };
}

export function sameRevision(a: DocumentRevision | null, b: DocumentRevision | null): boolean {
  return a !== null && b !== null && a.buffer === b.buffer && a.editRevision === b.editRevision
    && a.pageDirty === b.pageDirty && a.undoDepth === b.undoDepth;
}

/** The guided step's stored parameters as one request beside the document,
 * and whether the step consents to replacing existing scores. */
export function guidedRecognitionRequest(
  params: Record<string, unknown>,
  documentPath: string,
): { request: RecognizeMusicRequest; replaceExisting: boolean } {
  const pages = params.pages === 'all' || Array.isArray(params.pages) ? (params.pages as 'all' | number[]) : 'all';
  return {
    request: {
      pages,
      outputDir: parentFolder(documentPath),
      baseName: fileStem(documentPath),
      format: (params.format === 'musicxml' ? 'musicxml' : 'mxl') as MusicFormat,
      keepProject: params.keep_project === true,
      dpi: Number(params.dpi),
      ocrLang: typeof params.ocr_lang === 'string' ? params.ocr_lang : '',
      attach: false,
    },
    replaceExisting: params.overwrite === true,
  };
}

/**
 * One recognition with nobody to ask. An existing score is replaced only when
 * the step consents, and then only the files the engine listed; otherwise the
 * listing refusal is the step's error.
 */
export async function runUnattendedRecognition(
  io: RecognizeMusicIo,
  request: RecognizeMusicRequest,
  replaceExisting: boolean,
): Promise<RecognizeMusicResult> {
  let outcome = await startRecognition(io, request);
  if (outcome.kind === 'consent' && replaceExisting) outcome = await confirmPublish(io, outcome.pending);
  if (outcome.kind === 'consent') {
    dropPending(io, outcome.pending);
    throw outcome.pending.error;
  }
  if (outcome.kind === 'failed') throw outcome.error;
  if (outcome.kind === 'stopped') throw new Error('recognize_music_run stopped');
  return outcome.result;
}
