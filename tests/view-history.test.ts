// The per-document reading-view history: field-wise validation, the LRU cap,
// forget and clear, and the cross-window merge that keeps other paths' rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VIEW_HISTORY_MAX,
  clearViewHistory,
  forgetViewRecords,
  parseViewHistory,
  parseViewRecord,
  readViewRecord,
  subscribeViewHistoryRemoval,
  viewHistoryGeneration,
  writeViewRecord,
  writeViewRecordNow,
  type ViewHistoryRecord,
} from '../src/renderer/lib/view-history';
import { VIEW_HISTORY_KEY } from '../src/renderer/lib/reading-view-store';

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

function rec(over: Partial<ViewHistoryRecord> = {}): ViewHistoryRecord {
  return {
    page: 4,
    docIndex: 0,
    zoomMode: 'custom',
    zoomPercent: 150,
    layoutMode: 'grid',
    coverAlone: true,
    scrollMode: 'paged',
    pageCount: 12,
    savedAt: 1000,
    ...over,
  };
}

function stored(): { v: number; entries: Record<string, unknown> } {
  return JSON.parse(localStorage.getItem(VIEW_HISTORY_KEY) ?? 'null');
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe('parseViewHistory', () => {
  it('reads an empty history from nothing, garbage and wrong shapes', () => {
    for (const raw of [null, '', '{not json', '42', '"x"', 'null', '[]', '{"v":1}', '{"v":1,"entries":[]}']) {
      expect(Object.keys(parseViewHistory(raw).entries)).toEqual([]);
    }
  });

  it('reads a valid row unchanged', () => {
    const file = parseViewHistory(JSON.stringify({ v: 1, entries: { 'C:\\a.pdf': rec() } }));
    expect(file.v).toBe(1);
    expect(file.entries['C:\\a.pdf']).toEqual(rec());
  });

  it('gives each corrupt field its default and keeps the rest of the row', () => {
    const file = parseViewHistory(
      JSON.stringify({
        v: 1,
        entries: {
          'a.pdf': {
            page: 'seven',
            docIndex: -3,
            zoomMode: 'zoomy',
            zoomPercent: 1e9,
            layoutMode: 'two',
            coverAlone: 'yes',
            scrollMode: 'snap',
            pageCount: null,
            savedAt: -5,
          },
        },
      }),
    );
    expect(file.entries['a.pdf']).toEqual({
      page: 1,
      docIndex: 0,
      zoomMode: 'fitPage',
      zoomPercent: 6400,
      layoutMode: 'single',
      coverAlone: false,
      scrollMode: 'continuous',
      pageCount: 0,
      savedAt: 0,
    });
  });

  it('drops a row that is not an object, and an empty path', () => {
    const file = parseViewHistory(
      JSON.stringify({ v: 1, entries: { 'a.pdf': 3, 'b.pdf': [rec()], '': rec(), 'c.pdf': rec() } }),
    );
    expect(Object.keys(file.entries)).toEqual(['c.pdf']);
  });

  it('floors fractional page numbers and clamps a tiny zoom', () => {
    expect(parseViewRecord(rec({ page: 3.7, zoomPercent: 0.2 }))).toMatchObject({ page: 3, zoomPercent: 1 });
  });

  it('never reads an inherited property as a row', () => {
    const file = parseViewHistory(JSON.stringify({ v: 1, entries: { 'a.pdf': rec() } }));
    expect(file.entries.toString).toBeUndefined();
    expect(file.entries.__proto__).toBeUndefined();
    const own = parseViewHistory('{"v":1,"entries":{"__proto__":{"page":2}}}');
    expect(Object.keys(own.entries)).toEqual(['__proto__']);
    expect(own.entries.__proto__.page).toBe(2);
  });

  it('caps a hostile history at the newest rows', () => {
    const entries = Object.fromEntries(
      Array.from({ length: VIEW_HISTORY_MAX + 50 }, (_, i) => [`f${i}.pdf`, rec({ savedAt: i })]),
    );
    const file = parseViewHistory(JSON.stringify({ v: 1, entries }));
    expect(Object.keys(file.entries)).toHaveLength(VIEW_HISTORY_MAX);
    expect(file.entries['f0.pdf']).toBeUndefined();
    expect(file.entries[`f${VIEW_HISTORY_MAX + 49}.pdf`]).toBeDefined();
  });
});

describe('read and write', () => {
  it('round-trips a row, keyed by path', async () => {
    await writeViewRecord('a.pdf', rec());
    expect(readViewRecord('a.pdf')).toEqual(rec());
    expect(readViewRecord('b.pdf')).toBeNull();
    expect(stored().v).toBe(1);
  });

  it('stores a page number, never anything else that names the page', () => {
    writeViewRecordNow('a.pdf', { ...rec(), pageId: 'a.pdf#g1#p3' } as unknown as ViewHistoryRecord);
    expect(Object.keys(stored().entries['a.pdf'] as object).sort()).toEqual(
      ['coverAlone', 'docIndex', 'layoutMode', 'page', 'pageCount', 'savedAt', 'scrollMode', 'zoomMode', 'zoomPercent'],
    );
  });

  it('replaces a path’s own row', () => {
    writeViewRecordNow('a.pdf', rec({ page: 2 }));
    writeViewRecordNow('a.pdf', rec({ page: 9 }));
    expect(readViewRecord('a.pdf')?.page).toBe(9);
    expect(Object.keys(stored().entries)).toEqual(['a.pdf']);
  });

  it('evicts the least recently saved row past the cap', () => {
    for (let i = 0; i < VIEW_HISTORY_MAX; i += 1) writeViewRecordNow(`f${i}.pdf`, rec({ savedAt: 100 + i }));
    writeViewRecordNow('new.pdf', rec({ savedAt: 10_000 }));
    expect(Object.keys(stored().entries)).toHaveLength(VIEW_HISTORY_MAX);
    expect(readViewRecord('f0.pdf')).toBeNull();
    expect(readViewRecord('f1.pdf')).not.toBeNull();
    expect(readViewRecord('new.pdf')).not.toBeNull();
  });

  it('keeps the row just written even when its clock runs behind', () => {
    for (let i = 0; i < VIEW_HISTORY_MAX; i += 1) writeViewRecordNow(`f${i}.pdf`, rec({ savedAt: 100 + i }));
    writeViewRecordNow('late.pdf', rec({ savedAt: 1 }));
    expect(readViewRecord('late.pdf')).not.toBeNull();
    expect(Object.keys(stored().entries)).toHaveLength(VIEW_HISTORY_MAX);
  });

  it('skips a locked write that is no longer current', async () => {
    writeViewRecordNow('a.pdf', rec({ page: 7 }));
    await writeViewRecord('a.pdf', rec({ page: 2 }), { stillCurrent: () => false });
    expect(readViewRecord('a.pdf')?.page).toBe(7);
  });

  it('serializes writes through the shared browser lock', async () => {
    const requests: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(name: string, callback: () => T | Promise<T>): Promise<T> => {
          requests.push(name);
          return callback();
        },
      },
    });
    await writeViewRecord('a.pdf', rec());
    expect(requests).toEqual(['spectra-view-history-storage']);
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => writeViewRecordNow('a.pdf', rec())).not.toThrow();
    expect(readViewRecord('a.pdf')).toBeNull();
    expect(() => forgetViewRecords(['a.pdf'])).not.toThrow();
    expect(() => clearViewHistory()).not.toThrow();
  });
});

