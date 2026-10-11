// The reading view's external store: live per-pane snapshots, the active
// (path, pane), and pending document seeds. Leaf module: it imports no
// component and no app state, so the status bar, the commands and every
// DocumentView pane can share it without an import cycle.
import { useSyncExternalStore } from 'react';
import { loadSettings } from './app-settings';
import { defaultsFromSettings, recordFromSnapshot, resolveOpeningView } from './reading-view-resolve';
import {
  READING_PANE_IDS,
  type ReadingPaneId,
  type ReadingViewSeed,
  type ReadingViewSnapshot,
  type ReadingViewState,
} from './reading-view-types';
import {
  readViewRecord,
  subscribeViewHistoryRemoval,
  viewHistoryGeneration,
  writeViewRecord,
  writeViewRecordNow,
  type ViewHistoryRecord,
} from './view-history';

export { VIEW_HISTORY_KEY } from './reading-view-types';

export type ReadingViewSource = 'live' | 'sibling' | 'saved' | 'defaults';

/** Quiet time after the last settled change before the history row is written. */
export const VIEW_HISTORY_DEBOUNCE_MS = 400;

// Per path, keyed by `liveKey(pane, docIndex)`: two documents of one .pdfx
// file are two views, and a pane switching between them keeps both.
const live = new Map<string, Map<string, ReadingViewSnapshot>>();
const seeds = new Map<string, ReadingViewSeed>();
const seedListeners = new Map<string, Set<() => void>>();
const activeListeners = new Set<() => void>();
let activePath: string | null = null;
let activePane: ReadingPaneId = 'a';

/** The document index each (path, pane) shows now, keyed by `paneKey`. */
const docIndexes = new Map<string, number>();
/** Per path, the pane that was active when the path was last active: the pane
 * whose view the history remembers. */
const rememberedPanes = new Map<string, ReadingPaneId>();
interface PendingRecord {
  rec: ViewHistoryRecord;
  /** The pane whose snapshot the record was taken from. */
  pane: ReadingPaneId;
  /** The history removal generation when the record was taken. */
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** True from scheduling until a write of this record lands. */
  dirty: boolean;
}
// One entry per path, replaced (never mutated) per scheduled record: a locked
// write that finds a different entry skips, so a queued older view never lands
// over a newer one flushed synchronously in the meantime.
const pendingRecords = new Map<string, PendingRecord>();
let lastSavedAt = 0;
let pagehideTarget: Window | null = null;

function paneKey(path: string, pane: ReadingPaneId): string {
  return `${pane}\u0000${path}`;
}

function liveKey(pane: ReadingPaneId, docIndex: number): string {
  return `${pane}\u0000${docIndex}`;
}

function paneOfLiveKey(key: string): string {
  return key.slice(0, key.indexOf('\u0000'));
}

function docIndexOf(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function shownDocIndex(path: string, pane: ReadingPaneId): number {
  return docIndexes.get(paneKey(path, pane)) ?? 0;
}

/** Strictly increasing within the realm, so two records of one millisecond
 * still order. */
function nextSavedAt(): number {
  lastSavedAt = Math.max(lastSavedAt + 1, Date.now());
  return lastSavedAt;
}

function watchPagehide(): void {
  if (pagehideTarget || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('pagehide', flushReadingViewHistory);
  pagehideTarget = window;
}

function dropPending(path: string): void {
  const entry = pendingRecords.get(path);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingRecords.delete(path);
}

// A removal from the history also cancels this realm's unwritten records of
// the removed paths; the generation in the stored history drops the ones
// another realm has pending.
subscribeViewHistoryRemoval((paths) => {
  for (const path of paths ?? [...pendingRecords.keys()]) dropPending(path);
});

function scheduleRecord(path: string, pane: ReadingPaneId, snap: ReadingViewSnapshot): void {
  watchPagehide();
  const prev = pendingRecords.get(path);
  if (prev?.timer) clearTimeout(prev.timer);
  const entry: PendingRecord = {
    rec: recordFromSnapshot(snap, snap.docIndex, nextSavedAt()),
    pane,
    gen: viewHistoryGeneration(),
    timer: null,
    dirty: true,
  };
  pendingRecords.set(path, entry);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const current = (): boolean => pendingRecords.get(path) === entry && entry.dirty;
    void writeViewRecord(path, entry.rec, { stillCurrent: current, gen: entry.gen })
      .then(() => {
        if (pendingRecords.get(path) === entry) entry.dirty = false;
      })
      .catch(() => {});
  }, VIEW_HISTORY_DEBOUNCE_MS);
}

/** Write one snapshot now, synchronously, as the path's latest record: a
 * locked write still queued for an older record finds a different entry and
 * skips. */
