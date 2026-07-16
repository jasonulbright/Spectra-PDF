import { useCallback } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { invokeCommand } from '../commands/context';
import { showableFile, tabFiles } from '../state/selectors';
import type { OpenFile } from '../state/types';

/**
 * What an operation panel needs: the file it acts on, the files it can offer,
 * and a way to get one opened.
 */
export function useActiveFile() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  // Never a byte-only import source: it has no tab and is never rendered, so a
  // panel acting on it would be acting on a file the user cannot see — and File
  // ▸ Save would write over the real file it was imported from. The reducer
  // refuses to make one active; asking the shared selector states the same rule
  // where the panels read it, with one tested implementation.
  const activeFile: OpenFile | null = showableFile(state);

  // Tab-bearing files only. This is what a panel OFFERS the user (Compare's
  // "compare against" list), and a ghost has no window — it would be a name in a
  // dropdown for a document they never opened and cannot look at.
  const allFiles = tabFiles(state);

  /**
   * The panels' "Open a PDF to …" button.
   *
   * Delegates to the ONE open path (`file.openInPlace` → App's `openByPaths`).
   * This used to be a second, hand-rolled implementation of "open some files",
   * and it diverged from the real one four separate times: it missed the
   * `!importOnly` already-open check (so opening a file you'd imported pages
   * from was a permanent no-op), the batch dedupe (double-open, leaked working
   * copy), the commit gate before upgrading a ghost (silently wrong pages at
   * commit) — and, worst, it never had ENCRYPTION handling at all, so a
   * password-protected PDF could not be opened from a panel, including the
   * Decrypt panel whose entire job that is. Three of those were fixed here
   * one-by-one as each was found. The fourth is why there is now one
   * implementation instead of a discipline about keeping two in step.
   */
  const openNewFiles = useCallback(async () => {
    invokeCommand('file.openInPlace');
  }, []);

  return { activeFile, allFiles, openNewFiles, state, dispatch };
}
