// Per-document reading-view history (the `spectra-view-history` localStorage
// key). One record per canonical path: the page NUMBER, the document index and
// the view axes, never a page id, because page ids are per-realm and
// generation-tagged and would name a different page after a reopen.
//
// The key is shared by every window. A document is owned by one window at a
// time, so one path's row never races; every write is still a read-modify-
// write of the whole map under one Web Lock, or a write in one window erases
// the rows another window wrote since this one last read.

import {
  LAYOUT_MODES,
  READING_ZOOM_PERCENT_MAX,
  READING_ZOOM_PERCENT_MIN,
  SCROLL_MODES,
  VIEW_HISTORY_KEY,
  ZOOM_MODES,
  type LayoutMode,
  type ScrollMode,
  type ZoomMode,
} from './reading-view-types';

const STORAGE_LOCK = 'spectra-view-history-storage';

/** Rows kept; the least recently saved go first. */
export const VIEW_HISTORY_MAX = 200;

export interface ViewHistoryRecord {
  /** 1-based within `docIndex`. */
  page: number;
  /** 0-based position among the file's documents; 0 for an ordinary PDF. */
  docIndex: number;
  zoomMode: ZoomMode;
  /** Percent of actual size of `page` at save time. */
  zoomPercent: number;
  layoutMode: LayoutMode;
  coverAlone: boolean;
  scrollMode: ScrollMode;
  /** Page count at save time. */
  pageCount: number;
  /** Epoch ms; orders LRU eviction. */
  savedAt: number;
}

export interface ViewHistoryFile {
  v: 1;
  /** Keyed by canonical path. */
  entries: Record<string, ViewHistoryRecord>;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function integerAtLeast(value: unknown, min: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function zoomPercentOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.min(READING_ZOOM_PERCENT_MAX, Math.max(READING_ZOOM_PERCENT_MIN, value));
}

/** One row, field by field: an unknown enum or a non-finite number takes the
 * field's default, so one corrupt field never discards the rest of the row. A
 * value that is not an object at all is no row. */
export function parseViewRecord(raw: unknown): ViewHistoryRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    page: integerAtLeast(r.page, 1, 1),
    docIndex: integerAtLeast(r.docIndex, 0, 0),
    zoomMode: pick(r.zoomMode, ZOOM_MODES, 'fitPage'),
    zoomPercent: zoomPercentOf(r.zoomPercent),
    layoutMode: pick(r.layoutMode, LAYOUT_MODES, 'single'),
    coverAlone: r.coverAlone === true,
    scrollMode: pick(r.scrollMode, SCROLL_MODES, 'continuous'),
    pageCount: integerAtLeast(r.pageCount, 0, 0),
    savedAt: typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) && r.savedAt >= 0 ? r.savedAt : 0,
  };
}

/** Newest `VIEW_HISTORY_MAX` rows; `keep` survives whatever its timestamp, so
 * a write from a window whose clock runs behind still lands. */
function capped(rows: Map<string, ViewHistoryRecord>, keep?: string): Map<string, ViewHistoryRecord> {
  if (rows.size <= VIEW_HISTORY_MAX) return rows;
  const ordered = [...rows.entries()].sort(
    ([pa, a], [pb, b]) => Number(pb === keep) - Number(pa === keep) || b.savedAt - a.savedAt,
  );
  return new Map(ordered.slice(0, VIEW_HISTORY_MAX));
}

/** The stored map plus the counters that order a write against a removal in
 * every window. A forget or a clear takes the next generation; a write carries
 * the generation it was taken at and is dropped when a removal of its path is
 * newer. A write scheduled before a removal, in any window, can therefore never
 * put the removed row back, whenever it lands. */
interface Ledger {
  rows: Map<string, ViewHistoryRecord>;
  /** The generation each row was written at; absent means 0. */
  rowGen: Map<string, number>;
  gen: number;
  /** The generation of the last clear. */
  cleared: number;
  /** Per path, the generation of its last forget. */
  forgotten: Map<string, number>;
}

function generationOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function generationsOf(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [path, g] of Object.entries(value as Record<string, unknown>)) {
    const n = generationOf(g);
    if (path !== '' && n > 0) out.set(path, n);
  }
  return out;
}

function ledgerOf(raw: string | null): Ledger {
  const ledger: Ledger = { rows: new Map(), rowGen: new Map(), gen: 0, cleared: 0, forgotten: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || 'null');
  } catch {
    return ledger;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ledger;
  const file = parsed as { entries?: unknown; gen?: unknown; cleared?: unknown; forgotten?: unknown; rowGen?: unknown };
  ledger.cleared = generationOf(file.cleared);
  ledger.forgotten = generationsOf(file.forgotten);
  ledger.rowGen = generationsOf(file.rowGen);
  ledger.gen = Math.max(generationOf(file.gen), ledger.cleared, ...ledger.forgotten.values());
  const entries = file.entries;
  if (entries !== null && typeof entries === 'object' && !Array.isArray(entries)) {
    for (const [path, value] of Object.entries(entries as Record<string, unknown>)) {
      if (path === '') continue;
      const rec = parseViewRecord(value);
      if (rec) ledger.rows.set(path, rec);
    }
  }
  ledger.rows = capped(ledger.rows);
  return ledger;
}

function fileOf(rows: Map<string, ViewHistoryRecord>): ViewHistoryFile {
  // A null-prototype map: a path spelled like an Object.prototype member must
  // read back as a row, never as an inherited property.
  const entries = Object.assign(Object.create(null) as Record<string, ViewHistoryRecord>, Object.fromEntries(rows));
  return { v: 1, entries };
}

/** Pure parse of the stored value. Anything unreadable is an empty history. */
export function parseViewHistory(raw: string | null): ViewHistoryFile {
  return fileOf(ledgerOf(raw).rows);
}

function readLedger(): Ledger {
  try {
    return ledgerOf(localStorage.getItem(VIEW_HISTORY_KEY));
  } catch {
    return ledgerOf(null);
  }
}

function writeLedger(l: Ledger): void {
  const rowGen = [...l.rowGen].filter(([path, g]) => g > 0 && l.rows.has(path));
  // A forget no newer than the last clear is implied by the clear; the newest
  // forgets are the ones a pending write can still be older than.
  const forgotten = [...l.forgotten]
    .filter(([, g]) => g > l.cleared)
    .sort(([, a], [, b]) => b - a)
    .slice(0, VIEW_HISTORY_MAX);
  try {
    if (l.rows.size === 0 && l.gen === 0) {
      localStorage.removeItem(VIEW_HISTORY_KEY);
      return;
    }
    const file: Record<string, unknown> = { v: 1, gen: l.gen, cleared: l.cleared };
    if (forgotten.length > 0) file.forgotten = Object.fromEntries(forgotten);
    if (rowGen.length > 0) file.rowGen = Object.fromEntries(rowGen);
    file.entries = Object.fromEntries(l.rows);
    localStorage.setItem(VIEW_HISTORY_KEY, JSON.stringify(file));
  } catch {
    // storage full or unavailable: the history is best-effort
  }
}

export function readViewRecord(path: string): ViewHistoryRecord | null {
  return readLedger().rows.get(path) ?? null;
}

/** The current removal generation. A writer captures it when it takes the view
 * it writes later, and passes it as `gen`. */
export function viewHistoryGeneration(): number {
  return readLedger().gen;
}

let fallbackLock: Promise<void> = Promise.resolve();

