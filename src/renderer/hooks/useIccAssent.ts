// The colour-profile assent, as a subscription.
//
// `useGsCapability` is the model: the decision logic lives in the leaf
// `lib/icc-assent` (no React, so it is testable and reachable from outside a
// render), and this is the glue that makes an answer landing — or the user
// accepting mid-session — re-render the dependent surfaces in place, with no
// restart and no reopening the panel.
import { useEffect, useSyncExternalStore } from 'react';
import {
  ensureIccAssent,
  iccAssent,
  subscribeIccAssent,
  type IccAssentState,
} from '../lib/icc-assent';

export function useIccAssent(): IccAssentState {
  const state = useSyncExternalStore(subscribeIccAssent, iccAssent);
  useEffect(() => {
    // Kick the first read from whichever surface mounts first. Later mounts
    // resolve from the session's answer without another round trip.
    void ensureIccAssent();
  }, []);
  return state;
}
