import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { jobReportLine } from '../src/renderer/lib/virtual-printer-report';

describe('the virtual printer job line', () => {
  it('shows nothing when no job reported anything', () => {
    expect(jobReportLine({ lastJobError: '', lastJobNote: '' })).toBeNull();
  });

  it('shows a delivered job note under its own key, not the failure key', () => {
    expect(jobReportLine({ lastJobError: '', lastJobNote: 'the mirror option was not applied' })).toEqual({
      kind: 'note',
      key: 'panel.settings.lastJobNote',
      vars: { note: 'the mirror option was not applied' },
    });
  });

  it('shows an error over a note', () => {
    expect(jobReportLine({ lastJobError: 'the job was removed', lastJobNote: 'a note' })).toEqual({
      kind: 'error',
      key: 'panel.settings.lastJobFailed',
      vars: { error: 'the job was removed' },
    });
  });

  it('the panel renders the line through the selector', () => {
    const panel = readFileSync(resolve(__dirname, '../src/renderer/panels/SettingsPanel.tsx'), 'utf8');
    expect(panel).toContain('jobReportLine(vpStatus)');
    expect(panel).not.toContain("tChrome('panel.settings.lastJobFailed'");
  });
});
