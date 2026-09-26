// A document's credentials live as long as its entry in `files`: a closed
// tab, a tab handed to another window, and an import source nobody uses any
// more all leave `files`, and each takes its engine credential and its pdf.js
// password with it.
import { forgetDocumentPassword } from './document-passwords';

type EngineCaller = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** The working copies `held` names that `files` no longer holds under that
 * path. `held` becomes the current set. */
export function droppedCredentials(
  held: Map<string, string>,
  files: ReadonlyMap<string, { workingPath: string }>,
): { path: string; workingPath: string }[] {
  const dropped: { path: string; workingPath: string }[] = [];
  for (const [path, workingPath] of held) {
    if (files.get(path)?.workingPath === workingPath) continue;
    held.delete(path);
    dropped.push({ path, workingPath });
  }
  for (const [path, f] of files) held.set(path, f.workingPath);
  return dropped;
}

/** The pdf.js password is keyed by path, and a path still open under a new
 * working copy (an import source opened as a document) keeps the password
 * that copy was opened with. */
export function releaseDocumentCredentials(
  path: string,
  workingPath: string,
  pathStillOpen: boolean,
  call: EngineCaller,
): Promise<void> {
  if (!pathStillOpen) forgetDocumentPassword(path);
  return call('close_document', { path: workingPath }).then(() => {}, () => {});
}
