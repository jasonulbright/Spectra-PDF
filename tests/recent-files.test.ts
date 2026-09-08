// Recent-files list helpers. parseRecent must never let a
// JSON-valid-but-wrong-shaped localStorage value through as a non-array —
// that would crash HomeTab's recentFiles.map on the first render.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatOpenedAt,
  mergeRecent,
  nextRecentSeq,
  parseRecent,
  removeRecentEntries,
  sweepDeadRecents,
  withRecent,
} from '../src/renderer/lib/recent-files';
import type { RecentEntry, RecentPathStatus } from '../src/renderer/lib/recent-files';

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
    A.clearRecentStorage();
    expect(A.readRecent()).toEqual([]);
    // B still holds the pre-clear list and mirrors it back.
    expect(B.persistRecent(bList)).toEqual([]);
    expect(B.readRecent()).toEqual([]);
  });

  it('keeps a file opened AFTER the clear, in either window', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.persistRecent([{ path: 'x.pdf', openedAt: 1000 }]);
    const bList = B.readRecent();
    A.clearRecentStorage();
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

  it('removing the LAST locally-visible entry does not wipe entries only another window has written', async () => {
    const A = await newWindow();
    // A boots on exactly one stored entry. Hydrating through readRecent is
    // what a real boot does, and it is what used to arm the shape-based clear
    // heuristic — a bare persistRecent would not reproduce the trap.
    localStorage.setItem('spectra-recent', JSON.stringify([{ path: 'x.pdf', openedAt: 1100 }]));
    const aBoot = A.readRecent();
    expect(aBoot.map((e) => e.path)).toEqual(['x.pdf']);

    // A second window records two more opens. A never touched anything since,
    // so its own list is stale relative to storage.
    const B = await newWindow();
    B.persistRecent([
      { path: 'y.pdf', openedAt: 1000 },
      { path: 'z.pdf', openedAt: 900 },
    ]);

    // A removes its only locally known entry, emptying its list.
    const afterRemoval = A.removeRecentEntries(aBoot, ['x.pdf']);
    expect(afterRemoval).toEqual([]);

    // An ordinary targeted removal, NOT a clear: nothing tombstoned y.pdf or
    // z.pdf, and A was never in a position to know they exist.
    const merged = A.persistRecent(afterRemoval);
    expect(merged.map((e) => e.path).sort()).toEqual(['y.pdf', 'z.pdf']);
  });
});

// ── per-path removal ───────────────────────────────────────────────────────
//
// A plain filter cannot remove one entry: persistRecent folds the caller's list
// with storage and keeps the newest record of every path, so a filtered-out
// path is merged straight back in — from storage, or from a second window that
// still holds the pre-removal list. Removal therefore records a tombstone, and
// tombstones are ordered against opens by `seq`, not by wall clock: a removal
// and a re-open can land in the same millisecond.

const REMOVED_KEY = 'spectra-recent-removed';
/** Comfortably past any real clock value the code allocates, so an assertion
 * about `seq` ordering cannot be satisfied by `openedAt` instead. */
const FUTURE = 5_000_000_000_000;

describe('nextRecentSeq', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });

  it('is strictly increasing, including for calls inside one millisecond', () => {
    // Wall clock cannot separate a tight loop; max(last + 1, now) can.
    let prev = -Infinity;
    for (let i = 0; i < 500; i += 1) {
      const next = nextRecentSeq();
      expect(next).toBeGreaterThan(prev);
      prev = next;
    }
  });

  it('keeps increasing across windows sharing the key', async () => {
    const A = await newWindow();
    const B = await newWindow();
    const a1 = A.nextRecentSeq();
    const b1 = B.nextRecentSeq();
    const a2 = A.nextRecentSeq();
    expect(b1).toBeGreaterThan(a1);
    expect(a2).toBeGreaterThan(b1);
  });
});

