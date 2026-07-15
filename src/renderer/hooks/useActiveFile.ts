import { useCallback } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { useEngine } from './useEngine';
import { file } from '../lib/tauri-bridge';
import { withRecent } from '../lib/recent-files';
import type { OpenFile } from '../state/types';

export function useActiveFile() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { call, openFiles } = useEngine();

  // Never a byte-only import source: it has no tab and is never rendered, so a
  // panel acting on it would be acting on a file the user cannot see. The
  // reducer already refuses to make one active — this is the same rule stated
  // where the panels read it, so a future writer can't reintroduce the gap
  // upstream and have it silently arrive here.
  const active = state.activeFileId ? state.files.get(state.activeFileId) : undefined;
  const activeFile: OpenFile | null = active && !active.importOnly ? active : null;

  const allFiles = Array.from(state.files.values());

  const openNewFiles = useCallback(async () => {
    const paths = await openFiles();
    let recent = state.ui.recentFiles;
    let changed = false;
    try {
      for (const filePath of [...new Set(paths)]) {
        // Already open as a real DOCUMENT → just re-activate. A byte-only
        // import source doesn't count: it has an entry in `files` but no tab,
        // nothing upgrades the flag on its own, and the reducer refuses to make
        // one active — so treating it as "already open" made this button a
        // silent no-op for any file you'd previously imported pages FROM. Fall
        // through and open it properly, which upgrades the ghost in place.
        //
        // This is `App.openByPaths`'s fix, ported: the two are independent
        // implementations of "open some files", and the bug was fixed in one of
        // them. (The dedupe too — nothing guarantees the dialog can't return a
        // path twice, and a double-open leaks a working copy.)
        const existing = state.files.get(filePath);
        if (existing && !existing.importOnly) {
          dispatch({ type: 'SET_ACTIVE_FILE', path: filePath });
          recent = withRecent(recent, filePath); // only on success (review-caught)
          changed = true;
          continue;
        }
        const workingPath = await file.createWorkingCopy(filePath);
        const buffer = await file.readBuffer(workingPath);
        const info = await call('get_page_count', { file: workingPath });
        dispatch({
          type: 'OPEN_FILE',
          path: filePath,
          workingPath,
          name: filePath.split(/[\\/]/).pop() || filePath,
          pageCount: info.pages,
          buffer,
        });
        recent = withRecent(recent, filePath);
        changed = true;
      }
    } finally {
      // One dispatch so a multi-file batch doesn't clobber itself; in a finally
      // so a malformed file mid-batch still records the files that did open.
      if (changed) dispatch({ type: 'UI_SET_RECENT_FILES', files: recent });
    }
  }, [state.files, state.ui.recentFiles, call, openFiles, dispatch]);

  return { activeFile, allFiles, openNewFiles, state, dispatch };
}
