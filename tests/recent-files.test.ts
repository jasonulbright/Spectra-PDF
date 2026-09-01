// Recent-files list helpers. parseRecent must never let a
// JSON-valid-but-wrong-shaped localStorage value through as a non-array —
// that would crash HomeTab's recentFiles.map on the first render.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatOpenedAt, parseRecent, withRecent } from '../src/renderer/lib/recent-files';

describe('parseRecent', () => {
  it('reads a valid string array', () => {
    // Legacy entries are bare strings; they migrate with an honest
    // "unknown" openedAt, never a fabricated date.
    expect(parseRecent('["a.pdf","b.pdf"]')).toEqual([
      { path: 'a.pdf', openedAt: null },
      { path: 'b.pdf', openedAt: null },
    ]);
  });

  it('treats null / empty as an empty list', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('')).toEqual([]);
    expect(parseRecent('[]')).toEqual([]);
  });

  it('rejects JSON-valid non-arrays (object, string, bool, number)', () => {
    expect(parseRecent('{}')).toEqual([]);
    expect(parseRecent('"true"')).toEqual([]);
    expect(parseRecent('true')).toEqual([]);
    expect(parseRecent('42')).toEqual([]);
    expect(parseRecent('null')).toEqual([]);
  });

  it('drops non-string members of an array', () => {
    expect(parseRecent('[1,"a.pdf",null,"b.pdf",{}]')).toEqual([
      { path: 'a.pdf', openedAt: null },
      { path: 'b.pdf', openedAt: null },
    ]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseRecent('{not json')).toEqual([]);
  });
});

