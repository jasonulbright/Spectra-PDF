import { withFileLock } from './engine-lock';

type SaveBarrier = (workingPath: string) => Promise<void>;
const barriers = new Set<SaveBarrier>();

/** Window-owned queues outlive their panels. File export must wait for the
 * whole accepted gesture queue, not just whichever individual write owns the
 * file lock right now. A barrier may itself publish, so await it BEFORE locking. */
export function registerFileSaveBarrier(barrier: SaveBarrier): () => void {
  barriers.add(barrier);
  return () => { barriers.delete(barrier); };
}

export async function withFileSave<T>(workingPath: string, destPath: string, save: () => Promise<T>): Promise<T> {
  await Promise.all(Array.from(barriers, barrier => barrier(workingPath)));
  return withFileLock([workingPath, destPath], save);
}
