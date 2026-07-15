import { useCallback } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { useEngine } from './useEngine';
import { file } from '../lib/tauri-bridge';
import { withRecent } from '../lib/recent-files';
import { runCommitGate } from '../lib/commit-gate';
import { showableFile, tabFiles } from '../state/selectors';
import type { OpenFile } from '../state/types';

export function useActiveFile() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { call, openFiles } = useEngine();

  // Never a byte-only import source: it has no tab and is never rendered, so a
  // panel acting on it would be acting on a file the user cannot see — and File
  // ▸ Save would write over the real file it was imported from. The reducer
  // refuses to make one active; asking the shared selector states the same rule
  // where the panels read it, and gives it one tested implementation.
  const activeFile: OpenFile | null = showableFile(state);

  // Tab-bearing files only. This is what panels OFFER the user (Compare's
  // "compare against" list), and a ghost has no window — it would be a name in a
  // dropdown for a document they never opened and cannot look at.
  const allFiles = tabFiles(state);

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
        if (existing?.importOnly) {
          // Upgrading a ghost REPLACES bytes that other documents' pending pages
          // still point into, positionally (`sourceDocId` + `sourcePageIndex`,
          // resolved at commit by `bytesFor`). Flush first, so those pages are
          // materialized into their own files and nothing references these bytes
          // any more. The third thing `openByPaths` does that this sibling
          // didn't — reachable via Compare's "Open another…", the one caller
          // that runs with a real file already active and its page edits
          // possibly still pending.
          await runCommitGate();
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
