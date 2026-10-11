import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  VIEW_HISTORY_DEBOUNCE_MS,
  VIEW_HISTORY_KEY,
  __resetReadingViewStore,
  activeReadingView,
  flushReadingViewHistory,
  flushReadingViewRecord,
  forgetLiveReadingPane,
  forgetLiveReadingPanes,
  forgetLiveReadingView,
  initialReadingViewFor,
  liveReadingView,
  savedDocIndexFor,
  publishReadingView,
  seedReadingView,
  setActiveReadingPane,
  subscribeActiveReadingView,
  subscribeReadingViewSeed,
  takeReadingViewSeed,
  useActiveReadingView,
} from '../src/renderer/lib/reading-view-store';
import {
  DEFAULT_READING_VIEW,
  LAYOUT_MODES,
  SCROLL_MODES,
  ZOOM_MODES,
  type ReadingViewSnapshot,
} from '../src/renderer/lib/reading-view-types';
import { DEFAULTS, saveSettings } from '../src/renderer/lib/app-settings';
import {
  clearViewHistory,
  forgetViewRecords,
  readViewRecord,
  writeViewRecordNow,
  type ViewHistoryRecord,
} from '../src/renderer/lib/view-history';

const A = 'C:\\docs\\a.pdf';
const B = 'C:\\docs\\b.pdf';

function snap(over: Partial<ReadingViewSnapshot> = {}): ReadingViewSnapshot {
  return {
    zoomMode: 'custom',
    zoomPercent: 150,
    layoutMode: 'grid',
    coverAlone: true,
    scrollMode: 'paged',
    page: 7,
    columns: 3,
    pageCount: 20,
    docIndex: 0,
    ...over,
  };
}

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function savedRow(over: Partial<ViewHistoryRecord> = {}): ViewHistoryRecord {
  return {
    page: 6,
    docIndex: 0,
    zoomMode: 'fitWidth',
    zoomPercent: 90,
    layoutMode: 'single',
    coverAlone: false,
    scrollMode: 'paged',
    pageCount: 20,
    savedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
  __resetReadingViewStore();
});
afterEach(() => {
  __resetReadingViewStore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reading-view types', () => {
  it('defaults to a single fitted column', () => {
    expect(DEFAULT_READING_VIEW).toEqual({
      zoomMode: 'fitPage',
      zoomPercent: 100,
      layoutMode: 'single',
      coverAlone: false,
      scrollMode: 'continuous',
      page: 1,
    });
    expect(ZOOM_MODES).toContain(DEFAULT_READING_VIEW.zoomMode);
    expect(LAYOUT_MODES).toContain(DEFAULT_READING_VIEW.layoutMode);
    expect(SCROLL_MODES).toContain(DEFAULT_READING_VIEW.scrollMode);
  });

  it('names the shared history key', () => {
    expect(VIEW_HISTORY_KEY).toBe('spectra-view-history');
  });
});

