import { describe, it, expect } from 'vitest';
import { findResultPending } from '../src/renderer/components/canvas/find-pending';

describe('findResultPending', () => {
  it('is pending while the shown result belongs to an earlier query', () => {
    // Typed "aurora"; the debounce has not landed, the result is still for "".
    expect(findResultPending('aurora', '')).toBe(true);
    expect(findResultPending('aurora', 'auror')).toBe(true);
  });

  it('is settled once the result was computed for the current query', () => {
    expect(findResultPending('aurora', 'aurora')).toBe(false);
  });

  it('is never pending for an empty query', () => {
    expect(findResultPending('', 'aurora')).toBe(false);
    expect(findResultPending('   ', '')).toBe(false);
  });
});
