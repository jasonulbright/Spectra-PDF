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
    for (const filePath of paths) {
      recent = withRecent(recent, filePath);
      if (state.files.has(filePath)) {
        dispatch({ type: 'SET_ACTIVE_FILE', path: filePath });
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
    }
    // Track recent (ui slice + App's persistence effect) — one dispatch so
    // multi-file opens don't clobber each other within the batch.
    if (paths.length > 0) dispatch({ type: 'UI_SET_RECENT_FILES', files: recent });
  }, [state.files, state.ui.recentFiles, call, openFiles, dispatch]);

  return { activeFile, allFiles, openNewFiles, state, dispatch };
}
