import { useEffect, useSyncExternalStore } from 'react';
import {
  audiverisStatus,
  ensureAudiverisStatus,
  subscribeAudiverisStatus,
  type AudiverisStatus,
} from '../lib/audiveris-status';

export function useAudiverisStatus(): AudiverisStatus {
  const status = useSyncExternalStore(subscribeAudiverisStatus, audiverisStatus);
  useEffect(() => {
    void ensureAudiverisStatus();
  }, []);
  return status;
}
