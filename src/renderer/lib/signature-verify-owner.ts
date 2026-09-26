import type { OpenFile } from '../state/types';

/** The document bytes and trust configuration one verification judged. */
export interface VerifyOwner {
  path: string;
  workingPath: string;
  buffer: OpenFile['buffer'];
  trust: unknown;
}

export interface OwnedVerify<T> {
  owner: VerifyOwner;
  value: T;
}

export function verifyOwnerOf(file: OpenFile | null | undefined, trust: unknown): VerifyOwner | null {
  if (!file) return null;
  return { path: file.path, workingPath: file.workingPath, buffer: file.buffer, trust };
}

/** Buffer and trust compare by identity: a new byte string or trust edit is a new owner. */
export function verifyOwnerCurrent(owner: VerifyOwner, file: OpenFile | null | undefined, trust: unknown): boolean {
  return !!file && file.path === owner.path && file.workingPath === owner.workingPath
    && file.buffer === owner.buffer && trust === owner.trust;
}

/** The result to display, or null when it describes another document, other bytes or other trust. */
export function displayedVerify<T>(owned: OwnedVerify<T> | null, file: OpenFile | null | undefined,
  trust: unknown): T | null {
  return owned && verifyOwnerCurrent(owned.owner, file, trust) ? owned.value : null;
}

export interface VerifyRuns {
  /** Starts a run; every earlier run becomes stale. */
  begin(): () => boolean;
}

export function createVerifyRuns(): VerifyRuns {
  let latest = 0;
  return {
    begin() {
      const mine = ++latest;
      return () => mine === latest;
    },
  };
}

/**
 * Runs one verification and publishes it bound to `owner` only while it is
 * still the latest run. A reply that resolves after a later run began is
 * dropped, error or not, so a slow verification of one document can never
 * land over another's.
 */
export async function runOwnedVerify<T>(runs: VerifyRuns, owner: VerifyOwner,
  request: () => Promise<T>, publish: (owned: OwnedVerify<T>) => void): Promise<'published' | 'stale'> {
  const isLatest = runs.begin();
  let value: T;
  try {
    value = await request();
  } catch (e) {
    if (!isLatest()) return 'stale';
    throw e;
  }
  if (!isLatest()) return 'stale';
  publish({ owner, value });
  return 'published';
}