describe('withRecent', () => {
  it('moves an existing path to the front (dedup) with a fresh timestamp', () => {
    expect(
      withRecent(
        [
          { path: 'a.pdf', openedAt: 1 },
          { path: 'b.pdf', openedAt: 2 },
          { path: 'c.pdf', openedAt: 3 },
        ],
        'c.pdf',
        99,
      ),
    ).toEqual([
      { path: 'c.pdf', openedAt: 99 },
      { path: 'a.pdf', openedAt: 1 },
      { path: 'b.pdf', openedAt: 2 },
    ]);
  });

  it('prepends a new path', () => {
    expect(withRecent([{ path: 'a.pdf', openedAt: 1 }], 'b.pdf', 2)).toEqual([
      { path: 'b.pdf', openedAt: 2 },
      { path: 'a.pdf', openedAt: 1 },
    ]);
  });

  it('preserves an existing sourceUrl on a re-open that supplies none', () => {
    // A web-downloaded temp copy handed to a second window, or re-opened from
    // recents, records the open again without re-supplying its address. The
    // provenance must survive: otherwise the recent row re-opens a purgeable
    // temp path with no way back to its source.
    const before = [{ path: 't.pdf', openedAt: 1, sourceUrl: 'https://example.com/t.pdf' }];
    expect(withRecent(before, 't.pdf', 5)).toEqual([
      { path: 't.pdf', openedAt: 5, sourceUrl: 'https://example.com/t.pdf' },
    ]);
  });

  it('an explicit sourceUrl overrides the prior one', () => {
    const before = [{ path: 't.pdf', openedAt: 1, sourceUrl: 'https://old.example/t.pdf' }];
    expect(withRecent(before, 't.pdf', 5, 'https://new.example/t.pdf')).toEqual([
      { path: 't.pdf', openedAt: 5, sourceUrl: 'https://new.example/t.pdf' },
    ]);
  });

  it('a plain re-open of a non-web entry gains no sourceUrl', () => {
    expect(withRecent([{ path: 'a.pdf', openedAt: 1 }], 'a.pdf', 5)).toEqual([
      { path: 'a.pdf', openedAt: 5 },
    ]);
  });

  it('caps the list at 10', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.pdf`, openedAt: i }));
    const next = withRecent(ten, 'new.pdf', 11);
    expect(next).toHaveLength(10);
    expect(next[0]).toEqual({ path: 'new.pdf', openedAt: 11 });
    expect(next.map((e) => e.path)).not.toContain('f9.pdf'); // oldest dropped
  });
});

describe('formatOpenedAt (the Home opened-when column)', () => {
  // Fixed "now": 2026-07-16 15:00 local.
  const now = new Date(2026, 6, 16, 15, 0).getTime();

  it('renders today and yesterday with times, older dates plainly', () => {
    expect(formatOpenedAt(new Date(2026, 6, 16, 14, 32).getTime(), now)).toBe('Today 14:32');
    expect(formatOpenedAt(new Date(2026, 6, 16, 9, 5).getTime(), now)).toBe('Today 09:05');
    expect(formatOpenedAt(new Date(2026, 6, 15, 23, 59).getTime(), now)).toBe('Yesterday 23:59');
    expect(formatOpenedAt(new Date(2026, 6, 12, 8, 0).getTime(), now)).toBe('Jul 12');
    expect(formatOpenedAt(new Date(2025, 11, 3, 8, 0).getTime(), now)).toBe('Dec 3, 2025');
  });

  it('a legacy entry with no recorded time reads as an em dash — never a fabricated date', () => {
    expect(formatOpenedAt(null, now)).toBe('—');
  });
});

// ── the shared key, two windows ────────────────────────────────────────────
//
// `spectra-recent` is shared by every window and each mirrors its whole list
// back. The fold used to treat only UNKNOWN paths as foreign, so window B's
// re-open of a path window A already knew — a newer timestamp, a new download
// address — was overwritten by A's stale write. Removal cannot ride on a fold
// that keeps the newest record of every path, so Clear Recent stamps a
// generation and every window folds against it.

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
  } as Storage;
}

/** A second window: a fresh module scope over the SAME storage. */
async function newWindow(): Promise<typeof import('../src/renderer/lib/recent-files')> {
  vi.resetModules();
  return import('../src/renderer/lib/recent-files');
}

describe('cross-window recent merge', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });

  it('keeps window B s newer re-open of a path window A already knew', async () => {
    const A = await newWindow();
    const B = await newWindow();
    // Both windows boot on the same list.
    A.persistRecent([{ path: 'x.pdf', openedAt: 1000 }]);
    const bList = B.readRecent();
    expect(bList).toEqual([{ path: 'x.pdf', openedAt: 1000 }]);
    // B re-opens x.pdf.
    B.persistRecent(B.withRecent(bList, 'x.pdf', 2000));
    // A mirrors its own (now stale) list back. B's newer record survives.
    const merged = A.persistRecent([{ path: 'x.pdf', openedAt: 1000 }]);
    expect(merged).toEqual([{ path: 'x.pdf', openedAt: 2000 }]);
  });

  it('keeps a provenance change made in the other window', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.persistRecent([{ path: 'tmp.pdf', openedAt: 1000 }]);
    B.readRecent();
    B.persistRecent(B.withRecent([], 'tmp.pdf', 2000, 'https://example.test/a.pdf'));
    const merged = A.persistRecent([{ path: 'tmp.pdf', openedAt: 1000 }]);
    expect(merged).toEqual([
      { path: 'tmp.pdf', openedAt: 2000, sourceUrl: 'https://example.test/a.pdf' },
    ]);
  });

  it('never loses an address to a merge that a newer record did not re-supply', async () => {
    const A = await newWindow();
    expect(
      A.mergeRecent(
        [{ path: 'tmp.pdf', openedAt: 2000 }],
        [{ path: 'tmp.pdf', openedAt: 1000, sourceUrl: 'https://example.test/a.pdf' }],
      ),
    ).toEqual([{ path: 'tmp.pdf', openedAt: 2000, sourceUrl: 'https://example.test/a.pdf' }]);
  });

  it('a clear in one window is not undone by the other window mirroring its list back', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.persistRecent([
      { path: 'x.pdf', openedAt: 1000 },
      { path: 'y.pdf', openedAt: 900 },
    ]);
    const bList = B.readRecent();
    expect(bList).toHaveLength(2);
    expect(A.persistRecent([])).toEqual([]);
    // B still holds the pre-clear list and mirrors it back.
    expect(B.persistRecent(bList)).toEqual([]);
    expect(B.readRecent()).toEqual([]);
  });

  it('keeps a file opened AFTER the clear, in either window', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.persistRecent([{ path: 'x.pdf', openedAt: 1000 }]);
    const bList = B.readRecent();
    A.persistRecent([]);
    const afterClear = Date.now() + 60_000;
    // B opens something new; its stale x.pdf still goes.
    const merged = B.persistRecent(B.withRecent(bList, 'z.pdf', afterClear));
    expect(merged.map((e) => e.path)).toEqual(['z.pdf']);
  });

  it('does not read an empty boot list as a clear', async () => {
    const A = await newWindow();
    A.persistRecent([{ path: 'x.pdf', openedAt: 1000 }]);
    const B = await newWindow();
    // B never read or wrote: an empty list from it is "nothing yet", not a
    // removal, and A's entry survives.
    expect(B.persistRecent([])).toEqual([{ path: 'x.pdf', openedAt: 1000 }]);
  });
});