describe('the seq stamp', () => {
  it('parseRecent reads a numeric seq', () => {
    expect(parseRecent('[{"path":"a.pdf","openedAt":1,"seq":7}]')).toEqual([
      { path: 'a.pdf', openedAt: 1, seq: 7 },
    ]);
  });

  it('parseRecent omits a missing or wrong-shaped seq rather than defaulting it to 0', () => {
    // 0 is a real, comparable stamp; a legacy entry carrying one would read as
    // ancient-but-recorded instead of never-recorded.
    for (const raw of [
      '[{"path":"a.pdf","openedAt":1}]',
      '[{"path":"a.pdf","openedAt":1,"seq":"7"}]',
      '[{"path":"a.pdf","openedAt":1,"seq":null}]',
      '[{"path":"a.pdf","openedAt":1,"seq":{}}]',
    ]) {
      const [entry] = parseRecent(raw);
      expect(entry).not.toHaveProperty('seq');
    }
    expect(parseRecent('["a.pdf"]')[0]).not.toHaveProperty('seq');
  });

  it('withRecent stamps an explicit seq and keeps provenance alongside it', () => {
    expect(withRecent([], 'a.pdf', 5, undefined, 42)).toEqual([
      { path: 'a.pdf', openedAt: 5, seq: 42 },
    ]);
    expect(
      withRecent(
        [{ path: 't.pdf', openedAt: 1, sourceUrl: 'https://example.test/t.pdf' }],
        't.pdf',
        5,
        undefined,
        42,
      ),
    ).toEqual([
      { path: 't.pdf', openedAt: 5, sourceUrl: 'https://example.test/t.pdf', seq: 42 },
    ]);
  });

  it('withRecent called without a seq produces no seq key at all', () => {
    // The pin for every existing exact-shape assertion in this file: an extra
    // key would also travel into storage and into a merge.
    const [entry] = withRecent([{ path: 'a.pdf', openedAt: 1 }], 'a.pdf', 5);
    expect(entry).not.toHaveProperty('seq');
    expect(Object.keys(entry)).toEqual(['path', 'openedAt']);
    expect(withRecent([{ path: 'a.pdf', openedAt: 1 }], 'b.pdf', 2)).toEqual([
      { path: 'b.pdf', openedAt: 2 },
      { path: 'a.pdf', openedAt: 1 },
    ]);
    const [web] = withRecent(
      [{ path: 't.pdf', openedAt: 1, sourceUrl: 'https://example.test/t.pdf' }],
      't.pdf',
      5,
    );
    expect(web).not.toHaveProperty('seq');
  });

  it('mergeRecent carries the higher seq even when the OLDER record holds it', () => {
    // Whichever record wins on openedAt, losing the higher stamp would let a
    // stale tombstone outrank an open that actually postdates it.
    expect(
      mergeRecent(
        [{ path: 'x.pdf', openedAt: 2000, seq: 10 }],
        [{ path: 'x.pdf', openedAt: 1000, seq: 99 }],
      ),
    ).toEqual([{ path: 'x.pdf', openedAt: 2000, seq: 99 }]);
    expect(
      mergeRecent(
        [{ path: 'x.pdf', openedAt: 1000, seq: 99 }],
        [{ path: 'x.pdf', openedAt: 2000, seq: 10 }],
      ),
    ).toEqual([{ path: 'x.pdf', openedAt: 2000, seq: 99 }]);
  });

  it('mergeRecent takes the one stamp present, and writes none when neither has one', () => {
    expect(
      mergeRecent([{ path: 'x.pdf', openedAt: 2000 }], [{ path: 'x.pdf', openedAt: 1000, seq: 5 }]),
    ).toEqual([{ path: 'x.pdf', openedAt: 2000, seq: 5 }]);
    const [merged] = mergeRecent(
      [{ path: 'x.pdf', openedAt: 2000 }],
      [{ path: 'x.pdf', openedAt: 1000 }],
    );
    expect(merged).not.toHaveProperty('seq');
  });
});

