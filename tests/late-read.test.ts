import { describe, it, expect } from 'vitest';
import { mergeUntouched } from '../src/renderer/lib/late-read';

// The regression these guard is a REAL data loss (see lib/late-read.ts): a
// panel seeding editable state from an async engine read, and the read landing
// after the user started typing. There is no DOM test environment in this
// project, so the merge rule lives in a pure module precisely so it can be
// driven here rather than only through a racy e2e.

describe('mergeUntouched', () => {
  it('takes the file wholesale when the user has touched nothing', () => {
    const seed = { a: '1', b: '2' };
    const out = mergeUntouched(seed, { a: 'typed', b: 'typed' }, new Set());
    expect(out).toEqual({ a: '1', b: '2' });
  });

  it('returns a copy, never the seed object itself', () => {
    const seed = { a: '1' };
    const out = mergeUntouched(seed, { a: '1' }, new Set());
    expect(out).not.toBe(seed);
  });

  it('keeps what the user typed and reseeds everything else', () => {
    // The exact shape of the loss: the alt text is half-typed when a refresh
    // lands. The other four draft keys are still the file's truth.
    const seed = { type: 'Figure', title: 'Chart', alt: '', lang: 'en-US', actual_text: '' };
    const current = { type: 'Figure', title: 'Chart', alt: 'Quarterly rev', lang: 'en-US', actual_text: '' };
    const out = mergeUntouched(seed, current, new Set(['alt']));
    expect(out).toEqual({ ...seed, alt: 'Quarterly rev' });
  });

  it('reseeds an untouched key even when the user state disagrees', () => {
    // A key the user never touched but whose local value is stale (an undo
    // moved the file underneath them) must follow the file, not the stale copy.
    const out = mergeUntouched({ a: 'file' }, { a: 'stale' }, new Set(['b']));
    expect(out.a).toBe('file');
  });

  it('drops a touched key the file no longer has', () => {
    // A form field removed from the document: the edit cannot land, so it is
    // not carried. The key set stays exactly the seed's.
    const out = mergeUntouched({ a: '1' }, { a: '1', gone: 'typed' }, new Set(['gone']));
    expect(Object.keys(out)).toEqual(['a']);
  });

  it('never invents a key the seed does not have', () => {
    const seed = { a: '1', b: '2' };
    const out = mergeUntouched(seed, { a: 'x', b: 'y', c: 'z' }, new Set(['a', 'c']));
    expect(Object.keys(out).sort()).toEqual(['a', 'b']);
    expect(out.a).toBe('x');
  });

  it('handles non-string values (form field unions) by reference', () => {
    const picked = ['one', 'two'];
    const seed: Record<string, string | string[] | boolean> = { choice: [], flag: false };
    const out = mergeUntouched(seed, { choice: picked, flag: true }, new Set(['choice']));
    expect(out.choice).toBe(picked);
    expect(out.flag).toBe(false);
  });

  it('preserves a fixed-shape draft type rather than widening it', () => {
    // The TagsPanel case: the result must still be a Draft, not a bare record,
    // or the setState callback stops typechecking.
    const draft = { type: 'P', title: '', alt: '', actual_text: '', lang: '' };
    const out = mergeUntouched(draft, { ...draft, alt: 'typed' }, new Set(['alt']));
    const round: typeof draft = out;
    expect(round.alt).toBe('typed');
    expect(round.type).toBe('P');
  });

  it('does not mutate the inputs', () => {
    const seed = { a: '1' };
    const current = { a: '2' };
    const touched = new Set(['a']);
    mergeUntouched(seed, current, touched);
    expect(seed).toEqual({ a: '1' });
    expect(current).toEqual({ a: '2' });
    expect([...touched]).toEqual(['a']);
  });
});
