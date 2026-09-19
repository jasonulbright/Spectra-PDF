import { useEffect, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { indexOpenFile } from '../lib/workspace';
import { evictExcept, subscribeProxyEvictions } from '../lib/pdfDocCache';
import { createIndexRuns } from '../lib/index-runs';
import { clearIndexFailure, needsIndex, recordIndexFailure } from '../lib/workspace-settle';

// Keeps AppState.workspace in sync with AppState.files. Whenever a file's
// buffer changes (open, whole-file op, undo/redo), its workspace documents are
// re-derived asynchronously, so the workspace is eventually consistent with
// the files map. Workspace documents carry the buffer they were derived from,
// which is what makes staleness detectable here.
export function useWorkspaceIndexer(): void {
  const state = useAppState();
  const dispatch = useAppDispatch();
  // One live run per path, so a buffer is indexed once even while its run is
  // still in flight, and only the live run lands.
  const runs = useRef(createIndexRuns());
  // A destroyed proxy abandons the run reading it; this re-runs the pass that
  // starts it again.
  const [restarts, setRestarts] = useState(0);

  useEffect(
    () =>
      subscribeProxyEvictions((path, buffer) => {
        if (runs.current.abandon(path, buffer)) setRestarts((n) => n + 1);
      }),
    [],
  );

  useEffect(() => {
    const indexed = { files: state.files, workspace: state.workspace };
    evictExcept(new Set(state.files.keys()));
    for (const [path, f] of state.files) {
      const buffer = f.buffer;
      if (!buffer) continue;
      // Byte-only import sources provide bytes for rendering/commit only
      // — never a strip. evictExcept above still keeps their proxy alive.
      if (f.importOnly) continue;
      if (!needsIndex(indexed, path)) continue;
      const token = runs.current.begin(path, buffer);
      if (token === null) continue;
      clearIndexFailure(buffer);
      indexOpenFile(f)
        .then((documents) => {
          if (runs.current.live(path, token)) dispatch({ type: 'SET_WORKSPACE_DOCUMENTS', path, documents });
        })
        .catch(() => {
          // Unindexable buffer (shouldn't happen for a file that opened) —
          // the workspace entry stays absent or superseded. A commit waiting
          // for this landing is released with a refusal instead of waiting on.
          if (runs.current.live(path, token)) recordIndexFailure(buffer);
        })
        .finally(() => runs.current.end(path, token));
    }
  }, [state.files, state.workspace, dispatch, restarts]);
}