describe('publish and subscribe', () => {
  it('stores a copy per (path, pane)', () => {
    const s = snap();
    publishReadingView(A, 'a', s);
    s.page = 99;
    expect(liveReadingView(A, 'a', 0)?.page).toBe(7);
    expect(liveReadingView(A, 'b', 0)).toBeNull();
    expect(liveReadingView(B, 'a', 0)).toBeNull();
  });

  it('notifies only for the active entry', () => {
    const cb = vi.fn();
    subscribeActiveReadingView(cb);
    setActiveReadingPane(A, 'a');
    expect(cb).toHaveBeenCalledTimes(1);
    publishReadingView(A, 'b', snap());
    publishReadingView(B, 'a', snap());
    expect(cb).toHaveBeenCalledTimes(1);
    publishReadingView(A, 'a', snap());
    expect(cb).toHaveBeenCalledTimes(2);
    expect(activeReadingView()?.columns).toBe(3);
  });

  it('keeps the stored reference when an identical snapshot is published', () => {
    const cb = vi.fn();
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap());
    const first = activeReadingView();
    subscribeActiveReadingView(cb);
    publishReadingView(A, 'a', snap());
    expect(cb).not.toHaveBeenCalled();
    expect(activeReadingView()).toBe(first);
    publishReadingView(A, 'a', snap({ page: 8 }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(activeReadingView()).not.toBe(first);
  });

  it('switches the active entry and stops notifying after unsubscribe', () => {
    publishReadingView(A, 'a', snap({ page: 1 }));
    publishReadingView(A, 'b', snap({ page: 2 }));
    setActiveReadingPane(A, 'b');
    expect(activeReadingView()?.page).toBe(2);
    const cb = vi.fn();
    const off = subscribeActiveReadingView(cb);
    setActiveReadingPane(A, 'b');
    expect(cb).not.toHaveBeenCalled();
    setActiveReadingPane(A, 'a');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(activeReadingView()?.page).toBe(1);
    off();
    setActiveReadingPane(null, 'a');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(activeReadingView()).toBeNull();
  });

  it('serves the active entry through the hook', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ zoomPercent: 125 }));
    const Probe = (): string => String(useActiveReadingView()?.zoomPercent ?? 'none');
    expect(renderToString(createElement(Probe))).toBe('125');
    setActiveReadingPane(B, 'a');
    expect(renderToString(createElement(Probe))).toBe('none');
  });
});

describe('initialReadingViewFor', () => {
  it('falls back to the defaults', () => {
    const r = initialReadingViewFor(A, 'a', 0, 20);
    expect(r.source).toBe('defaults');
    expect(r.state).toEqual(DEFAULT_READING_VIEW);
    r.state.page = 5;
    expect(DEFAULT_READING_VIEW.page).toBe(1);
  });

  it("prefers the pane's own live snapshot", () => {
    publishReadingView(A, 'b', snap({ page: 4 }));
    publishReadingView(A, 'a', snap({ page: 9 }));
    const r = initialReadingViewFor(A, 'b', 0, 20);
    expect(r.source).toBe('live');
    expect(r.state.page).toBe(4);
    expect(r.state).not.toHaveProperty('columns');
    expect(r.state).not.toHaveProperty('pageCount');
  });

  it('clones pane a for a new split pane', () => {
    publishReadingView(A, 'a', snap());
    const r = initialReadingViewFor(A, 'c', 0, 20);
    expect(r.source).toBe('sibling');
    expect(r.state).toEqual({
      zoomMode: 'custom',
      zoomPercent: 150,
      layoutMode: 'grid',
      coverAlone: true,
      scrollMode: 'paged',
      page: 7,
    });
    r.state.page = 1;
    expect(liveReadingView(A, 'a', 0)?.page).toBe(7);
  });

  it('never clones a sibling into pane a', () => {
    publishReadingView(A, 'b', snap());
    expect(initialReadingViewFor(A, 'a', 0, 20).source).toBe('defaults');
  });

  it('clamps the page to the current page count', () => {
    publishReadingView(A, 'a', snap({ page: 30 }));
    expect(initialReadingViewFor(A, 'a', 0, 12).state.page).toBe(12);
    expect(initialReadingViewFor(A, 'a', 0, 0).state.page).toBe(1);
  });
});

describe('seeds', () => {
  it('is taken once', () => {
    seedReadingView(A, { state: { layoutMode: 'grid' }, columnsHint: 2 });
    expect(takeReadingViewSeed(B)).toBeNull();
    expect(takeReadingViewSeed(A)).toEqual({ state: { layoutMode: 'grid' }, columnsHint: 2 });
    expect(takeReadingViewSeed(A)).toBeNull();
  });

  it('notifies the path subscribers only', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = subscribeReadingViewSeed(A, onA);
    subscribeReadingViewSeed(B, onB);
    seedReadingView(A, { state: {}, columnsHint: null });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
    offA();
    seedReadingView(A, { state: { scrollMode: 'paged' }, columnsHint: null });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(takeReadingViewSeed(A)?.state).toEqual({ scrollMode: 'paged' });
  });
});