describe('removeRecentEntries', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });

  it('drops exactly the named paths and leaves the rest in order', () => {
    const before: RecentEntry[] = [
      { path: 'a.pdf', openedAt: 3 },
      { path: 'b.pdf', openedAt: 2 },
      { path: 'c.pdf', openedAt: 1 },
    ];
    expect(removeRecentEntries(before, ['b.pdf'])).toEqual([
      { path: 'a.pdf', openedAt: 3 },
      { path: 'c.pdf', openedAt: 1 },
    ]);
    expect(removeRecentEntries(before, [])).toBe(before);
  });

  it('is not undone by a second window mirroring its pre-removal list back', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.persistRecent([
      { path: 'x.pdf', openedAt: 1000 },
      { path: 'y.pdf', openedAt: 900 },
    ]);
    const bList = B.readRecent();
    expect(bList).toHaveLength(2);

    const kept = A.removeRecentEntries(A.readRecent(), ['x.pdf']);
    expect(A.persistRecent(kept).map((e) => e.path)).toEqual(['y.pdf']);

    // B still holds the pre-removal list and mirrors it back whole.
    expect(B.persistRecent(bList).map((e) => e.path)).toEqual(['y.pdf']);
    expect(B.readRecent().map((e) => e.path)).toEqual(['y.pdf']);
  });

  it('survives a restart — a fresh window hydrates without the removed entry', async () => {
    const A = await newWindow();
    A.persistRecent([
      { path: 'x.pdf', openedAt: 1000 },
      { path: 'y.pdf', openedAt: 900 },
    ]);
    A.persistRecent(A.removeRecentEntries(A.readRecent(), ['x.pdf']));
    const rebooted = await newWindow();
    expect(rebooted.readRecent().map((e) => e.path)).toEqual(['y.pdf']);
  });

  it('orders a same-instant re-open against the removal by seq, not by wall clock', async () => {
    const A = await newWindow();
    A.persistRecent([
      { path: 'x.pdf', openedAt: 1000 },
      { path: 'keep.pdf', openedAt: 900 },
    ]);
    const kept = A.removeRecentEntries(A.readRecent(), ['x.pdf']);

    // A stamp BELOW the removal's loses, however far ahead its clock reads:
    // openedAt cannot rescue it.
    const stale = A.withRecent(kept, 'x.pdf', FUTURE, undefined, 1);
    expect(A.persistRecent(stale).map((e) => e.path)).not.toContain('x.pdf');

    // A stamp above it wins, on the same clock value.
    const fresh = A.withRecent(A.readRecent(), 'x.pdf', FUTURE, undefined, A.nextRecentSeq());
    expect(A.persistRecent(fresh).map((e) => e.path)).toContain('x.pdf');
  });

  it('a real re-open after a removal restores the entry', async () => {
    const A = await newWindow();
    A.persistRecent([
      { path: 'x.pdf', openedAt: 1000 },
      { path: 'keep.pdf', openedAt: 900 },
    ]);
    A.persistRecent(A.removeRecentEntries(A.readRecent(), ['x.pdf']));
    const reopened = A.withRecent(A.readRecent(), 'x.pdf', Date.now(), undefined, A.nextRecentSeq());
    expect(A.persistRecent(reopened).map((e) => e.path)).toEqual(['x.pdf', 'keep.pdf']);
    // And the restored entry survives a stale mirror of the post-removal list.
    expect(A.persistRecent([{ path: 'keep.pdf', openedAt: 900 }]).map((e) => e.path)).toEqual([
      'x.pdf',
      'keep.pdf',
    ]);
  });

  it('leaves Clear Recent working, tombstones present', async () => {
    const A = await newWindow();
    A.persistRecent([
      { path: 'x.pdf', openedAt: 1000 },
      { path: 'y.pdf', openedAt: 900 },
    ]);
    A.persistRecent(A.removeRecentEntries(A.readRecent(), ['x.pdf']));
    A.clearRecentStorage();
    expect(A.readRecent()).toEqual([]);
    // A file opened after both still counts.
    const later = A.withRecent([], 'z.pdf', FUTURE, undefined, A.nextRecentSeq());
    expect(A.persistRecent(later).map((e) => e.path)).toEqual(['z.pdf']);
  });
});

