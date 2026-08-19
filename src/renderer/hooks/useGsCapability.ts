// The Ghostscript capability, as a subscription.
//
// The decision logic lives in the leaf `lib/gs-capability` (no React, so it
// is testable and the command layer can read it); this is the three lines of
// glue that make a landing probe re-render the surfaces. Installing
// Ghostscript and pointing Settings ▸ Engine at it therefore lights the
// disabled controls up in place — no restart, no reopening the panel.
import { useEffect, useSyncExternalStore } from 'react';
import {
  ensureGsCapability,
  gsCapability,
  subscribeGsCapability,
  type GsCapability,
} from '../lib/gs-capability';

export function useGsCapability(): GsCapability {
  const capability = useSyncExternalStore(subscribeGsCapability, gsCapability);
  useEffect(() => {
    // Kick the first probe from whichever surface mounts first. Later mounts
    // resolve from the session's answer without another round trip.
    void ensureGsCapability();
  }, []);
  return capability;
}