describe('forgetLiveReadingView', () => {
  it('drops every pane and the untaken seed of one path', () => {
    publishReadingView(A, 'a', snap());
    publishReadingView(A, 'b', snap());
    publishReadingView(B, 'a', snap());
    seedReadingView(A, { state: {}, columnsHint: null });
    forgetLiveReadingView(A);
    expect(liveReadingView(A, 'a', 0)).toBeNull();
    expect(liveReadingView(A, 'b', 0)).toBeNull();
    expect(takeReadingViewSeed(A)).toBeNull();
    expect(liveReadingView(B, 'a', 0)).not.toBeNull();
    expect(initialReadingViewFor(A, 'b', 0, 20).source).toBe('defaults');
  });

  it('notifies when the active document is forgotten', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap());
    const cb = vi.fn();
    subscribeActiveReadingView(cb);
    forgetLiveReadingView(B);
    expect(cb).not.toHaveBeenCalled();
    forgetLiveReadingView(A);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(activeReadingView()).toBeNull();
  });
});

describe('initialReadingViewFor: saved and Preferences layers', () => {
  it('restores the saved row when no pane is live', () => {
    writeViewRecordNow(A, savedRow());
    const r = initialReadingViewFor(A, 'a', 0, 20);
    expect(r.source).toBe('saved');
    expect(r.state).toEqual({
      zoomMode: 'fitWidth',
      zoomPercent: 90,
      layoutMode: 'single',
      coverAlone: false,
      scrollMode: 'paged',
      page: 6,
    });
  });

  it('puts a live pane and a sibling above the saved row', () => {
    writeViewRecordNow(A, savedRow());
    publishReadingView(A, 'a', snap({ page: 2 }));
    expect(initialReadingViewFor(A, 'a', 0, 20).source).toBe('live');
    expect(initialReadingViewFor(A, 'b', 0, 20).source).toBe('sibling');
  });

  it('clamps a saved page to the current count', () => {
    writeViewRecordNow(A, savedRow({ page: 50 }));
    expect(initialReadingViewFor(A, 'a', 0, 8).state.page).toBe(8);
  });

  it('falls back to the Viewing preferences', () => {
    saveSettings({ ...DEFAULTS, viewZoomMode: 'custom', viewZoomPercent: 175, viewLayoutMode: 'grid', viewScrollMode: 'paged' });
    const r = initialReadingViewFor(B, 'a', 0, 20);
    expect(r.source).toBe('defaults');
    expect(r.state).toEqual({
      zoomMode: 'custom',
      zoomPercent: 175,
      layoutMode: 'grid',
      coverAlone: false,
      scrollMode: 'paged',
      page: 1,
    });
  });

  it('forgetting a document returns it to its saved row', () => {
    writeViewRecordNow(A, savedRow());
    publishReadingView(A, 'a', snap());
    forgetLiveReadingView(A);
    expect(initialReadingViewFor(A, 'a', 0, 20).source).toBe('saved');
  });
});

