import { useEffect, useRef } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { indexOpenFile } from '../lib/workspace';
import { evictExcept } from '../lib/pdfDocCache';
import type { PdfBuffer } from '../state/types';

// Keeps AppState.workspace in sync with AppState.files. Whenever a file's
// buffer changes (open, whole-file op, undo/redo), its workspace documents are
// re-derived asynchronously, so the workspace is eventually consistent with
// the files map. Workspace documents carry the buffer they were derived from,
// which is what makes staleness detectable here.
export function useWorkspaceIndexer(): void {
  const state = useAppState();
  const dispatch = useAppDispatch();
  // path -> buffer an index run was started for, so a buffer is indexed once
  // even while the run is still in flight
  const inFlight = useRef(new Map<string, PdfBuffer>());

  useEffect(() => {
    evictExcept(new Set(state.files.keys()));
    for (const [path, f] of state.files) {
      const buffer = f.buffer;
      if (!buffer) continue;
      const current = state.workspace.documents.find((d) => d.path === path);
      if (current && current.buffer === buffer) continue;
      if (inFlight.current.get(path) === buffer) continue;
      inFlight.current.set(path, buffer);
      indexOpenFile(f)
        .then((documents) => dispatch({ type: 'SET_WORKSPACE_DOCUMENTS', path, documents }))
        .catch(() => {
          // Unindexable buffer (shouldn't happen for a file that opened) —
          // leave the workspace entry absent/stale rather than surfacing an
          // error for state no UI reads yet.
        })
        .finally(() => {
          if (inFlight.current.get(path) === buffer) inFlight.current.delete(path);
        });
    }
  }, [state.files, state.workspace, dispatch]);
}
