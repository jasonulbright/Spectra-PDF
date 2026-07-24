// Render-thread half of the regex search worker.
//
// Why this exists: the in-app Find ran the compiled regex synchronously over
// every indexed page. A user-authored pattern that backtracks catastrophically
// (the classic `(a+)+$`) has no cancellation point in JS — the render thread
// is simply gone, with no way back short of killing the app. Literal /
// case-sensitive / whole-word queries are escaped patterns with no such risk
// and stay on the render thread, unchanged; ONLY regex mode routes here.
//
// The worker is disposable: a search that outlives REGEX_TIMEOUT_MS is a hung
// backtrack, so the worker is terminated (the only way to stop it), every
// in-flight request is answered with a timeout, and the next search builds a
// fresh worker and re-seeds it.
import type { SearchOptions } from './normalize';
import type { CorpusSearch } from './search-core';
import type { SearchWorkerLike, SearchWorkerResponse } from './search-protocol';

/** How long a single regex scan may run before the worker is killed. A full
 *  scan of a large workspace is milliseconds; anything near this is a
 *  pathological pattern, not a slow document. */
export const REGEX_TIMEOUT_MS = 3000;

export const TIMEOUT_MESSAGE =
  'This pattern is too slow to run on this document. Simplify it (nested quantifiers such as (a+)+ are the usual cause).';

export interface RegexSearchResult extends CorpusSearch {
  /** True when the scan was killed by the time budget rather than completing. */
  timedOut: boolean;
}

export interface RegexSearchRunner {
  /**
   * Run `query` in the worker against `entries()`, re-seeding first if the
   * corpus moved since the last send. Resolves null when no worker could be
   * created at all (non-browser host) — the caller then falls back to the
   * synchronous scan.
   */
  run: (
    entries: () => [string, string][],
    corpusVersion: number,
    query: string,
    options: SearchOptions,
  ) => Promise<RegexSearchResult | null>;
  dispose: () => void;
}

export type SearchWorkerFactory = () => SearchWorkerLike | null;

export const defaultSearchWorkerFactory: SearchWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./search.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as SearchWorkerLike;
};

export function createRegexSearchRunner(
  makeWorker: SearchWorkerFactory = defaultSearchWorkerFactory,
): RegexSearchRunner {
  let worker: SearchWorkerLike | null = null;
  let seededVersion = -1;
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (result: RegexSearchResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  function kill(): void {
    const victims = [...pending.values()];
    pending.clear();
    for (const entry of victims) {
      clearTimeout(entry.timer);
      entry.resolve({ hits: [], error: TIMEOUT_MESSAGE, timedOut: true });
    }
    worker?.terminate();
    worker = null;
    seededVersion = -1; // a fresh worker starts with an empty corpus
  }

  function ensureWorker(): SearchWorkerLike | null {
    if (worker) return worker;
    let created: SearchWorkerLike | null;
    try {
      created = makeWorker();
    } catch {
      created = null;
    }
    if (!created) return null;
    created.onmessage = ({ data }: { data: SearchWorkerResponse }) => {
      const entry = pending.get(data.id);
      if (!entry) return; // a response that outlived its timeout
      pending.delete(data.id);
      clearTimeout(entry.timer);
      entry.resolve({ hits: data.hits, error: data.error, timedOut: false });
    };
    worker = created;
    return worker;
  }

  return {
    run(entries, corpusVersion, query, options) {
      const w = ensureWorker();
      if (!w) return Promise.resolve(null);
      if (seededVersion !== corpusVersion) {
        w.postMessage({ type: 'seed', entries: entries() });
        seededVersion = corpusVersion;
      }
      const id = ++seq;
      return new Promise<RegexSearchResult>((resolve) => {
        const timer = setTimeout(kill, REGEX_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        w.postMessage({ type: 'search', id, query, options });
      });
    },
    dispose() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      worker?.terminate();
      worker = null;
      seededVersion = -1;
    },
  };
}
