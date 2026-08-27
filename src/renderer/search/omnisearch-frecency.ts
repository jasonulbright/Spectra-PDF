// The persistence half of the omnisearch frecency signal. The math and the
// parse live in `omnisearch-rank.ts` (pure, unit-tested); this module is only
// the storage edge.
//
// Per WINDOW, like the other view-state keys: which tools you reach for is a
// property of the workspace you are working in, and a second window mirroring
// its own picks back over a shared key would reorder the first window's list
// from under it. The base key carries no `spectra-` prefix — that prefix is
// legacy, not the convention for new keys (the `workbench-ui` precedent).
import { readScoped, writeScoped } from '../lib/window-label';
import {
  parseFrecency,
  recordFrecencyPick,
  serializeFrecency,
  type FrecencyStore,
} from './omnisearch-rank';

const KEY = 'omnisearch-frecency';

export function readFrecency(): FrecencyStore {
  return parseFrecency(readScoped(KEY));
}

/** Record an activation and persist. Returns the new store so the caller can
 * rank against it without a re-read. */
export function noteToolPick(id: string, now: number = Date.now()): FrecencyStore {
  const next = recordFrecencyPick(readFrecency(), id, now);
  writeScoped(KEY, serializeFrecency(next));
  return next;
}
