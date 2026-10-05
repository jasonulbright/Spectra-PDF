import { describe, it, expect } from 'vitest';
import { lastRunView } from '../src/renderer/components/schedule-timing';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';

describe('lastRunView', () => {
  it('treats the has-not-run code as never run, whatever date comes with it', () => {
    expect(lastRunView('11/30/1999 12:00:00 AM', '267011')).toEqual({ ran: false, failed: false });
  });

  it('reports no failure for a successful or informational result', () => {
    expect(lastRunView('10/5/2026 3:00:00 AM', '0')).toEqual({ ran: true, failed: false });
    expect(lastRunView('10/5/2026 3:00:00 AM', '267009')).toEqual({ ran: true, failed: false });
  });

  it('reports a failed run', () => {
    expect(lastRunView('10/5/2026 3:00:00 AM', '1')).toEqual({ ran: true, failed: true });
    expect(lastRunView('10/5/2026 3:00:00 AM', '-2147024894')).toEqual({ ran: true, failed: true });
  });

  it('reports no failure when the result is empty or not a number', () => {
    expect(lastRunView('', '')).toEqual({ ran: false, failed: false });
    expect(lastRunView('10/5/2026', 'N/A')).toEqual({ ran: true, failed: false });
  });

  it('reports no failure for a task with no last run time', () => {
    expect(lastRunView('', '1')).toEqual({ ran: false, failed: false });
  });
});

describe('scheduled run timing text', () => {
  it('states a failed run in words, with no slot for the numeric result', () => {
    const text = DIALOG_STRINGS['dialog.schedule.timingFailed'];
    expect(text).not.toMatch(/\{\{\s*result\s*\}\}/);
    expect(text).toContain('{{next}}');
    expect(text).toContain('{{last}}');
    expect(text).toMatch(/failed/);
  });
});
