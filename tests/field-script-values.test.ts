// Script-derived values belong to ONE read of ONE document. A reread deleted
// the sandbox session but left `values` and `formatted` in place, so a
// calculated Total and a Format action's display string were drawn over the
// replacement document — and a late answer from the disposed sandbox could put
// them back after any purge.
import { describe, expect, it } from 'vitest';
import {
  pruneScriptValues,
  resultIsCurrent,
  staleScriptPaths,
} from '../src/renderer/lib/field-script-values';

const fieldsA = [{ name: 'total' }];
const fieldsB = [{ name: 'total' }];

describe('script value lifetime', () => {
  it('calls a path stale when its field identity changed', () => {
    expect([
      ...staleScriptPaths(new Map([['x.pdf', fieldsA]]), new Map([['x.pdf', fieldsB]])),
    ]).toEqual(['x.pdf']);
  });

  it('calls a path stale when the file is gone', () => {
    expect([...staleScriptPaths(new Map([['x.pdf', fieldsA]]), new Map())]).toEqual(['x.pdf']);
  });

  it('leaves an unchanged read alone', () => {
    expect(
      [...staleScriptPaths(new Map([['x.pdf', fieldsA]]), new Map([['x.pdf', fieldsA]]))].length,
    ).toBe(0);
  });

  it('purges values for a path whose field identity changed', () => {
    const prev = new Map([['x.pdf', new Map([['total', '42']])]]);
    const next = pruneScriptValues(prev, new Set(['x.pdf']), new Set(['x.pdf']));
    expect(next.has('x.pdf')).toBe(false);
  });

  it('purges values for a path the workspace no longer holds', () => {
    const prev = new Map([['x.pdf', new Map([['total', '$42.00']])]]);
    expect(pruneScriptValues(prev, new Set(['y.pdf']), new Set()).has('x.pdf')).toBe(false);
  });

  it('keeps a live read, and returns the same map so a state setter can bail out', () => {
    const prev = new Map([['x.pdf', new Map([['total', '42']])]]);
    expect(pruneScriptValues(prev, new Set(['x.pdf']), new Set())).toBe(prev);
  });

  it('refuses a late result from a session that is no longer the path s', () => {
    const disposed = { id: 'old' };
    const current = { id: 'new' };
    const sessions = new Map([['x.pdf', current]]);
    expect(resultIsCurrent(sessions, 'x.pdf', disposed)).toBe(false);
    expect(resultIsCurrent(sessions, 'x.pdf', current)).toBe(true);
    // A path with no session at all cannot accept a result either.
    expect(resultIsCurrent(new Map(), 'x.pdf', disposed)).toBe(false);
  });
});
