/**
 * Long engine reads run on a private byte copy of the working copy.
 *
 * A job-process call (print, export, conversion) can run for minutes. Read
 * under a shared lock on the working path, it makes every page commit of that
 * document, and so every gated call in the window, wait for it. A member call
 * instead copies the working copy once, after its gate, under a shared lock
 * held only for the copy, and runs on the copy holding no lock of the working
 * path.
 *
 * Order, after the commit gate and holding nothing: the shared locks of every
 * working path the call reads, claimed in one step, every `create`, release.
 * One claim makes the copies one revision of the workspace: a commit that
 * moves a page between two of the documents cannot land between two copies.
 * Then the credential loan, outside every lock: it waits in the window's
 * engine queue. Then the call's own write chain and file locks, with each
 * copied key replaced by its copy. A copy is never claimed while the call's
 * claims are held: a commit that claims two working paths in one step between
 * the two claims would wait for the call while the call waits for it.
 *
 * The queue label and the log read the caller's parameters. The result and the
 * refusal text name the working path, never the copy. The copy is removed and
 * the loan returned when the call settles, whatever the outcome; a copy still
 * held open is removed by Rust when the window is destroyed.
 *
 * A member keeps no state that names its input past the call. A method whose
 * cache or result keeps the input path (the separation plate cache, the print
 * preview folder) is not a member. Every member runs in the job process and
 * holds every parameter listed here shared (tests/test_reader_copy_table.py).
 */
import { withFileLock, type LockClaim } from './engine-lock';
import { EngineError } from './engine-messages';
import type { OpenFile } from '../state/types';

/** Each member -> the parameters that carry a working path. */
export const READER_COPY_METHODS: Readonly<Record<string, readonly string[]>> = {
  print: ['file'],
  printed_job: ['file'],
  export_document: ['file'],
  export_images: ['file'],
  export_postscript: ['file'],
  convert_pdfa: ['file'],
  convert_pdfx: ['file'],
  convert_cmyk: ['file'],
  distill: ['file'],
  compare_visual: ['file_a', 'file_b'],
  preflight: ['file'],
  apply_preflight_fixups: ['file'],
  flatten_transparency: ['file'],
  analyze_scan: ['file'],
  detect_form_fields: ['file'],
  sign_pdf: ['file'],
  compress: ['file'],
  grayscale: ['file'],
  rebuild: ['file'],
};

export function isReaderCopyMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(READER_COPY_METHODS, method);
}

export type ReaderCopyFile = Pick<OpenFile, 'workingPath' | 'security'>;

export interface ReaderCopyIo {
  /** The open, non-import-only file of this window whose working copy is `workingPath`. */
  fileAt: (workingPath: string) => ReaderCopyFile | undefined;
  /** Rust `create_reader_copy`: the copy's path, or a rejection when none can be made. */
  create: (workingPath: string) => Promise<string>;
  /** Rust `remove_reader_copy`: false while a handle still holds the copy. */
  remove: (copy: string) => Promise<boolean>;
  /** Lends the file's credential to the copy; true when the loan is returned with `giveBack`. */
  lend: (file: ReaderCopyFile, copy: string) => Promise<boolean>;
  /** Engine `close_document(copy)`. */
  giveBack: (copy: string) => Promise<void>;
}

/** Runs the engine step of a call. A call on a copy passes it through the hold seam. */
export type ReaderDispatch = <R>(send: () => Promise<R>) => Promise<R>;

export type ReaderCopyRun<T> = (
  params: Record<string, unknown>,
  claims: LockClaim[],
  dispatch: ReaderDispatch,
) => Promise<T>;

/**
 * Holds every call that runs on a reader copy after its copies exist and its
 * locks are taken, before its engine step, until `release` runs. An end-to-end
 * spec decides with it what happens during a long read without a timer.
 * Reached only from the harness, which exists only in a `VITE_E2E` build.
 */
let readerHold: { held: Promise<void>; waiting: number } | null = null;
export function holdReaderCopies(): { release: () => void; waiting: () => number } {
  let release!: () => void;
  const hold = { held: new Promise<void>(resolve => { release = resolve; }), waiting: 0 };
  readerHold = hold;
  return {
    release: () => { if (readerHold === hold) readerHold = null; release(); },
    waiting: () => hold.waiting,
  };
}

const direct: ReaderDispatch = send => send();
const heldDispatch: ReaderDispatch = async send => {
  const hold = readerHold;
  if (hold) {
    hold.waiting++;
    try { await hold.held; } finally { hold.waiting--; }
  }
  return send();
};

function pathValues(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item !== '');
  return [];
}

function errorText(error: unknown): string {
  if (error instanceof EngineError) return error.raw;
  return error instanceof Error ? error.message : String(error);
}

/** The folder part of `path` and its last component, split at the last separator. */
function splitPath(path: string): [string, string] | null {
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return at > 0 ? [path.slice(0, at), path.slice(at + 1)] : null;
}