describe('the tombstone store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });

  it('reads a malformed or wrong-shaped value as no tombstones', async () => {
    for (const raw of [
      '{not json',
      '{}',
      '"[]"',
      'null',
      '42',
      '["a.pdf"]',
      '[null,3]',
      '[{"path":"a.pdf"}]',
      '[{"seq":1}]',
      '[{"path":"a.pdf","seq":"1"}]',
    ]) {
      vi.stubGlobal('localStorage', fakeStorage());
      localStorage.setItem('spectra-recent', JSON.stringify([{ path: 'a.pdf', openedAt: 1 }]));
      localStorage.setItem(REMOVED_KEY, raw);
      const A = await newWindow();
      expect(A.readRecent()).toEqual([{ path: 'a.pdf', openedAt: 1 }]);
    }
  });

  it('a well-formed tombstone does remove — the control for the shapes above', async () => {
    localStorage.setItem('spectra-recent', JSON.stringify([{ path: 'a.pdf', openedAt: 1 }]));
    localStorage.setItem(REMOVED_KEY, '[{"path":"a.pdf","seq":10}]');
    expect((await newWindow()).readRecent()).toEqual([]);
    // …and an entry stamped after it is untouched.
    localStorage.setItem(
      'spectra-recent',
      JSON.stringify([{ path: 'a.pdf', openedAt: 1, seq: 11 }]),
    );
    expect((await newWindow()).readRecent()).toEqual([{ path: 'a.pdf', openedAt: 1, seq: 11 }]);
  });

  it('caps the list, evicting the oldest stamps first', async () => {
    const A = await newWindow();
    for (let i = 0; i < 40; i += 1) {
      A.removeRecentEntries([{ path: `f${i}.pdf`, openedAt: i }], [`f${i}.pdf`]);
    }
    const stored = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? '[]') as {
      path: string;
      seq: number;
    }[];
    expect(stored).toHaveLength(32);
    expect(new Set(stored.map((t) => t.path))).toEqual(
      new Set(Array.from({ length: 32 }, (_, i) => `f${i + 8}.pdf`)),
    );
    expect(stored.map((t) => t.seq)).toEqual([...stored.map((t) => t.seq)].sort((a, b) => b - a));
  });

  it('folds one path removed in two windows into a single newest row', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.removeRecentEntries([{ path: 'x.pdf', openedAt: 1 }], ['x.pdf']);
    B.removeRecentEntries([{ path: 'x.pdf', openedAt: 1 }], ['x.pdf']);
    const stored = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? '[]') as {
      path: string;
      seq: number;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].path).toBe('x.pdf');
  });
});

