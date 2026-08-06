// The source/destination pair every folder sweep picks, and the two guards that
// make picking one safe.
//
// One implementation rather than one per sweep dialog: these are the parts a
// second dialog copies verbatim, and a copy is where two sweeps start behaving
// differently at the edges (whether a stale enumeration can win, whether an
// aliased destination is caught).
import { useCallback, useEffect, useRef, useState } from 'react';
import { batch, type BatchPdfEntry } from '../lib/tauri-bridge';
import { destConflictsWithSource } from '../lib/batch-ocr';

export interface SweepFolders {
  source: string | null;
  dest: string | null;
  setDest: (path: string | null) => void;
  /** Pick a source and enumerate it. Rejected enumerations clear the source. */
  selectSource: (path: string) => Promise<void>;
  entries: BatchPdfEntry[] | null;
  skippedDirs: string[];
  scanning: boolean;
  /** The destination is the source, inside it, or the same physical folder. */
  conflict: boolean;
  /** The conflict was found by filesystem identity rather than by the path
   * text — a different sentence, because the paths look unrelated. */
  identityConflict: boolean;
  error: string | null;
  setError: (message: string | null) => void;
}

export function useSweepFolders(): SweepFolders {
  const [source, setSource] = useState<string | null>(null);
  const [dest, setDest] = useState<string | null>(null);
  const [entries, setEntries] = useState<BatchPdfEntry[] | null>(null);
  const [skippedDirs, setSkippedDirs] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monotonic token: re-picking the source mid-scan starts a second
  // enumeration, and a slow first response landing last would otherwise
  // replace the displayed folder's listing with another folder's files.
  const scanTokenRef = useRef(0);
  const selectSource = useCallback(async (path: string): Promise<void> => {
    const token = ++scanTokenRef.current;
    setError(null);
    setSource(path);
    setEntries(null);
    setSkippedDirs([]);
    setScanning(true);
    try {
      const listing = await batch.listPdfsRecursive(path);
      if (scanTokenRef.current !== token) return;
      setEntries(listing.files);
      setSkippedDirs(listing.skippedDirs);
    } catch (e: unknown) {
      if (scanTokenRef.current !== token) return;
      setSource(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (scanTokenRef.current === token) setScanning(false);
    }
  }, []);

  // Two-layer conflict guard, the batch one: the string check catches the
  // everyday case synchronously; the filesystem identity check catches
  // aliased spellings of one physical folder that no string comparison sees.
  const [identityConflict, setIdentityConflict] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (source === null || dest === null || destConflictsWithSource(source, dest)) {
      setIdentityConflict(false);
      return;
    }
    void batch
      .pathsSameFile(source, dest)
      .then((same) => {
        if (!cancelled) setIdentityConflict(same);
      })
      .catch(() => {
        if (!cancelled) setIdentityConflict(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, dest]);

  const conflict =
    (source !== null && dest !== null && destConflictsWithSource(source, dest)) ||
    identityConflict;

  return {
    source,
    dest,
    setDest,
    selectSource,
    entries,
    skippedDirs,
    scanning,
    conflict,
    identityConflict,
    error,
    setError,
  };
}
