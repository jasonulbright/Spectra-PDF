/**
 * True while the result on screen belongs to an earlier query: the debounce
 * or the asynchronous scan for the current one has not landed. A count shown
 * in that window reports the previous query ("No results" for a page that
 * does contain the new text).
 */
export function findResultPending(query: string, matchedQuery: string): boolean {
  return query.trim().length > 0 && query !== matchedQuery;
}
