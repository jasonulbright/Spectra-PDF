import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  mergeRecent,
  nextRecentSeq,
  sameRecent,
  type RecentEntry,
} from '../src/renderer/lib/recent-files';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  } as Storage;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

async function fresh(): Promise<typeof import('../src/renderer/lib/recent-files')> {
  vi.resetModules();
  return import('../src/renderer/lib/recent-files');
}

describe('adversarial recent-file ordering', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });

  it('state equality includes the ordering generation', () => {
    const a: RecentEntry[] = [{ path: 'x.pdf', openedAt: 1, seq: 10 }];
    const b: RecentEntry[] = [{ path: 'x.pdf', openedAt: 1, seq: 11 }];
    expect(sameRecent(a, b)).toBe(false);
  });

  it('the record from the later sequence wins when the wall clock moves backward', () => {
    expect(mergeRecent(
      [{ path: 'x.pdf', openedAt: 2000, seq: 10, sourceUrl: 'https://old.example/x.pdf' }],
      [{ path: 'x.pdf', openedAt: 1000, seq: 11, sourceUrl: 'https://new.example/x.pdf' }],
    )).toEqual([
      { path: 'x.pdf', openedAt: 1000, seq: 11, sourceUrl: 'https://new.example/x.pdf' },
    ]);
  });

  it('a removed path cannot resurrect merely because unrelated tombstones hit the cap', async () => {
    const A = await fresh();
    const B = await fresh();
    A.persistRecent([{ path: 'x.pdf', openedAt: 1, seq: 1 }]);
    const stale = B.readRecent();
    A.persistRecent(A.removeRecentEntries(A.readRecent(), ['x.pdf']));
    for (let i = 0; i < 32; i += 1) {
      A.removeRecentEntries([], [`other-${i}.pdf`]);
    }
    expect(B.persistRecent(stale).map((entry) => entry.path)).not.toContain('x.pdf');
  });

  it('the newest duplicate tombstone wins regardless of serialized row order', async () => {
    localStorage.setItem('spectra-recent', JSON.stringify([
      { path: 'x.pdf', openedAt: 1, seq: 50 },
    ]));
    localStorage.setItem('spectra-recent-removed', JSON.stringify([
      { path: 'x.pdf', seq: 100 },
      { path: 'x.pdf', seq: 1 },
    ]));
    expect((await fresh()).readRecent()).toEqual([]);
  });

  it('clear followed by open in the same millisecond keeps the later open', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const A = await fresh();
    A.persistRecent([{ path: 'old.pdf', openedAt: 900, seq: 900 }]);
    A.clearRecentStorage();
    const reopened = A.withRecent([], 'new.pdf', Date.now(), undefined, A.nextRecentSeq());
    expect(A.persistRecent(reopened).map((entry) => entry.path)).toEqual(['new.pdf']);
  });

  it('malformed sequence storage cannot poison future allocation', () => {
    localStorage.setItem('spectra-recent-seq', String(Number.MAX_VALUE));
    const value = nextRecentSeq();
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });

  it('every production mutation uses the shared browser lock', async () => {
    const requests: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(name: string, callback: () => T | Promise<T>): Promise<T> => {
          requests.push(name);
          return callback();
        },
      },
    });
    const A = await fresh();
    const opened = await A.recordRecentOpen([], 'x.pdf', 1);
    await A.removeRecentEntriesSafely(opened, ['x.pdf']);
    await A.clearRecentStorageSafely();
    expect(requests).toEqual([
      'spectra-recent-storage',
      'spectra-recent-storage',
      'spectra-recent-storage',
    ]);
  });

  it('boot hydration deduplicates and caps hostile-but-valid storage', async () => {
    localStorage.setItem(
      'spectra-recent',
      JSON.stringify([
        { path: '', openedAt: 999, seq: 999 },
        ...Array.from({ length: 80 }, (_, i) => ({
          path: `f${i % 20}.pdf`,
          openedAt: i,
          seq: i + 1,
        })),
      ]),
    );
    const entries = (await fresh()).readRecent();
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(10);
    expect(entries.some((entry) => entry.path === '')).toBe(false);
  });

  it('renderer callers cannot bypass the cross-window mutation boundary', () => {
    const root = resolve(process.cwd(), 'src', 'renderer');
    const implementation = resolve(root, 'lib', 'recent-files.ts');
    const bypass = /\b(?:nextRecentSeq|persistRecent|removeRecentEntries|clearRecentStorage)\b/;
    const offenders = sourceFiles(root)
      .filter((path) => path !== implementation)
      .filter((path) => bypass.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
