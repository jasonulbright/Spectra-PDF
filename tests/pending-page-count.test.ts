import { describe, expect, it } from 'vitest';
import { pendingPageCount } from '../src/renderer/lib/operation-intent';
import type { AppState } from '../src/renderer/state/types';

const docs = (path: string, ...sizes: number[]) =>
  sizes.map((n, i) => ({ id: `${path}:${i}`, path, pages: Array.from({ length: n }, (_, p) => ({ id: `${i}-${p}` })) }));

describe('pendingPageCount', () => {
  const file = { path: 'C:/a.pdf', pageCount: 5 };
  it('counts every partition of a file whose page tier is pending', () => {
    const state = { pageDirtyPaths: ['C:/a.pdf'], workspace: { documents: docs('C:/a.pdf', 5, 3) } };
    expect(pendingPageCount(state as unknown as Pick<AppState, 'pageDirtyPaths' | 'workspace'>, file)).toBe(8);
  });
  it('reads the stored count for a clean file', () => {
    const state = { pageDirtyPaths: [], workspace: { documents: docs('C:/a.pdf', 5, 3) } };
    expect(pendingPageCount(state as unknown as Pick<AppState, 'pageDirtyPaths' | 'workspace'>, file)).toBe(5);
  });
});
