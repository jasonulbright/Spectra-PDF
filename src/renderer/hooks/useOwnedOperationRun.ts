import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppState, useReadAppState } from '../state/AppStateProvider';
import type { OpenFile } from '../state/types';
import { createOwnedOperationRuns, type OwnedOperationRun } from '../lib/owned-operation-run';

export function useOwnedOperationRun(file: OpenFile | null) {
  const readState = useReadAppState();
  const { activeFileId } = useAppState();
  const runs = useMemo(() => createOwnedOperationRuns(readState), [readState]);
  const current = useRef<OwnedOperationRun | null>(null);
  useEffect(() => { runs.activate(); return () => runs.deactivate(); }, [runs]);
  useEffect(() => { current.current?.synchronize(); }, [file, activeFileId]);
  return useCallback((source: OpenFile | null = file) => {
    const run = runs.begin(source);
    if (run) current.current = run;
    return run;
  }, [file, runs]);
}
