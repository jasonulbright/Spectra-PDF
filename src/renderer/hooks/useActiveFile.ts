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

  const activeFile: OpenFile | null = state.activeFileId
    ? state.files.get(state.activeFileId) ?? null
    : null;

  const allFiles = Array.from(state.files.values());

  const openNewFiles = useCallback(async () => {
    const paths = await openFiles();
    let recent = state.ui.recentFiles;
    let changed = false;
    try {
      for (const filePath of paths) {
        if (state.files.has(filePath)) {
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
