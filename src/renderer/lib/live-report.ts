import { tChrome } from '../i18n';
import { readsLiveRevision } from './reader-copy';
import type { AppState } from '../state/types';

/** Whether a report's page numbers still address the live document. When
 * they do not, `refuse` gets the document-changed notice and nothing that
 * places or focuses a finding may run. */
export function liveOrRefuse(
  report: unknown,
  state: Pick<AppState, 'files' | 'pageDirtyPaths'>,
  workingPath: string | null,
  refuse: (message: string) => void,
): boolean {
  if (workingPath && readsLiveRevision(report, state, workingPath)) return true;
  refuse(tChrome('panel.common.documentChanged'));
  return false;
}