function persistNow(path: string, pane: ReadingPaneId, snap: ReadingViewSnapshot): void {
  const prev = pendingRecords.get(path);
  if (prev?.timer) clearTimeout(prev.timer);
  const entry: PendingRecord = {
    rec: recordFromSnapshot(snap, snap.docIndex, nextSavedAt()),
    pane,
    gen: viewHistoryGeneration(),
    timer: null,
    dirty: false,
  };
  pendingRecords.set(path, entry);
  writeViewRecordNow(path, entry.rec, { gen: entry.gen });
}

function flushEntry(path: string, entry: PendingRecord): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!entry.dirty) return;
  entry.dirty = false;
  writeViewRecordNow(path, entry.rec, { gen: entry.gen });
}

/** Write one document's latest view now, synchronously. A hand-off to another
 * window calls this before the receiving window can read the row. */
export function flushReadingViewRecord(path: string): void {
  const entry = pendingRecords.get(path);
  if (entry) flushEntry(path, entry);
}

/** Write every unwritten view now, synchronously: `pagehide`, window close,
 * and a pane's unmount, where a debounced or lock-queued write may never run. */
export function flushReadingViewHistory(): void {
  for (const [path, entry] of pendingRecords) flushEntry(path, entry);
}

function notifyActive(): void {
  for (const cb of [...activeListeners]) cb();
}

function notifySeed(path: string): void {
  const set = seedListeners.get(path);
  if (!set) return;
  for (const cb of [...set]) cb();
}

function sameSnapshot(a: ReadingViewSnapshot, b: ReadingViewSnapshot): boolean {
  return (
    a.zoomMode === b.zoomMode &&
    a.zoomPercent === b.zoomPercent &&
    a.layoutMode === b.layoutMode &&
    a.coverAlone === b.coverAlone &&
    a.scrollMode === b.scrollMode &&
    a.page === b.page &&
    a.columns === b.columns &&
    a.pageCount === b.pageCount &&
    a.docIndex === b.docIndex
  );
}

export interface PublishReadingViewOptions {
  /** The view's last snapshot before it unmounts. Written to the history at
   * once, synchronously, even when the path is no longer the active one and
   * even when the snapshot is unchanged, provided `pane` is the pane the
   * history remembers for the path (the one last active for it; pane a when
   * none was). */
  final?: boolean;
}

/** Record a pane's settled view. An unchanged snapshot keeps the stored
 * reference: `useSyncExternalStore` re-renders on reference change, so a
 * fresh object per publish would re-render every subscriber per scroll.
 * Only the active (path, pane) schedules a history write, except a final
 * publish (see `PublishReadingViewOptions.final`). */
export function publishReadingView(
  path: string,
  pane: ReadingPaneId,
  snap: ReadingViewSnapshot,
  opts: PublishReadingViewOptions = {},
): void {
  const docIndex = docIndexOf(snap.docIndex);
  docIndexes.set(paneKey(path, pane), docIndex);
  let panes = live.get(path);
  if (!panes) {
    panes = new Map();
    live.set(path, panes);
  }
  const key = liveKey(pane, docIndex);
  const prev = panes.get(key);
  const unchanged = prev !== undefined && sameSnapshot(prev, { ...snap, docIndex });
  if (unchanged && !opts.final) return;
  const stored = prev && unchanged ? prev : { ...snap, docIndex };
  panes.set(key, stored);
  const isActive = path === activePath && pane === activePane;
  if (opts.final) {
    if (pane === (rememberedPanes.get(path) ?? 'a')) persistNow(path, pane, stored);
  } else if (isActive) {
    scheduleRecord(path, pane, stored);
  }
  if (isActive && !unchanged) notifyActive();
}

/** A pane's live snapshot of one document of a file. */
export function liveReadingView(path: string, pane: ReadingPaneId, docIndex: number): ReadingViewSnapshot | null {
  return live.get(path)?.get(liveKey(pane, docIndexOf(docIndex))) ?? null;
}

/** Select the (path, pane) the commands and the status bar address. Selecting
 * a pane schedules the history write of its live snapshot, so the history
 * follows the selection even when the newly selected pane never changes. */
export function setActiveReadingPane(path: string | null, pane: ReadingPaneId): void {
  if (path === activePath && pane === activePane) return;
  activePath = path;
  activePane = pane;
  if (path !== null) {
    rememberedPanes.set(path, pane);
    const snap = liveReadingView(path, pane, shownDocIndex(path, pane));
    if (snap) scheduleRecord(path, pane, snap);
  }
  notifyActive();
}

/** The active pane's snapshot of the document it shows, outside React
 * (harness, commands). */
export function activeReadingView(): ReadingViewSnapshot | null {
  return activePath === null ? null : liveReadingView(activePath, activePane, shownDocIndex(activePath, activePane));
}

/** Change notification for the active entry, outside React. */
export function subscribeActiveReadingView(cb: () => void): () => void {
  activeListeners.add(cb);
  return () => {
    activeListeners.delete(cb);
  };
}

export function useActiveReadingView(): ReadingViewSnapshot | null {
  return useSyncExternalStore(subscribeActiveReadingView, activeReadingView, activeReadingView);
}