describe('cross-window merge', () => {
  async function newWindow(): Promise<typeof import('../src/renderer/lib/view-history')> {
    vi.resetModules();
    return import('../src/renderer/lib/view-history');
  }

  it('keeps the rows another window wrote since this one last read', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.writeViewRecordNow('a.pdf', rec({ page: 1 }));
    expect(B.readViewRecord('a.pdf')?.page).toBe(1);
    await B.writeViewRecord('b.pdf', rec({ page: 2 }));
    await A.writeViewRecord('a.pdf', rec({ page: 3 }));
    expect(A.readViewRecord('a.pdf')?.page).toBe(3);
    expect(A.readViewRecord('b.pdf')?.page).toBe(2);
    expect(Object.keys(stored().entries).sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('stays one key for every window', async () => {
    const A = await newWindow();
    A.writeViewRecordNow('a.pdf', rec());
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe('spectra-view-history');
  });
});

describe('forget and clear', () => {
  it('forgets the named paths only', async () => {
    writeViewRecordNow('a.pdf', rec());
    writeViewRecordNow('b.pdf', rec());
    writeViewRecordNow('c.pdf', rec());
    forgetViewRecords(['a.pdf', 'c.pdf', 'never.pdf']);
    expect(Object.keys(stored().entries)).toEqual(['b.pdf']);
    await Promise.resolve();
    expect(Object.keys(stored().entries)).toEqual(['b.pdf']);
  });

  it('keeps the removal generation, and no row, when the last row goes', () => {
    writeViewRecordNow('a.pdf', rec());
    forgetViewRecords(['a.pdf']);
    expect(Object.keys(stored().entries)).toEqual([]);
    expect(viewHistoryGeneration()).toBe(1);
  });

  it('forgets again under the lock, after a write that was already queued', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const queue: Array<() => unknown> = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(_name: string, callback: () => T | Promise<T>): Promise<T> => {
          const prior = queue.length > 0 ? gate : Promise.resolve();
          queue.push(callback);
          await prior;
          return callback();
        },
      },
    });
    writeViewRecordNow('a.pdf', rec({ page: 1 }));
    // A read-modify-write that read the row before the removal and writes it
    // back afterwards: the locked second pass removes it again.
    const stale = writeViewRecord('a.pdf', rec({ page: 1 }));
    forgetViewRecords(['a.pdf']);
    expect(readViewRecord('a.pdf')).toBeNull();
    await stale;
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(readViewRecord('a.pdf')).toBeNull();
  });

  it('clears every row', () => {
    writeViewRecordNow('a.pdf', rec());
    writeViewRecordNow('b.pdf', rec());
    clearViewHistory();
    expect(Object.keys(stored().entries)).toEqual([]);
    expect(readViewRecord('a.pdf')).toBeNull();
  });
});

