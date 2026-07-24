/// <reference lib="webworker" />
// Regex-mode corpus scan, off the render thread. Holds its own copy of the
// page text so a keystroke only ships the query, not the corpus; the render
// thread re-seeds whenever the index changed (or after a terminate).
// This worker is DISPOSABLE by design: a pathological user pattern that
// backtracks forever is killed with terminate() and a fresh worker is made on
// the next search — the reason regex mode lives here at all.
import { runCorpusSearch } from './search-core';
import type { SearchWorkerRequest, SearchWorkerResponse } from './search-protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const corpus = new Map<string, string>();

ctx.onmessage = (event: MessageEvent<SearchWorkerRequest>): void => {
  const message = event.data;
  if (message.type === 'seed') {
    corpus.clear();
    for (const [pageId, text] of message.entries) corpus.set(pageId, text);
    return;
  }
  const { hits, error } = runCorpusSearch(corpus, message.query, message.options);
  const response: SearchWorkerResponse = { type: 'result', id: message.id, hits, error };
  ctx.postMessage(response);
};
