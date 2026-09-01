// The fill's structured result, read rather than discarded. Both call sites
// (the Forms panel's Apply and the on-canvas fill) announced success
// unconditionally, so a fill that did not account for every field it named —
// or that answered with a shape this build cannot read — was reported as done.
import { describe, expect, it } from 'vitest';
import { classifyFillResult } from '../src/renderer/lib/fill-result';

const OK = { output: '/tmp/f.pdf', filled: 3, flattened: false };

describe('fill result classification', () => {
  it('accepts a report that accounts for every named field', () => {
    expect(classifyFillResult(OK, 3)).toEqual({ kind: 'ok', filled: 3 });
  });

  it('accepts a flatten that named no fields', () => {
    expect(classifyFillResult({ output: '/tmp/f.pdf', filled: 0, flattened: true }, 0)).toEqual({
      kind: 'ok',
      filled: 0,
    });
  });

  it('refuses a shortfall rather than announcing it as a fill', () => {
    expect(classifyFillResult({ ...OK, filled: 2 }, 3)).toEqual({
      kind: 'refused',
      refusal: { kind: 'incomplete', requested: 3, filled: 2 },
    });
  });

  it('refuses an absent result', () => {
    expect(classifyFillResult(undefined, 1)).toMatchObject({
      refusal: { kind: 'unverified' },
    });
    expect(classifyFillResult(null, 1)).toMatchObject({ refusal: { kind: 'unverified' } });
  });

  it('refuses a result this build cannot read', () => {
    expect(classifyFillResult('done', 1)).toMatchObject({ refusal: { kind: 'unverified' } });
    expect(classifyFillResult({ output: '/tmp/f.pdf' }, 1)).toMatchObject({
      refusal: { kind: 'unverified' },
    });
    expect(classifyFillResult({ ...OK, filled: 'three' }, 1)).toMatchObject({
      refusal: { kind: 'unverified' },
    });
    expect(classifyFillResult({ ...OK, filled: Number.NaN }, 1)).toMatchObject({
      refusal: { kind: 'unverified' },
    });
  });

  it('refuses a report that names no file it wrote', () => {
    expect(classifyFillResult({ filled: 3 }, 3)).toMatchObject({
      refusal: { kind: 'unverified' },
    });
    expect(classifyFillResult({ ...OK, output: '' }, 3)).toMatchObject({
      refusal: { kind: 'unverified' },
    });
  });

  it('does not treat a document-side recalculation as a shortfall', () => {
    // `calculated` names fields the DOCUMENT computed; `filled` still counts
    // what the caller named, which is what the announcement is about.
    expect(classifyFillResult({ ...OK, calculated: ['total'] }, 3)).toEqual({
      kind: 'ok',
      filled: 3,
    });
  });
});