describe('sweepDeadRecents', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });

  it('removes only the paths positively confirmed missing', async () => {
    const state: RecentEntry[] = [
      { path: 'gone.pdf', openedAt: 1, seq: 1 },
      { path: 'here.pdf', openedAt: 2, seq: 2 },
      { path: 'unknown.pdf', openedAt: 3, seq: 3 },
    ];
    const result = await sweepDeadRecents(
      () => state,
      async (paths) =>
        paths.map((p) =>
          p === 'gone.pdf' ? 'missing' : p === 'here.pdf' ? 'exists' : 'indeterminate',
        ),
    );
    expect(result?.removedPaths).toEqual(['gone.pdf']);
    expect(result?.next.map((e) => e.path)).toEqual(['here.pdf', 'unknown.pdf']);
  });

  it('removes a legacy entry that never carried a stamp', async () => {
    const state: RecentEntry[] = [{ path: 'gone.pdf', openedAt: null }];
    const result = await sweepDeadRecents(
      () => state,
      async (paths) => paths.map(() => 'missing' as RecentPathStatus),
    );
    expect(result?.removedPaths).toEqual(['gone.pdf']);
    expect(result?.next).toEqual([]);
  });

  it('returns null when nothing is missing', async () => {
    const state: RecentEntry[] = [
      { path: 'a.pdf', openedAt: 1, seq: 1 },
      { path: 'b.pdf', openedAt: 2, seq: 2 },
    ];
    const result = await sweepDeadRecents(
      () => state,
      async () => ['exists', 'indeterminate'],
    );
    expect(result).toBeNull();
  });

  it('never probes or removes an entry that carries an address', async () => {
    // The temp copy being gone is not a dead path — the address still re-opens
    // it. It must not even reach the probe.
    const calls: string[][] = [];
    const state: RecentEntry[] = [
      { path: 'tmp.pdf', openedAt: 1, seq: 1, sourceUrl: 'https://example.test/a.pdf' },
      { path: 'gone.pdf', openedAt: 2, seq: 2 },
    ];
    const result = await sweepDeadRecents(
      () => state,
      async (paths) => {
        calls.push(paths);
        return paths.map(() => 'missing' as RecentPathStatus);
      },
    );
    expect(calls).toEqual([['gone.pdf']]);
    expect(result?.removedPaths).toEqual(['gone.pdf']);
    expect(result?.next.map((e) => e.path)).toEqual(['tmp.pdf']);
  });

  it('does not probe at all when every entry carries an address', async () => {
    const calls: string[][] = [];
    const result = await sweepDeadRecents(
      () => [{ path: 'tmp.pdf', openedAt: 1, sourceUrl: 'https://example.test/a.pdf' }],
      async (paths) => {
        calls.push(paths);
        return paths.map(() => 'missing' as RecentPathStatus);
      },
    );
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it('spares a path re-opened while the probe was in flight', async () => {
    let state: RecentEntry[] = [
      { path: 'gone.pdf', openedAt: 1, seq: 1 },
      { path: 'alsogone.pdf', openedAt: 2, seq: 2 },
    ];
    const result = await sweepDeadRecents(
      () => state,
      async (paths) => {
        // The user re-opens gone.pdf while the probe is pending: the answer
        // about it is already stale by the time it lands.
        state = withRecent(state, 'gone.pdf', FUTURE, undefined, nextRecentSeq());
        return paths.map(() => 'missing' as RecentPathStatus);
      },
    );
    expect(result?.removedPaths).toEqual(['alsogone.pdf']);
    expect(result?.next.map((e) => e.path)).toEqual(['gone.pdf']);
    expect(result?.next[0].openedAt).toBe(FUTURE);
  });

  it('returns null when the only dead path was re-opened mid-probe', async () => {
    let state: RecentEntry[] = [{ path: 'gone.pdf', openedAt: 1, seq: 1 }];
    const result = await sweepDeadRecents(
      () => state,
      async (paths) => {
        state = withRecent(state, 'gone.pdf', FUTURE, undefined, nextRecentSeq());
        return paths.map(() => 'missing' as RecentPathStatus);
      },
    );
    expect(result).toBeNull();
  });

  it('removes nothing when the probe itself fails', async () => {
    const state: RecentEntry[] = [{ path: 'gone.pdf', openedAt: 1, seq: 1 }];
    const result = await sweepDeadRecents(
      () => state,
      async () => {
        throw new Error('ipc unavailable');
      },
    );
    expect(result).toBeNull();
    // No tombstone was recorded either.
    expect(localStorage.getItem(REMOVED_KEY)).toBeNull();
  });

  it('a sweep removal is not resurrected by a stale mirror', async () => {
    const A = await newWindow();
    const B = await newWindow();
    A.persistRecent([
      { path: 'gone.pdf', openedAt: 1000 },
      { path: 'here.pdf', openedAt: 900 },
    ]);
    const bList = B.readRecent();
    const swept = await A.sweepDeadRecents(
      () => A.readRecent(),
      async (paths) => paths.map((p) => (p === 'gone.pdf' ? 'missing' : 'exists')),
    );
    expect(swept?.removedPaths).toEqual(['gone.pdf']);
    A.persistRecent(swept?.next ?? []);
    expect(B.persistRecent(bList).map((e) => e.path)).toEqual(['here.pdf']);
  });
});
