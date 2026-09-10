import { describe, expect, it } from 'vitest';
import { recoveryOutcome } from '../src/renderer/lib/recovery-result';

const complete = { page_count_known: true, enumeration_error: null, total_pages: 3, recovered: 3, lost: 0 };

describe('recovery completion requires a finished page traversal', () => {
  it('accepts a complete scan and a counted partial recovery', () => {
    expect(recoveryOutcome(complete)).toBe('complete');
    expect(recoveryOutcome({ ...complete, recovered: 2, lost: 1 })).toBe('partial');
  });
  it('does not call a one-page observed prefix all pages recovered', () => {
    expect(recoveryOutcome({ ...complete, total_pages: 1, recovered: 1,
      page_count_known: false, enumeration_error: 'page tree unreadable' })).toBe('undetermined');
  });
  it.each([
    { page_count_known: false }, { page_count_known: undefined },
    { enumeration_error: 'scan failed' }, { enumeration_error: '' },
    { recovered: 2 }, { total_pages: NaN }, { lost: -1, recovered: 4 },
    { total_pages: 0, recovered: 0 }, { recovered: 1.5, lost: 1.5 },
  ])('refuses unsupported completion evidence: %j', (mutation) => {
    expect(recoveryOutcome({ ...complete, ...mutation })).toBe('undetermined');
  });
});
