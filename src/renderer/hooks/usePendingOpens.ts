import { useSyncExternalStore } from 'react';
import { pendingOpens, type PendingOpensSnapshot } from '../lib/pending-opens';

/** This window's opens in flight, for the tab strip and the loading pane. */
export function usePendingOpens(): PendingOpensSnapshot {
  return useSyncExternalStore(pendingOpens.subscribe, pendingOpens.snapshot);
}