/** The document index of the path's latest recorded view: this realm's
 * unwritten record, else the stored row; null when there is neither. A reopen
 * focuses that document before its view mounts. */
export function savedDocIndexFor(path: string): number | null {
  const entry = pendingRecords.get(path);
  if (entry?.dirty) return entry.rec.docIndex;
  return readViewRecord(path)?.docIndex ?? null;
}

/** The view a pane opens with: its own live snapshot of this document (a
 * remount after a document switch), else pane a's live snapshot of this
 * document for a new split pane, else the file's saved row, else the
 * Preferences defaults. `page` is clamped to `pageCount`. */
export function initialReadingViewFor(
  path: string,
  pane: ReadingPaneId,
  docIndex: number,
  pageCount: number,
): { state: ReadingViewState; source: ReadingViewSource } {
  const index = docIndexOf(docIndex);
  docIndexes.set(paneKey(path, pane), index);
  const own = liveReadingView(path, pane, index);
  const siblingLive = pane === 'a' ? null : liveReadingView(path, 'a', index);
  return resolveOpeningView({
    live: own,
    siblingLive,
    saved: own || siblingLive ? null : readViewRecord(path),
    defaults: defaultsFromSettings(loadSettings()),
    pageCount,
    docIndex: index,
  });
}

/** Park a document's own initial view until that document's view mounts.
 * A later seed for the same path replaces an untaken one. */
export function seedReadingView(path: string, seed: ReadingViewSeed): void {
  seeds.set(path, { state: { ...seed.state }, columnsHint: seed.columnsHint });
  notifySeed(path);
}

/** Consume the pending seed: a second take returns null, so a remount never
 * re-applies a document's initial view over the user's own choices. */
export function takeReadingViewSeed(path: string): ReadingViewSeed | null {
  const seed = seeds.get(path) ?? null;
  if (seed) seeds.delete(path);
  return seed;
}

export function subscribeReadingViewSeed(path: string, cb: () => void): () => void {
  let set = seedListeners.get(path);
  if (!set) {
    set = new Set();
    seedListeners.set(path, set);
  }
  set.add(cb);
  return () => {
    const cur = seedListeners.get(path);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) seedListeners.delete(path);
  };
}

/** Drop one pane's live snapshots of a file (every document of it), for a
 * split pane that closes: a reopened split pane must clone pane a again, and
 * `initialReadingViewFor` prefers a pane's own snapshot over the clone. A
 * history record still pending from that pane is discarded unwritten,
 * including one already queued behind the lock. */
export function forgetLiveReadingPane(path: string, pane: ReadingPaneId): void {
  const entry = pendingRecords.get(path);
  if (entry && entry.pane === pane) dropPending(path);
  const wasShown = path === activePath && pane === activePane && activeReadingView() !== null;
  docIndexes.delete(paneKey(path, pane));
  const panes = live.get(path);
  if (!panes) return;
  let dropped = false;
  for (const key of [...panes.keys()]) {
    if (paneOfLiveKey(key) !== pane) continue;
    panes.delete(key);
    dropped = true;
  }
  if (panes.size === 0) live.delete(path);
  if (dropped && wasShown) notifyActive();
}

/** `forgetLiveReadingPane` for every document the store knows. The split
 * setting is window-wide, so closing it closes those panes for documents
 * that are not on screen too; forgetting only the shown document would let
 * another document's stale pane outrank pane a when the split reopens. */
export function forgetLiveReadingPanes(panes: readonly ReadingPaneId[]): void {
  const paths = new Set<string>([...live.keys(), ...pendingRecords.keys()]);
  for (const key of docIndexes.keys()) paths.add(key.slice(key.indexOf('\u0000') + 1));
  for (const path of paths) for (const pane of panes) forgetLiveReadingPane(path, pane);
}

/** Drop every pane's live snapshots and any untaken seed for a closed file,
 * so a reopen resolves from history and defaults rather than from the closed
 * session. The file's last view is written first: a reopen reads the row
 * synchronously and must not race the debounce. */
export function forgetLiveReadingView(path: string): void {
  flushReadingViewRecord(path);
  pendingRecords.delete(path);
  for (const pane of READING_PANE_IDS) docIndexes.delete(paneKey(path, pane));
  rememberedPanes.delete(path);
  const hadLive = live.delete(path);
  seeds.delete(path);
  if (hadLive && path === activePath) notifyActive();
}

/** Test-only: return the store to its module-load state. */
export function __resetReadingViewStore(): void {
  live.clear();
  seeds.clear();
  seedListeners.clear();
  activeListeners.clear();
  activePath = null;
  activePane = 'a';
  for (const entry of pendingRecords.values()) if (entry.timer) clearTimeout(entry.timer);
  pendingRecords.clear();
  docIndexes.clear();
  rememberedPanes.clear();
  lastSavedAt = 0;
  pagehideTarget?.removeEventListener('pagehide', flushReadingViewHistory);
  pagehideTarget = null;
}