describe('removal generations', () => {
  async function newWindow(): Promise<typeof import('../src/renderer/lib/view-history')> {
    vi.resetModules();
    return import('../src/renderer/lib/view-history');
  }
  const settle = async (): Promise<void> => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('spectra-view-history-storage', () => undefined);
    }
    await new Promise((r) => setTimeout(r, 0));
  };

  it('drops a write taken before a forget of its path, in both write forms', async () => {
    const taken = viewHistoryGeneration();
    forgetViewRecords(['a.pdf']);
    writeViewRecordNow('a.pdf', rec(), { gen: taken });
    await writeViewRecord('a.pdf', rec(), { gen: taken });
    expect(readViewRecord('a.pdf')).toBeNull();
    writeViewRecordNow('a.pdf', rec({ page: 2 }));
    expect(readViewRecord('a.pdf')?.page).toBe(2);
  });

  it('keeps a write of another path taken before the forget', () => {
    const taken = viewHistoryGeneration();
    forgetViewRecords(['a.pdf']);
    writeViewRecordNow('b.pdf', rec({ page: 5 }), { gen: taken });
    expect(readViewRecord('b.pdf')?.page).toBe(5);
  });

  it('drops every write taken before a clear', async () => {
    const taken = viewHistoryGeneration();
    clearViewHistory();
    writeViewRecordNow('a.pdf', rec(), { gen: taken });
    await writeViewRecord('b.pdf', rec(), { gen: taken });
    expect(readViewRecord('a.pdf')).toBeNull();
    expect(readViewRecord('b.pdf')).toBeNull();
  });

  it('keeps a row written after the clear through the clear’s locked pass', async () => {
    writeViewRecordNow('a.pdf', rec({ page: 1 }));
    clearViewHistory();
    writeViewRecordNow('a.pdf', rec({ page: 8 }));
    await settle();
    expect(readViewRecord('a.pdf')?.page).toBe(8);
  });

  it('drops a write another window queued before the clear', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.writeViewRecordNow('a.pdf', rec({ page: 1 }));
    const queued = B.writeViewRecord('a.pdf', rec({ page: 4 }));
    A.clearViewHistory();
    await queued;
    await settle();
    expect(A.readViewRecord('a.pdf')).toBeNull();
    expect(B.readViewRecord('a.pdf')).toBeNull();
    await B.writeViewRecord('a.pdf', rec({ page: 5 }));
    expect(A.readViewRecord('a.pdf')?.page).toBe(5);
  });

  it('restores the counters a stale read-modify-write put back', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(_name: string, callback: () => T | Promise<T>): Promise<T> => {
          await held;
          return callback();
        },
      },
    });
    writeViewRecordNow('a.pdf', rec({ page: 1 }));
    const beforeClear = localStorage.getItem(VIEW_HISTORY_KEY);
    clearViewHistory();
    // Another window holding the lock read the map before the clear and
    // writes it back after.
    localStorage.setItem(VIEW_HISTORY_KEY, beforeClear ?? '');
    release();
    await settle();
    expect(readViewRecord('a.pdf')).toBeNull();
    expect(viewHistoryGeneration()).toBe(1);
    writeViewRecordNow('a.pdf', rec(), { gen: 0 });
    expect(readViewRecord('a.pdf')).toBeNull();
  });

  it('reads a history stored without counters as generation 0', () => {
    localStorage.setItem(VIEW_HISTORY_KEY, JSON.stringify({ v: 1, entries: { 'a.pdf': rec() } }));
    expect(viewHistoryGeneration()).toBe(0);
    expect(readViewRecord('a.pdf')).toEqual(rec());
  });

  it('tells removal listeners which paths go, before they go', () => {
    writeViewRecordNow('a.pdf', rec());
    const seen: Array<{ paths: readonly string[] | null; rowStill: boolean }> = [];
    const off = subscribeViewHistoryRemoval((paths) => seen.push({ paths, rowStill: readViewRecord('a.pdf') !== null }));
    forgetViewRecords(['a.pdf']);
    clearViewHistory();
    off();
    clearViewHistory();
    expect(seen).toEqual([
      { paths: ['a.pdf'], rowStill: true },
      { paths: null, rowStill: false },
    ]);
  });
});
