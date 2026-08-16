import { useEffect, useState } from 'react';
import { engine } from '../lib/tauri-bridge';

/**
 * How many engine requests the OTHER windows have in flight.
 *
 * One sidecar serves every window and runs strictly serial FIFO, so a long run
 * started elsewhere stalls this window's next operation. The operation queue is
 * per window and can only show this window's own work, so without this the wait
 * renders as a hang. Rust owns the count — it is the only side that knows which
 * window each in-flight request belongs to — and each window is told a NUMBER,
 * never the other window's document.
 */
export function useOtherWindowWork(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const unlisten = engine.onOtherWindows(setCount);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
  return count;
}