describe('view history writes', () => {
  it('writes the active pane after the quiet time, debounced', async () => {
    vi.useFakeTimers();
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 3 }));
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS - 1);
    publishReadingView(A, 'a', snap({ page: 4 }));
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS - 1);
    await Promise.resolve();
    expect(readViewRecord(A)).toBeNull();
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    const row = readViewRecord(A);
    expect(row?.page).toBe(4);
    expect(row).toMatchObject({
      zoomMode: 'custom',
      zoomPercent: 150,
      layoutMode: 'grid',
      coverAlone: true,
      scrollMode: 'paged',
      pageCount: 20,
    });
    expect(row).not.toHaveProperty('columns');
  });

  it('never writes an inactive pane or document', () => {
    vi.useFakeTimers();
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'b', snap());
    publishReadingView(B, 'a', snap());
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS * 2);
    flushReadingViewHistory();
    expect(readViewRecord(A)).toBeNull();
    expect(readViewRecord(B)).toBeNull();
  });

  it('records the document index the snapshot shows', () => {
    initialReadingViewFor(A, 'b', 2, 20);
    setActiveReadingPane(A, 'b');
    publishReadingView(A, 'b', snap({ docIndex: 2 }));
    flushReadingViewHistory();
    expect(readViewRecord(A)?.docIndex).toBe(2);
  });

  it('flushes synchronously, once', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 5 }));
    flushReadingViewRecord(B);
    expect(readViewRecord(A)).toBeNull();
    flushReadingViewRecord(A);
    expect(readViewRecord(A)?.page).toBe(5);
    writeViewRecordNow(A, savedRow({ page: 1 }));
    flushReadingViewHistory();
    expect(readViewRecord(A)?.page).toBe(1);
  });

  it('flushes on pagehide', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 9 }));
    expect(readViewRecord(A)).toBeNull();
    target.dispatchEvent(new Event('pagehide'));
    expect(readViewRecord(A)?.page).toBe(9);
  });

  it('writes the last view when the document is forgotten', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 11 }));
    forgetLiveReadingView(A);
    expect(readViewRecord(A)?.page).toBe(11);
  });

  it('a queued debounced write never lands over a newer flushed one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(_name: string, callback: () => T | Promise<T>): Promise<T> => {
          await gate;
          return callback();
        },
      },
    });
    vi.useFakeTimers();
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 2 }));
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS);
    publishReadingView(A, 'a', snap({ page: 3 }));
    flushReadingViewRecord(A);
    expect(readViewRecord(A)?.page).toBe(3);
    vi.useRealTimers();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(readViewRecord(A)?.page).toBe(3);
  });

  it('never stores a page id', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap());
    flushReadingViewHistory();
    expect(Object.keys(readViewRecord(A) ?? {}).sort()).toEqual([
      'coverAlone',
      'docIndex',
      'layoutMode',
      'page',
      'pageCount',
      'savedAt',
      'scrollMode',
      'zoomMode',
      'zoomPercent',
    ]);
    expect(localStorage.getItem(VIEW_HISTORY_KEY)).not.toContain('#p');
  });
});

describe('forgetLiveReadingPane', () => {
  it('drops only that pane, leaving pane a and other documents intact', () => {
    publishReadingView(A, 'a', snap({ page: 1 }));
    publishReadingView(A, 'b', snap({ page: 2 }));
    publishReadingView(B, 'b', snap({ page: 3 }));
    forgetLiveReadingPane(A, 'b');
    expect(liveReadingView(A, 'b', 0)).toBeNull();
    expect(liveReadingView(A, 'a', 0)?.page).toBe(1);
    expect(liveReadingView(B, 'b', 0)?.page).toBe(3);
  });

  it('makes a reopened split pane clone pane a again', () => {
    publishReadingView(A, 'a', snap({ page: 1 }));
    publishReadingView(A, 'b', snap({ page: 9 }));
    expect(initialReadingViewFor(A, 'b', 0, 20).source).toBe('live');
    forgetLiveReadingPane(A, 'b');
    const r = initialReadingViewFor(A, 'b', 0, 20);
    expect(r.source).toBe('sibling');
    expect(r.state.page).toBe(1);
  });

  it('notifies when the forgotten pane is the active one, and only then', () => {
    publishReadingView(A, 'a', snap());
    publishReadingView(A, 'b', snap());
    setActiveReadingPane(A, 'b');
    const cb = vi.fn();
    subscribeActiveReadingView(cb);
    forgetLiveReadingPane(A, 'c');
    forgetLiveReadingPane(B, 'b');
    expect(cb).not.toHaveBeenCalled();
    forgetLiveReadingPane(A, 'b');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(activeReadingView()).toBeNull();
  });

  it('discards a pending record from that pane without writing it', () => {
    vi.useFakeTimers();
    setActiveReadingPane(A, 'b');
    publishReadingView(A, 'b', snap({ page: 4 }));
    forgetLiveReadingPane(A, 'b');
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS * 2);
    flushReadingViewHistory();
    forgetLiveReadingView(A);
    expect(readViewRecord(A)).toBeNull();
  });

  it('discards a record already queued behind the lock', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(_name: string, callback: () => T | Promise<T>): Promise<T> => {
          await gate;
          return callback();
        },
      },
    });
    vi.useFakeTimers();
    setActiveReadingPane(A, 'b');
    publishReadingView(A, 'b', snap({ page: 4 }));
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS);
    forgetLiveReadingPane(A, 'b');
    vi.useRealTimers();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(readViewRecord(A)).toBeNull();
  });

  it('keeps a pending record taken from another pane', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 6 }));
    publishReadingView(A, 'b', snap({ page: 8 }));
    forgetLiveReadingPane(A, 'b');
    flushReadingViewRecord(A);
    expect(readViewRecord(A)?.page).toBe(6);
  });
});