// Web Locks serialize the read-modify-write across windows; localStorage makes
// each get and set atomic but not the pair. The fallback orders writes within
// one realm where `navigator.locks` is absent (unit tests).
async function withViewHistoryLock<T>(operation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(STORAGE_LOCK, operation);
  }
  const result = fallbackLock.then(operation, operation);
  fallbackLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function merge(path: string, rec: ViewHistoryRecord, gen: number | undefined): void {
  const sane = parseViewRecord(rec);
  if (path === '' || !sane) return;
  const l = readLedger();
  const born = gen === undefined ? l.gen : generationOf(gen);
  if (born < Math.max(l.cleared, l.forgotten.get(path) ?? 0)) return;
  l.rows.delete(path);
  l.rows.set(path, sane);
  l.rowGen.set(path, born);
  l.rows = capped(l.rows, path);
  writeLedger(l);
}

export interface WriteViewRecordOptions {
  /** Evaluated under the lock: false skips the write. A write queued behind
   * the lock can be overtaken by a synchronous flush of a newer record for the
   * same path, and landing afterwards would put the older view back. */
  stillCurrent?: () => boolean;
  /** The removal generation the record was taken at (`viewHistoryGeneration`).
   * A forget of the path or a clear at a later generation drops the write.
   * Omitted: the generation at the call. */
  gen?: number;
}

/** Locked read-modify-write of one path's row. */
export function writeViewRecord(
  path: string,
  rec: ViewHistoryRecord,
  opts: WriteViewRecordOptions = {},
): Promise<void> {
  const gen = opts.gen ?? viewHistoryGeneration();
  return withViewHistoryLock(() => {
    if (opts.stillCurrent && !opts.stillCurrent()) return;
    merge(path, rec, gen);
  });
}

/** Synchronous read-modify-write, for unmount and `pagehide`, where an awaited
 * lock may never be granted before the realm goes away. `gen` as for
 * `writeViewRecord`; omitted, the write is current. */
export function writeViewRecordNow(path: string, rec: ViewHistoryRecord, opts: { gen?: number } = {}): void {
  merge(path, rec, opts.gen);
}

/** `paths` removed from the history, or null for all of it. */
export type ViewHistoryRemovalListener = (paths: readonly string[] | null) => void;
const removalListeners = new Set<ViewHistoryRemovalListener>();

/** Called synchronously before the stored rows go, so this realm can cancel
 * the writes it has pending for the removed paths. */
export function subscribeViewHistoryRemoval(cb: ViewHistoryRemovalListener): () => void {
  removalListeners.add(cb);
  return () => {
    removalListeners.delete(cb);
  };
}

function notifyRemoval(paths: readonly string[] | null): void {
  for (const cb of [...removalListeners]) {
    try {
      cb(paths);
    } catch {
      // a listener's failure never blocks the removal
    }
  }
}

// Applied at once and again under the lock: a read-modify-write another window
// began before the removal would otherwise write the removed rows and the old
// counters back. Both passes use the generation the first one took.
function removeRows(apply: (l: Ledger, at: number) => void): void {
  let at = 0;
  const pass = (): void => {
    const l = readLedger();
    if (at === 0) at = l.gen + 1;
    l.gen = Math.max(l.gen, at);
    apply(l, at);
    writeLedger(l);
  };
  pass();
  void withViewHistoryLock(pass).catch(() => {});
}

function dropOlderRow(l: Ledger, path: string, at: number): void {
  if ((l.rowGen.get(path) ?? 0) >= at) return;
  l.rows.delete(path);
  l.rowGen.delete(path);
}

/** Remove the rows of `paths`, and every write of them taken before now. */
export function forgetViewRecords(paths: readonly string[]): void {
  const list = paths.filter((p) => p !== '');
  if (list.length === 0) return;
  notifyRemoval(list);
  removeRows((l, at) => {
    for (const p of list) {
      l.forgotten.set(p, Math.max(l.forgotten.get(p) ?? 0, at));
      dropOlderRow(l, p, at);
    }
  });
}

/** Remove every row, and every write taken before now. */
export function clearViewHistory(): void {
  notifyRemoval(null);
  removeRows((l, at) => {
    l.cleared = Math.max(l.cleared, at);
    for (const p of [...l.rows.keys()]) dropOlderRow(l, p, at);
  });
}
