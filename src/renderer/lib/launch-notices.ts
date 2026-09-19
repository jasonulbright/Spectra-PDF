// What a launch has to report once a window exists.
//
// Both reports are decided before any window is built: the "Start with
// Windows" correction, and the records the launch could not read. Rust keeps
// each until the first window asks, and asking clears it, so one launch
// reports once.

import type { UnreadableRecord } from './tauri-bridge';
import { tChrome } from '../i18n';

export interface LaunchNotice {
  title: string;
  message: string;
}

/** The notice for one record the launch could not read, naming what was lost
 * and, when the file was moved aside, where it went. */
export function unreadableRecordNotice(record: UnreadableRecord): LaunchNotice {
  if (record.record === 'session') {
    return {
      title: tChrome('app.unreadableRecord.sessionTitle'),
      message: record.keptAs
        ? tChrome('app.unreadableRecord.session', { path: record.keptAs })
        : tChrome('app.unreadableRecord.sessionInPlace'),
    };
  }
  return {
    title: tChrome('app.unreadableRecord.startupTitle'),
    message: record.keptAs
      ? tChrome('app.unreadableRecord.startup', { path: record.keptAs })
      : tChrome('app.unreadableRecord.startupInPlace'),
  };
}

export interface LaunchReportDeps {
  startupEntryNotice: () => Promise<string>;
  takeUnreadableRecords: () => Promise<UnreadableRecord[]>;
  /** Write the startup flags back from this window's preferences. */
  saveStartupFlags: () => void;
  /** Resolves when the notice is dismissed. */
  showNotice: (title: string, message: string) => Promise<void>;
}

/**
 * Show what the launch has to report, one notice after another.
 *
 * A startup record that could not be read left this launch on the default
 * flags and, once moved aside, left no record for the next launch either. The
 * flags mirror this window's own preferences, so they are written again from
 * those; the next launch then acts on what the user chose.
 */
export async function reportLaunch(deps: LaunchReportDeps): Promise<void> {
  const notices: LaunchNotice[] = [];
  const detail = await deps.startupEntryNotice().catch(() => '');
  if (detail) {
    notices.push({
      title: tChrome('app.startupEntry.staleTitle'),
      message: tChrome('app.startupEntry.stale', { detail }),
    });
  }
  const records = await deps.takeUnreadableRecords().catch((): UnreadableRecord[] => []);
  if (records.some((r) => r.record === 'startup')) deps.saveStartupFlags();
  notices.push(...records.map(unreadableRecordNotice));
  for (const notice of notices) await deps.showNotice(notice.title, notice.message);
}