/** Copy spelling -> working spelling, longest first. The copy's folder maps to
 * the working folder when the two file names agree, so a message that names
 * the folder alone reads right too. Each pair also appears with backslashes
 * doubled, as a quoted path in Python's or JSON's escaping spells it. */
function replacements(copies: ReadonlyMap<string, string>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [working, copy] of copies) {
    pairs.push([copy, working]);
    const c = splitPath(copy);
    const w = splitPath(working);
    if (c && w && c[1] === w[1]) pairs.push([c[0], w[0]]);
  }
  const escaped = pairs
    .filter(([from]) => from.includes('\\'))
    .map(([from, to]): [string, string] => [from.replace(/\\/g, '\\\\'), to.replace(/\\/g, '\\\\')]);
  return [...escaped, ...pairs].sort((a, b) => b[0].length - a[0].length);
}

function remapText(text: string, pairs: readonly [string, string][]): string {
  let out = text;
  for (const [from, to] of pairs) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

function remapValue(value: unknown, pairs: readonly [string, string][]): unknown {
  if (typeof value === 'string') return remapText(value, pairs);
  if (Array.isArray(value)) return value.map(item => remapValue(item, pairs));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapValue(item, pairs)]));
  }
  return value;
}

function remapError(error: unknown, pairs: readonly [string, string][]): unknown {
  if (error instanceof EngineError) {
    const raw = remapText(error.raw, pairs);
    const data = remapValue(error.data, pairs);
    return raw === error.raw && JSON.stringify(data) === JSON.stringify(error.data) ? error : new EngineError(raw, data);
  }
  if (error instanceof Error) {
    const message = remapText(error.message, pairs);
    if (message !== error.message) error.message = message;
    return error;
  }
  return remapValue(error, pairs);
}

/**
 * Runs `run` on reader copies of the working copies `method` reads, or on the
 * working copies themselves. A working path is copied when a parameter listed
 * for the method names it, the call claims it shared, and it is the working
 * copy of an open file of this window. A call that copies nothing, and every
 * non-member, reaches `run` synchronously with its own parameters and claims.
 * A copy that cannot be made or cannot be lent its credential leaves that path
 * to the shared-lock read.
 */
export function withReaderCopies<T>(
  method: string,
  params: Record<string, unknown>,
  claims: LockClaim[],
  io: ReaderCopyIo | null,
  run: ReaderCopyRun<T>,
): Promise<T> {
  if (!io || !isReaderCopyMethod(method)) return run(params, claims, direct);
  const declared = READER_COPY_METHODS[method];
  const shared = new Set(claims.filter(claim => claim.mode === 'shared').map(claim => claim.key));
  const working: string[] = [];
  for (const param of declared) {
    for (const path of pathValues(params[param])) {
      if (shared.has(path) && !working.includes(path) && io.fileAt(path)) working.push(path);
    }
  }
  if (!working.length) return run(params, claims, direct);
  return runOnCopies(method, params, claims, declared, working, io, run);
}

async function runOnCopies<T>(
  method: string,
  params: Record<string, unknown>,
  claims: LockClaim[],
  declared: readonly string[],
  working: readonly string[],
  io: ReaderCopyIo,
  run: ReaderCopyRun<T>,
): Promise<T> {
  const fallback = (path: string, error: unknown) =>
    console.info(`[reader-copy] ${method} reads ${path} under its lock: ${errorText(error)}`);
  const made: string[] = [];
  const lent = new Set<string>();
  const copies = new Map<string, string>();
  try {
    // One claim of the read keys and nothing else held: see the module comment.
    await withFileLock(working.map(key => ({ key, mode: 'shared' as const })), async () => {
      for (const path of working) {
        try {
          const copy = await io.create(path);
          made.push(copy);
          copies.set(path, copy);
        } catch (error) {
          fallback(path, error);
        }
      }
    });
    for (const [path, copy] of [...copies]) {
      try {
        const file = io.fileAt(path);
        if (!file) throw new Error('the document is no longer open');
        if (await io.lend(file, copy)) lent.add(copy);
      } catch (error) {
        copies.delete(path);
        fallback(path, error);
      }
    }
    if (!copies.size) return await run(params, claims, direct);
    const readParams: Record<string, unknown> = { ...params };
    for (const param of declared) {
      const value = params[param];
      if (typeof value === 'string') readParams[param] = copies.get(value) ?? value;
      else if (Array.isArray(value)) readParams[param] = value.map(item => typeof item === 'string' ? copies.get(item) ?? item : item);
    }
    const readClaims = claims.map(claim => {
      const copy = copies.get(claim.key);
      return copy ? { key: copy, mode: 'shared' as const } : claim;
    });
    const pairs = replacements(copies);
    try {
      return remapValue(await run(readParams, readClaims, heldDispatch), pairs) as T;
    } catch (error) {
      throw remapError(error, pairs);
    }
  } finally {
    for (const copy of made) {
      try {
        await io.remove(copy);
      } catch (error) {
        console.info(`[reader-copy] ${method} left ${copy}: ${errorText(error)}`);
      }
      if (lent.has(copy)) await io.giveBack(copy).catch(() => {});
    }
  }
}
