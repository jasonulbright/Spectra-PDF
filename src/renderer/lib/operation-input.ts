import type { OwnedOperationRun } from './owned-operation-run';

export interface OperationInputIo {
  allocate(): Promise<string>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Read derived edit parameters from owned bytes, not a mutable working path.
 * No page commit or signed-document consent runs during this inspection.
 * The later write still enters the ordinary consent/gate transaction. */
export async function inspectOperationInput<T>(run: OwnedOperationRun, io: OperationInputIo,
  inspect: (path: string) => Promise<T>): Promise<T> {
  run.assertCleanSource();
  const source = run.source.buffer!;
  const path = await io.allocate();
  try {
    run.assertCleanSource();
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source);
    await io.write(path, bytes);
    run.assertCleanSource();
    const result = await inspect(path);
    run.assertCleanSource();
    return result;
  } finally { await io.remove(path); }
}