describe('forgetLiveReadingPanes', () => {
  it('drops the named panes of every document and leaves pane a untouched', () => {
    publishReadingView(A, 'a', snap({ page: 1 }));
    publishReadingView(A, 'b', snap({ page: 2 }));
    publishReadingView(B, 'a', snap({ page: 3 }));
    publishReadingView(B, 'b', snap({ page: 4 }));
    publishReadingView(B, 'c', snap({ page: 5 }));
    forgetLiveReadingPanes(['b', 'c', 'd']);
    expect(liveReadingView(A, 'b', 0)).toBeNull();
    expect(liveReadingView(B, 'b', 0)).toBeNull();
    expect(liveReadingView(B, 'c', 0)).toBeNull();
    expect(liveReadingView(A, 'a', 0)?.page).toBe(1);
    expect(liveReadingView(B, 'a', 0)?.page).toBe(3);
    expect(initialReadingViewFor(B, 'b', 0, 20)).toMatchObject({ source: 'sibling', state: { page: 3 } });
  });

  it('discards a pending pane-b record on both documents unwritten', () => {
    vi.useFakeTimers();
    setActiveReadingPane(A, 'b');
    publishReadingView(A, 'b', snap({ page: 4 }));
    setActiveReadingPane(B, 'b');
    publishReadingView(B, 'b', snap({ page: 5 }));
    forgetLiveReadingPanes(['b']);
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS * 2);
    flushReadingViewHistory();
    expect(readViewRecord(A)).toBeNull();
    expect(readViewRecord(B)).toBeNull();
  });

  it('keeps a pending record taken from pane a', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 6 }));
    publishReadingView(A, 'b', snap({ page: 8 }));
    forgetLiveReadingPanes(['b']);
    flushReadingViewRecord(A);
    expect(readViewRecord(A)?.page).toBe(6);
  });

  it('notifies once when the active pane is among those dropped', () => {
    publishReadingView(A, 'b', snap());
    setActiveReadingPane(A, 'b');
    const cb = vi.fn();
    subscribeActiveReadingView(cb);
    forgetLiveReadingPanes(['c', 'd']);
    expect(cb).not.toHaveBeenCalled();
    forgetLiveReadingPanes(['b']);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('the history follows the selected pane', () => {
  it('selecting a pane back writes its view without another change to it', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 2 }));
    setActiveReadingPane(A, 'b');
    publishReadingView(A, 'b', snap({ page: 9 }));
    flushReadingViewHistory();
    expect(readViewRecord(A)?.page).toBe(9);
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 2 }));
    forgetLiveReadingView(A);
    expect(readViewRecord(A)?.page).toBe(2);
  });

  it('writes the selected pane after the debounce', async () => {
    vi.useFakeTimers();
    setActiveReadingPane(A, 'b');
    publishReadingView(A, 'a', snap({ page: 2 }));
    publishReadingView(A, 'b', snap({ page: 9 }));
    setActiveReadingPane(A, 'a');
    expect(readViewRecord(A)).toBeNull();
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    await navigator.locks?.request('spectra-view-history-storage', () => undefined);
    expect(readViewRecord(A)?.page).toBe(2);
  });

  it('writes nothing when the selected pane has no live view', () => {
    setActiveReadingPane(A, 'b');
    flushReadingViewHistory();
    expect(readViewRecord(A)).toBeNull();
  });
});

