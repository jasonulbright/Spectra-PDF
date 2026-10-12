// Recognize Music: the request the panel and the guided step send, and the
// answer they read. Pure, so the shapes are testable without a DOM.

import { EngineError, matchEngineMessage } from './engine-messages';

/** The output formats, in the order the panel lists them. A list rather than a
 * flag, so a further format is one more row. */
export const MUSIC_FORMATS = [
  { id: 'mxl', extension: '.mxl' },
  { id: 'musicxml', extension: '.musicxml' },
] as const;

export type MusicFormat = (typeof MUSIC_FORMATS)[number]['id'];

export const DEFAULT_MUSIC_FORMAT: MusicFormat = 'mxl';

/** Audiveris's own scanning range: below it detail is lost, above it the run
 * costs more and gains nothing. */
export const OMR_DPI_MIN = 200;
export const OMR_DPI_MAX = 500;
export const OMR_DPI_DEFAULT = 300;
export const OMR_DPI_SMALL_NOTATION = 400;

/** The engine-message key of the refusal that lists every existing output
 * a run would replace, in its `names` value. */
export const OMR_OUTPUT_EXISTS_KEY = 'recognize_music.theseFilesAlreadyExist';

export function musicFormatExtension(format: MusicFormat): string {
  return MUSIC_FORMATS.find((f) => f.id === format)?.extension ?? '.mxl';
}

