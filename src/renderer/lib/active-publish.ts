import { showableDoc } from '../state/selectors';
import type { AppState } from '../state/types';

export type ActivePublish<T> = { stale: false; placed: T } | { stale: true };

/**
 * Places a result computed for the document at `path` into a view that shows
 * one document at a time, and commits it only if that document is still the
 * one shown once placing has finished.
 *
 * Placing awaits (page geometry); a tab switch inside it makes the result
 * another document's, and committing it would replace the set the shown
 * document owns. The check runs after the last await and before the commit,
 * with nothing between them that yields.
 */
export async function publishToShownDocument<T>(
  path: string,
  readState: () => AppState,
  place: () => Promise<T>,
  commit: (placed: T) => void,
): Promise<ActivePublish<T>> {
  const placed = await place();
  if (showableDoc(readState()) !== path) return { stale: true };
  commit(placed);
  return { stale: false, placed };
}
