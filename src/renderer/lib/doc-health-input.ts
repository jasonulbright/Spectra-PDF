import type { PdfBuffer } from '../state/types';
import type { IdleGate } from './engine-idle-lane';

export interface HealthInputIO {
  allocate(): Promise<string>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Idempotent when allocation or a failed write left no file. */
  remove(path: string): Promise<void>;
}

/** Inspect the displayed revision, never an open handle on its working path.
 * Allocation happens inside the serial health lane, so queued revisions do
 * not accumulate private files. Currency is checked again after every write.
 * `inspect` must settle only after the worker has released its input handle. */
export async function withHealthInput<T>(
  buffer: PdfBuffer,
  gate: IdleGate,
  io: HealthInputIO,
  inspect: (path: string) => Promise<T>,
): Promise<T> {
  const path = await gate(() => io.allocate());
  try {
    // State buffers are immutable, and binary IPC does not transfer/detach
    // them. Preserve a typed view's byteOffset/byteLength without cloning it.
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    await gate(() => io.write(path, bytes));
    return await gate(() => inspect(path));
  } finally {
    // Also clean partial writes, superseded runs and failed worker requests.
    await io.remove(path);
  }
}