function separatorIndex(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/** The folder part of a path; empty for a bare name. A root keeps its
 * separator: `D:` alone names the drive's current folder, and an empty string
 * names no folder at all. */
function folderOf(path: string, i: number): string {
  if (i < 0) return '';
  const atRoot = i === 0 || (i === 2 && /^[A-Za-z]:$/.test(path.slice(0, 2)));
  return path.slice(0, atRoot ? i + 1 : i);
}

/** Everything before the last path separator; empty for a bare name. */
export function parentFolder(path: string): string {
  return folderOf(path, separatorIndex(path));
}

/** The base name without its last extension. A leading dot belongs to the
 * name. */
export function fileStem(path: string): string {
  const name = path.slice(separatorIndex(path) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The save dialog's default: beside the source, named after it. */
export function defaultScorePath(sourcePath: string, format: MusicFormat): string {
  const i = separatorIndex(sourcePath);
  const folder = i < 0 ? '' : sourcePath.slice(0, i + 1);
  return `${folder}${fileStem(sourcePath)}${musicFormatExtension(format)}`;
}

/**
 * The folder and base name a picked score path names.
 *
 * Only a MusicXML extension is removed: the engine appends the format's own
 * extension and the movement suffix, so `song.v2` keeps its `.v2`.
 */
export function splitScoreDestination(dest: string): { outputDir: string; baseName: string } {
  const i = separatorIndex(dest);
  const name = dest.slice(i + 1);
  const baseName = name.replace(/\.(mxl|musicxml|xml)$/i, '');
  return { outputDir: folderOf(dest, i), baseName };
}

/** Audiveris's OCR language specification: codes joined by `+`, in the order
 * the installed list gives them. Empty means no OCR language was chosen. */
export function ocrLanguageSpec(installed: readonly string[], chosen: ReadonlySet<string>): string {
  return installed.filter((code) => chosen.has(code)).join('+');
}

/** The engine's `ocr_lang`: null when no language is chosen, the `+`-joined
 * codes otherwise. An empty or blank specification is never sent as text. */
export function ocrLangParam(spec: string): string | null {
  const trimmed = spec.trim();
  return trimmed === '' ? null : trimmed;
}

export function dpiInRange(dpi: number): boolean {
  return Number.isInteger(dpi) && dpi >= OMR_DPI_MIN && dpi <= OMR_DPI_MAX;
}

/** One recognition as the user asked for it, fixed when the run starts. */
export interface RecognizeMusicRequest {
  pages: 'all' | number[];
  outputDir: string;
  baseName: string;
  format: MusicFormat;
  keepProject: boolean;
  dpi: number;
  ocrLang: string;
  attach: boolean;
}

export interface RecognizedScore {
  path: string;
  movement: number | null;
}

/** What one finished recognition wrote, read from the four steps' answers. */
export interface RecognizeMusicResult {
  files: RecognizedScore[];
  /** The kept project's path, for display only. */
  project: string | null;
  /** The id `audiveris_open_project` opens the kept project by. */
  projectId: string | null;
  attached: boolean;
  skippedPages: number[];
  log: string | null;
  /** Pages of a tagged document whose score could not be tied to one figure;
   * empty for an untagged document or when nothing was attached. */
  untiedPages: number[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function pageNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const pages = value.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1);
  return [...new Set(pages)].sort((a, b) => a - b);
}

/** `recognize_music_prepare`: the token naming the private stage. */
export function readPrepareAnswer(raw: unknown): { token: string; pageCount: number; pages: number[] } | null {
  if (!isRecord(raw)) return null;
  const token = text(raw.token);
  if (token === null) return null;
  const pageCount = typeof raw.pageCount === 'number' && Number.isInteger(raw.pageCount) ? raw.pageCount : 0;
  return { token, pageCount, pages: pageNumbers(raw.pages) };
}

export interface RunAnswer {
  token: string;
  movements: { index: number; pages: number[]; name: string }[];
  project: boolean;
  skippedPages: number[];
  log: string | null;
}

/** `recognize_music_run`: what Audiveris recognized in the stage. A run with
 * no movement is not an answer: the engine refuses that case by name. */
export function readRunAnswer(raw: unknown): RunAnswer | null {
  if (!isRecord(raw)) return null;
  const token = text(raw.token);
  if (token === null || !Array.isArray(raw.movements)) return null;
  const movements: RunAnswer['movements'] = [];
  for (const entry of raw.movements) {
    // A single movement's suffix name is the empty string.
    if (!isRecord(entry) || typeof entry.index !== 'number' || typeof entry.name !== 'string') continue;
    movements.push({ index: entry.index, pages: pageNumbers(entry.pages), name: entry.name });
  }
  if (movements.length === 0) return null;
  return {
    token,
    movements,
    project: raw.project === true,
    skippedPages: pageNumbers(raw.skippedPages),
    log: text(raw.log),
  };
}

/** `recognize_music_publish`: the files now beside the document. */
export function readPublishAnswer(raw: unknown): { files: RecognizedScore[]; project: string | null; projectId: string | null } | null {
  if (!isRecord(raw) || !Array.isArray(raw.files)) return null;
  const files: RecognizedScore[] = [];
  for (const entry of raw.files) {
    if (!isRecord(entry) || text(entry.path) === null) continue;
    const movement = entry.movement;
    files.push({
      path: String(entry.path),
      movement: typeof movement === 'number' && Number.isInteger(movement) ? movement : null,
    });
  }
  if (files.length === 0) return null;
  return { files, project: text(raw.project), projectId: text(raw.projectId) };
}

/** `recognize_music_attach`: the pages a tagged document could not tie. */
export function readAttachAnswer(raw: unknown): { untiedPages: number[] } {
  const ties = isRecord(raw) ? raw.structureTies : null;
  return { untiedPages: isRecord(ties) && ties.tagged === true ? pageNumbers(ties.untied) : [] };
}

/** The score an attach embeds: movement 1, else the only or first file. */
export function attachedScore(files: readonly RecognizedScore[]): string | null {
  return (files.find((f) => f.movement === 1) ?? files[0])?.path ?? null;
}

/**
 * Every existing output the publish refused to replace, or null for any other
 * failure. Read from the refusal's structured `error.data.names` when the
 * engine sends it, else from the matched row's captured value; never from the
 * displayed text.
 */
export function existingOutputs(error: unknown): string[] | null {
  if (!(error instanceof EngineError)) return null;
  const hit = matchEngineMessage(error.raw);
  if (hit?.row.key !== OMR_OUTPUT_EXISTS_KEY) return null;
  const listed = isRecord(error.data) ? error.data.names : undefined;
  if (Array.isArray(listed) && listed.length > 0 && listed.every((n) => typeof n === 'string' && n !== '')) {
    return [...listed];
  }
  const names = (hit.values.names ?? '').split(', ').filter((n) => n !== '');
  return names.length > 0 ? names : null;
}

/** A publish target its failed rollback could not put back. `backup` holds
 * the previous content beside the target, or is null when the target was new
 * and nothing could restore it. */
export interface UnrestoredOutput {
  target: string;
  backup: string | null;
}

/** The targets a failed publish left changed, from `error.data.unrestored`
 * (target to backup path, `""` for a new target); empty for any other error. */
export function unrestoredOutputs(error: unknown): UnrestoredOutput[] {
  if (!(error instanceof EngineError) || !isRecord(error.data)) return [];
  const unrestored = error.data.unrestored;
  if (!isRecord(unrestored)) return [];
  const out: UnrestoredOutput[] = [];
  for (const [target, backup] of Object.entries(unrestored)) {
    if (target === '' || typeof backup !== 'string') continue;
    out.push({ target, backup: backup === '' ? null : backup });
  }
  return out;
}

/** The log file a failed run names in its `error.data`, or null. */
export function failureLog(error: unknown): string | null {
  if (!(error instanceof EngineError)) return null;
  const data = error.data;
  if (!data || typeof data !== 'object') return null;
  const log = (data as Record<string, unknown>).log;
  return typeof log === 'string' && log !== '' ? log : null;
}

/** The refusal keys `audiveris_open_project` rejects with, and the catalog
 * message each one shows. Any other rejection is shown as it came. */
export const OPEN_PROJECT_REFUSALS: Readonly<Record<string, string>> = {
  'omr.openProjectNotProject': 'panel.omr.openProjectNotProject',
  'omr.openProjectNoAudiveris': 'panel.omr.openProjectNoAudiveris',
  'omr.openProjectPathUnreadable': 'panel.omr.openProjectPathUnreadable',
};

/** The catalog key for an `audiveris_open_project` rejection, or null. */
export function openProjectRefusalKey(error: unknown): string | null {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : null;
  return raw !== null && Object.prototype.hasOwnProperty.call(OPEN_PROJECT_REFUSALS, raw)
    ? OPEN_PROJECT_REFUSALS[raw]
    : null;
}

/** The last component of a path. */
export function pathBaseName(path: string): string {
  return path.slice(separatorIndex(path) + 1);
}

/** The base name of each written file, in the engine's order. */
export function scoreFileNames(result: RecognizeMusicResult): string[] {
  return result.files.map((f) => pathBaseName(f.path));
}
