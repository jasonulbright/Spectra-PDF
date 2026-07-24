// Wire types between the render thread and the regex search worker.
import type { SearchOptions } from './normalize';
import type { CorpusHit } from './search-core';

export type SearchWorkerRequest =
  /** Replace the worker's whole corpus. Sent whenever the index changed since
   *  the last send (and always after a terminate, which loses the corpus). */
  | { type: 'seed'; entries: [string, string][] }
  | { type: 'search'; id: number; query: string; options: SearchOptions };

export type SearchWorkerResponse = {
  type: 'result';
  id: number;
  hits: CorpusHit[];
  error: string | null;
};

/** The minimum of the DOM Worker surface this client uses — so a test can
 *  supply a fake (there is no DOM test environment in this repo). */
export interface SearchWorkerLike {
  postMessage: (message: SearchWorkerRequest) => void;
  terminate: () => void;
  onmessage: ((event: { data: SearchWorkerResponse }) => void) | null;
}
