import { useEffect, useState } from 'react';
import { updates } from '../lib/tauri-bridge';
import type { UpdateStatus } from '../lib/update-check';

/** The Rust update status: read once, then followed through `update://status`. An event outranks the first read. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    let heard = false;
    let unlisten: (() => void) | null = null;
    void updates
      .onStatus((next) => {
        if (cancelled) return;
        heard = true;
        setStatus(next);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    void updates
      .status()
      .then((next) => {
        if (!cancelled && !heard) setStatus(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return status;
}
