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
    claimOutputRoots: vi.fn(),
    releaseOutputRoots: vi.fn(),
  },
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { claimPaths, createClaimHolds, departedImportSources, releasePaths, soleOwner } from '../src/renderer/lib/window-claims';
import type { OpenFile } from '../src/renderer/state/types';
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

// Close releases a path without awaiting the release; a reopen claims the
// same path. The arbiter's claim is idempotent per window and its release
// drops the window's claim whatever came before, so a release processed after
// the reopen's claim leaves the reopened document open with no claim at all.
// Both calls are async commands, and nothing orders two of them by arrival.
describe('claims on one path from one window', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  function arbiter() {
    const held = new Set<string>();
    const arrived: { kind: 'claim' | 'release'; path: string; process: () => void }[] = [];
    claim.mockImplementation((path: string) => new Promise((resolve) => {
      arrived.push({ kind: 'claim', path, process: () => { held.add(path); resolve({ granted: true, owner: '' }); } });
    }));
    release.mockImplementation((path: string) => new Promise<void>((resolve) => {
      arrived.push({ kind: 'release', path, process: () => { held.delete(path); resolve(); } });
    }));
    /** Process what has arrived, newest first: the order a busy runtime may pick. */
    const drain = async (): Promise<string[]> => {
      const order: string[] = [];
      await flush();
      while (arrived.length > 0) {
        const call = arrived.pop()!;
        order.push(`${call.kind} ${call.path}`);
        call.process();
        await flush();
      }
      return order;
    };
    return { held, drain };
  }

  it('a reopen claim is sent only after the close release of the same path answered', async () => {
    const { held, drain } = arbiter();
    held.add('P');
    const closing = releasePaths(['P']);
    const reopening = claimPaths(['P'], 'write');
    const order = await drain();
    await Promise.all([closing, reopening]);
    expect(order).toEqual(['release P', 'claim P']);
    expect(held.has('P')).toBe(true);
  });

  it('a close of several paths puts every release ahead of a reopen of any of them', async () => {
    const { held, drain } = arbiter();
    held.add('A');
    held.add('P');
    const closing = releasePaths(['A', 'P']);
    const reopening = claimPaths(['P'], 'write');
    const order = await drain();
    await Promise.all([closing, reopening]);
    expect(order.indexOf('release P')).toBeLessThan(order.indexOf('claim P'));
    expect([...held]).toEqual(['P']);
  });

  it('a close after an open waits for the claim, so the close has the last word', async () => {
    const { held, drain } = arbiter();
    const opening = claimPaths(['P'], 'write');
    const closing = releasePaths(['P']);
    const order = await drain();
    await Promise.all([opening, closing]);
    expect(order).toEqual(['claim P', 'release P']);
    expect(held.has('P')).toBe(false);
  });

  it('calls on different paths do not wait for each other', async () => {
    const { drain } = arbiter();
    const closing = releasePaths(['A']);
    const opening = claimPaths(['B'], 'write');
    // Both are in flight together; the newest (the claim of B) answers first.
    expect(await drain()).toEqual(['claim B', 'release A']);
    await Promise.all([closing, opening]);
  });

  it('a failed release does not hold the next claim of that path back', async () => {
    release.mockRejectedValueOnce(new Error('window gone'));
    claim.mockResolvedValueOnce({ granted: true, owner: '' });
    await releasePaths(['P']);
    await expect(claimPaths(['P'], 'write')).resolves.toEqual({ granted: ['P'], refused: [] });
  });

  it('a release is not sent for a path this window uses when the release’s turn comes', async () => {
    const { held, drain } = arbiter();
    const holds = createClaimHolds();
    const inUse = (path: string): boolean => holds.held(path);
    // An open of P that is cancelled, and an import of P that runs meanwhile:
    // both flows of one window, one claim between them.
    holds.hold(['P']);
    const opening = claimPaths(['P'], 'write');
    holds.hold(['P']);
    const importing = claimPaths(['P'], 'read');
    await drain();
    await Promise.all([opening, importing]);
    holds.drop(['P']); // the open is cancelled
    const cancelled = releasePaths(['P'], inUse);
    expect(await drain()).toEqual([]);
    await cancelled;
    expect(held.has('P')).toBe(true);
    holds.drop(['P']); // the import ends without using it
    const ended = releasePaths(['P'], inUse);
    expect(await drain()).toEqual(['release P']);
    await ended;
    expect(held.has('P')).toBe(false);
  });

  it('asks whether the path is in use at the release’s turn, not at its call', async () => {
    const { held, drain } = arbiter();
    held.add('P');
    let used = false;
    const claiming = claimPaths(['P'], 'write');
    const releasing = releasePaths(['P'], () => used);
    // A flow takes the path while the claim ahead of the release is unanswered.
    used = true;
    expect(await drain()).toEqual(['claim P']);
    await Promise.all([claiming, releasing]);
    expect(held.has('P')).toBe(true);
  });

  it('a third call waits for the second even after the first answered', async () => {
    const sent: string[] = [];
    const answers: (() => void)[] = [];
    release.mockImplementation((path: string) => new Promise<void>((resolve) => {
      sent.push(`release ${path}`);
      answers.push(resolve);
    }));
    claim.mockImplementation((path: string) => new Promise((resolve) => {
      sent.push(`claim ${path}`);
      answers.push(() => resolve({ granted: true, owner: '' }));
    }));
    const first = releasePaths(['P']);
    const second = claimPaths(['P'], 'write');
    await flush();
    answers.shift()!();
    await first;
    await flush();
    expect(sent).toEqual(['release P', 'claim P']);
    // The claim is in flight: a close now must wait for its answer.
    const third = releasePaths(['P']);
    await flush();
    expect(sent).toEqual(['release P', 'claim P']);
    answers.shift()!();
    await second;
    await flush();
    expect(sent).toEqual(['release P', 'claim P', 'release P']);
    answers.shift()!();
    await third;
  });
});