describe('a final publish', () => {
  it('persists at once when its path is no longer the active one', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 2 }));
    flushReadingViewHistory();
    // A tab switch selects B in a layout effect before A's view unmounts.
    setActiveReadingPane(B, 'a');
    publishReadingView(A, 'a', snap({ page: 9 }), { final: true });
    expect(readViewRecord(A)?.page).toBe(9);
    forgetLiveReadingView(A);
    expect(readViewRecord(A)?.page).toBe(9);
  });

  it('persists an unchanged snapshot', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 2 }));
    flushReadingViewHistory();
    writeViewRecordNow(A, savedRow({ page: 11 }));
    publishReadingView(A, 'a', snap({ page: 2 }), { final: true });
    expect(readViewRecord(A)?.page).toBe(2);
  });

  it('persists for a path never made active', () => {
    publishReadingView(A, 'a', snap({ page: 4 }), { final: true });
    expect(readViewRecord(A)?.page).toBe(4);
  });

  it('leaves the row of the pane the history remembers', () => {
    setActiveReadingPane(A, 'b');
    publishReadingView(A, 'b', snap({ page: 9 }));
    flushReadingViewHistory();
    setActiveReadingPane(B, 'a');
    publishReadingView(A, 'a', snap({ page: 2 }), { final: true });
    expect(readViewRecord(A)?.page).toBe(9);
    expect(liveReadingView(A, 'a', 0)?.page).toBe(2);
  });

  it('wins over a debounced write still queued behind the lock', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(_name: string, callback: () => T | Promise<T>): Promise<T> => {
          await gate;
          return callback();
        },
      },
    });
    vi.useFakeTimers();
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 3 }));
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS);
    publishReadingView(A, 'a', snap({ page: 4 }), { final: true });
    expect(readViewRecord(A)?.page).toBe(4);
    vi.useRealTimers();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(readViewRecord(A)?.page).toBe(4);
  });
});

describe('removing saved views cancels pending writes', () => {
  const settle = async (): Promise<void> => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('spectra-view-history-storage', () => undefined);
    }
    await new Promise((r) => setTimeout(r, 0));
  };

  it('a clear leaves nothing for a later flush to write back', async () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 4 }));
    clearViewHistory();
    await settle();
    expect(readViewRecord(A)).toBeNull();
    flushReadingViewHistory();
    forgetLiveReadingView(A);
    expect(readViewRecord(A)).toBeNull();
  });

  it('a clear leaves nothing for the debounce to write back', async () => {
    vi.useFakeTimers();
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 4 }));
    clearViewHistory();
    vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS);
    vi.useRealTimers();
    await settle();
    expect(readViewRecord(A)).toBeNull();
  });

  it('a forget cancels that path only', () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 4 }));
    setActiveReadingPane(B, 'a');
    publishReadingView(B, 'a', snap({ page: 5 }));
    forgetViewRecords([A]);
    flushReadingViewHistory();
    expect(readViewRecord(A)).toBeNull();
    expect(readViewRecord(B)?.page).toBe(5);
  });

  it('a change after the clear is written again', async () => {
    setActiveReadingPane(A, 'a');
    publishReadingView(A, 'a', snap({ page: 4 }));
    clearViewHistory();
    await settle();
    publishReadingView(A, 'a', snap({ page: 7 }));
    flushReadingViewHistory();
    expect(readViewRecord(A)?.page).toBe(7);
  });

  it('a write another window has pending before the clear never lands', async () => {
    vi.resetModules();
    const other = await import('../src/renderer/lib/reading-view-store');
    try {
      other.setActiveReadingPane(A, 'a');
      other.publishReadingView(A, 'a', snap({ page: 4 }));
      other.setActiveReadingPane(B, 'a');
      vi.useFakeTimers();
      other.publishReadingView(B, 'a', snap({ page: 6 }));
      clearViewHistory();
      vi.advanceTimersByTime(VIEW_HISTORY_DEBOUNCE_MS);
      vi.useRealTimers();
      await settle();
      expect(readViewRecord(B)).toBeNull();
      other.flushReadingViewHistory();
      expect(readViewRecord(A)).toBeNull();
      expect(readViewRecord(B)).toBeNull();
    } finally {
      other.__resetReadingViewStore();
    }
  });
});

