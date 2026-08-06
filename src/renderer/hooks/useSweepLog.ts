// Writing one sweep's run log: the settings read, the write, the retention
// prune, and the written-path/error pair a done phase renders.
//
// One implementation rather than one per sweep dialog. The prune failure is
// swallowed deliberately — a log that was written is a log that exists, and a
// retention sweep that could not run is not a reason to tell the user their run
// failed. The WRITE failure is surfaced, because a run with no artefact cannot
// be audited afterwards.
import { useCallback, useState } from 'react';
import { batch } from '../lib/tauri-bridge';
import { getSettings } from '../lib/app-settings';

export interface SweepLog {
  logPath: string | null;
  logError: string | null;
  /** Writes the log when logging is enabled; a no-op otherwise. */
  write: (name: string, contents: string) => Promise<void>;
  reset: () => void;
}

export function useSweepLog(): SweepLog {
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    setLogPath(null);
    setLogError(null);
  }, []);

  const write = useCallback(async (name: string, contents: string): Promise<void> => {
    const settings = getSettings();
    if (!settings.batchLogEnabled) return;
    try {
      const path = await batch.writeLog(name, contents, settings.batchLogDir);
      setLogPath(path);
      setLogError(null);
      await batch.pruneLogs(settings.batchLogRetentionDays, settings.batchLogDir).catch(() => {});
    } catch (e: unknown) {
      setLogPath(null);
      setLogError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return { logPath, logError, write, reset };
}
