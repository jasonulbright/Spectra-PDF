// A document opened with its user password keeps an encrypted working copy,
// and the engine opens it with the credential recorded for that path only. A
// staged rewrite or an inspection runs on a byte copy at another path, so the
// copy borrows the credential for its lifetime (engine `share_document`) and
// gives it back when the copy is removed.
import type { OpenFile } from '../state/types';

type EngineCaller = (method: string, params: Record<string, unknown>) => Promise<unknown>;

let caller: EngineCaller | null = null;

/** Registered by App with its ungated engine transport: the calls run inside
 * a transaction that already holds the file lock. */
export function setStageCredentialCaller(next: EngineCaller | null): void {
  caller = next;
}

/** Whether `copy` now opens with `file`'s credential. A file that needs none
 * answers false without a call. */
export async function shareStageCredential(file: Pick<OpenFile, 'workingPath' | 'security'>, copy: string): Promise<boolean> {
  if (file.security?.opener !== 'user') return false;
  if (!caller) throw new Error('stage credentials are not registered');
  await caller('share_document', { path: file.workingPath, alias: copy });
  return true;
}

export async function releaseStageCredential(copy: string): Promise<void> {
  if (!caller) return;
  await caller('close_document', { path: copy }).catch(() => {});
}
