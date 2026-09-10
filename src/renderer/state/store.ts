import { appReducer } from './reducer';
import type { AppAction, AppState } from './types';

/** Dispatch settles the authoritative state synchronously, independently of
 * React's render batching. Transaction receipts must not inspect a stale render. */
export function createAppStore(initial: AppState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch: (action: AppAction) => {
      const next = appReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) {
        // Notification failure cannot turn an already published state into a
        // rejected transaction and cause native rollback underneath that state.
        try { listener(); } catch (error) { queueMicrotask(() => { throw error; }); }
      }
    },
  };
}