describe('PDFX partitions', () => {
  const X = 'C:\\docs\\parts.pdfx';

  it('a partition never opens with the live view of another', () => {
    initialReadingViewFor(X, 'a', 0, 20);
    setActiveReadingPane(X, 'a');
    publishReadingView(X, 'a', snap({ page: 8, docIndex: 0 }));
    const other = initialReadingViewFor(X, 'a', 1, 20);
    expect(other.source).toBe('defaults');
    expect(other.state.page).toBe(1);
    expect(initialReadingViewFor(X, 'a', 0, 20)).toMatchObject({ source: 'live', state: { page: 8 } });
  });

  it('a new split pane clones the view pane a has of the same partition only', () => {
    publishReadingView(X, 'a', snap({ page: 5, docIndex: 1 }));
    expect(initialReadingViewFor(X, 'b', 0, 20).source).toBe('defaults');
    expect(initialReadingViewFor(X, 'b', 1, 20)).toMatchObject({ source: 'sibling', state: { page: 5 } });
  });

  it('the active view is the one of the partition the pane shows', () => {
    initialReadingViewFor(X, 'a', 0, 20);
    setActiveReadingPane(X, 'a');
    publishReadingView(X, 'a', snap({ page: 8, docIndex: 0 }));
    expect(activeReadingView()?.page).toBe(8);
    initialReadingViewFor(X, 'a', 1, 20);
    expect(activeReadingView()).toBeNull();
    publishReadingView(X, 'a', snap({ page: 3, docIndex: 1 }));
    expect(activeReadingView()).toMatchObject({ page: 3, docIndex: 1 });
  });

  it('forgetting a pane drops its views of every partition', () => {
    publishReadingView(X, 'a', snap({ docIndex: 0 }));
    publishReadingView(X, 'b', snap({ docIndex: 0 }));
    publishReadingView(X, 'b', snap({ docIndex: 1 }));
    forgetLiveReadingPane(X, 'b');
    expect(liveReadingView(X, 'b', 0)).toBeNull();
    expect(liveReadingView(X, 'b', 1)).toBeNull();
    expect(liveReadingView(X, 'a', 0)).not.toBeNull();
    forgetLiveReadingView(X);
    expect(liveReadingView(X, 'a', 0)).toBeNull();
  });

  it('a reopen restores the page of the recorded partition', () => {
    initialReadingViewFor(X, 'a', 2, 20);
    setActiveReadingPane(X, 'a');
    publishReadingView(X, 'a', snap({ page: 12, docIndex: 2 }));
    forgetLiveReadingView(X);
    expect(savedDocIndexFor(X)).toBe(2);
    expect(initialReadingViewFor(X, 'a', 2, 20)).toMatchObject({ source: 'saved', state: { page: 12 } });
    expect(initialReadingViewFor(X, 'a', 0, 20)).toMatchObject({ source: 'saved', state: { page: 1 } });
  });

  it('names the partition of an unwritten record before the stored row', () => {
    expect(savedDocIndexFor(X)).toBeNull();
    writeViewRecordNow(X, savedRow({ docIndex: 1 }));
    expect(savedDocIndexFor(X)).toBe(1);
    setActiveReadingPane(X, 'a');
    publishReadingView(X, 'a', snap({ docIndex: 3 }));
    expect(readViewRecord(X)?.docIndex).toBe(1);
    expect(savedDocIndexFor(X)).toBe(3);
  });
});
