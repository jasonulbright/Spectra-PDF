// The workspace indexer's run bookkeeping. Only the live run of a path lands;
// a newer buffer supersedes an older run; and a run whose proxy was destroyed
// is abandoned, because a pdf.js request sent to a terminating proxy never
// settles and the commit that waits for the landing would wait forever.
import { describe, expect, it } from 'vitest';
import { createIndexRuns } from '../src/renderer/lib/index-runs';

describe('createIndexRuns', () => {
  it('starts one run per buffer, and only the live run lands', () => {
    const runs = createIndexRuns();
    const a = [1];
    const first = runs.begin('p', a)!;
    expect(first).not.toBeNull();
    expect(runs.begin('p', a)).toBeNull(); // in flight already
    expect(runs.live('p', first)).toBe(true);
    runs.end('p', first);
    expect(runs.live('p', first)).toBe(false);
    expect(runs.begin('p', a)).not.toBeNull(); // a finished run can run again
  });

  it('a newer buffer supersedes the run of an older one', () => {
    const runs = createIndexRuns();
    const older = runs.begin('p', [1])!;
    const newer = runs.begin('p', [2])!;
    expect(runs.live('p', older)).toBe(false);
    expect(runs.live('p', newer)).toBe(true);
    // The superseded run ending does not end the newer one.
    runs.end('p', older);
    expect(runs.live('p', newer)).toBe(true);
  });

  it('a destroyed proxy abandons the live run of its buffer, and nothing else', () => {
    const runs = createIndexRuns();
    const current = [2];
    const token = runs.begin('p', current)!;
    const other = runs.begin('q', [9])!;
    expect(runs.abandon('p', [1])).toBe(false); // another buffer's proxy
    expect(runs.abandon('r', current)).toBe(false); // another path
    expect(runs.live('p', token)).toBe(true);
    expect(runs.abandon('p', current)).toBe(true);
    expect(runs.live('p', token)).toBe(false);
    expect(runs.live('q', other)).toBe(true);
    // The path is indexed again, and the abandoned run never lands.
    const again = runs.begin('p', current)!;
    expect(again).not.toBe(token);
    runs.end('p', token);
    expect(runs.live('p', again)).toBe(true);
  });
});
