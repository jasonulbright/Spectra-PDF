import { tChrome } from '../i18n';
import { METADATA_BYTES } from './metadata-stream';
import type { MetadataRequest, MetadataResult } from './metadata-process';

export const METADATA_DEADLINE_MS = 5000;

/** A fresh worker gives each packet an independently enforceable deadline,
 * including decompression and synchronous XML parsing. There is no UI-thread
 * fallback when worker creation fails. All outcomes retire the owned worker. */
export function transformMetadata(request: MetadataRequest): Promise<MetadataResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (result?: MetadataResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
      }
      if (result) resolve(result); else reject(new Error(tChrome('app.operation.unverified')));
    };
    const timer = setTimeout(() => finish(), METADATA_DEADLINE_MS);
    try {
      worker = new Worker(new URL('./metadata.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        const response = event.data;
        if (!response || response.ok !== true || !response.result) return finish();
        const result = response.result;
        if (result.changed === false && !Object.hasOwn(result, 'bytes')) return finish({ changed: false });
        if (result.changed === true && result.bytes instanceof Uint8Array && result.bytes.length > 0 && result.bytes.length <= METADATA_BYTES) {
          return finish({ changed: true, bytes: result.bytes });
        }
        finish();
      };
      worker.onerror = worker.onmessageerror = () => finish();
      // Clone, never transfer a buffer owned by a source PDF or application state.
      worker.postMessage(request);
    } catch { finish(); }
  });
}
