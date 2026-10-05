import { describe, it, expect } from 'vitest';
import { lastRunView } from '../src/renderer/components/schedule-timing';

describe('lastRunView', () => {
  it('treats the has-not-run code as never run, whatever date comes with it', () => {
    expect(lastRunView('11/30/1999 12:00:00 AM', '267011')).toEqual({ ran: false, failureCode: null });
  });

  it('shows no code for a successful or informational result', () => {
    expect(lastRunView('10/5/2026 3:00:00 AM', '0')).toEqual({ ran: true, failureCode: null });
    expect(lastRunView('10/5/2026 3:00:00 AM', '267009')).toEqual({ ran: true, failureCode: null });
  });

  it('shows the code of a failed run', () => {
    expect(lastRunView('10/5/2026 3:00:00 AM', '1')).toEqual({ ran: true, failureCode: '1' });
    expect(lastRunView('10/5/2026 3:00:00 AM', '-2147024894')).toEqual({
      ran: true,
      failureCode: '-2147024894',
    });
  });

  it('shows no code when the result is empty or not a number', () => {
    expect(lastRunView('', '')).toEqual({ ran: false, failureCode: null });
    expect(lastRunView('10/5/2026', 'N/A')).toEqual({ ran: true, failureCode: null });
  });
});
