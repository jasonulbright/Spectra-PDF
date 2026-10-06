import { withFileLock, withWriteChain } from './engine-lock';

type SaveBarrier = (workingPath: string) => Promise<void>;
const barriers = new Set<SaveBarrier>();

/** Window-owned queues outlive their panels. File export must wait for the
 * whole accepted gesture queue, not just whichever individual write owns the
 * file lock right now. A barrier may itself publish, so await it BEFORE locking.
 * The working path's write chain comes before its lock: a staged rewrite holds
 * the chain from before its engine step until it publishes, so the save writes
 * the rewritten bytes, and saves and writes of one path keep their issue order. */
export function registerFileSaveBarrier(barrier: SaveBarrier): () => void {
  barriers.add(barrier);
  return () => { barriers.delete(barrier); };
}

export async function withFileSave<T>(workingPath: string, destPath: string, save: () => Promise<T>): Promise<T> {
  await Promise.all(Array.from(barriers, barrier => barrier(workingPath)));
  return withWriteChain([workingPath], () => withFileLock([workingPath, destPath], save));
}
