// The renderer half of document ownership across windows.
//
// The arbiter itself is Rust managed state (one process, one table) — what
// lives here is the funnel's contract with it: a batch is claimed path by
// path so one refused file cannot refuse a whole drop, a refusal that names
// ONE window can offer to go there, and per-window storage keys fall back to
// the primary window's so a new window opens with the layout the user is
// looking at rather than defaults.
//
// Guards live in testable modules rather than components: there is no DOM test
// environment, so localStorage is stubbed the way every other storage test
// does it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const claim = vi.fn();
const release = vi.fn();
vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  claims: {
    claim: (path: string, mode: string) => claim(path, mode),
    release: (path: string) => release(path),
    claimOutputRoot: vi.fn(),
    releaseOutputRoot: vi.fn(),
  },
}));

import { claimPaths, releasePaths, soleOwner } from '../src/renderer/lib/window-claims';
import { mergeRecent, sameRecent, type RecentEntry } from '../src/renderer/lib/recent-files';
import { scopedKeyFor, PRIMARY_WINDOW_LABEL } from '../src/renderer/lib/window-label';

beforeEach(() => {
  claim.mockReset();
  release.mockReset();
});

describe('claimPaths', () => {
  it('keeps what was granted and reports only what was refused', async () => {
    claim.mockImplementation(async (path: string) =>
      path === 'B' ? { granted: false, owner: 'doc-1' } : { granted: true, owner: '' },
    );

    const { granted, refused } = await claimPaths(['A', 'B', 'C'], 'write');

    // Partial success: a three-file drop whose middle file belongs elsewhere
    // still opens the other two.
    expect(granted).toEqual(['A', 'C']);
    expect(refused).toEqual([{ path: 'B', owner: 'doc-1' }]);
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('passes the mode through so an import source claims a read', async () => {
    claim.mockResolvedValue({ granted: true, owner: '' });
    await claimPaths(['A'], 'read');
    expect(claim).toHaveBeenCalledWith('A', 'read');
  });

  it('grants everything when nothing is held elsewhere', async () => {
    claim.mockResolvedValue({ granted: true, owner: '' });
    const { granted, refused } = await claimPaths(['A', 'B'], 'write');
    expect(granted).toEqual(['A', 'B']);
    expect(refused).toEqual([]);
  });
});

describe('soleOwner', () => {
  it('names the window when every refusal points at the same one', () => {
    expect(soleOwner([{ path: 'A', owner: 'doc-1' }, { path: 'B', owner: 'doc-1' }])).toBe('doc-1');
  });

  it('is null across several windows — there is nowhere single to send the user', () => {
    expect(soleOwner([{ path: 'A', owner: 'doc-1' }, { path: 'B', owner: 'main' }])).toBeNull();
  });

  it('is null for no refusals', () => {
    expect(soleOwner([])).toBeNull();
  });
});

describe('releasePaths', () => {
  it('releases every path and survives a failure on one of them', async () => {
    release.mockImplementation(async (path: string) => {
      if (path === 'A') throw new Error('window gone');
    });
    await expect(releasePaths(['A', 'B'])).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe('scopedKeyFor', () => {
  it('leaves the primary window on the unsuffixed key', () => {
    expect(scopedKeyFor('workbench-ui', PRIMARY_WINDOW_LABEL)).toBe('workbench-ui');
  });

  it('gives every other window its own key', () => {
    expect(scopedKeyFor('workbench-ui', 'doc-1')).toBe('workbench-ui:doc-1');
    expect(scopedKeyFor('snap-ui', 'doc-2')).toBe('snap-ui:doc-2');
  });
});

describe('mergeRecent', () => {
  const at = (path: string, openedAt: number | null): RecentEntry => ({ path, openedAt });

  it('keeps the newest open per path', () => {
    expect(mergeRecent([at('A', 20)], [at('A', 10)])).toEqual([at('A', 20)]);
    expect(mergeRecent([at('A', 10)], [at('A', 20)])).toEqual([at('A', 20)]);
  });

  it('folds in a path only the other window has seen', () => {
    // The defect this exists to stop: a window that hydrated its list at boot
    // and mirrors it back whole erases every open the other window recorded.
    expect(mergeRecent([at('A', 20)], [at('B', 30)])).toEqual([at('B', 30), at('A', 20)]);
  });

  it('sorts most recent first and caps the list at ten', () => {
    const many = Array.from({ length: 14 }, (_, i) => at(`F${i}`, i));
    const merged = mergeRecent(many, []);
    expect(merged).toHaveLength(10);
    expect(merged[0]).toEqual(at('F13', 13));
    expect(merged[9]).toEqual(at('F4', 4));
  });

  it('sorts an unrecorded time last and loses to any timed entry', () => {
    expect(mergeRecent([at('A', null)], [at('A', 5)])).toEqual([at('A', 5)]);
    expect(mergeRecent([at('A', 5)], [at('A', null)])).toEqual([at('A', 5)]);
    expect(mergeRecent([at('A', null)], [at('B', 1)])).toEqual([at('B', 1), at('A', null)]);
  });
});

describe('sameRecent', () => {
  it('is true only for the same entries in the same order', () => {
    const a: RecentEntry[] = [{ path: 'A', openedAt: 1 }, { path: 'B', openedAt: 2 }];
    expect(sameRecent(a, [...a])).toBe(true);
    expect(sameRecent(a, [a[1], a[0]])).toBe(false);
    expect(sameRecent(a, [a[0]])).toBe(false);
    expect(sameRecent(a, [{ path: 'A', openedAt: 9 }, a[1]])).toBe(false);
  });
});

describe('persistRecent', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adopts the other window opens without losing its own', async () => {
    const mod = await import('../src/renderer/lib/recent-files');
    store.set('spectra-recent', JSON.stringify([{ path: 'A', openedAt: 1 }]));
    expect(mod.readRecent()).toEqual([{ path: 'A', openedAt: 1 }]);

    // The other window opens B while this one holds its hydrated list.
    store.set(
      'spectra-recent',
      JSON.stringify([{ path: 'B', openedAt: 5 }, { path: 'A', openedAt: 1 }]),
    );

    const merged = mod.persistRecent([{ path: 'C', openedAt: 9 }, { path: 'A', openedAt: 1 }]);
    expect(merged.map((e) => e.path)).toEqual(['C', 'B', 'A']);
  });

  it('lets this window remove an entry it wrote', async () => {
    const mod = await import('../src/renderer/lib/recent-files');
    store.set('spectra-recent', JSON.stringify([{ path: 'A', openedAt: 1 }]));
    mod.readRecent();
    // Clear Recent: a blind union would resurrect what the user just removed.
    expect(mod.persistRecent([])).toEqual([]);
    expect(store.get('spectra-recent')).toBe('[]');
  });
});
