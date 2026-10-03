import type { VirtualPrinterStatus } from './tauri-bridge';

/** The one line Settings shows about the latest print jobs. */
export type JobReportLine =
  | { kind: 'error'; key: 'panel.settings.lastJobFailed'; vars: { error: string } }
  | { kind: 'note'; key: 'panel.settings.lastJobNote'; vars: { note: string } };

/**
 * A job error outranks a note: the note describes a delivered job, and it is
 * shown only while no error stands.
 */
export function jobReportLine(
  status: Pick<VirtualPrinterStatus, 'lastJobError' | 'lastJobNote'>,
): JobReportLine | null {
  if (status.lastJobError !== '') {
    return { kind: 'error', key: 'panel.settings.lastJobFailed', vars: { error: status.lastJobError } };
  }
  if (status.lastJobNote !== '') {
    return { kind: 'note', key: 'panel.settings.lastJobNote', vars: { note: status.lastJobNote } };
  }
  return null;
}
