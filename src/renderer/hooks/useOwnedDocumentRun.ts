import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppState, useReadAppState } from '../state/AppStateProvider';
import { createOwnedDocumentRuns, type OwnedDocumentRun } from '../lib/owned-document-run';
import type { OpenFile } from '../state/types';

/** A synchronous reservation starts before any picker or prerequisite await. */
export function useOwnedDocumentRun(file: OpenFile | null) {
  const readState = useReadAppState();
  const { pageDirtyPaths } = useAppState();
  const runs = useMemo(() => createOwnedDocumentRuns(readState), [readState]);
  const current = useRef<OwnedDocumentRun | null>(null);
  useEffect(() => { runs.activate(); return () => runs.deactivate(); }, [runs]);
  useEffect(() => { current.current?.synchronize(); }, [file, pageDirtyPaths]);
  return useCallback(() => {
    const run = runs.begin(file);
    if (run) current.current = run;
    return run;
  }, [file, runs]);
}