describe('createClaimHolds', () => {
  it('counts every flow that holds a path', () => {
    const holds = createClaimHolds();
    holds.hold(['A', 'B']);
    holds.hold(['A']);
    holds.drop(['A']);
    expect(holds.held('A')).toBe(true);
    holds.drop(['A', 'B']);
    expect(holds.held('A')).toBe(false);
    expect(holds.held('B')).toBe(false);
    // A drop without a hold does not go below nothing.
    holds.drop(['C']);
    holds.hold(['C']);
    expect(holds.held('C')).toBe(true);
  });
});

describe('departedImportSources', () => {
  const entry = (path: string, importOnly?: true): [string, OpenFile] => [path, {
    path, workingPath: `${path}.w`, name: path, pageCount: 1, buffer: [1],
    dirty: false, undoStack: [], redoStack: [], ...(importOnly ? { importOnly } : {}),
  }];

  it('names an import source no longer in the files, and nothing else', () => {
    const previous = new Map([entry('doc.pdf'), entry('gone.pdf', true), entry('kept.pdf', true), entry('closed.pdf')]);
    const next = new Map([entry('doc.pdf'), entry('kept.pdf', true)]);
    expect(departedImportSources(previous, next)).toEqual(['gone.pdf']);
  });

  it('does not name a source that became an open document', () => {
    const previous = new Map([entry('x.pdf', true)]);
    const next = new Map([entry('x.pdf')]);
    expect(departedImportSources(previous, next)).toEqual([]);
  });
});

// App has no DOM test environment: its claim flows are pinned to the rules
// above as source text.
describe('the window’s claim flows', () => {
  const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');

  it('hold their paths from before the claim until they finish', () => {
    expect(app).toContain('claimHolds.current.hold(holding);');
    expect(app).toContain('claimHolds.current.drop(holding);');
    expect(app).toContain('claimHolds.current.hold(canonicalImports);');
    expect(app).toContain('claimHolds.current.drop(canonicalImports);');
    expect(app).toContain('claimHolds.current.hold([dest]);');
    expect(app).toContain('claimHolds.current.drop([dest]);');
  });

  it('release the read claim of an import source that left the files', () => {
    expect(app).toContain('const departed = departedImportSources(filesSeen.current, state.files);');
    expect(app).toContain('if (departed.length > 0) void releasePaths(departed, pathInUse);');
  });

  it('release only through the in-use check', () => {
    expect(app).toContain('(path: string): boolean => readState().files.has(path) || claimHolds.current.held(path),');
    const releases = app.match(/releasePaths\([^;]*\);/g) ?? [];
    expect(releases.length).toBeGreaterThanOrEqual(6);
    expect(releases.filter((call) => !call.includes('pathInUse'))).toEqual([]);
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
    mod.clearRecentStorage();
    expect(mod.readRecent()).toEqual([]);
    expect(store.get('spectra-recent')).toBe('[]');
  });
});
